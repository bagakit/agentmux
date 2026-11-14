import { AgentMuxError } from './errors.js'
import type { AgentMuxRunRef } from './types.js'

/**
 * One user Stop, from admission to retirement, as facts the lifecycle owner recorded.
 *
 * The receipt is the business result of `stopAgent`. The same stage facts persist with the lifecycle
 * itself: while the Stop is in flight or has failed they live on its reservation row (`progress`), and
 * once it retires they move into the retirement record (`stop`). There is no separate journal, so a
 * read-only inspect always reads the single owner of the fact.
 */
/** `retained-run-stop`: stopping the one Run a taken-over prepared resume left under its key. */
export type AgentMuxAgentStopStageName = 'admission' | 'runtime-observe' | 'runtime-stop' | 'retained-run-stop' | 'retire-commit'
export type AgentMuxAgentStopStage = {
  stage: AgentMuxAgentStopStageName
  startedAt: number
  endedAt: number
  /** `skipped`: the Run had already ended, so no Runtime stop was sent. `not-found`: Runtime no longer knew the Run. */
  outcome: 'ok' | 'skipped' | 'not-found' | 'failed'
  errorCode?: string
}
export type AgentMuxAgentStopRuntime = {
  observed: 'running' | 'exited' | 'interrupted' | 'not-found'
  /** The Runtime's own receipt for the stop, when one was sent. */
  stop: 'graceful' | 'forced' | 'not-required' | 'not-found'
}
/** How this reader reached the Stop. Whether the Stop took over a prepared resume is the receipt's `supersededResume`. */
export type AgentMuxAgentStopAdmission = 'new' | 'retained' | 'joined'
/**
 * The prepared resume a Stop took over and the Runtime witness that allowed it. The Stop keeps this
 * record of the original operation on its own reservation and then in the retirement; it never
 * replays that operation's Start or input.
 */
export type AgentMuxStopSupersededResume = {
  /** The prepared resume's creation key. */
  lifecycleOperationId: string
  /** The caller's identity for that resume, when it was recorded. */
  resumeOperationId?: string
  /** `retired`: the key is sealed, so no Run can start under it. `retained`: that key's one Run exists and is stopped with this Session. */
  fence: 'retired' | 'retained'
  runtimeId: string
  retainedRun?: AgentMuxRunRef
  /** How the retained Run was stopped; written at retirement. */
  retainedStop?: AgentMuxAgentStopRuntime['stop']
}
export type AgentMuxAgentStopReceipt = {
  agentSessionId: string
  expectedRun: AgentMuxRunRef
  /** The caller's operation identity, or the one minted for this Stop. */
  operationId: string
  lifecycleOperationId: string
  admission: AgentMuxAgentStopAdmission
  runtime: AgentMuxAgentStopRuntime
  retiredAt: number
  stages: AgentMuxAgentStopStage[]
  supersededResume?: AgentMuxStopSupersededResume
}
/** What a still-open Stop reservation records about how far it got. */
export type AgentMuxAgentStopProgress = {
  operationId: string
  stages: AgentMuxAgentStopStage[]
  failure?: { stage: AgentMuxAgentStopStageName; code: string; message: string; observedAt: number }
}
/** What a retirement records about the Stop that produced it. */
export type AgentMuxAgentStopRecord = {
  operationId: string
  lifecycleOperationId: string
  runtime: AgentMuxAgentStopRuntime
  stages: AgentMuxAgentStopStage[]
  supersededResume?: AgentMuxStopSupersededResume
}
export type AgentMuxAgentStopIdentity = { agentSessionId: string; expectedRun: AgentMuxRunRef; operationId?: string }
export type AgentMuxAgentStopInspection = {
  agentSessionId: string
  expectedRun: AgentMuxRunRef
  /**
   * `not-requested`: the Session still holds this Run and no Stop is open.
   * `stopping`: a Stop reservation for this Run is open; an explicit retry continues it.
   * `retired`: this Run's Session is retired.
   * `unconfirmed`: none of the above can be confirmed from the owner's exact rows, for example another
   * lifecycle operation holds the Session (`holder`) or the Session now holds a different Run.
   */
  phase: 'not-requested' | 'stopping' | 'retired' | 'unconfirmed'
  canRetry: boolean
  lifecycleOperationId?: string
  /** Present when the caller named an operation: whether the open or retired Stop is that same operation. */
  operationIdMatched?: boolean
  stages?: AgentMuxAgentStopStage[]
  runtime?: AgentMuxAgentStopRuntime
  failure?: AgentMuxAgentStopProgress['failure']
  retiredAt?: number
  holder?: { kind: 'create' | 'resume' | 'reopen'; operationId: string }
  /** The prepared resume this Stop took over, with its Runtime witness. */
  supersededResume?: AgentMuxStopSupersededResume
  observedAt: number
}

const STAGES: readonly AgentMuxAgentStopStageName[] = ['admission', 'runtime-observe', 'runtime-stop', 'retained-run-stop', 'retire-commit']
const OUTCOMES: readonly AgentMuxAgentStopStage['outcome'][] = ['ok', 'skipped', 'not-found', 'failed']
const OBSERVED: readonly AgentMuxAgentStopRuntime['observed'][] = ['running', 'exited', 'interrupted', 'not-found']
const DISPOSITIONS: readonly AgentMuxAgentStopRuntime['stop'][] = ['graceful', 'forced', 'not-required', 'not-found']

function invalid(what: string): never {
  throw new AgentMuxError(`Stop ${what} is invalid.`, 'INVALID_AGENT_SESSION_STORE')
}
function object(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(what)
  return value as Record<string, unknown>
}
function id(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim() || new TextEncoder().encode(value).byteLength > 512 || /[\0\r\n]/u.test(value)) invalid(what)
  return value as string
}
function time(value: unknown, what: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(what)
  return value as number
}
function member<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (!allowed.includes(value as T)) invalid(what)
  return value as T
}
function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > 4096) invalid(what)
  return value as string
}

export function parseAgentStopStages(value: unknown): AgentMuxAgentStopStage[] {
  if (!Array.isArray(value) || value.length > STAGES.length * 2) invalid('stages')
  return value.map(item => {
    const stage = object(item, 'stage')
    const parsed: AgentMuxAgentStopStage = { stage: member(stage.stage, STAGES, 'stage name'), startedAt: time(stage.startedAt, 'stage start'),
      endedAt: time(stage.endedAt, 'stage end'), outcome: member(stage.outcome, OUTCOMES, 'stage outcome') }
    if (parsed.endedAt < parsed.startedAt) invalid('stage order')
    if (stage.errorCode !== undefined) parsed.errorCode = id(stage.errorCode, 'stage error code')
    return parsed
  })
}
export function parseAgentStopRuntime(value: unknown): AgentMuxAgentStopRuntime {
  const source = object(value, 'runtime')
  return { observed: member(source.observed, OBSERVED, 'runtime observation'), stop: member(source.stop, DISPOSITIONS, 'runtime disposition') }
}
function parseAgentStopFailure(value: unknown): NonNullable<AgentMuxAgentStopProgress['failure']> {
  const failure = object(value, 'failure')
  return { stage: member(failure.stage, STAGES, 'failure stage'), code: id(failure.code, 'failure code'),
    message: text(failure.message, 'failure message'), observedAt: time(failure.observedAt, 'failure time') }
}
export function parseAgentStopProgress(value: unknown): AgentMuxAgentStopProgress {
  const source = object(value, 'progress')
  return { operationId: id(source.operationId, 'progress operation'), stages: parseAgentStopStages(source.stages),
    ...(source.failure === undefined ? {} : { failure: parseAgentStopFailure(source.failure) }) }
}
export function parseStopSupersededResume(value: unknown): AgentMuxStopSupersededResume {
  const source = object(value, 'superseded resume')
  const fence = member(source.fence, ['retired', 'retained'] as const, 'superseded resume fence')
  const parsed: AgentMuxStopSupersededResume = { lifecycleOperationId: id(source.lifecycleOperationId, 'superseded resume operation'), fence,
    runtimeId: id(source.runtimeId, 'superseded resume Runtime') }
  if (source.resumeOperationId !== undefined) parsed.resumeOperationId = id(source.resumeOperationId, 'superseded resume caller operation')
  if (source.retainedRun !== undefined) parsed.retainedRun = { runId: id(object(source.retainedRun, 'retained Run').runId, 'retained Run') }
  if (source.retainedStop !== undefined) parsed.retainedStop = member(source.retainedStop, DISPOSITIONS, 'retained Run stop')
  if ((fence === 'retained') !== (parsed.retainedRun !== undefined) || fence === 'retired' && parsed.retainedStop !== undefined) invalid('superseded resume witness')
  return parsed
}
export function parseAgentStopRecord(value: unknown): AgentMuxAgentStopRecord {
  const source = object(value, 'record')
  return { operationId: id(source.operationId, 'record operation'), lifecycleOperationId: id(source.lifecycleOperationId, 'record lifecycle'),
    runtime: parseAgentStopRuntime(source.runtime), stages: parseAgentStopStages(source.stages),
    ...(source.supersededResume === undefined ? {} : { supersededResume: parseStopSupersededResume(source.supersededResume) }) }
}
export function parseAgentStopReceipt(value: unknown, expected?: { agentSessionId: string; operationId?: string }): AgentMuxAgentStopReceipt {
  const source = object(value, 'receipt'), run = object(source.expectedRun, 'receipt Run')
  const receipt: AgentMuxAgentStopReceipt = {
    agentSessionId: id(source.agentSessionId, 'receipt Session'), expectedRun: { runId: id(run.runId, 'receipt Run') },
    operationId: id(source.operationId, 'receipt operation'), lifecycleOperationId: id(source.lifecycleOperationId, 'receipt lifecycle'),
    admission: member(source.admission, ['new', 'retained', 'joined'] as const, 'receipt admission'),
    runtime: parseAgentStopRuntime(source.runtime), retiredAt: time(source.retiredAt, 'receipt retirement'), stages: parseAgentStopStages(source.stages),
    ...(source.supersededResume === undefined ? {} : { supersededResume: parseStopSupersededResume(source.supersededResume) })
  }
  if (expected && (receipt.agentSessionId !== expected.agentSessionId || expected.operationId !== undefined && receipt.operationId !== expected.operationId)) {
    throw new AgentMuxError('The Stop receipt belongs to another Session or operation.', 'CONTROL_PROTOCOL_ERROR')
  }
  return receipt
}
/** The one strict reading of an inspection, used wherever one crosses a boundary; it must answer the asked identity. */
export function parseAgentStopInspection(value: unknown, asked: AgentMuxAgentStopIdentity): AgentMuxAgentStopInspection {
  const bad = (): never => { throw new AgentMuxError('Stop inspection is malformed or answers another Stop.', 'CONTROL_PROTOCOL_ERROR') }
  const source = value as Record<string, unknown>
  const fields = ['agentSessionId', 'expectedRun', 'phase', 'canRetry', 'lifecycleOperationId', 'operationIdMatched', 'stages', 'runtime',
    'failure', 'retiredAt', 'holder', 'supersededResume', 'observedAt']
  if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some(key => !fields.includes(key))) bad()
  const run = object(source.expectedRun, 'inspection Run')
  if (source.agentSessionId !== asked.agentSessionId || Object.keys(run).join() !== 'runId' || run.runId !== asked.expectedRun.runId) bad()
  const phase = member(source.phase, ['not-requested', 'stopping', 'retired', 'unconfirmed'] as const, 'inspection phase')
  if (typeof source.canRetry !== 'boolean') bad()
  if (source.operationIdMatched !== undefined && (typeof source.operationIdMatched !== 'boolean' || asked.operationId === undefined)) bad()
  const inspection: AgentMuxAgentStopInspection = { agentSessionId: asked.agentSessionId, expectedRun: { runId: asked.expectedRun.runId }, phase,
    canRetry: source.canRetry as boolean, observedAt: time(source.observedAt, 'inspection time'),
    ...(source.lifecycleOperationId === undefined ? {} : { lifecycleOperationId: id(source.lifecycleOperationId, 'inspection lifecycle') }),
    ...(source.operationIdMatched === undefined ? {} : { operationIdMatched: source.operationIdMatched as boolean }),
    ...(source.stages === undefined ? {} : { stages: parseAgentStopStages(source.stages) }),
    ...(source.runtime === undefined ? {} : { runtime: parseAgentStopRuntime(source.runtime) }),
    ...(source.retiredAt === undefined ? {} : { retiredAt: time(source.retiredAt, 'inspection retirement') }),
    ...(source.supersededResume === undefined ? {} : { supersededResume: parseStopSupersededResume(source.supersededResume) }) }
  if (source.failure !== undefined) inspection.failure = parseAgentStopFailure(source.failure)
  if (source.holder !== undefined) {
    const holder = object(source.holder, 'inspection holder')
    if (Object.keys(holder).some(key => key !== 'kind' && key !== 'operationId')) bad()
    inspection.holder = { kind: member(holder.kind, ['create', 'resume', 'reopen'] as const, 'holder kind'), operationId: id(holder.operationId, 'holder operation') }
  }
  // Each phase carries only the facts it can have.
  if (phase === 'retired' && (inspection.retiredAt === undefined || inspection.canRetry) || phase !== 'retired' && inspection.retiredAt !== undefined ||
    phase !== 'stopping' && inspection.failure || phase !== 'unconfirmed' && inspection.holder ||
    inspection.supersededResume && phase !== 'stopping' && phase !== 'retired') bad()
  return inspection
}

export function parseAgentStopIdentity(value: unknown): AgentMuxAgentStopIdentity {
  const source = value as Record<string, unknown>, bad = () => { throw new AgentMuxError('Stop inspection requires the exact original Session and Run.', 'INVALID_CONTROL_REQUEST') }
  const exact = (item: unknown) => typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(item)
  if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some(key => !['agentSessionId', 'expectedRun', 'operationId'].includes(key))) bad()
  const run = source.expectedRun as Record<string, unknown> | undefined
  if (!exact(source.agentSessionId) || source.agentSessionId === 'self' || !run || typeof run !== 'object' || Object.keys(run).join() !== 'runId' || !exact(run.runId) ||
    source.operationId !== undefined && !exact(source.operationId)) bad()
  return { agentSessionId: source.agentSessionId as string, expectedRun: { runId: run!.runId as string },
    ...(source.operationId === undefined ? {} : { operationId: source.operationId as string }) }
}
