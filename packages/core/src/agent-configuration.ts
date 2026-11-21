import { parsePostureTarget, type PostureTarget } from './agent-posture.js'
import { AgentMuxError } from './errors.js'
import { parseRunControlActor, type RunControlActor } from './run-control-context.js'
import { parseCreationRuntime, type AgentMuxCreationRuntime } from './terminal-creation-retirement.js'
import { rpcRecord, rpcString } from './rpc-data.js'

export type AgentConfigurationChoice = {
  value: string; name: string; description?: string; group?: { id: string; name: string }
}

export type AgentConfigurationOption = {
  id: string; name: string; description?: string; category?: string
} & (
  | { type: 'select'; currentValue: string; choices: AgentConfigurationChoice[] }
  | { type: 'boolean'; currentValue: boolean }
)

/** Machine observation of the original configuration, independent of its available choices. */
export type AgentConfigurationObservation = {
  nativeSessionId: string
  sourceId?: string
  /** When present, ordered by the original Provider observation stream, including explicit reads. */
  sequence?: number
  observedAt: number
  state: 'confirmed' | 'unconfirmed'
  issue?: { code: string; message: string }
}

export type AgentConfigurationSnapshot = {
  revision: string
  options: AgentConfigurationOption[]
  observation?: AgentConfigurationObservation
}
export type AgentConfigurationObservedSnapshot = AgentConfigurationSnapshot & {
  observation: AgentConfigurationObservation & { state: 'confirmed'; sourceId: string; sequence: number }
}

export type AgentConfigurationTarget = PostureTarget
export type AgentConfigurationSet = { target: AgentConfigurationTarget; operationId: string; configId: string; value: string | boolean; expectedRevision: string }
export type AgentConfigurationInspect = { hostId: string; agentSessionId: string } &
  ({ expectedRun: { runId: string }; operationId?: never } | { operationId: string; expectedRun?: never })

export type AgentConfigurationReceipt = {
  action: 'agent-configuration'; operationId: string; target: AgentConfigurationTarget; configId: string; value: string | boolean
  actor: RunControlActor; phase: 'prepared' | 'dispatching' | 'settled'; outcome: 'not-dispatched' | 'not-applied' | 'applied' | 'unknown'
  nativeOperationId: string; runtime: AgentMuxCreationRuntime; acknowledgement: AgentConfigurationSnapshot | null
  diskDurability: 'confirmed' | 'unconfirmed'; issue?: string
}

export type AgentConfigurationInspection =
  | { kind: 'configuration'; target: AgentConfigurationTarget; snapshot: AgentConfigurationSnapshot | null }
  | { kind: 'operation'; agentSessionId: string; operationId: string; operation: AgentConfigurationReceipt | null }

const protocol = 'CONTROL_PROTOCOL_ERROR'
const invalid = () => new AgentMuxError('The original native configuration result is unconfirmed.', protocol)
const text = (value: unknown, name: string) => rpcString(value, name)
const description = (value: unknown): string => {
  if (typeof value !== 'string' || value.includes('\0') || new TextEncoder().encode(value).byteLength > 4096) throw invalid()
  return value
}

export function parseAgentConfigurationSnapshot(value: unknown): AgentConfigurationSnapshot {
  const p = rpcRecord(value, ['revision', 'options', 'observation'], protocol)
  const revision = text(p.revision, 'Original configuration revision')
  if (!Array.isArray(p.options) || p.options.length > 256) throw invalid()
  const ids = new Set<string>()
  const options = p.options.map((value): AgentConfigurationOption => {
    const o = rpcRecord(value, ['id', 'name', 'description', 'category', 'type', 'currentValue', 'choices'], protocol)
    const id = text(o.id, 'Original configuration ID')
    if (ids.has(id)) throw invalid()
    ids.add(id)
    const fields = { id, name: text(o.name, 'Configuration name'),
      ...(o.description === undefined ? {} : { description: description(o.description) }),
      ...(o.category === undefined ? {} : { category: text(o.category, 'Configuration category') }) }
    if (o.type === 'boolean' && typeof o.currentValue === 'boolean' && o.choices === undefined) return { ...fields, type: 'boolean', currentValue: o.currentValue }
    if (o.type !== 'select' || !Array.isArray(o.choices) || o.choices.length > 256) throw invalid()
    const choiceIds = new Set<string>()
    const choices = o.choices.map(value => {
      const c = rpcRecord(value, ['value', 'name', 'description', 'group'], protocol)
      const id = text(c.value, 'Original configuration choice')
      if (choiceIds.has(id)) throw invalid()
      choiceIds.add(id)
      const group = c.group === undefined ? undefined : rpcRecord(c.group, ['id', 'name'], protocol)
      return { value: id, name: text(c.name, 'Configuration choice name'),
        ...(c.description === undefined ? {} : { description: description(c.description) }),
        ...(group === undefined ? {} : { group: { id: text(group.id, 'Configuration group'), name: text(group.name, 'Configuration group name') } }) }
    })
    // A native configured value can remain current after it leaves the selectable catalog.
    // Reporting it never invents an available choice or authorizes setting it.
    return { ...fields, type: 'select', currentValue: text(o.currentValue, 'Current configuration value'), choices }
  })
  const observation = p.observation === undefined ? undefined : parseAgentConfigurationObservation(p.observation)
  return { revision, options, ...(observation ? { observation } : {}) }
}

export function parseAgentConfigurationObservation(value: unknown): AgentConfigurationObservation {
  const p = rpcRecord(value, ['nativeSessionId', 'sourceId', 'sequence', 'observedAt', 'state', 'issue'], protocol)
  if (!Number.isSafeInteger(p.observedAt) || Number(p.observedAt) < 0 ||
      p.sequence !== undefined && (!Number.isSafeInteger(p.sequence) || Number(p.sequence) <= 0) ||
      !['confirmed', 'unconfirmed'].includes(String(p.state)) || p.state === 'confirmed' && p.sourceId === undefined) throw invalid()
  const issue = p.issue === undefined ? undefined : rpcRecord(p.issue, ['code', 'message'], protocol)
  return { nativeSessionId: text(p.nativeSessionId, 'Original configuration Session'),
    ...(p.sourceId === undefined ? {} : { sourceId: text(p.sourceId, 'Original configuration source') }),
    observedAt: p.observedAt as number, state: p.state as AgentConfigurationObservation['state'],
    ...(p.sequence === undefined ? {} : { sequence: p.sequence as number }),
    ...(issue ? { issue: { code: text(issue.code, 'Configuration observation issue'), message: text(issue.message, 'Configuration observation issue') } } : {}) }
}

export function parseAgentConfigurationSet(value: unknown): AgentConfigurationSet {
  const p = rpcRecord(value, ['target', 'operationId', 'configId', 'value', 'expectedRevision'])
  return { target: parsePostureTarget(p.target), operationId: rpcString(p.operationId, 'Original configuration operation'),
    configId: rpcString(p.configId, 'Original native configuration ID'), expectedRevision: rpcString(p.expectedRevision, 'Original configuration revision'),
    value: typeof p.value === 'boolean' ? p.value : rpcString(p.value, 'Original configuration value') }
}

export function parseAgentConfigurationInspect(value: unknown): AgentConfigurationInspect {
  const p = rpcRecord(value, ['hostId', 'agentSessionId', 'expectedRun', 'operationId'])
  const target = { hostId: rpcString(p.hostId, 'Original Host'), agentSessionId: rpcString(p.agentSessionId, 'Original Session') }
  if ((p.operationId === undefined) === (p.expectedRun === undefined)) throw new AgentMuxError('Inspect one exact Run or one original configuration operation.', 'INVALID_CONTROL_REQUEST')
  return p.operationId !== undefined ? { ...target, operationId: rpcString(p.operationId, 'Original configuration operation') }
    : { ...target, expectedRun: { runId: rpcString(rpcRecord(p.expectedRun, ['runId']).runId, 'Original Run') } }
}

export function parseAgentConfigurationReceipt(value: unknown, input?: AgentConfigurationSet): AgentConfigurationReceipt {
  const r = rpcRecord(value, ['action', 'operationId', 'target', 'configId', 'value', 'actor', 'phase', 'outcome', 'nativeOperationId',
    'runtime', 'acknowledgement', 'diskDurability', 'issue'], protocol)
  const target = parsePostureTarget(r.target), runtime = parseCreationRuntime(r.runtime)
  if (r.action !== 'agent-configuration' || runtime.runtimeId !== target.runtimeId ||
      !['prepared', 'dispatching', 'settled'].includes(String(r.phase)) ||
      !['not-dispatched', 'not-applied', 'applied', 'unknown'].includes(String(r.outcome)) ||
      !['confirmed', 'unconfirmed'].includes(String(r.diskDurability)) || r.issue !== undefined && typeof r.issue !== 'string' ||
      r.phase === 'prepared' && r.outcome !== 'not-dispatched' || r.phase === 'dispatching' && r.outcome !== 'unknown' ||
      r.phase === 'settled' && r.outcome === 'not-dispatched') throw invalid()
  const operationId = text(r.operationId, 'Original configuration operation')
  const configId = text(r.configId, 'Original configuration ID')
  const nativeOperationId = text(r.nativeOperationId, 'Original native configuration request')
  const selection = typeof r.value === 'boolean' ? r.value : text(r.value, 'Original configuration selection')
  const acknowledgement = r.acknowledgement === null ? null : parseAgentConfigurationSnapshot(r.acknowledgement)
  if ((r.outcome === 'applied') !== (acknowledgement !== null) || acknowledgement &&
      acknowledgement.options.find(option => option.id === configId)?.currentValue !== selection ||
      input && (operationId !== input.operationId || JSON.stringify(target) !== JSON.stringify(input.target) ||
        configId !== input.configId || selection !== input.value)) throw invalid()
  return { ...r, target, runtime, operationId, configId, value: selection, nativeOperationId,
    actor: parseRunControlActor(r.actor), acknowledgement } as AgentConfigurationReceipt
}

export function parseAgentConfigurationInspection(value: unknown, input: AgentConfigurationInspect): AgentConfigurationInspection {
  if (input.operationId !== undefined) {
    const p = rpcRecord(value, ['kind', 'agentSessionId', 'operationId', 'operation'], protocol)
    if (p.kind !== 'operation' || p.agentSessionId !== input.agentSessionId || p.operationId !== input.operationId) throw invalid()
    const operation = p.operation === null ? null : parseAgentConfigurationReceipt(p.operation)
    if (operation && (operation.operationId !== input.operationId ||
        operation.target.agentSessionId !== input.agentSessionId || operation.target.hostId !== input.hostId)) throw invalid()
    return { kind: 'operation', agentSessionId: input.agentSessionId, operationId: input.operationId, operation }
  }
  const p = rpcRecord(value, ['kind', 'target', 'snapshot'], protocol), target = parsePostureTarget(p.target)
  if (p.kind !== 'configuration' || target.hostId !== input.hostId || target.agentSessionId !== input.agentSessionId ||
      target.expectedRun.runId !== input.expectedRun.runId) throw invalid()
  return { kind: 'configuration', target, snapshot: p.snapshot === null ? null : parseAgentConfigurationSnapshot(p.snapshot) }
}
