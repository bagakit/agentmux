import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import { parsePostureTarget, type PostureTarget } from './agent-posture.js'
import { parseAgentConfigurationSnapshot, type AgentConfigurationSnapshot, type AgentConfigurationOption } from './agent-configuration.js'

export type AgentInformationIssue = {
  field: 'model' | 'plan' | 'limits' | 'configuration'
  kind: 'unsupported' | 'unavailable' | 'unconfirmed'
  code: string
  message: string
}

/** Native configured model, not a historical response or a launch-time preference. */
export type AgentInformationModel = { id: string; name?: string; scope: 'session' | 'next-turn' }
export type AgentInformationLimit = {
  id: string
  name: string
  usedPercent: number
  windowMinutes?: number
  /** Unix epoch milliseconds, normalized by the Provider. */
  resetsAt?: number
}

/** One read of the original native source. Account quotas never derive from context or tokens. */
export type AgentInformationSnapshot = {
  nativeSessionId: string
  sourceId: string
  observedAt: number
  model?: AgentInformationModel
  plan?: { id: string; name: string }
  limits?: AgentInformationLimit[]
  issues: AgentInformationIssue[]
}

export type AgentInformationInspect = { hostId: string; agentSessionId: string; expectedRun: { runId: string } }
export type AgentInformationInspection = {
  kind: 'information'
  target: PostureTarget
  snapshot: AgentInformationSnapshot | null
  configuration: AgentConfigurationSnapshot | null
  /** Failed latest observation; a retained snapshot keeps its original observation time. */
  issue?: { code: string; message: string }
}

/** The Provider normalizes the native semantic category; labels and IDs never identify a model. */
export function agentModelOption(configuration?: AgentConfigurationSnapshot | null): Extract<AgentConfigurationOption, { type: 'select' }> | undefined {
  const options = configuration?.options.filter((option): option is Extract<AgentConfigurationOption, { type: 'select' }> => option.category === 'model' && option.type === 'select')
  return options?.length === 1 ? options[0] : undefined
}

export function agentCurrentModel(information?: AgentInformationSnapshot | null, configuration?: AgentConfigurationSnapshot | null): AgentInformationModel | undefined {
  const option = agentModelOption(configuration)
  return option ? { id: option.currentValue, name: option.choices.find(choice => choice.value === option.currentValue)!.name, scope: 'next-turn' } : information?.model
}

export function parseAgentInformationInspect(value: unknown): AgentInformationInspect {
  const p = rpcRecord(value, ['hostId', 'agentSessionId', 'expectedRun'])
  return { hostId: rpcString(p.hostId, 'Original Host'), agentSessionId: rpcString(p.agentSessionId, 'Original Session'),
    expectedRun: { runId: rpcString(rpcRecord(p.expectedRun, ['runId']).runId, 'Original Run') } }
}

export function parseAgentInformationInspection(value: unknown, input: AgentInformationInspect): AgentInformationInspection {
  const p = rpcRecord(value, ['kind', 'target', 'snapshot', 'configuration', 'issue'], 'CONTROL_PROTOCOL_ERROR')
  const target = parsePostureTarget(p.target)
  if (p.kind !== 'information' || target.hostId !== input.hostId || target.agentSessionId !== input.agentSessionId || target.expectedRun.runId !== input.expectedRun.runId)
    throw new AgentMuxError('Native information belongs to another original target.', 'CONTROL_PROTOCOL_ERROR')
  const issue = p.issue === undefined ? undefined : rpcRecord(p.issue, ['code', 'message'], 'CONTROL_PROTOCOL_ERROR')
  return { kind: 'information', target, snapshot: p.snapshot === null ? null : parseAgentInformationSnapshot(p.snapshot),
    configuration: p.configuration === null ? null : parseAgentConfigurationSnapshot(p.configuration),
    ...(issue ? { issue: { code: rpcString(issue.code, 'Information issue'), message: rpcString(issue.message, 'Information issue') } } : {}) }
}

export function parseAgentInformationSnapshot(value: unknown): AgentInformationSnapshot {
  const invalid = (): never => { throw new AgentMuxError('The original native information is unconfirmed.', 'CONTROL_PROTOCOL_ERROR') }
  const text = (v: unknown) => rpcString(v, 'Native information')
  const number = (v: unknown) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) invalid(); return v as number }
  const p = rpcRecord(value, ['nativeSessionId', 'sourceId', 'observedAt', 'model', 'plan', 'limits', 'issues'], 'CONTROL_PROTOCOL_ERROR')
  const model = p.model === undefined ? undefined : rpcRecord(p.model, ['id', 'name', 'scope'], 'CONTROL_PROTOCOL_ERROR')
  if (model && !['session', 'next-turn'].includes(String(model.scope))) invalid()
  const plan = p.plan === undefined ? undefined : rpcRecord(p.plan, ['id', 'name'], 'CONTROL_PROTOCOL_ERROR')
  if (!Array.isArray(p.issues) || p.limits !== undefined && !Array.isArray(p.limits)) invalid()
  const ids = new Set<string>()
  const limits = (p.limits as unknown[] | undefined)?.map(value => {
    const row = rpcRecord(value, ['id', 'name', 'usedPercent', 'windowMinutes', 'resetsAt'], 'CONTROL_PROTOCOL_ERROR')
    const id = text(row.id)
    if (ids.has(id)) invalid()
    ids.add(id)
    return { id, name: text(row.name), usedPercent: number(row.usedPercent),
      ...(row.windowMinutes === undefined ? {} : { windowMinutes: number(row.windowMinutes) }),
      ...(row.resetsAt === undefined ? {} : { resetsAt: number(row.resetsAt) }) }
  })
  const issues = (p.issues as unknown[]).map(value => {
    const issue = rpcRecord(value, ['field', 'kind', 'code', 'message'], 'CONTROL_PROTOCOL_ERROR')
    if (!['model', 'plan', 'limits', 'configuration'].includes(String(issue.field)) ||
        !['unsupported', 'unavailable', 'unconfirmed'].includes(String(issue.kind))) invalid()
    return { field: issue.field as AgentInformationIssue['field'], kind: issue.kind as AgentInformationIssue['kind'],
      code: text(issue.code), message: text(issue.message) }
  })
  return { nativeSessionId: text(p.nativeSessionId), sourceId: text(p.sourceId), observedAt: number(p.observedAt),
    ...(model ? { model: { id: text(model.id), ...(model.name === undefined ? {} : { name: text(model.name) }), scope: model.scope as AgentInformationModel['scope'] } } : {}),
    ...(plan ? { plan: { id: text(plan.id), name: text(plan.name) } } : {}), ...(limits === undefined ? {} : { limits }), issues }
}
