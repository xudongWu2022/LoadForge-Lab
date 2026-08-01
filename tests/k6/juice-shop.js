import http from 'k6/http';
import { check, sleep } from 'k6';

const baseUrl = __ENV.BASE_URL || 'http://juice-shop:3000';

export const options = {
  scenarios: {
    shoppers: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 10 },
        { duration: '30s', target: 50 },
        { duration: '60s', target: 25 },
        { duration: '20s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<1000'],
  },
};

export default function () {
  const userId = `vu-${__VU}`;
  const responses = http.batch([
    ['GET', `${baseUrl}/api/Products`, null, { tags: { action: 'browse', user: userId } }],
    ['GET', `${baseUrl}/rest/products/search?q=apple`, null, { tags: { action: 'search', user: userId } }],
  ]);

  for (const response of responses) {
    check(response, {
      'response is successful': (result) => result.status >= 200 && result.status < 400,
    });
  }
  sleep(Math.random() * 2 + 0.5);
}

export function handleSummary(data) {
  const metric = (name) => data.metrics[name]?.values || {};
  const markdown = `# LoadForge-Lab Report

## Scenario

- Target: ${baseUrl}
- Profile: Juice Shop browsing/search

## Results

| Metric | Value |
| --- | --- |
| Requests | ${metric('http_reqs').count || 0} |
| Failed request rate | ${((metric('http_req_failed').rate || 0) * 100).toFixed(2)}% |
| P95 latency | ${(metric('http_req_duration')['p(95)'] || 0).toFixed(2)} ms |
| Checks passed | ${metric('checks').passes || 0} |
| Checks failed | ${metric('checks').fails || 0} |

## Interpretation

Compare the P95 latency and failure rate with the configured thresholds. Treat this result as valid only when the target was owned or explicitly authorized.
`;
  return {
    '/reports/latest-summary.md': markdown,
    stdout: 'LoadForge-Lab scenario finished. See reports/latest-summary.md.\n',
  };
}
