import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseCreationRuntime, type AgentMuxCreationRuntime } from './terminal-creation-retirement.js'
import { parseRawTerminalRun } from './terminal-observation.js'
import type { AgentMuxRun } from './types.js'

export type TerminalCreationInspect = { hostId: string; operationId: string; runtimeId?: string; includeRetirementBlocker?: true }
export type TerminalCreationRetire = Omit<TerminalCreationInspect, 'includeRetirementBlocker'> & { runtimeId: string }
export type TerminalCreationRetirement = {
  request: {operationId: string; runtimeId: string; dispatchRuntime: AgentMuxCreationRuntime|null}
  phase: 'dispatched'|'observed'|'unconfirmed'
  native: null | ({runtime:AgentMuxCreationRuntime}&({outcome:'retired'}|{outcome:'retained';run:AgentMuxRun}))
  diskDurability:'confirmed'|'unconfirmed'
}
export type TerminalCreationInspection = {
  hostId: string; operationId: string; known: boolean
  admission: null | {
    runtime: AgentMuxCreationRuntime; workspacePath: string
    phase: 'dispatched' | 'published' | 'retired' | 'unconfirmed'
    /** Last exact positive Native fact, with its own observedAt; not current liveness when observation is unavailable. */
    run: AgentMuxRun | null
    observation: { availability: 'retained' | 'not-observed' | 'unavailable'; runtime: AgentMuxCreationRuntime | null }
    diskDurability: 'confirmed' | 'unconfirmed'; issue?: string
    startFailure?: {operationId:string;disposition:'not_applied'|'unknown';code:string;observedAt:number}
    retirement?: TerminalCreationRetirement
    retirementBlocker?: 'agent-role-unconfirmed'
  }
}
const bad = (): never => { throw new AgentMuxError('The original Terminal creation observation is unconfirmed.', 'CONTROL_PROTOCOL_ERROR') }
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && !/[\0\r\n]/u.test(v)
export function parseTerminalCreationInspect(value: unknown): TerminalCreationInspect {
  const r = rpcRecord(value, ['hostId', 'operationId', 'runtimeId', 'includeRetirementBlocker'])
  if (!id(r.hostId) || !id(r.operationId) || r.runtimeId !== undefined && !id(r.runtimeId) ||
      Object.hasOwn(r, 'includeRetirementBlocker') && r.includeRetirementBlocker !== true)
    throw new AgentMuxError('Use the original Host and creation operation ID.', 'INVALID_CONTROL_REQUEST')
  return structuredClone(r) as TerminalCreationInspect
}
export function parseTerminalCreationRetire(value: unknown): TerminalCreationRetire {
  const input=parseTerminalCreationInspect(value)
  if(!input.runtimeId || input.includeRetirementBlocker) throw new AgentMuxError('Explicit retirement requires the original persistent Runtime.','INVALID_CONTROL_REQUEST')
  return input as TerminalCreationRetire
}
export function parseTerminalCreationInspection(value: unknown, input: TerminalCreationInspect): TerminalCreationInspection {
  const r = rpcRecord(value, ['hostId', 'operationId', 'known', 'admission'], 'CONTROL_PROTOCOL_ERROR')
  if (r.hostId !== input.hostId || r.operationId !== input.operationId || typeof r.known !== 'boolean' || r.known !== (r.admission !== null)) bad()
  if (r.admission === null) return structuredClone(r) as TerminalCreationInspection
  const a = rpcRecord(r.admission, ['runtime', 'workspacePath', 'phase', 'run', 'observation', 'diskDurability', 'issue', 'startFailure', 'retirement', 'retirementBlocker'], 'CONTROL_PROTOCOL_ERROR')
  const runtime = parseCreationRuntime(a.runtime)
  const o = rpcRecord(a.observation, ['availability', 'runtime'], 'CONTROL_PROTOCOL_ERROR')
  if (input.runtimeId !== undefined && runtime.runtimeId !== input.runtimeId || typeof a.workspacePath !== 'string' || a.workspacePath.length === 0 || a.workspacePath.includes('\0') ||
    !['dispatched', 'published', 'retired', 'unconfirmed'].includes(String(a.phase)) || !['confirmed', 'unconfirmed'].includes(String(a.diskDurability)) ||
    !['retained', 'not-observed', 'unavailable'].includes(String(o.availability)) || a.issue !== undefined && typeof a.issue !== 'string') bad()
  if (o.runtime !== null && parseCreationRuntime(o.runtime).runtimeId !== runtime.runtimeId || o.availability === 'retained' && (o.runtime === null || a.run === null)) bad()
  if (a.run !== null) {
    const run = parseRawTerminalRun(a.run, String(rpcRecord(a.run).runId))
    if (run.workspacePath !== a.workspacePath) bad()
  }
  if(a.startFailure!==undefined) {
    const f=rpcRecord(a.startFailure,['operationId','disposition','code','observedAt'],'CONTROL_PROTOCOL_ERROR')
    if(f.operationId!==input.operationId || !['not_applied','unknown'].includes(String(f.disposition)) || !id(f.code) || typeof f.observedAt!=='number' || !Number.isFinite(f.observedAt)) bad()
  }
  if(a.retirement!==undefined) {
    const t=rpcRecord(a.retirement,['request','phase','native','diskDurability'],'CONTROL_PROTOCOL_ERROR'),q=rpcRecord(t.request,['operationId','runtimeId','dispatchRuntime'],'CONTROL_PROTOCOL_ERROR')
    if(q.operationId!==input.operationId || q.runtimeId!==runtime.runtimeId || q.dispatchRuntime!==null && parseCreationRuntime(q.dispatchRuntime).runtimeId!==runtime.runtimeId ||
      !['dispatched','observed','unconfirmed'].includes(String(t.phase)) || !['confirmed','unconfirmed'].includes(String(t.diskDurability))) bad()
    if(t.native!==null) {
      const n=rpcRecord(t.native,undefined,'CONTROL_PROTOCOL_ERROR')
      if(parseCreationRuntime(n.runtime).runtimeId!==runtime.runtimeId || !['retired','retained'].includes(String(n.outcome))) bad()
      rpcRecord(n,n.outcome==='retained'?['runtime','outcome','run']:['runtime','outcome'],'CONTROL_PROTOCOL_ERROR')
      if(n.outcome==='retained' && parseRawTerminalRun(n.run,String(rpcRecord(n.run).runId)).workspacePath!==a.workspacePath) bad()
      if(t.phase!=='observed') bad()
    } else if(t.phase==='observed') bad()
  }
  if (a.phase === 'retired' && a.run !== null || a.phase === 'published' && a.run === null) bad()
  if (Object.hasOwn(a, 'retirementBlocker') && (!input.includeRetirementBlocker || a.retirementBlocker !== 'agent-role-unconfirmed' ||
      a.phase !== 'dispatched' || a.run !== null || o.availability !== 'not-observed' || o.runtime === null || a.retirement !== undefined)) bad()
  return structuredClone(r) as TerminalCreationInspection
}
