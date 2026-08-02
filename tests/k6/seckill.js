import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import { Counter } from 'k6/metrics';

const baseUrl = (__ENV.BASE_URL || 'http://host.docker.internal:18080').replace(/\/$/, '');
const jwtSecret = __ENV.JWT_SECRET;
const profileName = __ENV.SECKILL_PROFILE || 'burst';
const runId = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const acceptedOrders = new Counter('seckill_accepted_orders');
const soldOutOrders = new Counter('seckill_sold_out_orders');
const throttledOrders = new Counter('seckill_throttled_orders');

const profiles = {
  smoke: [
    { duration: '10s', target: 2 },
    { duration: '20s', target: 2 },
    { duration: '10s', target: 0 },
  ],
  burst: [
    { duration: '15s', target: 50 },
    { duration: '30s', target: 200 },
    { duration: '30s', target: 0 },
  ],
  stress: [
    { duration: '20s', target: 75 },
    { duration: '30s', target: 300 },
    { duration: '60s', target: 300 },
    { duration: '20s', target: 0 },
  ],
};

if (!jwtSecret) {
  throw new Error('JWT_SECRET is required for the seckill test.');
}
if (!profiles[profileName]) {
  throw new Error(`Unknown SECKILL_PROFILE "${profileName}". Choose smoke, burst, or stress.`);
}

export const options = {
  scenarios: {
    buyers: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: profiles[profileName],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1500'],
    seckill_accepted_orders: ['count>0'],
  },
};

function tokenFor(userId) {
  const encode = (value) => encoding.b64encode(JSON.stringify(value), 'rawurl');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ sub: String(userId), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
  const signature = encoding.b64encode(crypto.hmac('sha256', jwtSecret, `${header}.${payload}`, 'binary'), 'rawurl');
  return `${header}.${payload}.${signature}`;
}

export function setup() {
  const response = http.get(`${baseUrl}/api/user/ping`, { tags: { action: 'health' } });
  if (response.status !== 200) {
    fail(`Gateway health check failed: GET ${baseUrl}/api/user/ping returned ${response.status}.`);
  }
}

export default function () {
  const userId = 100000 + __VU;
  const response = http.post(
    `${baseUrl}/api/product/seckill`,
    JSON.stringify({ userId, productId: 1 }),
    {
      headers: {
        Authorization: `Bearer ${tokenFor(userId)}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `${runId}-${__VU}-${__ITER}`,
      },
      responseCallback: http.expectedStatuses(200, 400, 429),
      tags: { action: 'seckill' },
    },
  );

  if (response.status === 200) acceptedOrders.add(1);
  if (response.status === 400) soldOutOrders.add(1);
  if (response.status === 429) throttledOrders.add(1);

  check(response, {
    'order accepted, sold out, or rate limited': (result) => [200, 400, 429].includes(result.status),
    'no server error': (result) => result.status < 500,
  });
  sleep(Math.random() * 0.4 + 0.1);
}

export function handleSummary(data) {
  const metric = (name) => data.metrics[name]?.values || {};
  const markdown = `# Seckill Load Test Report

## Scenario

- Target: ${baseUrl}
- Profile: ${profileName}
- Peak VUs: ${{ smoke: 2, burst: 200, stress: 300 }[profileName]}

## Results

| Metric | Value |
| --- | ---: |
| Accepted orders | ${metric('seckill_accepted_orders').count || 0} |
| Sold out responses | ${metric('seckill_sold_out_orders').count || 0} |
| Rate-limited responses | ${metric('seckill_throttled_orders').count || 0} |
| Failed request rate | ${((metric('http_req_failed').rate || 0) * 100).toFixed(2)}% |
| P95 latency | ${(metric('http_req_duration')['p(95)'] || 0).toFixed(2)} ms |

HTTP 400 denotes expected inventory depletion. HTTP 429 denotes gateway protection; 5xx responses are test failures.
`;
  return {
    '/reports/seckill-latest-summary.md': markdown,
    stdout: 'Seckill load test finished. See reports/seckill-latest-summary.md.\n',
  };
}
