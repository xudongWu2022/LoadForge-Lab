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

The default `moderate` scenario is deliberately modest:

1. Warm up from 0 to 10 virtual users.
2. Burst to 50 virtual users.
3. Hold at 25 virtual users.
4. Ramp back to 0.

Increase these values only after observing CPU, memory, latency, and error rates. Override the target only for an authorized environment:

```powershell
docker compose --profile load-test run --rm -e BASE_URL=http://your-authorized-target k6
```

## Seckill throughput test

The `tests/k6/seckill.js` adapter tests the self-hosted SecKill project. Its `throughput` profile uses a fixed arrival rate (500, then 1,000, then 1,500 orders/second) rather than a variable VU-driven rate. It refuses to run until the product database holds at least 250,000 units, then preloads Redis before testing.

Run the monitor before starting k6 so Kafka lag and order growth are recorded every five seconds:

```powershell
pwsh tools/monitor-seckill.ps1 -DurationSeconds 330
```

Then run the k6 adapter with `SECKILL_PROFILE=throughput`, `JWT_SECRET`, and an authorized `BASE_URL`. A result is sustainable only if consumer lag stops growing and returns to zero after traffic stops.

## Prometheus, Grafana, and distributed k6

The SecKill Compose stack now exposes Prometheus at `http://localhost:9090` and Grafana at `http://localhost:3001` (the default login is `admin` / `admin-change-me`; change it in `.env`). The provisioned **Seckill Load Test Overview** dashboard correlates:

- gateway request rate and P95 latency;
- JVM heap use and GC pause time for every Spring service;
- Kafka consumer-group lag;
- MySQL query rate and connected sessions.

This makes a P95 regression diagnosable: rising GC pause points to heap/allocation pressure; rising lag with low database query rate points to consumers; saturated MySQL connections or reduced query rate points to the database.

For a local multi-runner k6 test, first do the normal preflight/preload once, then launch three non-overlapping execution segments. Each writes its own aggregate summary JSON and Markdown report, rather than multi-gigabyte per-request JSON streams, so the generator's disk I/O does not distort the target measurement:

```powershell
# From SecKill-Project: start the target and observability stack.
docker compose up -d

# From LoadForge-Lab: run one normal smoke/preload pass, then the three segments.
docker run --rm --network sekill_default -e BASE_URL=http://gateway-service:8080 -e JWT_SECRET=$env:JWT_SECRET -e SECKILL_PROFILE=smoke -v "${PWD}/tests/k6:/scripts:ro" grafana/k6:0.54.0 run /scripts/seckill.js
docker compose -f docker-compose.seckill.yml --profile distributed-seckill up --abort-on-container-exit
```

Set `JWT_SECRET` in the shell running the second command too (or put it in a local uncommitted `.env`). The built-in three-runner setup removes the single k6 process as the first bottleneck; for larger tests, run the same execution segments on separate authorized worker hosts or Kubernetes nodes.

### Start with a smoke test

Before every new target or environment, use the small `smoke` profile. It ramps to two VUs, holds briefly, and produces the same report artifacts:

```powershell
docker compose --profile load-test run --rm -e LOAD_PROFILE=smoke k6
```

The test waits up to 24 seconds for the target to pass its preflight check before it starts. If the target remains unavailable or returns an error, k6 stops instead of applying traffic. Supported values for `LOAD_PROFILE` are `smoke`, `moderate`, and `stress`; an unsupported value fails immediately.

### Apply higher pressure deliberately

For an owned local target that has already passed a smoke and moderate run, use the `stress` profile:

```powershell
docker compose --profile load-test run --rm -e LOAD_PROFILE=stress k6
```

It ramps to 200 VUs, then holds 125 VUs for three minutes before ramping down. Observe host CPU, memory, and container health while it runs; do not use this profile outside infrastructure you own or are explicitly authorized to test.

## Reports

Each run replaces these local artifacts in `reports/`:

- `latest.json` — raw k6 metrics for later analysis.
- `latest-summary.md` — a concise run summary, including request volume, failure rate, and P95 latency.

The test labels requests only by endpoint action (`browse`, `search`, or `preflight`), rather than by virtual-user ID. This keeps metrics aggregation usable at higher VU counts.

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
