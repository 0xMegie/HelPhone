# Telemetry and event delivery

## Distributed tracing

The backend starts the OpenTelemetry Node SDK before creating the Express app. HTTP and Express auto-instrumentation propagate W3C Trace Context. Requests carrying a valid `traceparent` receive an `x-trace-id` response header, and structured request logs include the same trace ID. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to an OTLP/HTTP collector to export traces; without it, instrumentation and propagation remain enabled but spans are not exported.

The React error boundary creates a W3C trace context for each captured render error and submits only the bounded error message and component stack to `POST /api/telemetry/errors`. The backend logs the trace ID with that report. Do not include wallet secrets, request form contents, or authentication tokens in client telemetry.

## Prometheus

`GET /metrics` uses Prometheus text exposition format. It includes the request counter and duration histogram plus `helphone_soroban_rpc_duration_seconds` and `helphone_zk_proof_duration_seconds`. Labels use route templates or fixed operation names; raw URLs, wallet addresses, and user IDs are never labels. Set `METRICS_BEARER_TOKEN` when the endpoint is reachable from outside a private monitoring network.

## WebSocket event relay

`GET /events/ws` upgrades to WebSocket. The relay supports the request lifecycle topics and responds to a `subscribe` message with an acknowledgement. A validated `tenant` query parameter filters events that include a matching tenant ID; events without a tenant ID are not sent to tenant-filtered clients. Heartbeats remove dead connections, and clients exceeding the bounded send buffer are disconnected.

When `REDIS_URL` is configured, events are published on `helphone:contract-events:v1` and each server process fans them out to its local sockets. A short Redis `SET NX` marker deduplicates event IDs produced by multiple pollers. Without Redis, the relay works within one process only. `node server/tests/ws-cluster.js` opens 1,000 clients across the three URLs supplied in `WS_CLUSTER_URLS` to exercise a deployed cluster.

## Heap forensics in production (#793)

`src/lib/heapForensics.ts` samples per-subsystem proxies every 30 s (clamped
15–60 s, run in `requestIdleCallback`) into a fixed 50-row `Float64Array`
census, so sampling never grows the heap. On pressure (heartbeat stall > 30 s,
JS heap > 85 % of limit, storage > 90 % of quota) or on demand
(`window.__helphone_forceHeapSnapshot()`, or TelemetryLab → **Force forensic
snapshot**) it posts a `helphone.forensics/1` envelope to
`POST /api/telemetry/forensics`. The envelope goes through the worker priority
lane when one is registered, otherwise `sendBeacon`, otherwise keepalive fetch.
The server validates it with zod, rejects anything over 64 KB, and exports
`helphone_forensic_subsystem_bytes{subsystem,ua}`.

Crash path: `ErrorBoundary` sends allocation-shaped errors (`RangeError`
allocation/array length, "out of memory") to `emergencyEmit()`. That sends
only the preallocated census, with no Yjs or Mapbox walks and no full report.

No `--expose-gc`, DevTools protocol or `measureUserAgentSpecificMemory()` is
used. Enabling any of them in production builds is out of scope.

### Measurability matrix

| Signal | Chromium | Firefox | Safari | Kind | Error bound / note |
|---|---|---|---|---|---|
| `jsHeapUsed` / `jsHeapLimit` | ✅ `performance.memory` | ❌ | ❌ | measured | main thread only, engine-bucketed |
| `workerQueueDepth` | ✅ | ✅ | ✅ | measured | from worker heartbeat |
| `workerPendingBytes` | ✅ | ✅ | ✅ | estimate | depth × payload size, ±structured-clone overhead |
| `workerHeartbeatAgeMs` | ✅ | ✅ | ✅ | proxy | death detected ≤ 30 s |
| `yjsBytes` | ✅ | ✅ | ✅ | estimate | `encodeStateAsUpdate` length; excludes undo stack and JS object overhead (real heap ≈ 3–10×) |
| `mapboxTiles` | ✅ | ✅ | ✅ | measured | reads internal `sourceCaches`, so may break on a Mapbox upgrade |
| `mapboxStyleBytes` | ✅ | ✅ | ✅ | estimate | JSON length; GPU textures **unobtainable** |
| `ringBytes` | ✅ | ✅ | ✅ | measured | includes the census itself (`SELF_BYTES`) |
| `wasmBytes` / `wasmGrowEvents` | ✅ | ✅ | ✅ | measured | linear memory sits outside the JS heap |
| `parserAllocBytes` | ✅ | ✅ | ✅ | measured | cumulative copy-in bytes |
| `storageUsage` / `storageQuota` | ✅ | ✅ | ⚠️ coarse | estimate | UA-padded |

Cannot be obtained without native APIs: Mapbox GPU allocations, worker JS heap
size, and per-object retainer paths. Retainer *hints* (largest Yjs maps,
largest tile sources) stand in for them.

Overhead budget: < 1 % main-thread CPU and < 50 KB/day/device at the 30 s
cadence. Routine samples stay local; only pressure or manual envelopes upload,
and those are rate-limited to one per 5 min. Neither number has been measured
on devices yet; that is a follow-up (ISP-125 harness).

## Unified perf budget (#795)

`perf-budget.json` is the single source of truth. It holds the field profile
(Moto G4, Fast 3G, 4× CPU), the end-to-end budget (tap-to-confirm p75 < 2.5 s),
per-link budgets, chunk KB caps, and the shared histogram `le` set. Consumers:
`playwright.config.js` (`field-moto-g4` project), `server/telemetry.js` and
`server/middleware/metrics.ts` (bucket boundaries), and
`scripts/perf-budget.mjs` (the verdict).

```bash
npm run build
npm run perf:budget:client          # throttled Playwright leg → artifacts/perf-budget/client-*.json
npm run perf:budget -- --metrics http://localhost:3001/metrics
npm run perf:budget -- --inject-chunk mapbox=200     # must go red
npm run perf:budget -- --inject-indexer-lag 15       # must go red
```

**Bytes → ms model:** `parseMs ≈ fixedMs + KB × msPerKb` (currently 40 ms +
1.1 ms/KB, ±25 %). These coefficients are placeholders until they are fitted
from five chunk sizes on the field profile. They are device-specific: a Moto G4
fit does not transfer to Tecno/Infinix. Chunk caps are derived from the time
budgets, not the other way round.

**Labelled self-overhead:** `wasm.init`, `telemetry.rum`, `telemetry.export`,
`worker.flush` and `parser.decode` are emitted as `performance.measure`
entries, so traces attribute them. The budget is < 5 % of long-task time.

**Server links:** `helphone_link_duration_seconds{link=ws.queue|pg.pool.wait|redis.publish|parser.decode|indexer.lag}`.
Demo query:

```promql
histogram_quantile(0.95, sum by (le, link) (rate(helphone_link_duration_seconds_bucket[5m])))
```

## Synthetic vs real-user authority (#796)

Both pipes post to `POST /api/telemetry/rum`. Samples are labelled
`source=synthetic|rum`, `route`, `step`, `cohort`, `device`, `network` and use
the shared budget buckets, so the p95s compare directly. Synthetic runs carry
`window.__HELPHONE_SYNTHETIC__ = {runId, commitSha, cohort}`. `runId` and
`commitSha` go to logs only, never to labels. `tests/e2e/rum-map.ts` declares
the field slice each synthetic journey stands in for.

Offline gap: `droppedSamples` and `offlineSeconds` persist in localStorage and
flush as a beacon on reconnect. `rumCoverage()` = received / (received +
dropped). It is a lower bound, because sessions that never reconnect report
nothing.

| Signal state | Action |
|---|---|
| Field RUM p95 over budget (≥ 20 samples) | **page** |
| Synthetic red, RUM green | ticket |
| Synthetic red, route has < 20 RUM samples | **page** (zero-coverage exception) |
| Both green | none |

`GET /api/telemetry/divergence?route=/help&step=tapToConfirm&cohort=default`
returns both p95s, the delta, coverage and the decision. TelemetryLab shows the
same data. Run the old and new paging rules in shadow mode for one on-call
cycle before cutover.

Cardinality: telemetry families are capped at 2 000 series per process.
