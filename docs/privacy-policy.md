# Privacy Policy — Field Data Handling

_Last updated: field-ops release (radio/NFC/SOS)._

## What we collect

- Emergency requests: location (coarsened on-chain via ZK zone proofs),
  emergency type, optional nickname/contact you type yourself.
- Staging check-ins: responder ID (wallet or session pseudonym), staging
  area ID, direction (IN/OUT), timestamp.
- Radio traffic: depends on band plan (see below).

## Radio band plan and PII

- **Ham mode**: no PII ever leaves the device. Names, phone numbers,
  addresses, free-text notes and exact coordinates are stripped by
  `src/lib/radio/bandPlan.js` before the first frame is built. Only a
  triage code, a ~0.5 km grid square, severity, short id and timestamp are
  transmitted in the clear, as required by amateur-band law.
- **Licensed mode**: the full intent is encrypted (AES-256-GCM) before
  transmit. Keys are provisioned by the operator and never stored in
  bundles or exports.

## Staging NFC tags

Posted tags hold **only** a staging-area ID, a rotating nonce and an HMAC.
No personal data is written to or read from the tag itself.

## Offline queue & device storage

Queued intents (requests, staging check-ins, SOS) persist in local storage
on your device until a transport (internet or radio) delivers them. You can
clear them by clearing site data. Queued payloads follow the same band-plan
redaction rules before radio transmit.

## Incident bundles

Bundles shared with volunteers are scrubbed of secrets **and** PII (phones,
emails, full-precision coordinates, free-text notes) by default
(`volunteer-safe` tier). Full-fidelity forensic bundles require
break-glass authorization and expire automatically.

## Your rights

Request export or deletion of stored incident data through the response
organization operating the HelPhone instance you used.
