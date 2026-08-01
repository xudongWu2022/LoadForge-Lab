# LoadForge-Lab

An authorized Web/API load-testing lab: reproducible local targets, realistic k6 traffic profiles, and report artifacts.

## Safety boundary

Run LoadForge-Lab only against infrastructure you own or have explicit written permission to test. A CTF, a bug-bounty scope, or a deliberately vulnerable app does **not** automatically grant permission for denial-of-service or high-volume load testing. The included target runs locally in Docker so the test environment is entirely under your control.

## What is included

- **OWASP Juice Shop** as a local e-commerce target.
- **k6** traffic that ramps up, bursts, holds steady, then ramps down.
- **Mixed user behaviour**: product browsing and product search with independent virtual users.
- **Reports**: k6 JSON output plus a Markdown summary for each run.

## Quick start

```powershell
docker compose up -d juice-shop
docker compose --profile load-test run --rm k6
```

Open the local target at `http://localhost:3000`. Test output is written to `reports/`.

## Test profile

The default scenario is deliberately modest:

1. Warm up from 0 to 10 virtual users.
2. Burst to 50 virtual users.
3. Hold at 25 virtual users.
4. Ramp back to 0.

Increase these values only after observing CPU, memory, latency, and error rates. Override the target only for an authorized environment:

```powershell
docker compose --profile load-test run --rm -e BASE_URL=http://your-authorized-target k6
```

## Terminology

- **Virtual user (VU)**: one simulated independent browser/user.
- **Ramp**: gradually increase or decrease active VUs.
- **Burst**: a short sharp traffic increase, similar to a sale opening.
- **P95 latency**: the response time that 95% of requests meet or beat.

## Roadmap

- Authenticated API adapters with generated test users.
- Flash-sale/order consistency validation for self-hosted targets.
- Prometheus/Grafana dashboards.
- Multi-runner orchestration for environments you control.
