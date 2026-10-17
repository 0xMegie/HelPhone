# Legal Compliance — Band Plan, Radio Redaction, Incident Bundles

## Amateur (Part 97 / ham) bands

- **Encryption is prohibited** on amateur frequencies in most jurisdictions.
  Ham-mode radio traffic stays plaintext.
- **PII is prohibited on-air** by HelPhone policy: ham mode transmits only
  the minimal schema enforced in `src/lib/radio/bandPlan.js`
  (`HAM_WIRE_FIELDS`): triage code, 6-char Maidenhead grid square, severity
  1–3, short id, timestamp, callsigns. Names, phones, notes, addresses and
  full-precision coordinates are structurally redacted before fragmentation
  (`redactForHam` + `assertHamSafe` — enforced by unit tests that fail the
  build on any leak).
- Operators must hold a valid amateur license and identify with their
  callsign (`from` field) per local regulations.

## Licensed (Part 90 / commercial) bands

- Licensed mode encrypts every frame with compact AEAD (AES-256-GCM,
  12-byte IV) via `bandPlan.encryptLicensed` inside the 150-byte MTU budget.
- Session keys are provisioned out-of-band; never on-air, never in
  `localStorage` exports or incident bundles.

## Incident bundles (ISP-130)

- Default tier `volunteer-safe`: secrets + PII scrubbed by
  `scripts/security/env_firewall.js` (`scrubText`), verified with
  `scanForPii` before the archive is written — a single hit fails collection.
- `command-internal` tier requires `--break-glass`, writes an `audit-log.json`
  (actor, time, reason, expiry) into the bundle, and expires in 7 days.
- Bundle access must be recorded in the incident postmortem; expired bundles
  are deleted per retention policy (`docs/disaster-recovery.md`).

## Staging NFC tags

- Tags carry only `stagingId + nonce + HMAC` (`x-helphone/staging` mime) —
  zero PII on the air, per `docs/privacy-policy.md`. Cloned/static tags
  fail HMAC verification and are logged as tamper events.

## Hardware key interception (ISP-131)

- Hardware SOS/PTT interception is opt-in via the `hardwareSos` feature flag
  and consented on first use in the Help page. Handlers are unregistered on
  unmount; media keys outside the PWA scope are never touched.

## Consent & audit logging

- SOS dispatches, staging check-ins and break-glass bundle collections are
  idempotently logged with timestamps for liability audit; free-text notes
  never traverse amateur bands.
