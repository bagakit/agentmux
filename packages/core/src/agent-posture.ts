import { parseRunControlActor, type RunControlActor } from './run-control-context.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import type { AgentPostureControl, AgentMuxRunInputAck } from './types.js'
import { parseCreationRuntime, type AgentMuxCreationRuntime } from './terminal-creation-retirement.js'
import { RISK_TIERS } from './risk-tier.js'

export type PostureTarget = { hostId: string; runtimeId: string; agentSessionId: string; expectedRun: { runId: string }; providerId: string }
export type PostureSet = { target: PostureTarget; operationId: string; controlId: string; modeId: string; expectedControlDigest: string }
export type PostureInspect = { hostId: string; agentSessionId: string } &
  ({ expectedRun: { runId: string }; operationId?: never } | { operationId: string; expectedRun?: never })
export type PostureReceipt = {
  action: 'agent-posture'; operationId: string; target: PostureTarget; controlId: string; modeId: string;
  actor: RunControlActor; phase: 'prepared' | 'dispatching' | 'settled';
  outcome: 'not-dispatched' | 'not-applied' | 'applied' | 'unknown';
  nativeOperationId: string; runtime: AgentMuxCreationRuntime;
  acknowledgement: AgentMuxRunInputAck | null; diskDurability: 'confirmed' | 'unconfirmed'; issue?: string
}
export type PostureInspection =
  | { kind: 'declaration'; target: PostureTarget; control: AgentPostureControl | null; controlDigest: string | null; currentMode: { status: 'unknown' } }
  | { kind: 'operation'; agentSessionId: string; operationId: string; operation: PostureReceipt | null }

export function postureControlDigest(control: AgentPostureControl): string {
  const normalized = { id: control.id, label: control.label,
    modes: control.modes.map(m => ({ id: m.id, label: m.label, description: m.description ?? null, tier: m.tier ?? null })) }
  return 'sha256:' + Array.from(sha256(new TextEncoder().encode(JSON.stringify(normalized))), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function parsePostureTarget(value: unknown): PostureTarget {
  const t = rpcRecord(value, ['hostId', 'runtimeId', 'agentSessionId', 'expectedRun', 'providerId'])
  const run = rpcRecord(t.expectedRun, ['runId'])
  return { hostId: rpcString(t.hostId, 'Original Host'), runtimeId: rpcString(t.runtimeId, 'Original Native Runtime'),
    agentSessionId: rpcString(t.agentSessionId, 'Original Session'), expectedRun: { runId: rpcString(run.runId, 'Original Run') }, providerId: rpcString(t.providerId, 'Original Provider') }
}
export function parsePostureSet(value: unknown): PostureSet {
  const p = rpcRecord(value, ['target', 'operationId', 'controlId', 'modeId', 'expectedControlDigest'])
  if (typeof p.expectedControlDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(p.expectedControlDigest)) throw new AgentMuxError('Keep the original posture declaration digest.', 'INVALID_CONTROL_REQUEST')
  return { target: parsePostureTarget(p.target), operationId: rpcString(p.operationId, 'Original posture operation'),
    controlId: rpcString(p.controlId, 'Provider control'), modeId: rpcString(p.modeId, 'Provider mode'), expectedControlDigest: p.expectedControlDigest }
}
export function parsePostureInspect(value: unknown): PostureInspect {
  const p = rpcRecord(value, ['hostId', 'agentSessionId', 'expectedRun', 'operationId'])
  const base = { hostId: rpcString(p.hostId, 'Original Host'), agentSessionId: rpcString(p.agentSessionId, 'Original Session') }
  if ((p.operationId === undefined) === (p.expectedRun === undefined)) throw new AgentMuxError('Inspect one exact expected Run or one original operation.', 'INVALID_CONTROL_REQUEST')
  return p.operationId !== undefined ? { ...base, operationId: rpcString(p.operationId, 'Original posture operation') }
    : { ...base, expectedRun: { runId: rpcString(rpcRecord(p.expectedRun, ['runId']).runId, 'Original Run') } }
}


function invalid(): never { throw new AgentMuxError('The original posture result is unconfirmed.', 'CONTROL_PROTOCOL_ERROR') }
export function parsePostureReceipt(value: unknown): PostureReceipt {
  const r = rpcRecord(value, ['action', 'operationId', 'target', 'controlId', 'modeId', 'actor', 'phase', 'outcome', 'nativeOperationId', 'runtime', 'acknowledgement', 'diskDurability', 'issue'], 'CONTROL_PROTOCOL_ERROR')
  const target = parsePostureTarget(r.target), runtime = parseCreationRuntime(r.runtime)
  if (r.action !== 'agent-posture' || runtime.runtimeId !== target.runtimeId ||
    !['prepared', 'dispatching', 'settled'].includes(String(r.phase)) || !['not-dispatched', 'not-applied', 'applied', 'unknown'].includes(String(r.outcome)) ||
    !['confirmed', 'unconfirmed'].includes(String(r.diskDurability)) || r.issue !== undefined && typeof r.issue !== 'string') invalid()
  for (const key of ['operationId', 'controlId', 'modeId', 'nativeOperationId']) rpcString(r[key], 'Original posture receipt')
  parseRunControlActor(r.actor)
  if (r.phase === 'prepared' && r.outcome !== 'not-dispatched' || r.phase === 'dispatching' && r.outcome !== 'unknown' ||
    r.phase === 'settled' && r.outcome === 'not-dispatched') invalid()
  if (r.acknowledgement !== null) {
    const ack = rpcRecord(r.acknowledgement, ['runId', 'appliedByteRange', 'acceptedThroughByte'], 'CONTROL_PROTOCOL_ERROR')
    const range = rpcRecord(ack.appliedByteRange, ['startByte', 'endByte'], 'CONTROL_PROTOCOL_ERROR')
    if (ack.runId !== target.expectedRun.runId || !Number.isSafeInteger(range.startByte) || !Number.isSafeInteger(range.endByte) ||
      Number(range.startByte) < 0 || Number(range.endByte) <= Number(range.startByte) ||
      !Number.isSafeInteger(ack.acceptedThroughByte) || Number(ack.acceptedThroughByte) < Number(range.endByte)) invalid()
  }
  if ((r.outcome === 'applied') !== (r.acknowledgement !== null)) invalid()
  return structuredClone({ ...r, target, runtime, actor: parseRunControlActor(r.actor) }) as PostureReceipt
}
export function parsePostureInspection(value: unknown, input: PostureInspect): PostureInspection {
  const p = rpcRecord(value, input.operationId === undefined ? ['kind', 'target', 'control', 'controlDigest', 'currentMode'] : ['kind', 'agentSessionId', 'operationId', 'operation'], 'CONTROL_PROTOCOL_ERROR')
  if (input.operationId !== undefined) {
    if (p.kind !== 'operation' || p.agentSessionId !== input.agentSessionId || p.operationId !== input.operationId) invalid()
    if (p.operation !== null) {
      const operation = parsePostureReceipt(p.operation)
      if (operation.operationId !== input.operationId || operation.target.agentSessionId !== input.agentSessionId || operation.target.hostId !== input.hostId) invalid()
    }
  } else {
    const target = parsePostureTarget(p.target), mode = rpcRecord(p.currentMode, ['status'], 'CONTROL_PROTOCOL_ERROR')
    if (p.kind !== 'declaration' || target.hostId !== input.hostId || target.agentSessionId !== input.agentSessionId || target.expectedRun.runId !== input.expectedRun.runId || mode.status !== 'unknown') invalid()
    if (p.control === null) { if (p.controlDigest !== null) invalid() }
    else {
      const control = rpcRecord(p.control, ['id', 'label', 'modes'], 'CONTROL_PROTOCOL_ERROR')
      rpcString(control.id, 'Provider posture control'); rpcString(control.label, 'Provider posture label')
      if (!Array.isArray(control.modes) || control.modes.length < 2) invalid()
      const ids = new Set<string>()
      for (const value of control.modes) {
        const item = rpcRecord(value, ['id', 'label', 'description', 'tier'], 'CONTROL_PROTOCOL_ERROR')
        const id = rpcString(item.id, 'Provider mode'); rpcString(item.label, 'Provider mode label')
        if (ids.has(id) || item.description !== undefined && typeof item.description !== 'string' || item.tier !== undefined && !RISK_TIERS.includes(item.tier as typeof RISK_TIERS[number])) invalid()
        ids.add(id)
      }
      if (p.controlDigest !== postureControlDigest(p.control as AgentPostureControl)) invalid()
    }
  }
  return structuredClone(p) as PostureInspection
}
export function parsePostureSetResult(value: unknown, input: PostureSet): PostureReceipt {
  input = parsePostureSet(input)
  const r = parsePostureReceipt(value)
  if (r.operationId !== input.operationId || JSON.stringify(r.target) !== JSON.stringify(input.target) || r.controlId !== input.controlId || r.modeId !== input.modeId) invalid()
  return r
}
