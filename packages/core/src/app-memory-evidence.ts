import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

export const APP_MEMORY_EVIDENCE_INTERVAL_MS = 30_000
export const APP_MEMORY_EVIDENCE_MAX_SEGMENTS = 8
export const APP_MEMORY_EVIDENCE_MAX_PROCESSES = 16

/** rssKib stores Electron workingSetSize in KiB, not an independent RSS/footprint reading. */
export type AppMemoryProcess = { pid: number; creationTime: number; type: string; rssKib: number }
export type AppMemoryPeak = { observedAt: number; rssKib: number; processCount: number;
  processes: AppMemoryProcess[]; omittedProcesses: number }
export type AppMemorySegment = { main: { pid: number; creationTime: number }; firstObservedAt: number;
  lastObservedAt: number; sampleCount: number; peak: AppMemoryPeak;
  largestProcess: AppMemoryProcess & { observedAt: number } }
export type AppMemoryArchive = { schema: 'agentmux.app-memory-evidence.v1'; segments: AppMemorySegment[] }
export type AppMemoryEvidence = AppMemoryArchive & { intervalMs: typeof APP_MEMORY_EVIDENCE_INTERVAL_MS;
  sampling: { state: 'available' | 'unavailable'; reason: string | null };
  persistence: { state: 'confirmed' | 'pending' | 'unconfirmed'; reason: string | null; coalescedWrites: number } }

function invalid(): never { throw new AgentMuxError('App memory evidence is invalid.', 'CONTROL_PROTOCOL_ERROR') }
function fields(value: unknown, keys: string[]): Record<string, unknown> {
  const result = rpcRecord(value, keys, 'CONTROL_PROTOCOL_ERROR')
  if (Object.keys(result).length !== keys.length) invalid()
  return result
}
function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function positive(value: unknown): value is number { return count(value) && value > 0 }
function creation(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0 }
function process(value: unknown): AppMemoryProcess {
  const record = fields(value, ['pid', 'creationTime', 'type', 'rssKib'])
  if (!positive(record.pid) || !creation(record.creationTime) || typeof record.type !== 'string' ||
    !record.type || record.type.length > 64 || !count(record.rssKib)) invalid()
  return record as AppMemoryProcess
}
function segments(value: unknown): AppMemorySegment[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > APP_MEMORY_EVIDENCE_MAX_SEGMENTS || Reflect.ownKeys(value).length !== value.length + 1) invalid()
  const seen = new Set<string>()
  let previous = -1
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !('value' in descriptor)) invalid()
    const segment = fields(descriptor.value, ['main', 'firstObservedAt', 'lastObservedAt', 'sampleCount', 'peak', 'largestProcess'])
    const main = fields(segment.main, ['pid', 'creationTime'])
    const peak = fields(segment.peak, ['observedAt', 'rssKib', 'processCount', 'processes', 'omittedProcesses'])
    const largest = fields(segment.largestProcess, ['pid', 'creationTime', 'type', 'rssKib', 'observedAt'])
    process({ pid: largest.pid, creationTime: largest.creationTime, type: largest.type, rssKib: largest.rssKib })
    if (!positive(main.pid) || !creation(main.creationTime) || !count(segment.firstObservedAt) ||
      !count(segment.lastObservedAt) || segment.lastObservedAt < segment.firstObservedAt ||
      !positive(segment.sampleCount) || !count(peak.observedAt) || peak.observedAt < segment.firstObservedAt ||
      peak.observedAt > segment.lastObservedAt || !count(peak.rssKib) || !positive(peak.processCount) ||
      !Array.isArray(peak.processes) || Object.getPrototypeOf(peak.processes) !== Array.prototype ||
      Reflect.ownKeys(peak.processes).length !== peak.processes.length + 1 ||
      peak.processes.length > APP_MEMORY_EVIDENCE_MAX_PROCESSES ||
      !count(peak.omittedProcesses) || peak.processes.length + peak.omittedProcesses !== peak.processCount ||
      !count(largest.observedAt) || largest.observedAt < segment.firstObservedAt || largest.observedAt > segment.lastObservedAt ||
      segment.firstObservedAt < previous) invalid()
    const key = `${main.pid}:${main.creationTime}`
    if (seen.has(key)) invalid()
    seen.add(key); previous = segment.firstObservedAt as number
    const processes = Array.from({ length: peak.processes.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(peak.processes, String(index))
      if (!descriptor?.enumerable || !('value' in descriptor)) invalid()
      return process(descriptor.value)
    })
    if (processes.reduce((sum, item) => sum + item.rssKib, 0) > (peak.rssKib as number) ||
      (largest.rssKib as number) > (peak.rssKib as number) ||
      processes.some(item => item.rssKib > (largest.rssKib as number))) invalid()
    return segment as AppMemorySegment
  })
}
export function parseAppMemoryArchive(value: unknown): AppMemoryArchive {
  const archive = fields(value, ['schema', 'segments'])
  if (archive.schema !== 'agentmux.app-memory-evidence.v1') invalid()
  segments(archive.segments)
  return archive as AppMemoryArchive
}
export function parseAppMemoryEvidence(value: unknown): AppMemoryEvidence {
  const evidence = fields(value, ['schema', 'segments', 'intervalMs', 'sampling', 'persistence'])
  parseAppMemoryArchive({ schema: evidence.schema, segments: evidence.segments })
  const sampling = fields(evidence.sampling, ['state', 'reason'])
  const persistence = fields(evidence.persistence, ['state', 'reason', 'coalescedWrites'])
  if (evidence.intervalMs !== APP_MEMORY_EVIDENCE_INTERVAL_MS ||
    !(sampling.state === 'available' || sampling.state === 'unavailable') ||
    !(persistence.state === 'confirmed' || persistence.state === 'pending' || persistence.state === 'unconfirmed') ||
    !count(persistence.coalescedWrites)) invalid()
  for (const state of [sampling, persistence]) if (state.reason !== null &&
    (typeof state.reason !== 'string' || state.reason.length > 512)) invalid()
  if (sampling.state === 'available' && sampling.reason !== null ||
    persistence.state !== 'unconfirmed' && persistence.reason !== null ||
    sampling.state === 'unavailable' && !sampling.reason ||
    persistence.state === 'unconfirmed' && !persistence.reason) invalid()
  return evidence as AppMemoryEvidence
}
