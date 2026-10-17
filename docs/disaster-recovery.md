# Disaster Recovery & Soroban State Backup Runbook

## Overview

HelPhone utilizes an automated Soroban storage state backup system to safeguard contract state data. Contract storage entries (instance, persistent, and temporary) are inspected, parsed, and dumped into versioned JSON snapshot files indexed by Stellar ledger sequence numbers.

---

## Technical Architecture

```
+---------------------------+       +---------------------------+
|  Soroban RPC / Node       | ----> | export-contract-state.sh  |
|  (stellar contract inspect|       |   (CLI & RPC Exporter)    |
+---------------------------+       +---------------------------+
              |                                   |
              v                                   v
+---------------------------+       +---------------------------+
| server/indexer/exporter.ts | ----> |  JSON Snapshot Storage    |
|   (Daily Backup Cron)     |       | ./snapshots/snapshot-*.json|
+---------------------------+       +---------------------------+
```

---

## Storage Snapshot Format

Snapshots are exported in structured JSON format with complete ledger indexing:

```json
{
  "ledgerSequence": 123456,
  "contractId": "CC325F37QW7N2F5M3QGHL4A4O7J2K9L0M1N2O3P4Q5R6S7T8U9V0",
  "timestamp": "2026-09-24T16:00:00.000Z",
  "entries": [
    {
      "key": "CONTRACT_ADMIN",
      "val": { "address": "CC325F37QW7N2F5M3QGHL4A4O7J2K9L0M1N2O3P4Q5R6S7T8U9V0" },
      "durability": "persistent",
      "lastModifiedLedgerSeq": 123450
    }
  ],
  "metadata": {
    "exporterVersion": "1.0.0",
    "totalEntries": 1,
    "networkPassphrase": "Test SDF Network ; September 2015",
    "rpcUrl": "https://soroban-testnet.stellar.org"
  }
}
```

---

## Executing Manual Backups

Run the state exporter shell script:

```bash
# Export using default contract ID and testnet RPC
bash scripts/export-contract-state.sh

# Export with explicit environment variables
CONTRACT_ID="C..." SOROBAN_RPC_URL="https://soroban-testnet.stellar.org" bash scripts/export-contract-state.sh
```

---

## Server Automated Daily Backup Cron

The backend server (`server/index.ts`) initializes an automated daily cron task on startup.
- **Interval**: 24 hours (86,400,000 ms)
- **Output Directory**: `./snapshots/`
- **REST Endpoint**:
  - `POST /api/state/export` - Trigger state dump on demand
  - `GET /api/state/snapshots/latest` - Fetch the latest state snapshot

---

## Disaster Recovery & State Restoration

In case of network partition, state corruption, or redeployment:

1. **Locate Latest Snapshot**:
   ```bash
   ls -la snapshots/snapshot-*.json | sort | tail -n 1
   ```

2. **Verify Snapshot Integrity**:
   Run tests or use `verifySnapshotIntegrity()` helper:
   ```bash
   npm test test/state-export.test.js
   ```

3. **Restore Contract State**:
   Execute Stellar CLI contract restore/invoke commands using snapshot entry payloads:
   ```bash
   stellar contract invoke --id <CONTRACT_ID> --source <ADMIN_KEY> -- restore_state --snapshot-file snapshots/snapshot-123456.json
   ```

## Kill-switch runbook (#797)

Kill-switches are versioned. Every flip bumps the global flag version.

```bash
curl -X POST https://<host>/api/flags \
  -H "Authorization: Bearer $FLAGS_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"kills":{"soroban.submit":false}}'
```

How a kill propagates:

1. **Server enforcement (immediate, all cohorts):** routes guarded by
   `enforceKillSwitch(key)` return `503 kill_switch_active`. A request stamped
   with an older `x-helphone-flag-version` than the kill gets
   `409 quarantined`. It is held for review, not executed. Guarded today:
   `telemetry.upload` → `/api/telemetry/rum` and `/api/telemetry/forensics`;
   `soroban.submit` → `/api/soroban/footprint/inspect`. Transactions already
   on-ledger cannot be undone. Attribute them through the flag version
   recorded with each envelope.
2. **WS push (foreground, online):** a Redis `helphone:flags:v1` message
   becomes a `flags.patch` frame on `/events/ws`.
3. **Poll fallback:** `GET /api/flags` every 15 s with exponential backoff up
   to 5 min. It runs in background tabs and re-polls on `online` and
   visibility change.
4. **Tabs and workers:** the `helphone-flags` BroadcastChannel. Every worker
   in `src/workers/*` reads the shared snapshot directly, so it never waits on
   the main thread.

Offline semantics (`KILL_SWITCH_POLICIES` in `src/lib/featureFlags.ts`):

| Switch | TTL (fresh) | Max stale | When expired |
|---|---|---|---|
| `telemetry.upload` | 60 s | 24 h | fail closed |
| `soroban.submit` | 60 s | 5 min | **fail open**: blocking a rescue is worse; the server still enforces |
| `yjs.sync` | 60 s | 1 h | fail open |
| `mapbox.highres` | 60 s | 1 h | fail closed |
| `debug.verboseLogs` | 0 | 0 | fail closed (no flag can enable raw-PII logging) |

Unknown flags: old clients ignore them. Experiments default open, and a
known kill set to `false` wins.

Crash recovery: drafts store their `flagVersion`. `checkReplay(draft)` refuses
to resubmit a draft composed before a kill to a killed path, and the UI should
show "blocked by kill-switch".

Verify containment with `helphone_flag_version_reports_total{version,cohort}`
and `helphone_flag_time_to_effect_seconds`. Propagation p50/p95 per cohort
(foreground, background, intermittent, offline) still has to be measured in
the mixed-cohort Playwright drill. Until that is done, assume offline devices
adopt a kill only on reconnect, and rely on server enforcement.
