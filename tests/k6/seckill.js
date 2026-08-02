import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import { Counter } from 'k6/metrics';

const baseUrl = (__ENV.BASE_URL || 'http://host.docker.internal:18080').replace(/\/$/, '');
const jwtSecret = __ENV.JWT_SECRET;
const profileName = __ENV.SECKILL_PROFILE || 'burst';
const runId = __ENV.K6_RUN_ID || `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const acceptedOrders = new Counter('seckill_accepted_orders');
const soldOutOrders = new Counter('seckill_sold_out_orders');
const throttledOrders = new Counter('seckill_throttled_orders');

const profiles = {
  smoke: {
    label: '2 VU smoke test',
    minimumStock: 1,
    minimumAcceptedOrders: 1,
    scenario: {
      executor: 'ramping-vus', startVUs: 0,
      stages: [{ duration: '10s', target: 2 }, { duration: '20s', target: 2 }, { duration: '10s', target: 0 }],
      gracefulRampDown: '10s',
    },
  },
  burst: {
    label: '200 VU burst',
    minimumStock: 1,
    minimumAcceptedOrders: 1,
    scenario: {
      executor: 'ramping-vus', startVUs: 0,
      stages: [{ duration: '15s', target: 50 }, { duration: '30s', target: 200 }, { duration: '30s', target: 0 }],
      gracefulRampDown: '10s',
    },
  },
  stress: {
    label: '300 VU sustained stress',
    minimumStock: 1,
    minimumAcceptedOrders: 1,
    scenario: {
      executor: 'ramping-vus', startVUs: 0,
      stages: [{ duration: '20s', target: 75 }, { duration: '30s', target: 300 }, { duration: '60s', target: 300 }, { duration: '20s', target: 0 }],
      gracefulRampDown: '10s',
    },
  },
  throughput: {
    label: 'fixed-rate end-to-end throughput',
    minimumStock: 250000,
    minimumAcceptedOrders: 200000,
    scenario: {
      executor: 'ramping-arrival-rate',
      startRate: 100,
      timeUnit: '1s',
      preAllocatedVUs: 600,
      maxVUs: 2000,
      stages: [
        { duration: '30s', target: 500 },
        { duration: '120s', target: 1000 },
        { duration: '120s', target: 1500 },
        { duration: '30s', target: 0 },
      ],
    },
  },
};

if (!jwtSecret) throw new Error('JWT_SECRET is required for the seckill test.');
if (!profiles[profileName]) throw new Error(`Unknown SECKILL_PROFILE "${profileName}".`);

const profile = profiles[profileName];
const minimumStock = Number(__ENV.MINIMUM_STOCK || profile.minimumStock);
const minimumAcceptedOrders = Number(__ENV.MINIMUM_ACCEPTED_ORDERS || profile.minimumAcceptedOrders);

export const options = {
  scenarios: { buyers: profile.scenario },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1500'],
    seckill_accepted_orders: [`count>${minimumAcceptedOrders}`],
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
  const adminHeaders = { Authorization: `Bearer ${tokenFor(999999)}` };
  const health = http.get(`${baseUrl}/api/user/ping`, { tags: { action: 'health' } });
  if (health.status !== 200) fail(`Gateway health check failed with ${health.status}.`);

  const product = http.get(`${baseUrl}/api/product/1`, { headers: adminHeaders, tags: { action: 'stock-preflight' } });
  if (product.status !== 200) fail(`Product preflight failed with ${product.status}.`);
  const stock = JSON.parse(product.body).stock;
  if (stock < minimumStock) fail(`Database stock is ${stock}; this profile requires at least ${minimumStock}.`);

  if (__ENV.SKIP_PRELOAD !== 'true') {
    const preload = http.post(`${baseUrl}/api/product/preload`, null, { headers: adminHeaders, tags: { action: 'preload' } });
    if (preload.status !== 200) fail(`Redis preload failed with ${preload.status}.`);
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
  sleep(profileName === 'throughput' ? 0.05 : Math.random() * 0.4 + 0.1);
}

export function handleSummary(data) {
  const metric = (name) => data.metrics[name]?.values || {};
  const markdown = `# Seckill Load Test Report

## Scenario

- Target: ${baseUrl}
- Profile: ${profile.label}
- Required database stock: ${minimumStock}
- Required accepted orders: ${minimumAcceptedOrders}

## Results

| Metric | Value |
| --- | ---: |
| Requests | ${metric('http_reqs').count || 0} |
| Accepted orders | ${metric('seckill_accepted_orders').count || 0} |
| Sold out responses | ${metric('seckill_sold_out_orders').count || 0} |
| Rate-limited responses | ${metric('seckill_throttled_orders').count || 0} |
| Failed request rate | ${((metric('http_req_failed').rate || 0) * 100).toFixed(2)}% |
| P95 latency | ${(metric('http_req_duration')['p(95)'] || 0).toFixed(2)} ms |

The matching CSV monitor output is required to judge Kafka lag and end-to-end sustainability.
`;
  const summaryFile = __ENV.K6_SUMMARY_FILE || 'seckill-latest-summary.md';
  return { [`/reports/${summaryFile}`]: markdown, stdout: `Seckill load test finished. See reports/${summaryFile}.\n` };
}
