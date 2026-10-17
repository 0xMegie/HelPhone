import { Router } from 'express'
import { LwwElementSet, evaluateConflictWinner } from '../../src/lib/crdt.js'
import type { LwwOperation, VectorClock } from '../../src/lib/crdt.js'

export const localCrdtStore = new LwwElementSet('server-sync', process.env.TENANT || 'local')
export const syncRouter = Router()

syncRouter.post('/', (req, res) => {
  const incoming: LwwOperation[] = Array.isArray(req.body?.operations) ? req.body.operations : []
  for (const op of incoming) {
    if (typeof op?.actor !== 'string' || !Number.isSafeInteger(op?.counter) || op.counter < 1) continue
    localCrdtStore.apply(op)
  }

  const remoteClock: VectorClock = (req.body?.vectorClock as VectorClock) || {}
  const deltas = localCrdtStore.delta(remoteClock)

  res.json({
    operations: deltas.length > 0 ? deltas : localCrdtStore.snapshot().operations,
    vectorClock: localCrdtStore.clock,
  })
})

syncRouter.post('/peer-delta', (req, res) => {
  const peerInstance = req.body?.peerInstance || 'peer'
  const operations: LwwOperation[] = Array.isArray(req.body?.operations) ? req.body.operations : []
  const remoteClock: VectorClock = (req.body?.vectorClock as VectorClock) || {}

  let mergedCount = 0
  for (const op of operations) {
    if (!op || typeof op.actor !== 'string') continue
    const namespacedOp: LwwOperation = {
      ...op,
      instance: op.instance || peerInstance,
      provenance: 'peer_asserted',
    }
    if (localCrdtStore.apply(namespacedOp)) {
      mergedCount++
    }
  }

  const responseDeltas = localCrdtStore.delta(remoteClock)

  res.json({
    success: true,
    mergedCount,
    deltas: responseDeltas,
    vectorClock: localCrdtStore.clock,
  })
})
