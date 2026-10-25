import { AgentMuxError } from './errors.js'
import { parseHostedRuntimeOwnerIdentity } from './hosted-value.js'
import type { AgentMuxRuntimeFence, AgentMuxRuntimeOwnerIdentity } from './hosted-client-contract.js'
import { rpcRecord, rpcString } from './rpc-business-codec.js'
import { v8ProfileJSON, type V8Profile } from './v8-profile.js'

export type RuntimeV8ProfileInput = { fence: AgentMuxRuntimeFence; processId: number; durationMs: number }
export type HostV8ProfileInput = RuntimeV8ProfileInput & { hostId: string }
export type RuntimeV8ProfileResult = {
  schema: 'agentmux.runtime-v8-profile.v1'
  scope: 'semantic-host-main-thread-v8'
  owner: AgentMuxRuntimeOwnerIdentity
  durationMs: number
  status: 'completed' | 'failed' | 'cancelled' | 'unknown'
  timing: { requestedAt: number; startedAt: number | null; stoppedAt: number | null; finishedAt: number; elapsedMs: number }
  sourceVerified: { before: true; after: boolean }
  cleanup: { stopped: boolean; disabled: boolean; disconnected: boolean }
  profile: V8Profile | null
  profileBytes: number | null
  profileSha256: string | null
  issues: Array<{ stage: string; message: string }>
}

export function parseRuntimeV8ProfileInput(value: unknown, host = false): HostV8ProfileInput | RuntimeV8ProfileInput {
  const p = rpcRecord(value, ['fence', 'processId', 'durationMs', ...(host ? ['hostId'] : [])])
  const fence = rpcRecord(p.fence, ['runtimeId', 'ownerInstanceId'])
  rpcString(fence.runtimeId, 'Original Runtime'); rpcString(fence.ownerInstanceId, 'Original owner')
  if (!Number.isSafeInteger(p.processId) || (p.processId as number) <= 0 || !Number.isSafeInteger(p.durationMs) ||
      (p.durationMs as number) < 1000 || (p.durationMs as number) > 5000) throw new AgentMuxError(
    'Host profiling requires an exact positive process ID and a duration from 1000 to 5000 milliseconds.', 'INVALID_CONTROL_REQUEST')
  if (host) rpcString(p.hostId, 'Original route Host')
  return p as HostV8ProfileInput | RuntimeV8ProfileInput
}

export function parseRuntimeV8ProfileResult(value: unknown, input: RuntimeV8ProfileInput): RuntimeV8ProfileResult {
  const invalid = (): never => { throw new AgentMuxError('Host profile is malformed or belongs to another original process.', 'CONTROL_PROTOCOL_ERROR') }
  const p = rpcRecord(value, ['schema', 'scope', 'owner', 'durationMs', 'status', 'timing', 'sourceVerified', 'cleanup',
    'profile', 'profileBytes', 'profileSha256', 'issues'], 'CONTROL_PROTOCOL_ERROR')
  const owner = parseHostedRuntimeOwnerIdentity(p.owner)
  if (p.schema !== 'agentmux.runtime-v8-profile.v1' || p.scope !== 'semantic-host-main-thread-v8' ||
      owner.runtimeId !== input.fence.runtimeId || owner.ownerInstanceId !== input.fence.ownerInstanceId ||
      owner.processId !== input.processId || p.durationMs !== input.durationMs ||
      !['completed', 'failed', 'cancelled', 'unknown'].includes(p.status as string)) invalid()
  const timing = rpcRecord(p.timing, ['requestedAt', 'startedAt', 'stoppedAt', 'finishedAt', 'elapsedMs'], 'CONTROL_PROTOCOL_ERROR')
  for (const key of ['requestedAt', 'finishedAt', 'elapsedMs']) if (typeof timing[key] !== 'number' || !Number.isFinite(timing[key]) || timing[key] < 0) invalid()
  for (const key of ['startedAt', 'stoppedAt']) if (timing[key] !== null && (typeof timing[key] !== 'number' || !Number.isFinite(timing[key]) || timing[key] < 0)) invalid()
  const source = rpcRecord(p.sourceVerified, ['before', 'after'], 'CONTROL_PROTOCOL_ERROR')
  const cleanup = rpcRecord(p.cleanup, ['stopped', 'disabled', 'disconnected'], 'CONTROL_PROTOCOL_ERROR')
  if (source.before !== true || typeof source.after !== 'boolean' || Object.values(cleanup).length !== 3 ||
      Object.values(cleanup).some(v => typeof v !== 'boolean')) invalid()
  if (!Array.isArray(p.issues) || p.issues.length > 8) invalid()
  for (const issue of p.issues as unknown[]) {
    const item = rpcRecord(issue, ['stage', 'message'], 'CONTROL_PROTOCOL_ERROR')
    if (typeof item.stage !== 'string' || item.stage.length > 64 || typeof item.message !== 'string' || item.message.length > 512) invalid()
  }
  if (p.profile === null) {
    if (p.profileBytes !== null || p.profileSha256 !== null) invalid()
  } else {
    const bytes = new TextEncoder().encode(v8ProfileJSON(p.profile as V8Profile)).byteLength
    if (p.profileBytes !== bytes || typeof p.profileSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(p.profileSha256)) invalid()
  }
  if (p.status === 'completed' && (p.profile === null || !source.after || Object.values(cleanup).some(v => !v) ||
      timing.startedAt === null || timing.stoppedAt === null || (p.issues as unknown[]).length)) invalid()
  return p as RuntimeV8ProfileResult
}
