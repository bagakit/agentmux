import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import {
  parseRendererV8ProfileInput,
  sameRendererV8ProfileTarget,
  type RendererV8Profile,
  type RendererV8ProfileInput,
  type RendererV8ProfileIssue,
  type RendererV8ProfileResult
} from './renderer-v8-profile.js'

export const RENDERER_ALLOCATIONS_MAX_BYTES = 8 * 1024 * 1024
export const RENDERER_ALLOCATION_POLICY = {
  samplingIntervalBytes: 32768,
  stackDepth: 128,
  includeObjectsCollectedByMajorGC: false,
  includeObjectsCollectedByMinorGC: false
} as const
export type RendererAllocationsInput = RendererV8ProfileInput
export type RendererAllocationNode = {
  id: number
  callFrame: RendererV8Profile['nodes'][number]['callFrame']
  selfSize: number
  children: RendererAllocationNode[]
}
/** The Chromium HeapProfiler wire DTO, including IDs and ordered samples absent from older Node inspector types. */
export type RendererAllocationsProfile = {
  head: RendererAllocationNode
  samples: Array<{ size: number; nodeId: number; ordinal: number }>
}
export type RendererAllocationsResult = Omit<
  RendererV8ProfileResult,
  'schema' | 'scope' | 'profilerTimeUnit' | 'profile' | 'cleanup'
> & {
  schema: 'agentmux.renderer-allocations.v1'
  scope: 'renderer-v8-isolate-sampled-allocations'
  policy: typeof RENDERER_ALLOCATION_POLICY
  cleanup: RendererV8ProfileResult['cleanup'] & { startRequested: boolean; startAcknowledged: boolean }
  profile: RendererAllocationsProfile | null
}
export const parseRendererAllocationsInput = parseRendererV8ProfileInput
const bad = (): never => {
  throw new AgentMuxError('Renderer allocation sampling contract is invalid.', 'CONTROL_PROTOCOL_ERROR')
}
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const count = (v: unknown): v is number => number(v) && Number.isSafeInteger(v)
type ProfileLocation = { kind: 'profile' | 'node' | 'sample'; index: number }
type ProfileField =
  | 'samples' | 'id' | 'selfSize' | 'callFrame' | 'children'
  | 'functionName' | 'scriptId' | 'url' | 'lineNumber' | 'columnNumber'
  | 'size' | 'nodeId' | 'ordinal'
type ProfilePredicate =
  | 'record.json-fields' | 'record.required-fields' | 'array.shape' | 'array.data-element'
  | 'node.id' | 'node.unique-id' | 'node.selfSize' | 'frame.string'
  | 'frame.position-integer' | 'frame.position-minimum'
  | 'sample.size' | 'sample.nodeId' | 'sample.node-reference' | 'sample.ordinal' | 'sample.unique-ordinal'

// Only fixed schema tokens and traversal/array indices enter the existing error message.
// A node visit is zero-based in the original LIFO traversal, not a wire array or native node ID.
const profileBad = (predicate: ProfilePredicate, at: ProfileLocation, field?: ProfileField, element?: number): never => {
  const owner = at.kind === 'profile' ? 'profile' : at.kind === 'node' ? `head{visit=${at.index}}` : `samples[${at.index}]`
  const frame = field !== undefined && ['functionName', 'scriptId', 'url', 'lineNumber', 'columnNumber'].includes(field)
  const location = owner + (field ? `${frame ? '.callFrame' : ''}.${field}` : '') + (element === undefined ? '' : `[${element}]`)
  throw new AgentMuxError(
    `Renderer allocation sampling contract is invalid: ${predicate} at ${location}.`,
    'CONTROL_PROTOCOL_ERROR'
  )
}
const fields = (v: unknown, keys: string[], at?: ProfileLocation, field?: ProfileField) => {
  let r: Record<string, unknown>
  try {
    r = rpcRecord(v, keys, 'CONTROL_PROTOCOL_ERROR')
  } catch (error) {
    if (at && error instanceof AgentMuxError && error.code === 'CONTROL_PROTOCOL_ERROR') profileBad('record.json-fields', at, field)
    throw error
  }
  if (Object.keys(r).length !== keys.length) {
    if (at) profileBad('record.required-fields', at, field)
    bad()
  }
  return r
}
const array = (v: unknown, at?: ProfileLocation, field?: ProfileField): unknown[] => {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype || Reflect.ownKeys(v).length !== v.length + 1) {
    if (at) profileBad('array.shape', at, field)
    bad()
  }
  for (let i = 0; i < (v as unknown[]).length; i++) {
    const d = Object.getOwnPropertyDescriptor(v, String(i))
    if (!d?.enumerable || !('value' in d)) {
      if (at) profileBad('array.data-element', at, field, i)
      bad()
    }
  }
  return v as unknown[]
}
/** Original protocol tree and sample order; no object bodies, reconstructed stacks or truncation. */
export function parseRendererAllocationsProfile(value: unknown): RendererAllocationsProfile {
  const at: ProfileLocation = { kind: 'profile', index: 0 }
  const r = fields(value, ['head', 'samples'], at),
    pending = [r.head],
    ids = new Set<number>()
  let nodeVisit = 0
  while (pending.length) {
    at.kind = 'node'
    at.index = nodeVisit++
    const n = fields(pending.pop(), ['callFrame', 'selfSize', 'id', 'children'], at)
    if (!count(n.id)) profileBad('node.id', at, 'id')
    if (ids.has(n.id as number)) profileBad('node.unique-id', at, 'id')
    if (!number(n.selfSize)) profileBad('node.selfSize', at, 'selfSize')
    ids.add(n.id as number)
    const f = fields(n.callFrame, ['functionName', 'scriptId', 'url', 'lineNumber', 'columnNumber'], at, 'callFrame')
    for (const field of ['functionName', 'scriptId', 'url'] as const)
      if (typeof f[field] !== 'string') profileBad('frame.string', at, field)
    for (const field of ['lineNumber', 'columnNumber'] as const) {
      if (!Number.isSafeInteger(f[field])) profileBad('frame.position-integer', at, field)
      if (Number(f[field]) < -1) profileBad('frame.position-minimum', at, field)
    }
    for (const child of array(n.children, at, 'children')) pending.push(child)
  }
  const ordinals = new Set<number>()
  at.kind = 'profile'
  at.index = 0
  const samples = array(r.samples, at, 'samples')
  for (let index = 0; index < samples.length; index++) {
    at.kind = 'sample'
    at.index = index
    const s = fields(samples[index], ['size', 'nodeId', 'ordinal'], at)
    if (!number(s.size)) profileBad('sample.size', at, 'size')
    if (!count(s.nodeId)) profileBad('sample.nodeId', at, 'nodeId')
    if (!ids.has(s.nodeId as number)) profileBad('sample.node-reference', at, 'nodeId')
    if (!number(s.ordinal)) profileBad('sample.ordinal', at, 'ordinal')
    if (ordinals.has(s.ordinal as number)) profileBad('sample.unique-ordinal', at, 'ordinal')
    ordinals.add(s.ordinal as number)
  }
  return r as unknown as RendererAllocationsProfile
}
export function rendererAllocationsJSON(profile: RendererAllocationsProfile): string {
  const text = JSON.stringify(profile)
  if (new TextEncoder().encode(text).byteLength > RENDERER_ALLOCATIONS_MAX_BYTES)
    throw new AgentMuxError(
      'Original allocation profile exceeds the 8 MiB result budget; it was not truncated.',
      'CONTROL_PROTOCOL_ERROR'
    )
  parseRendererAllocationsProfile(profile)
  return text
}
export function parseRendererAllocationsResult(
  value: unknown,
  input?: RendererAllocationsInput
): RendererAllocationsResult {
  const r = fields(value, [
    'target',
    'durationMs',
    'schema',
    'scope',
    'status',
    'timing',
    'policy',
    'sourceVerified',
    'cleanup',
    'profile',
    'profileBytes',
    'sha256',
    'issues'
  ])
  const actual = parseRendererAllocationsInput({ target: r.target, durationMs: r.durationMs }, 'CONTROL_PROTOCOL_ERROR')
  if (input && (!sameRendererV8ProfileTarget(actual.target, input.target) || actual.durationMs !== input.durationMs))
    bad()
  if (
    r.schema !== 'agentmux.renderer-allocations.v1' ||
    r.scope !== 'renderer-v8-isolate-sampled-allocations' ||
    !['completed', 'failed', 'unknown'].includes(String(r.status))
  )
    bad()
  const policy = fields(r.policy, Object.keys(RENDERER_ALLOCATION_POLICY))
  for (const [key, expected] of Object.entries(RENDERER_ALLOCATION_POLICY)) if (policy[key] !== expected) bad()
  const timing = fields(r.timing, [
    'requestedAt',
    'startedAt',
    'stoppedAt',
    'finishedAt',
    'startMonotonicMs',
    'stopMonotonicMs'
  ])
  for (const key of ['requestedAt', 'finishedAt']) if (!number(timing[key])) bad()
  for (const key of ['startedAt', 'stoppedAt', 'startMonotonicMs', 'stopMonotonicMs'])
    if (timing[key] !== null && !number(timing[key])) bad()
  if (
    Number(timing.finishedAt) < Number(timing.requestedAt) ||
    (timing.stopMonotonicMs !== null &&
      (timing.startMonotonicMs === null || Number(timing.stopMonotonicMs) < Number(timing.startMonotonicMs)))
  )
    bad()
  const source = fields(r.sourceVerified, ['before', 'after']),
    cleanup = fields(r.cleanup, [
      'startRequested',
      'startAcknowledged',
      'stopRequested',
      'stopAcknowledged',
      'disableAcknowledged',
      'detached'
    ])
  if (
    Object.values(source).some((v) => typeof v !== 'boolean') ||
    ['startRequested', 'startAcknowledged', 'stopRequested', 'stopAcknowledged', 'disableAcknowledged'].some(
      (k) => typeof cleanup[k] !== 'boolean'
    ) ||
    !['not-attached', 'confirmed', 'unconfirmed', 'owner-lost'].includes(String(cleanup.detached)) ||
    (cleanup.stopAcknowledged && !cleanup.stopRequested) ||
    (cleanup.startAcknowledged && !cleanup.startRequested)
  )
    bad()
  const issues = array(r.issues)
  if (issues.length > 8) bad()
  for (const issue of issues) {
    const i = fields(issue, ['stage', 'code', 'message', 'messageTruncated'])
    if (
      typeof i.stage !== 'string' ||
      i.stage.length > 80 ||
      typeof i.code !== 'string' ||
      i.code.length > 128 ||
      typeof i.message !== 'string' ||
      i.message.length > 2048 ||
      typeof i.messageTruncated !== 'boolean'
    )
      bad()
  }
  if (r.profileBytes !== null && !count(r.profileBytes)) bad()
  if (r.profile === null) {
    if (r.sha256 !== null) bad()
  } else {
    const text = rendererAllocationsJSON(r.profile as RendererAllocationsProfile)
    if (
      r.profileBytes !== new TextEncoder().encode(text).byteLength ||
      typeof r.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(r.sha256)
    )
      bad()
  }
  if (
    r.status === 'completed' &&
    (r.profile === null ||
      !source.before ||
      !source.after ||
      !cleanup.startAcknowledged ||
      !cleanup.stopAcknowledged ||
      !cleanup.disableAcknowledged ||
      cleanup.detached !== 'confirmed' ||
      issues.length ||
      ['startedAt', 'stoppedAt', 'startMonotonicMs', 'stopMonotonicMs'].some((k) => timing[k] === null))
  )
    bad()
  if (new TextEncoder().encode(JSON.stringify({ ...r, profile: null })).byteLength > 64 * 1024) bad()
  return r as unknown as RendererAllocationsResult
}
export function rendererCaptureIssue(stage: string, error: unknown): RendererV8ProfileIssue {
  const cause = error instanceof Error ? (error as Error & { code?: string }) : null,
    message = cause?.message ?? String(error)
  return {
    stage: stage.slice(0, 80),
    code: typeof cause?.code === 'string' ? cause.code.slice(0, 128) : 'CONTROL_FAILED',
    message: message.slice(0, 2048),
    messageTruncated: message.length > 2048
  }
}
