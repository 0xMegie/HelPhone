# Disaster Recovery — Incident Bundle Runbook

## Single command

During an incident, collect logs + config + build provenance into one
manifest-led archive:

```bash
npm run bundle -- collect --since 2h --tier volunteer-safe --out incident-bundle.tgz
```

Options:

| Flag                                    | Meaning                                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| `--since 2h`                            | Collection window (`30m`, `2h`, `1d`, …). Only recent log lines are sliced.        |
| `--log-file <path>`                     | Morgan/structured log file to slice (`server-logs/slice.txt`).                     |
| `--dispatch`                            | Marks the bundle as produced during an active dispatch.                            |
| `--tier volunteer-safe`                 | Default. Secrets **and** PII scrubbed — safe to share with volunteers.             |
| `--tier command-internal --break-glass` | Full-fidelity PII (secrets still redacted). Writes `audit-log.json`, 7-day expiry. |
| `--out <file.tgz>`                      | Output path.                                                                       |

Verify a bundle's integrity (per-file SHA-256 vs `manifest.json`):

```bash
npm run bundle:verify -- incident-bundle.tgz
```

Scan any artifact for secrets/PII before sharing:

```bash
node scripts/security/env_firewall.js --scan some-log.txt
```

## What's inside

- `manifest.json` — collector identity, collection window, git commit/branch,
  feature-flag versions, per-file sha256 + redaction version + source,
  expiry date.
- `server-logs/` — time-sliced, scrubbed log output.
- `config/` — env allowlist (`VITE_*` only), feature-flag snapshot, build
  defines (COOP/COEP, PWA display/scope).
- `build/` — SBOM: `package-lock.json` / `package.json` hashes, `dist/assets`
  chunk hashes (when built), WASM hashes (when present), container digest
  from `CONTAINER_DIGEST`/`IMAGE_DIGEST`.
- `ledger/`, `metrics/`, `client/` — populated when the corresponding
  artifacts/scripts exist in the checkout.

## Retention

Every manifest carries `expiresAt` (volunteer-safe: 30 days,
command-internal: 7 days). Delete expired bundles per ISP-128 retention.
Break-glass access is recorded in `audit-log.json` inside the bundle and
must be reconciled against `docs/legal-compliance.md` audit requirements.

## Escalation order

1. `collect --tier volunteer-safe` — share with responders/volunteers.
2. If PII forensics are required: `collect --tier command-internal
--break-glass`, log the justification, share only through approved
   channels.
3. Always `verify` any bundle before trusting it in a postmortem.
