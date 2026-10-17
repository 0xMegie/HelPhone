# Storage Optimization: Bounded Ring Buffer (#531)

## Problem

A wallet's expert verification history was append-only: `("ev", wallet, idx)` grew forever and each entry kept costing rent. Nothing bounded it.

## Design

`contract/contracts/helphone-contract/src/ring_buffer.rs` caps a per-owner history at `CAPACITY = 500` entries.

```
("evcount", wallet)             -> u32   total pushes ever (the write cursor)
("ev", wallet, index % 500)     -> value slot
```

`index` only ever grows. The readable window is `oldest ..= total - 1`, with `oldest = max(total - 500, 0)`. A push writes to `index % 500`; once the buffer is full that slot holds the oldest entry (`index - 500`), so the module reads it first and returns it as `evicted`. `lib.rs` turns that into an `Evicted` event.

Every entry point is O(1): one counter read, at most one slot read, one slot write, one counter write.

## Compatibility

While fewer than 500 entries exist, `slot == index`, so the keys are identical to the old unbounded layout. Existing histories read back unchanged and need no migration (covered by `history_written_before_the_ring_buffer_still_reads_back`). `record_expert_verification` still returns the count after the push.

Behaviour that changed: a wallet with more than 500 lifetime entries can no longer read the oldest ones. `get_expert_verifications(wallet, limit)` now caps by *retained* entries, not the lifetime total.

## Rent

Each push extends the TTL of the slot it wrote and of the counter to about 90 days once they fall under about 30 days. Because the buffer is bounded, so is the rent. Slots not rewritten recently can lapse independently; persistent entries are archived, not deleted, and can be restored.

Per-invocation write limits also apply on the network (50 ledger entries per invocation); a record touches 2, and the ring buffer never writes more.

## Events

```
topics: ["evicted", <wallet>]
data:   { index: u32, record: ExpertVerification }
```

Emitted only when a push displaces an entry. Indexers should archive `record` from this event, since it is no longer readable on chain afterwards.

## Client

`getExpertVerificationWindow(wallet)` in `src/lib/contract.ts` returns `{ total, capacity, oldest, retained, evicted }`. `src/lib/ringBuffer.ts` has the pure helpers (`verificationWindow`, `isRetained`, `recentIndexes`) so a UI pages within `[oldest, total)` and never asks for an evicted slot.

## Tests

- Rust (`ring_buffer.rs`, `test.rs`): fill to capacity with no eviction or event; the 501st entry evicts index 0 and emits the exact event; strict FIFO across more than two wraps; per-wallet isolation; legacy layout; TTL extension; listing capped by retained entries.
- JS (`test/ring-buffer.test.js`): window math, retention checks, recent-index paging, and the contract wrapper with only the RPC faked.
