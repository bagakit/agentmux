import type { Profiler } from 'node:inspector'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

export const V8_PROFILE_MAX_BYTES = 8 * 1024 * 1024
export type V8Profile = Profiler.Profile

function invalid(code: string): never { throw new AgentMuxError('V8 profile contract is invalid.', code) }
const numeric = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const count = (v: unknown): v is number => numeric(v) && Number.isSafeInteger(v)
const positive = (v: unknown): v is number => count(v) && v > 0
const fields = (v: unknown, keys: string[], code: string) => {
  const r = rpcRecord(v, keys, code)
  if (Object.keys(r).length !== keys.length) invalid(code)
  return r
}
function array(v: unknown, code: string): unknown[] {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype || Reflect.ownKeys(v).length !== v.length + 1) invalid(code)
  for (let i = 0; i < v.length; i++) {
    const d = Object.getOwnPropertyDescriptor(v, String(i))
    if (!d?.enumerable || !('value' in d)) invalid(code)
  }
  return v
}

/** Validate the original protocol object, retaining optional fields and array order. */
export function parseV8Profile(value: unknown): V8Profile {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const p = rpcRecord(value, ['nodes', 'startTime', 'endTime', 'samples', 'timeDeltas'], code)
  if (!numeric(p.startTime) || !numeric(p.endTime) || p.endTime < p.startTime) invalid(code)
  const nodes = array(p.nodes, code), ids = new Set<number>()
  if (!nodes.length) invalid(code)
  for (const item of nodes) {
    const n = rpcRecord(item, ['id', 'callFrame', 'hitCount', 'children', 'deoptReason', 'positionTicks'], code)
    if (!positive(n.id) || ids.has(n.id)) invalid(code)
    ids.add(n.id)
    const f = fields(n.callFrame, ['functionName', 'scriptId', 'url', 'lineNumber', 'columnNumber'], code)
    if (['functionName', 'scriptId', 'url'].some(key => typeof f[key] !== 'string') ||
      !Number.isSafeInteger(f.lineNumber) || Number(f.lineNumber) < -1 ||
      !Number.isSafeInteger(f.columnNumber) || Number(f.columnNumber) < -1 ||
      n.hitCount !== undefined && !count(n.hitCount) || n.deoptReason !== undefined && typeof n.deoptReason !== 'string') invalid(code)
    if (n.positionTicks !== undefined) for (const tick of array(n.positionTicks, code)) {
      const t = fields(tick, ['line', 'ticks'], code)
      if (!count(t.line) || !count(t.ticks)) invalid(code)
    }
  }
  for (const item of nodes) {
    const n = item as { children?: unknown }
    if (n.children !== undefined) for (const id of array(n.children, code)) if (!positive(id) || !ids.has(id)) invalid(code)
  }
  if (p.samples !== undefined || p.timeDeltas !== undefined) {
    const samples = array(p.samples, code), deltas = array(p.timeDeltas, code)
    if (samples.length !== deltas.length) invalid(code)
    for (const id of samples) if (!positive(id) || !ids.has(id)) invalid(code)
    for (const delta of deltas) if (!numeric(delta)) invalid(code)
  }
  return p as unknown as V8Profile
}

export function v8ProfileJSON(profile: V8Profile): string {
  const json = JSON.stringify(profile)
  if (new TextEncoder().encode(json).byteLength > V8_PROFILE_MAX_BYTES) {
    throw new AgentMuxError('Original V8 profile exceeds the 8 MiB result transport budget; it was not truncated.', 'CONTROL_PROTOCOL_ERROR')
  }
  parseV8Profile(profile)
  return json
}
