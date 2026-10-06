import { AgentMuxError } from './errors.js'
import type { RemoteCoreUpgradeCandidate, RemoteCoreUpgradeCheck, RemoteCoreUpgradeExpected, RemoteCoreUpgradeHost, RemoteCoreUpgradeReceipt,
  RemoteCoreMaintenanceOwner, RemoteCoreMaintenanceObservation } from './remote-core-upgrade.js'
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new AgentMuxError('Upgrade DTO has invalid fields.', 'CONTROL_PROTOCOL_ERROR')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 8192 || value.includes('\0')) throw new AgentMuxError('Upgrade DTO text is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return value
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new AgentMuxError('Upgrade DTO count is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return value as number
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new AgentMuxError('Upgrade DTO digest is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return value
}
function positive(value: unknown): number {
  const result = count(value)
  if (result < 1) throw new AgentMuxError('Maintenance process identity is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return result
}
function maintenanceOwner(value: unknown): RemoteCoreMaintenanceOwner {
  const p = record(value, ['runtimeId', 'ownerInstanceId', 'processId', 'ctxmux'])
  const native = record(p.ctxmux, ['instanceId', 'processId', 'buildIdentity', 'protocolVersion'])
  return { runtimeId: text(p.runtimeId), ownerInstanceId: text(p.ownerInstanceId), processId: positive(p.processId), ctxmux: {
    instanceId: text(native.instanceId), processId: native.processId === null ? null : positive(native.processId),
    buildIdentity: text(native.buildIdentity), protocolVersion: count(native.protocolVersion) } }
}
export function parseRemoteCoreMaintenanceShutdown(value: unknown): { accepted: true; owner: RemoteCoreMaintenanceOwner } {
  const p = record(value, ['accepted', 'owner'])
  if (p.accepted !== true) throw new AgentMuxError('Maintenance shutdown acknowledgement is unknown.', 'CONTROL_PROTOCOL_ERROR')
  return { accepted: true, owner: maintenanceOwner(p.owner) }
}
export function parseRemoteCoreMaintenanceObservation(value: unknown): RemoteCoreMaintenanceObservation {
  const p = record(value, ['owner', 'bootstrap', 'runs', 'missingRunIds', 'nativeRuntime']), owner = maintenanceOwner(p.owner)
  const bootstrap = record(p.bootstrap, ['storePath', 'hostProcessId', 'sessions'])
  const runtime = record(p.nativeRuntime, ['daemonInstanceId', 'runtimeId', 'buildId', 'protocolGeneration', 'runtimeIdPersistence', 'platform', 'arch', 'capabilities'])
  if (!Array.isArray(bootstrap.sessions) || !Array.isArray(p.runs) || !Array.isArray(p.missingRunIds) || !runtime.capabilities || typeof runtime.capabilities !== 'object' || Array.isArray(runtime.capabilities)) {
    throw new AgentMuxError('Maintenance inventory is invalid.', 'CONTROL_PROTOCOL_ERROR')
  }
  const capabilities = Object.fromEntries(Object.entries(runtime.capabilities).map(([key, version]) => [text(key), count(version)]))
  const sessions = bootstrap.sessions.map(value => {
    const session = record(value, ['agentSessionId', 'run']), run = record(session.run, ['runId'])
    return { agentSessionId: text(session.agentSessionId), run: { runId: text(run.runId) } }
  })
  const runs = p.runs.map(value => {
    const run = record(value, ['agentSessionId', 'runId', 'pid', 'state', 'outputBytes', 'inputBytes'])
    if (!['running', 'exited', 'interrupted'].includes(text(run.state))) throw new AgentMuxError('Maintenance Run state is invalid.', 'CONTROL_PROTOCOL_ERROR')
    return { agentSessionId: text(run.agentSessionId), runId: text(run.runId), pid: run.pid === null ? null : positive(run.pid),
      state: run.state as RemoteCoreMaintenanceObservation['runs'][number]['state'], outputBytes: count(run.outputBytes), inputBytes: run.inputBytes === null ? null : count(run.inputBytes) }
  })
  const bySession = new Map(runs.map(run => [run.agentSessionId, run])), bindings = new Map(sessions.map(session => [session.agentSessionId, session.run.runId]))
  const boundRunIds = new Set(bindings.values())
  const missingRunIds = p.missingRunIds.map(text), missing = new Set(missingRunIds)
  if (positive(bootstrap.hostProcessId) !== owner.processId || text(runtime.daemonInstanceId) !== owner.ctxmux.instanceId ||
    count(runtime.protocolGeneration) !== owner.ctxmux.protocolVersion || text(runtime.buildId) !== owner.ctxmux.buildIdentity ||
    bindings.size !== sessions.length || bySession.size !== runs.length ||
    missing.size !== missingRunIds.length || missingRunIds.some(id => !boundRunIds.has(id)) || runs.some(run => missing.has(run.runId)) ||
    sessions.some(session => bySession.get(session.agentSessionId)?.runId !== session.run.runId && !missing.has(session.run.runId)) ||
    runs.some(run => bindings.get(run.agentSessionId) !== run.runId)) {
    throw new AgentMuxError('Maintenance facts belong to different owners or Run bindings.', 'CONTROL_PROTOCOL_ERROR')
  }
  return { owner, bootstrap: { storePath: text(bootstrap.storePath), hostProcessId: owner.processId, sessions }, runs, missingRunIds,
    nativeRuntime: { daemonInstanceId: text(runtime.daemonInstanceId), runtimeId: text(runtime.runtimeId), buildId: text(runtime.buildId),
      protocolGeneration: count(runtime.protocolGeneration), runtimeIdPersistence: text(runtime.runtimeIdPersistence), platform: text(runtime.platform), arch: text(runtime.arch), capabilities } }
}
export function parseRemoteCoreUpgradeExpected(value: unknown): RemoteCoreUpgradeExpected {
  const p = record(value, ['targetDigest', 'runtimeId', 'ownerInstanceId', 'processId', 'startTicks', 'candidateDigest', 'nativeInstanceId', 'nativeProcessId', 'nativeStartTicks'])
  if (!/^\d+$/u.test(text(p.startTicks)) || !/^\d+$/u.test(text(p.nativeStartTicks)) || count(p.processId) < 1 || count(p.nativeProcessId) < 1) throw new AgentMuxError('Upgrade process identity is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return { targetDigest: digest(p.targetDigest), runtimeId: text(p.runtimeId), ownerInstanceId: text(p.ownerInstanceId), processId: count(p.processId),
    startTicks: text(p.startTicks), candidateDigest: digest(p.candidateDigest), nativeInstanceId: text(p.nativeInstanceId), nativeProcessId: count(p.nativeProcessId), nativeStartTicks: text(p.nativeStartTicks) }
}
function host(value: unknown): RemoteCoreUpgradeHost {
  const p = record(value, ['id', 'kind', 'label', 'hostname', 'user', 'port', 'identityFile', 'remoteCommand', 'remoteSocketPath', 'runtimeId'])
  text(p.id); text(p.label)
  if (p.kind === 'local') {
    if (Object.keys(p).some(key => !['id', 'kind', 'label'].includes(key))) throw new AgentMuxError('Local upgrade input has SSH fields.', 'CONTROL_PROTOCOL_ERROR')
  } else if (p.kind === 'ssh') {
    text(p.hostname)
    for (const key of ['user', 'identityFile', 'remoteCommand', 'remoteSocketPath', 'runtimeId']) if (p[key] !== undefined) text(p[key])
    if (p.port !== undefined && (count(p.port) < 1 || count(p.port) > 65535)) throw new AgentMuxError('Upgrade SSH port is invalid.', 'CONTROL_PROTOCOL_ERROR')
  } else throw new AgentMuxError('Upgrade input kind is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return p as unknown as RemoteCoreUpgradeHost
}
function candidate(value: unknown): RemoteCoreUpgradeCandidate {
  const p = record(value, ['digest', 'sourceCommit', 'protocolVersion'])
  return { digest: digest(p.digest), sourceCommit: p.sourceCommit === null ? null : text(p.sourceCommit), protocolVersion: count(p.protocolVersion) }
}
export function parseRemoteCoreUpgradeReceipt(value: unknown): RemoteCoreUpgradeReceipt {
  const p = record(value, ['input', 'operationId', 'expected', 'status', 'stage', 'detail', 'remoteCommand', 'updatedAt'])
  if (!['running', 'completed', 'failed', 'unknown'].includes(text(p.status)) || !['preparing', 'staged', 'stopping', 'starting', 'verifying', 'completed'].includes(text(p.stage))) throw new AgentMuxError('Upgrade outcome is invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (p.status === 'completed' && (p.stage !== 'completed' || !p.remoteCommand)) throw new AgentMuxError('Completed upgrade lacks its serving command.', 'CONTROL_PROTOCOL_ERROR')
  return { input: host(p.input), operationId: text(p.operationId), expected: parseRemoteCoreUpgradeExpected(p.expected),
    status: p.status as RemoteCoreUpgradeReceipt['status'], stage: p.stage as RemoteCoreUpgradeReceipt['stage'], detail: text(p.detail),
    ...(p.remoteCommand === undefined ? {} : { remoteCommand: text(p.remoteCommand) }), updatedAt: count(p.updatedAt) }
}
export function parseRemoteCoreUpgradeCheck(value: unknown): RemoteCoreUpgradeCheck {
  const p = record(value, ['input', 'candidate', 'eligible', 'reason', 'detail', 'expected', 'latestOperation'])
  if (typeof p.eligible !== 'boolean' || p.eligible !== (p.expected !== undefined)) throw new AgentMuxError('Upgrade eligibility does not match its checked admission.', 'CONTROL_PROTOCOL_ERROR')
  if (!['ready', 'runtime-update-required', 'unverified'].includes(text(p.reason)) || p.eligible !== (p.reason === 'ready')) throw new AgentMuxError('Upgrade reason does not match its eligibility.', 'CONTROL_PROTOCOL_ERROR')
  return { input: host(p.input), candidate: candidate(p.candidate), eligible: p.eligible, reason: p.reason as RemoteCoreUpgradeCheck['reason'], detail: text(p.detail),
    ...(p.expected === undefined ? {} : { expected: parseRemoteCoreUpgradeExpected(p.expected) }),
    ...(p.latestOperation === undefined ? {} : { latestOperation: parseRemoteCoreUpgradeReceipt(p.latestOperation) }) }
}
