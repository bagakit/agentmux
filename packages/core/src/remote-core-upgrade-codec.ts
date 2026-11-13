import { AgentMuxError } from './errors.js'
import type { RemoteCoreCurrentObservation, RemoteCoreUpgradeCandidate, RemoteCoreUpgradeCheck, RemoteCoreUpgradeExpected, RemoteCoreUpgradeHost, RemoteCoreUpgradeReceipt,
  RemoteCoreMaintenanceOwner, RemoteCoreMaintenanceObservation } from './remote-core-upgrade.js'
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new AgentMuxError('Upgrade DTO has invalid fields.', 'CONTROL_PROTOCOL_ERROR')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 8192 || value.includes('\0')) throw new AgentMuxError('Upgrade DTO text is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return value
}
function tailcatField(value: unknown, required: boolean): string {
  if (typeof value !== 'string' || value.length > 8192 || /[\0\r\n]/u.test(value) || required && !value.trim()) throw new AgentMuxError('Upgrade Tailcat target is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return value
}
function operationIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(id))) throw new AgentMuxError('Upgrade unreadable operation IDs are invalid.', 'CONTROL_PROTOCOL_ERROR')
  return [...value] as string[]
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
  const p = record(value, ['runtimeId', 'ownerInstanceId', 'processId', 'protocolVersion', 'ctxmux'])
  const native = record(p.ctxmux, ['instanceId', 'processId', 'buildIdentity', 'protocolVersion'])
  return { runtimeId: text(p.runtimeId), ownerInstanceId: text(p.ownerInstanceId), processId: positive(p.processId), protocolVersion: positive(p.protocolVersion), ctxmux: {
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
  const p = record(value, ['id', 'kind', 'label', 'hostname', 'user', 'port', 'identityFile', 'remoteCommand', 'remoteSocketPath', 'runtimeId', 'transport', 'tailcat'])
  text(p.id); text(p.label)
  if (p.kind === 'local') {
    if (Object.keys(p).some(key => !['id', 'kind', 'label', 'tailcat'].includes(key))) throw new AgentMuxError('Local upgrade input has SSH fields.', 'CONTROL_PROTOCOL_ERROR')
    if (p.tailcat !== undefined) {
      const t = record(p.tailcat, ['enabled', 'keyFile', 'allowedClients'])
      if (typeof t.enabled !== 'boolean' || typeof t.keyFile !== 'string' || !Array.isArray(t.allowedClients)) throw new AgentMuxError('Invalid local Tailcat configuration.', 'CONTROL_PROTOCOL_ERROR')
      for (const key of t.allowedClients) text(key)
    }
  } else if (p.kind === 'ssh') {
    if (p.transport !== 'tailcat') text(p.hostname)
    else if (typeof p.hostname !== 'string') throw new AgentMuxError('Invalid remote hostname.', 'CONTROL_PROTOCOL_ERROR')
    if (p.transport !== undefined && !['ssh', 'ssh-tailcat', 'tailcat'].includes(p.transport as string)) throw new AgentMuxError('Invalid remote transport.', 'CONTROL_PROTOCOL_ERROR')
    // Same values as the saved Host record: an unused Tailcat target may stay empty.
    const tailcatRequired = p.transport === 'tailcat' || p.transport === 'ssh-tailcat'
    if (p.tailcat !== undefined) { const t = record(p.tailcat, ['address', 'keyFile']); tailcatField(t.address, tailcatRequired); tailcatField(t.keyFile, tailcatRequired) }
    if ((p.transport === 'tailcat' || p.transport === 'ssh-tailcat') && p.tailcat === undefined) throw new AgentMuxError('Missing Tailcat target.', 'CONTROL_PROTOCOL_ERROR')
    for (const key of ['user', 'identityFile', 'remoteCommand', 'remoteSocketPath', 'runtimeId']) if (p[key] !== undefined) text(p[key])
    if (p.port !== undefined && (count(p.port) < 1 || count(p.port) > 65535)) throw new AgentMuxError('Upgrade SSH port is invalid.', 'CONTROL_PROTOCOL_ERROR')
  } else throw new AgentMuxError('Upgrade input kind is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return p as unknown as RemoteCoreUpgradeHost
}
function candidate(value: unknown): RemoteCoreUpgradeCandidate {
  const p = record(value, ['digest', 'sourceCommit', 'version', 'ownerProtocolVersion', 'requiredNativeProtocolVersion'])
  return { digest: digest(p.digest), sourceCommit: p.sourceCommit === null ? null : text(p.sourceCommit), version: p.version === null ? null : text(p.version),
    ownerProtocolVersion: p.ownerProtocolVersion === null ? null : positive(p.ownerProtocolVersion), requiredNativeProtocolVersion: positive(p.requiredNativeProtocolVersion) }
}
function current(value: unknown): RemoteCoreCurrentObservation {
  const p = record(value, ['state', 'observedAt', 'version', 'sourceCommit', 'deploymentDigest', 'ownerProtocolVersion', 'runtimeId', 'ownerInstanceId', 'processId', 'native', 'code', 'detail'])
  const observedAt = count(p.observedAt)
  if (p.state === 'unavailable') {
    if (Object.keys(p).some(key => !['state', 'observedAt', 'code', 'detail'].includes(key))) throw new AgentMuxError('Unavailable current Core has serving facts.', 'CONTROL_PROTOCOL_ERROR')
    return { state: 'unavailable', observedAt, code: text(p.code), detail: text(p.detail) }
  }
  if (p.state !== 'available' || p.code !== undefined || p.detail !== undefined) throw new AgentMuxError('Current Core observation is invalid.', 'CONTROL_PROTOCOL_ERROR')
  const native = record(p.native, ['instanceId', 'buildId', 'protocolVersion'])
  return { state: 'available', observedAt, version: p.version === null ? null : text(p.version), sourceCommit: p.sourceCommit === null ? null : text(p.sourceCommit),
    deploymentDigest: digest(p.deploymentDigest), ownerProtocolVersion: positive(p.ownerProtocolVersion), runtimeId: text(p.runtimeId), ownerInstanceId: text(p.ownerInstanceId), processId: positive(p.processId),
    native: { instanceId: text(native.instanceId), buildId: text(native.buildId), protocolVersion: positive(native.protocolVersion) } }
}
export function parseRemoteCoreUpgradeReceipt(value: unknown): RemoteCoreUpgradeReceipt {
  const p = record(value, ['input', 'operationId', 'expected', 'status', 'stage', 'detail', 'remoteCommand', 'updatedAt', 'candidate', 'connectionAdoption'])
  if (!['running', 'completed', 'failed', 'unknown'].includes(text(p.status)) || !['preparing', 'staged', 'stopping', 'starting', 'verifying', 'completed'].includes(text(p.stage))) throw new AgentMuxError('Upgrade outcome is invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (p.status === 'completed' && (p.stage !== 'completed' || !p.remoteCommand)) throw new AgentMuxError('Completed upgrade lacks its serving command.', 'CONTROL_PROTOCOL_ERROR')
  const expected = parseRemoteCoreUpgradeExpected(p.expected), target = p.candidate === undefined ? undefined : candidate(p.candidate)
  if (target && target.digest !== expected.candidateDigest) throw new AgentMuxError('Original operation candidate belongs to another admission.', 'CONTROL_PROTOCOL_ERROR')
  let connectionAdoption: RemoteCoreUpgradeReceipt['connectionAdoption']
  if (p.connectionAdoption !== undefined) {
    const a = record(p.connectionAdoption, ['state', 'readAt', 'code', 'detail'])
    if (p.status !== 'completed' || !['pending-confirmation', 'connected', 'unconfirmed'].includes(text(a.state))) throw new AgentMuxError('Connection adoption lacks its completed deployment.', 'CONTROL_PROTOCOL_ERROR')
    connectionAdoption = { state: a.state as NonNullable<RemoteCoreUpgradeReceipt['connectionAdoption']>['state'], readAt: count(a.readAt),
      ...(a.code === undefined ? {} : { code: text(a.code) }), ...(a.detail === undefined ? {} : { detail: text(a.detail) }) }
  }
  return { input: host(p.input), operationId: text(p.operationId), expected,
    status: p.status as RemoteCoreUpgradeReceipt['status'], stage: p.stage as RemoteCoreUpgradeReceipt['stage'], detail: text(p.detail),
    ...(p.remoteCommand === undefined ? {} : { remoteCommand: text(p.remoteCommand) }), updatedAt: count(p.updatedAt),
    ...(target === undefined ? {} : { candidate: target }), ...(connectionAdoption === undefined ? {} : { connectionAdoption }) }
}
export function parseRemoteCoreUpgradeCheck(value: unknown): RemoteCoreUpgradeCheck {
  const p = record(value, ['input', 'current', 'candidate', 'candidateUnavailable', 'eligible', 'reason', 'detail', 'expected', 'latestOperation', 'unreadableOperations'])
  if (typeof p.eligible !== 'boolean' || p.eligible !== (p.expected !== undefined)) throw new AgentMuxError('Upgrade eligibility does not match its checked admission.', 'CONTROL_PROTOCOL_ERROR')
  if (!['ready', 'up-to-date', 'runtime-update-required', 'unverified'].includes(text(p.reason)) || p.eligible !== (p.reason === 'ready')) throw new AgentMuxError('Upgrade reason does not match its eligibility.', 'CONTROL_PROTOCOL_ERROR')
  const serving = current(p.current), target = p.candidate === null ? null : candidate(p.candidate), input = host(p.input)
  let candidateUnavailable: RemoteCoreUpgradeCheck['candidateUnavailable']
  if (p.candidateUnavailable !== undefined) {
    const failure = record(p.candidateUnavailable, ['code', 'detail'])
    candidateUnavailable = { code: text(failure.code), detail: text(failure.detail) }
  }
  if (target === null ? !candidateUnavailable || p.eligible || p.expected !== undefined || p.reason !== 'unverified' : candidateUnavailable !== undefined) {
    throw new AgentMuxError('Candidate availability does not match its upgrade admission.', 'CONTROL_PROTOCOL_ERROR')
  }
  if (serving.state === 'available' && input.kind === 'ssh' && input.runtimeId && serving.runtimeId !== input.runtimeId ||
      p.reason === 'up-to-date' && (serving.state !== 'available' || !target || serving.deploymentDigest !== target.digest)) throw new AgentMuxError('Current Core belongs to another update target.', 'CONTROL_PROTOCOL_ERROR')
  if (p.expected !== undefined) {
    const admission = parseRemoteCoreUpgradeExpected(p.expected)
    if (serving.state !== 'available' || !target || admission.candidateDigest !== target.digest || admission.runtimeId !== serving.runtimeId ||
        admission.ownerInstanceId !== serving.ownerInstanceId || admission.processId !== serving.processId || admission.nativeInstanceId !== serving.native.instanceId) {
      throw new AgentMuxError('Upgrade candidate or current owner differs from checked admission.', 'CONTROL_PROTOCOL_ERROR')
    }
  }
  return { input, current: serving, candidate: target, eligible: p.eligible, reason: p.reason as RemoteCoreUpgradeCheck['reason'], detail: text(p.detail),
    ...(candidateUnavailable === undefined ? {} : { candidateUnavailable }),
    ...(p.expected === undefined ? {} : { expected: parseRemoteCoreUpgradeExpected(p.expected) }),
    ...(p.latestOperation === undefined ? {} : { latestOperation: parseRemoteCoreUpgradeReceipt(p.latestOperation) }),
    ...(p.unreadableOperations === undefined ? {} : { unreadableOperations: operationIds(p.unreadableOperations) }) }
}
