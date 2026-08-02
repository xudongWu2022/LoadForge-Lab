import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const baseUrl = (__ENV.BASE_URL || 'http://juice-shop:3000').replace(/\/$/, '');
const profileName = __ENV.LOAD_PROFILE || 'moderate';
const endpointRequests = new Counter('endpoint_requests');

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
    'endpoint_requests{action:browse}': ['count>0'],
    'endpoint_requests{action:search}': ['count>0'],
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
    const action = index === 0 ? 'browse' : 'search';
    endpointRequests.add(1, { action });
    check(response, {
      'response is successful': (result) => result.status >= 200 && result.status < 400,
    }, { endpoint: action === 'browse' ? 'products' : 'search' });
  }
  sleep(Math.random() * 2 + 0.5);
}

export function handleSummary(data) {
  const metric = (name) => data.metrics[name]?.values || {};
  const endpointMetric = (name, action) => metric(`${name}{action:${action}}`);
  const requestCount = (action) => metric(`endpoint_requests{action:${action}}`).count || 0;
  const failureRate = (action) => endpointMetric('http_req_failed', action).rate || 0;
  const browseRequests = requestCount('browse');
  const searchRequests = requestCount('search');
  const trafficRequests = browseRequests + searchRequests;
  const trafficFailureRate = trafficRequests === 0
    ? 0
    : ((browseRequests * failureRate('browse')) + (searchRequests * failureRate('search'))) / trafficRequests;
  const worstEndpointP95 = Math.max(
    endpointMetric('http_req_duration', 'browse')['p(95)'] || 0,
    endpointMetric('http_req_duration', 'search')['p(95)'] || 0,
  );
  const markdown = `# LoadForge-Lab Report

## Scenario

- Target: ${baseUrl}
- Profile: ${profileName} (Juice Shop browsing/search)

## Results

| Metric | Value |
| --- | --- |
| Traffic requests | ${trafficRequests} |
| Traffic failed request rate | ${(trafficFailureRate * 100).toFixed(2)}% |
| Worst endpoint P95 latency | ${worstEndpointP95.toFixed(2)} ms |
| Checks passed | ${metric('checks').passes || 0} |
| Checks failed | ${metric('checks').fails || 0} |

## Endpoint performance

| Endpoint | Requests | Failed request rate | P95 latency |
| --- | ---: | ---: | ---: |
| Browse products | ${browseRequests} | ${(failureRate('browse') * 100).toFixed(2)}% | ${(endpointMetric('http_req_duration', 'browse')['p(95)'] || 0).toFixed(2)} ms |
| Search products | ${searchRequests} | ${(failureRate('search') * 100).toFixed(2)}% | ${(endpointMetric('http_req_duration', 'search')['p(95)'] || 0).toFixed(2)} ms |

## Interpretation

Each browsing and search endpoint has an independent threshold: less than 2% failures and P95 below 1,000 ms. Treat this result as valid only when the target was owned or explicitly authorized.
`;
  return {
    '/reports/latest-summary.md': markdown,
    stdout: 'LoadForge-Lab scenario finished. See reports/latest-summary.md.\n',
  };
}
