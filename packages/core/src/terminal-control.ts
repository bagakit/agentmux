import { sha256 } from '@noble/hashes/sha2.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import { parseTerminalTarget, type TerminalTarget } from './terminal-observation.js'
import { parseCreationRuntime, type AgentMuxCreationRuntime } from './terminal-creation-retirement.js'
import { parseRunControlActor, type RunControlActor } from './run-control-context.js'

export type TerminalControlIntent = { target: TerminalTarget; operationId: string; ownerInstanceId: string }
export type TerminalInputIntent = TerminalControlIntent & { expectedByte: number; dataBase64: string }
export type TerminalControlRequest =
  | TerminalInputIntent & { action: 'terminal-input' }
  | TerminalControlIntent & { action: 'terminal-interrupt' | 'terminal-stop' }
export type TerminalControlAction = TerminalControlRequest['action']
export type TerminalControlInspect = { hostId: string; run: { runId: string }; operationId: string; runtimeId?: string }
export type TerminalControlAcknowledgement =
  | { kind: 'input'; runId: string; appliedByteRange: { startByte: number; endByte: number }; acceptedThroughByte: number }
  | { kind: 'input-noop'; runId: string; inputByte: number }
  | { kind: 'interrupt'; runId: string; signal: 'SIGINT' }
  | { kind: 'stop'; runId: string; disposition: 'graceful' | 'forced'; state: 'exited' | 'interrupted' }
  | { kind: 'stop-absent'; runId: string }
export type TerminalControlReceipt = {
  action: TerminalControlAction; operationId: string; target: TerminalTarget; actor: RunControlActor;
  ownerInstanceId: string; runtime: AgentMuxCreationRuntime; nativeOperationId: string | null;
  input?: { expectedByte: number; bytes: number; digest: string };
  phase: 'prepared' | 'dispatching' | 'settled'; outcome: 'not-dispatched' | 'not-applied' | 'applied' | 'unknown' | 'no-op';
  acknowledgement: TerminalControlAcknowledgement | null; diskDurability: 'confirmed' | 'unconfirmed'; issue?: string
}
export type TerminalStopResult = { kind: 'acknowledged'; runId: string; disposition: 'graceful' | 'forced'; state: 'exited' | 'interrupted' }
  | { kind: 'absent'; runId: string }
const member = (value: unknown, allowed: readonly string[]): value is string => typeof value === 'string' && allowed.includes(value)
const count = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0
const invalid = (): never => { throw new AgentMuxError('The original raw Terminal operation result is unconfirmed.', 'CONTROL_PROTOCOL_ERROR') }
export function terminalInputBytes(base64: unknown): Uint8Array {
  if (typeof base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64))
    throw new AgentMuxError('Terminal input must be canonical base64 bytes; no quoting or newline is added.', 'INVALID_CONTROL_REQUEST')
  const decoded = atob(base64)
  if (btoa(decoded) !== base64) throw new AgentMuxError('Terminal input must retain its canonical original bytes.', 'INVALID_CONTROL_REQUEST')
  return Uint8Array.from(decoded, c => c.charCodeAt(0))
}
export function terminalInputDescriptor(input: TerminalInputIntent): NonNullable<TerminalControlReceipt['input']> {
  const bytes = terminalInputBytes(input.dataBase64)
  return { expectedByte: input.expectedByte, bytes: bytes.byteLength,
    digest: 'sha256:' + Array.from(sha256(bytes), byte => byte.toString(16).padStart(2, '0')).join('') }
}
export function parseTerminalControl(value: unknown, action?: TerminalControlAction): TerminalControlRequest {
  const raw = rpcRecord(value)
  const selected = action ?? raw.action
  if (!member(selected, ['terminal-input', 'terminal-interrupt', 'terminal-stop']))
    throw new AgentMuxError('Choose one exact raw Terminal input, interrupt or stop intent.', 'INVALID_CONTROL_REQUEST')
  const p = rpcRecord(raw, ['target', 'operationId', 'ownerInstanceId', ...(action === undefined ? ['action'] : []), ...(selected === 'terminal-input' ? ['expectedByte', 'dataBase64'] : [])])
  const base = { target: parseTerminalTarget(p.target), operationId: rpcString(p.operationId, 'Original Terminal operation'), ownerInstanceId: rpcString(p.ownerInstanceId, 'Original Native incarnation') }
  if (selected !== 'terminal-input') return { ...base, action: selected as 'terminal-interrupt' | 'terminal-stop' }
  if (!count(p.expectedByte)) throw new AgentMuxError('Keep the exact original Native input byte precondition.', 'INVALID_CONTROL_REQUEST')
  terminalInputBytes(p.dataBase64)
  return { ...base, action: 'terminal-input', expectedByte: p.expectedByte, dataBase64: p.dataBase64 as string }
}
export function parseTerminalControlInspect(value: unknown): TerminalControlInspect {
  const p = rpcRecord(value, ['hostId', 'run', 'operationId', 'runtimeId']), run = rpcRecord(p.run, ['runId'])
  return { hostId: rpcString(p.hostId, 'Original Host'), run: { runId: rpcString(run.runId, 'Original raw Run') }, operationId: rpcString(p.operationId, 'Original Terminal operation'),
    ...(p.runtimeId === undefined ? {} : { runtimeId: rpcString(p.runtimeId, 'Original Native Runtime') }) }
}

export function parseTerminalControlReceipt(value: unknown): TerminalControlReceipt {
  const p = rpcRecord(value, ['action', 'operationId', 'target', 'actor', 'ownerInstanceId', 'runtime', 'nativeOperationId', 'input', 'phase', 'outcome', 'acknowledgement', 'diskDurability', 'issue'], 'CONTROL_PROTOCOL_ERROR')
  const target = parseTerminalTarget(p.target), runtime = parseCreationRuntime(p.runtime), actor = parseRunControlActor(p.actor)
  if (!member(p.action, ['terminal-input', 'terminal-interrupt', 'terminal-stop']) || runtime.runtimeId !== target.runtimeId || runtime.instanceId !== p.ownerInstanceId ||
    !member(p.phase, ['prepared', 'dispatching', 'settled']) || !member(p.outcome, ['not-dispatched', 'not-applied', 'applied', 'unknown', 'no-op']) ||
    !member(p.diskDurability, ['confirmed', 'unconfirmed']) || p.issue !== undefined && typeof p.issue !== 'string') invalid()
  rpcString(p.operationId, 'Original Terminal operation'); rpcString(p.ownerInstanceId, 'Original Native incarnation')
  if (p.nativeOperationId !== null) rpcString(p.nativeOperationId, 'Original Native operation')
  if (p.phase === 'prepared' && p.outcome !== 'not-dispatched' || p.phase === 'dispatching' && p.outcome !== 'unknown' || p.phase === 'settled' && p.outcome === 'not-dispatched') invalid()
  if (p.action === 'terminal-input') {
    const input = rpcRecord(p.input, ['expectedByte', 'bytes', 'digest'], 'CONTROL_PROTOCOL_ERROR')
    if (!count(input.expectedByte) || !count(input.bytes) || typeof input.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(input.digest)) invalid()
    if ((input.bytes === 0) !== (p.nativeOperationId === null)) invalid()
  } else if (p.input !== undefined || (p.action === 'terminal-interrupt') !== (p.nativeOperationId === null)) invalid()
  if (p.acknowledgement !== null) {
    const a = rpcRecord(p.acknowledgement, undefined, 'CONTROL_PROTOCOL_ERROR')
    if (a.runId !== target.run.runId) invalid()
    if (a.kind === 'input' && p.action === 'terminal-input') {
      rpcRecord(a, ['kind', 'runId', 'appliedByteRange', 'acceptedThroughByte'], 'CONTROL_PROTOCOL_ERROR')
      const r = rpcRecord(a.appliedByteRange, ['startByte', 'endByte'], 'CONTROL_PROTOCOL_ERROR'), input = p.input as NonNullable<TerminalControlReceipt['input']>
      if (!count(r.startByte) || !count(r.endByte) || !count(a.acceptedThroughByte) || r.startByte !== input.expectedByte || r.endByte - r.startByte !== input.bytes || input.bytes === 0 || a.acceptedThroughByte < r.endByte || p.outcome !== 'applied') invalid()
    } else if (a.kind === 'input-noop' && p.action === 'terminal-input') {
      rpcRecord(a, ['kind', 'runId', 'inputByte'], 'CONTROL_PROTOCOL_ERROR'); if ((p.input as NonNullable<TerminalControlReceipt['input']>).bytes !== 0 || a.inputByte !== (p.input as NonNullable<TerminalControlReceipt['input']>).expectedByte || p.outcome !== 'no-op') invalid()
    } else if (a.kind === 'interrupt' && p.action === 'terminal-interrupt') {
      rpcRecord(a, ['kind', 'runId', 'signal'], 'CONTROL_PROTOCOL_ERROR'); if (a.signal !== 'SIGINT' || p.outcome !== 'applied') invalid()
    } else if (a.kind === 'stop' && p.action === 'terminal-stop') {
      rpcRecord(a, ['kind', 'runId', 'disposition', 'state'], 'CONTROL_PROTOCOL_ERROR'); if (!member(a.disposition, ['graceful', 'forced']) || !member(a.state, ['exited', 'interrupted']) || p.outcome !== 'applied') invalid()
    } else if (a.kind === 'stop-absent' && p.action === 'terminal-stop') {
      rpcRecord(a, ['kind', 'runId'], 'CONTROL_PROTOCOL_ERROR'); if (p.outcome !== 'no-op') invalid()
    } else invalid()
  } else if (p.outcome === 'applied' || p.outcome === 'no-op') invalid()
  return { ...p, target, runtime, actor } as TerminalControlReceipt
}
export function parseTerminalControlResult(value: unknown, request: TerminalControlRequest): TerminalControlReceipt {
  const r = parseTerminalControlReceipt(value)
  if (r.action !== request.action || r.operationId !== request.operationId || JSON.stringify(r.target) !== JSON.stringify(request.target) || r.ownerInstanceId !== request.ownerInstanceId ||
    request.action === 'terminal-input' && JSON.stringify(r.input) !== JSON.stringify(terminalInputDescriptor(request))) invalid()
  return r
}
export function parseTerminalControlInspection(value: unknown, input: TerminalControlInspect): { hostId: string; run: { runId: string }; operationId: string; operation: TerminalControlReceipt | null } {
  const p = rpcRecord(value, ['hostId', 'run', 'operationId', 'operation'], 'CONTROL_PROTOCOL_ERROR'), run = rpcRecord(p.run, ['runId'], 'CONTROL_PROTOCOL_ERROR')
  if (p.hostId !== input.hostId || p.operationId !== input.operationId || run.runId !== input.run.runId) invalid()
  const operation = p.operation === null ? null : parseTerminalControlReceipt(p.operation)
  if (operation && (operation.operationId !== input.operationId || operation.target.hostId !== input.hostId || operation.target.run.runId !== input.run.runId || input.runtimeId !== undefined && operation.target.runtimeId !== input.runtimeId)) invalid()
  return { hostId: input.hostId, run: { ...input.run }, operationId: input.operationId, operation }
}
