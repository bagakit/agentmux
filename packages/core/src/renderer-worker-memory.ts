import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseRendererHeapUsage, type RendererHeapUsage } from './renderer-memory.js'
import { parseRendererV8Target, sameRendererV8ProfileTarget, type RendererV8ProfileTarget, type RendererV8ProfileIssue } from './renderer-v8-profile.js'

/** Budgets apply only to this explicit observation, never to Worker/Agent capacity. */
export const RENDERER_WORKER_MEMORY_LIMITS = { discoveryMs: 200, relations: 16, commands: 64,
  concurrency: 2, metadataCodeUnits: 8192, urlCodeUnits: 2048, titleCodeUnits: 512, issues: 32 } as const
export type RendererWorkerMemoryInput = { target: RendererV8ProfileTarget }
export type RendererWorkerMemoryText = { state: 'absent' | 'present' | 'truncated' | 'omitted' | 'unavailable'; value: string | null; originalLength: number | null }
export type RendererWorkerMemoryRelation = {
  sessionId: string; parentSessionId: string | null; observedAt: number; endedAt: number | null
  target: { targetId: string; type: 'worker'; url: RendererWorkerMemoryText; title: RendererWorkerMemoryText
    parentId: string | null; parentFrameId: string | null; openerId: string | null; openerFrameId: string | null }
  status: 'pending' | 'measured' | 'root-alias' | 'worker-alias' | 'failed'
  isolateId: string | null
  /** Relatedness never establishes a child OS process identity. */
  process: null
}
export type RendererWorkerMemoryResult = RendererWorkerMemoryInput & {
  schema: 'agentmux.renderer-worker-memory.v1'; scope: 'renderer-related-dedicated-worker-isolates'; units: 'bytes'
  status: 'completed' | 'partial' | 'failed' | 'unknown'
  timing: { requestedAt: number; finishedAt: number }
  sourceVerified: { before: boolean; after: boolean }
  limits: typeof RENDERER_WORKER_MEMORY_LIMITS
  discovery: { scope: 'root-and-nested-dedicated-workers'; coverage: 'bounded' | 'partial'
    startedAt: number | null; finishedAt: number | null; observed: number; omitted: number; ignored: number; pending: number }
  root: { targetId: string; isolateId: string; usage: RendererHeapUsage; sampledAt: number } | null
  relations: RendererWorkerMemoryRelation[]
  isolates: { isolateId: string; sessionId: string; targetId: string; usage: RendererHeapUsage; sampledAt: number }[]
  cleanup: { detached: 'not-attached' | 'confirmed' | 'unconfirmed' | 'owner-lost' }
  issues: RendererV8ProfileIssue[]
  issuesOmitted: number
}
function fail(code = 'CONTROL_PROTOCOL_ERROR'): never { throw new AgentMuxError('Renderer Worker memory observation is invalid.', code) }
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const count = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v)
const identity = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\0\r\n]/u.test(v)
function shape(v: unknown, keys: string[], code = 'CONTROL_PROTOCOL_ERROR') { const r = rpcRecord(v, keys, code); if (Object.keys(r).length !== keys.length) fail(code); return r }
export function parseRendererWorkerMemoryInput(value: unknown, code = 'INVALID_CONTROL_REQUEST'): RendererWorkerMemoryInput {
  const r = shape(value, ['target'], code); parseRendererV8Target(r.target, code); return r as RendererWorkerMemoryInput
}
function text(value: unknown, maximum: number) {
  const r = shape(value, ['state', 'value', 'originalLength'])
  if (r.state === 'absent' || r.state === 'unavailable') { if (r.value !== null || r.originalLength !== null) fail(); return }
  if (!count(r.originalLength)) fail()
  if (r.state === 'omitted') { if (r.value !== null) fail(); return }
  if (typeof r.value !== 'string' || r.value.length > maximum) fail()
  if (r.state === 'present' ? r.value.length !== r.originalLength : r.state !== 'truncated' || r.value.length >= r.originalLength) fail()
}
export function parseRendererWorkerMemoryResult(value: unknown, input?: RendererWorkerMemoryInput): RendererWorkerMemoryResult {
  const r = shape(value, ['target', 'schema', 'scope', 'units', 'status', 'timing', 'sourceVerified', 'limits', 'discovery', 'root', 'relations', 'isolates', 'cleanup', 'issues', 'issuesOmitted'])
  if (!count(r.issuesOmitted)) fail()
  const target = parseRendererV8Target(r.target, 'CONTROL_PROTOCOL_ERROR')
  if (input && !sameRendererV8ProfileTarget(target, input.target)) fail()
  if (r.schema !== 'agentmux.renderer-worker-memory.v1' || r.scope !== 'renderer-related-dedicated-worker-isolates' || r.units !== 'bytes' ||
    !['completed', 'partial', 'failed', 'unknown'].includes(r.status as string)) fail()
  const timing = shape(r.timing, ['requestedAt', 'finishedAt']); if (!finite(timing.requestedAt) || !finite(timing.finishedAt) || timing.finishedAt < timing.requestedAt) fail()
  const verified = shape(r.sourceVerified, ['before', 'after']); if (typeof verified.before !== 'boolean' || typeof verified.after !== 'boolean') fail()
  const limits = shape(r.limits, Object.keys(RENDERER_WORKER_MEMORY_LIMITS))
  for (const [key, v] of Object.entries(RENDERER_WORKER_MEMORY_LIMITS)) if (limits[key] !== v) fail()
  const discovery = shape(r.discovery, ['scope', 'coverage', 'startedAt', 'finishedAt', 'observed', 'omitted', 'ignored', 'pending'])
  if (discovery.scope !== 'root-and-nested-dedicated-workers' || !['bounded', 'partial'].includes(discovery.coverage as string)) fail()
  for (const key of ['startedAt', 'finishedAt']) if (discovery[key] !== null && !finite(discovery[key])) fail()
  for (const key of ['observed', 'omitted', 'ignored', 'pending']) if (!count(discovery[key])) fail()
  if (!Array.isArray(r.relations) || r.relations.length > RENDERER_WORKER_MEMORY_LIMITS.relations || discovery.observed !== r.relations.length ||
    !Array.isArray(r.isolates) || r.isolates.length > r.relations.length || !Array.isArray(r.issues) || r.issues.length > RENDERER_WORKER_MEMORY_LIMITS.issues) fail()
  let rootId: string | null = null
  if (r.root !== null) { const root = shape(r.root, ['targetId', 'isolateId', 'usage', 'sampledAt']); if (!identity(root.targetId) || !identity(root.isolateId) || !finite(root.sampledAt)) fail(); parseRendererHeapUsage(root.usage); rootId = root.isolateId }
  const sessions = new Set<string>(), relationBySession = new Map<string, RendererWorkerMemoryRelation>(); let metadata = 0, pending = 0
  for (const raw of r.relations) {
    const row = shape(raw, ['sessionId', 'parentSessionId', 'observedAt', 'endedAt', 'target', 'status', 'isolateId', 'process'])
    if (!identity(row.sessionId) || sessions.has(row.sessionId) || row.parentSessionId !== null && !identity(row.parentSessionId) || !finite(row.observedAt) || row.endedAt !== null && !finite(row.endedAt) || row.process !== null ||
      !['pending', 'measured', 'root-alias', 'worker-alias', 'failed'].includes(row.status as string) || row.isolateId !== null && !identity(row.isolateId)) fail()
    if (['measured', 'root-alias', 'worker-alias'].includes(row.status as string) && row.isolateId === null || row.status === 'root-alias' && row.isolateId !== rootId) fail()
    const native = shape(row.target, ['targetId', 'type', 'url', 'title', 'parentId', 'parentFrameId', 'openerId', 'openerFrameId'])
    if (!identity(native.targetId) || native.type !== 'worker') fail()
    for (const key of ['parentId', 'parentFrameId', 'openerId', 'openerFrameId']) if (native[key] !== null && !identity(native[key])) fail()
    for (const [key, maximum] of [['url', RENDERER_WORKER_MEMORY_LIMITS.urlCodeUnits], ['title', RENDERER_WORKER_MEMORY_LIMITS.titleCodeUnits]] as const) { text(native[key], maximum); metadata += ((native[key] as RendererWorkerMemoryText).value?.length ?? 0) }
    if (row.parentSessionId !== null && !sessions.has(row.parentSessionId as string)) fail()
    sessions.add(row.sessionId); relationBySession.set(row.sessionId, raw as RendererWorkerMemoryRelation); if (row.status === 'pending') pending++
  }
  if (metadata > RENDERER_WORKER_MEMORY_LIMITS.metadataCodeUnits || discovery.pending !== pending) fail()
  for (const row of relationBySession.values()) if (row.parentSessionId !== null && !sessions.has(row.parentSessionId)) fail()
  if (r.root === null && (r.relations.length || r.isolates.length)) fail()
  const isolates = new Set<string>(), measurements = new Map<string, string>()
  for (const raw of r.isolates) {
    const row = shape(raw, ['isolateId', 'sessionId', 'targetId', 'usage', 'sampledAt'])
    if (!identity(row.isolateId) || row.isolateId === rootId || isolates.has(row.isolateId) || !identity(row.sessionId) || !identity(row.targetId) || !finite(row.sampledAt)) fail()
    const relation = relationBySession.get(row.sessionId)
    if (!relation || relation.status !== 'measured' || relation.isolateId !== row.isolateId || relation.target.targetId !== row.targetId) fail()
    parseRendererHeapUsage(row.usage); isolates.add(row.isolateId); measurements.set(row.isolateId, row.sessionId)
  }
  for (const row of relationBySession.values()) if ((row.status === 'measured' || row.status === 'worker-alias') && !isolates.has(row.isolateId!)) fail()
  for (const row of relationBySession.values()) {
    if (row.status === 'measured' && measurements.get(row.isolateId!) !== row.sessionId) fail()
    if (row.status === 'worker-alias' && measurements.get(row.isolateId!) === row.sessionId) fail()
  }
  const cleanup = shape(r.cleanup, ['detached']); if (!['not-attached', 'confirmed', 'unconfirmed', 'owner-lost'].includes(cleanup.detached as string)) fail()
  for (const raw of r.issues) { const issue = shape(raw, ['stage', 'code', 'message', 'messageTruncated']); if (typeof issue.stage !== 'string' || issue.stage.length > 80 || typeof issue.code !== 'string' || issue.code.length > 128 || typeof issue.message !== 'string' || issue.message.length > 2048 || typeof issue.messageTruncated !== 'boolean') fail() }
  if (r.status === 'completed' && (!r.root || !verified.before || !verified.after || cleanup.detached !== 'confirmed' || discovery.coverage !== 'bounded' || discovery.pending !== 0 || discovery.omitted !== 0 || r.issues.length || r.issuesOmitted || r.relations.some(row => row.status === 'failed' || row.endedAt !== null))) fail()
  if (r.status === 'partial' && (!r.root || !verified.before || !verified.after || cleanup.detached !== 'confirmed' || discovery.coverage !== 'partial')) fail()
  return r as RendererWorkerMemoryResult
}
