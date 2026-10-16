import { currentFlagVersion, evaluateKillSwitch, flagHeaders } from './featureFlags'

const HEX = '0123456789abcdef'

function randomHex(length: number): string {
  const bytes = new Uint8Array(length / 2)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => `${HEX[byte >> 4]}${HEX[byte & 15]}`).join('')
}

export function createTraceparent(): string {
  return `00-${randomHex(32)}-${randomHex(16)}-01`
}

export function reportClientError(error: Error, componentStack?: string): string | null {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return null
  const traceparent = createTraceparent()
  void fetch('/api/telemetry/errors', {
    method: 'POST',
    headers: { 'content-type': 'application/json', traceparent, ...flagHeaders() },
    body: JSON.stringify({
      message: error.message,
      componentStack: componentStack?.slice(0, 2000),
    }),
    keepalive: true,
  }).catch(() => undefined)
  return traceparent.split('-')[1]
}

// ── Self-overhead labelling (#795) ──────────────────────────────────────────
// Telemetry work shows up in traces as anonymous "scripting". Named
// performance.measure entries (prefix `telemetry.`) let the perf-budget
// harness attribute it and hold it under 5 % of scripting time.

export type TelemetryCost = 'telemetry.export' | 'telemetry.rum' | 'wasm.init' | 'worker.flush' | 'parser.decode'

export function measureTelemetry<T>(name: TelemetryCost, fn: () => T): T {
  const start = typeof performance !== 'undefined' ? performance.now() : 0
  try {
    return fn()
  } finally {
    try {
      performance.measure(name, { start, end: performance.now() })
    } catch {}
  }
}

export async function measureTelemetryAsync<T>(name: TelemetryCost, fn: () => Promise<T>): Promise<T> {
  const start = typeof performance !== 'undefined' ? performance.now() : 0
  try {
    return await fn()
  } finally {
    try {
      performance.measure(name, { start, end: performance.now() })
    } catch {}
  }
}

// ── RUM slice dimensions (#796) ─────────────────────────────────────────────
// Every RUM sample carries the same dimensions synthetic runs declare in
// tests/e2e/rum-map.ts, so the server can join the two pipes on
// route × cohort × device class × network class. Values are coarse buckets
// only — never raw UA strings, ids or coordinates.

export type DeviceClass = 'low' | 'mid' | 'high'
export type NetworkClass = 'offline' | 'slow-2g' | '2g' | '3g' | '4g' | 'unknown'

export interface RumDimensions {
  route: string
  cohort: string
  deviceClass: DeviceClass
  networkClass: NetworkClass
  flagVersion: string
  synthetic: boolean
  runId?: string
  commitSha?: string
}

export function deviceClass(): DeviceClass {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }) : undefined
  const mem = nav?.deviceMemory ?? 4
  const cores = nav?.hardwareConcurrency ?? 4
  if (mem <= 2 || cores <= 4) return 'low'
  if (mem <= 4) return 'mid'
  return 'high'
}

export function networkClass(): NetworkClass {
  if (typeof navigator === 'undefined') return 'unknown'
  if (navigator.onLine === false) return 'offline'
  const type = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection?.effectiveType
  return type === 'slow-2g' || type === '2g' || type === '3g' || type === '4g' ? type : 'unknown'
}

/** Route template, not raw path: strips ids so label cardinality stays bounded. */
export function routeTemplate(pathname: string): string {
  return pathname
    .replace(/\/[0-9a-f]{8,}(?=\/|$)/gi, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:n')
    .replace(/\/G[A-Z2-7]{55}(?=\/|$)/g, '/:account')
}

/**
 * Synthetic runs set `window.__HELPHONE_SYNTHETIC__ = { runId, commitSha, cohort }`
 * via Playwright `addInitScript`; field sessions never do.
 */
export function rumDimensions(cohort = 'default'): RumDimensions {
  const w = typeof window !== 'undefined' ? (window as unknown as { __HELPHONE_SYNTHETIC__?: { runId?: string; commitSha?: string; cohort?: string } }) : undefined
  const synth = w?.__HELPHONE_SYNTHETIC__
  return {
    route: routeTemplate(typeof location !== 'undefined' ? location.pathname : '/'),
    cohort: synth?.cohort ?? cohort,
    deviceClass: deviceClass(),
    networkClass: networkClass(),
    flagVersion: currentFlagVersion(),
    synthetic: Boolean(synth),
    runId: synth?.runId,
    commitSha: synth?.commitSha,
  }
}

// Offline-gap evidence, persisted so it survives the reload that usually
// follows a field outage and is flushed as a priority beacon on reconnect.
const GAP_KEY = 'helphone.rumGap'
interface GapState {
  droppedSamples: number
  offlineSeconds: number
  offlineSince: number | null
}

function readGap(): GapState {
  try {
    const raw = localStorage.getItem(GAP_KEY)
    if (raw) return { droppedSamples: 0, offlineSeconds: 0, offlineSince: null, ...JSON.parse(raw) }
  } catch {}
  return { droppedSamples: 0, offlineSeconds: 0, offlineSince: null }
}

function writeGap(g: GapState): void {
  try {
    localStorage.setItem(GAP_KEY, JSON.stringify(g))
  } catch {}
}

export function trackOfflineGap(): () => void {
  if (typeof window === 'undefined') return () => {}
  const goOffline = () => {
    const g = readGap()
    if (g.offlineSince == null) writeGap({ ...g, offlineSince: Date.now() })
  }
  const goOnline = () => {
    const g = readGap()
    if (g.offlineSince != null) g.offlineSeconds += Math.round((Date.now() - g.offlineSince) / 1000)
    g.offlineSince = null
    writeGap(g)
    flushGap()
  }
  window.addEventListener('offline', goOffline)
  window.addEventListener('online', goOnline)
  if (navigator.onLine === false) goOffline()
  else goOnline()
  return () => {
    window.removeEventListener('offline', goOffline)
    window.removeEventListener('online', goOnline)
  }
}

function flushGap(): void {
  const g = readGap()
  if (!g.droppedSamples && !g.offlineSeconds) return
  const sent = beacon('/api/telemetry/rum', { kind: 'gap', dims: rumDimensions(), droppedSamples: g.droppedSamples, offlineSeconds: g.offlineSeconds })
  if (sent) writeGap({ droppedSamples: 0, offlineSeconds: 0, offlineSince: null })
}

function beacon(url: string, body: unknown): boolean {
  try {
    const json = JSON.stringify(body)
    if (navigator.sendBeacon?.(url, new Blob([json], { type: 'application/json' }))) return true
    void fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...flagHeaders() }, body: json, keepalive: true }).catch(() => {})
    return true
  } catch {
    return false
  }
}

/**
 * Reports one RUM timing (seconds) for a named step. Respects the
 * `telemetry.upload` kill-switch; samples taken while offline or killed are
 * counted as dropped so the server can correct for survivorship bias.
 */
export function reportRumTiming(step: string, seconds: number, cohort?: string): void {
  if (!Number.isFinite(seconds) || seconds < 0) return
  const dims = rumDimensions(cohort)
  if (dims.networkClass === 'offline' || !evaluateKillSwitch('telemetry.upload').enabled) {
    const g = readGap()
    writeGap({ ...g, droppedSamples: g.droppedSamples + 1 })
    return
  }
  measureTelemetry('telemetry.rum', () => beacon('/api/telemetry/rum', { kind: 'timing', step, seconds, dims }))
}
