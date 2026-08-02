import http from 'k6/http';
import { check, fail, sleep } from 'k6';

const baseUrl = (__ENV.BASE_URL || 'http://juice-shop:3000').replace(/\/$/, '');
const profileName = __ENV.LOAD_PROFILE || 'moderate';

const profiles = {
  smoke: [
    { duration: '10s', target: 2 },
    { duration: '20s', target: 2 },
    { duration: '10s', target: 0 },
  ],
  moderate: [
    { duration: '20s', target: 10 },
    { duration: '30s', target: 50 },
    { duration: '60s', target: 25 },
    { duration: '20s', target: 0 },
  ],
};

if (!profiles[profileName]) {
  throw new Error(`Unknown LOAD_PROFILE "${profileName}". Choose smoke or moderate.`);
}

export const options = {
  scenarios: {
    shoppers: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: profiles[profileName],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    'http_req_failed{action:browse}': ['rate<0.02'],
    'http_req_failed{action:search}': ['rate<0.02'],
    'http_req_duration{action:browse}': ['p(95)<1000'],
    'http_req_duration{action:search}': ['p(95)<1000'],
  },
};

export function setup() {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const response = http.get(`${baseUrl}/`, { tags: { action: 'preflight' } });
    lastStatus = response.status;
    if (lastStatus >= 200 && lastStatus < 400) {
      return;
    }
    sleep(2);
  }
  fail(`Target preflight failed: GET ${baseUrl}/ returned ${lastStatus} after 24 seconds.`);
}

export default function () {
  const responses = http.batch([
    ['GET', `${baseUrl}/api/Products`, null, { tags: { action: 'browse' } }],
    ['GET', `${baseUrl}/rest/products/search?q=apple`, null, { tags: { action: 'search' } }],
  ]);

  for (const [index, response] of responses.entries()) {
    check(response, {
      'response is successful': (result) => result.status >= 200 && result.status < 400,
    }, { endpoint: index === 0 ? 'products' : 'search' });
  }
  sleep(Math.random() * 2 + 0.5);
}

export function handleSummary(data) {
  const metric = (name) => data.metrics[name]?.values || {};
  const endpointMetric = (name, action) => metric(`${name}{action:${action}}`);
  const markdown = `# LoadForge-Lab Report

## Scenario

- Target: ${baseUrl}
- Profile: ${profileName} (Juice Shop browsing/search)

## Results

| Metric | Value |
| --- | --- |
| Requests | ${metric('http_reqs').count || 0} |
| Failed request rate | ${((metric('http_req_failed').rate || 0) * 100).toFixed(2)}% |
| P95 latency | ${(metric('http_req_duration')['p(95)'] || 0).toFixed(2)} ms |
| Checks passed | ${metric('checks').passes || 0} |
| Checks failed | ${metric('checks').fails || 0} |

## Endpoint performance

| Endpoint | Requests | Failed request rate | P95 latency |
| --- | ---: | ---: | ---: |
| Browse products | ${endpointMetric('http_reqs', 'browse').count || 0} | ${((endpointMetric('http_req_failed', 'browse').rate || 0) * 100).toFixed(2)}% | ${(endpointMetric('http_req_duration', 'browse')['p(95)'] || 0).toFixed(2)} ms |
| Search products | ${endpointMetric('http_reqs', 'search').count || 0} | ${((endpointMetric('http_req_failed', 'search').rate || 0) * 100).toFixed(2)}% | ${(endpointMetric('http_req_duration', 'search')['p(95)'] || 0).toFixed(2)} ms |

## Interpretation

Each browsing and search endpoint has an independent threshold: less than 2% failures and P95 below 1,000 ms. Treat this result as valid only when the target was owned or explicitly authorized.
`;
  return {
    '/reports/latest-summary.md': markdown,
    stdout: 'LoadForge-Lab scenario finished. See reports/latest-summary.md.\n',
  };
}
