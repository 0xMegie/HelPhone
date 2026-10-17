import { currentFlagVersion, evaluateKillSwitch, flagHeaders } from './featureFlags'

const HEX = '0123456789abcdef'
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

function randomHex(length: number): string {
  const bytes = new Uint8Array(length / 2)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => `${HEX[byte >> 4]}${HEX[byte & 15]}`).join('')
}

export function createTraceparent(): string {
  return `00-${randomHex(32)}-${randomHex(16)}-01`
}

export function parseTraceparent(value: unknown): { traceId: string; spanId: string; flags: string } | null {
  if (typeof value !== 'string') return null
  const match = value.trim().toLowerCase().match(TRACEPARENT_RE)
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return null
  return { traceId: match[1], spanId: match[2], flags: match[3] }
}

/** Same trace, new span: what each hop sends onward (#791). */
export function childTraceparent(parent?: string | null): string {
  const ctx = parseTraceparent(parent)
  return ctx ? `00-${ctx.traceId}-${randomHex(16)}-${ctx.flags}` : createTraceparent()
}

/**
 * Trace of the dispatch currently in flight. Set when a dispatch starts
 * (tap) so every later request, worker message and crash dump shares one
 * traceId instead of each starting an orphan trace.
 */
let activeTraceparent: string | null = null

export function beginDispatchTrace(): string {
  activeTraceparent = createTraceparent()
  return activeTraceparent
}

export function endDispatchTrace(): void {
  activeTraceparent = null
}

export function getActiveTraceparent(): string | null {
  return activeTraceparent
}

/** Headers for fetch/WS upgrade calls inside the active dispatch trace. */
export function traceHeaders(): Record<string, string> {
  return activeTraceparent ? { traceparent: childTraceparent(activeTraceparent) } : {}
}

export const TRACE_ENVELOPE_VERSION = 1

/**
 * postMessage structured-clone drops OTel Context, so context crosses the
 * worker boundary as plain fields. Readers ignore unknown versions and treat
 * a missing envelope as "no context" (old workers keep working).
 */
export function wrapForWorker<T extends object>(payload: T, traceparent = activeTraceparent) {
  return traceparent
    ? { ...payload, __traceVersion: TRACE_ENVELOPE_VERSION, __traceparent: childTraceparent(traceparent) }
    : payload
}

export function unwrapFromWorker(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null
  const m = message as { __traceVersion?: number; __traceparent?: string }
  return m.__traceVersion === TRACE_ENVELOPE_VERSION && parseTraceparent(m.__traceparent) ? m.__traceparent! : null
}

/** traceId/spanId to persist alongside crash-recovery payloads. */
export function currentTraceIds(): { traceId: string; spanId: string } | null {
  const ctx = parseTraceparent(activeTraceparent)
  return ctx ? { traceId: ctx.traceId, spanId: ctx.spanId } : null
}

export function reportClientError(error: Error, componentStack?: string): string | null {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return null
  const traceparent = activeTraceparent ? childTraceparent(activeTraceparent) : createTraceparent()
  void fetch('/api/telemetry/errors', {
    method: 'POST',
    headers: { 'content-type': 'application/json', traceparent, ...flagHeaders() },
    body: JSON.stringify({
      message: error.message,
      componentStack: componentStack?.slice(0, 2000),
      // Event time on the client clock; the server records ingest time separately (#794).
      clientTs: Date.now(),
    }),
    keepalive: true,
  }).catch(() => undefined)
  return traceparent.split('-')[1]
}

/**
 * Clock-sync beacon (#794): best-of-N Cristian estimate of
 * serverTime - clientTime against GET /api/time.
 */
export async function estimateClockOffset(samples = 5): Promise<{ offsetMs: number; confidenceMs: number } | null> {
  let best: { offsetMs: number; confidenceMs: number } | null = null
  for (let i = 0; i < samples; i++) {
    try {
      const t0 = Date.now()
      const res = await fetch('/api/time', { cache: 'no-store' })
      const t1 = Date.now()
      const { tServer } = await res.json()
      if (!Number.isFinite(tServer)) continue
      const confidenceMs = Math.ceil((t1 - t0) / 2)
      if (!best || confidenceMs < best.confidenceMs) {
        best = { offsetMs: Math.round(tServer - (t0 + t1) / 2), confidenceMs }
      }
    } catch {
      // offline: no estimate is better than a wrong one
    }
  }
  return best
}
