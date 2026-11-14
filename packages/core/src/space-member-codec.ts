import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import { parseSpaceAuthorityRef } from './space-authority.js'
import { decodeHostedValue } from './hosted-value.js'
import { AGENTMUX_HOSTED_RPC_FIELDS } from './hosted-client-contract.js'
import { SPACE_MEMBER_CALLS, SPACE_MEMBER_STREAMS, SPACE_MEMBER_INVOCATIONS, type SpaceMemberTarget, type SpaceMemberParams } from './space-member.js'

function mismatch(): never { throw new AgentMuxError('This operation does not identify the original Space member and Run. Its Session and other controls are retained.', 'SPACE_MEMBER_TARGET_MISMATCH') }
export function parseSpaceMemberTarget(value: unknown): SpaceMemberTarget {
  const p = rpcRecord(value, ['reference', 'regionId', 'runtimeId', 'agentSessionId', 'expectedRun']), run = rpcRecord(p.expectedRun, ['runId'])
  return { reference: parseSpaceAuthorityRef(p.reference), regionId: rpcString(p.regionId, 'Original Region'), runtimeId: rpcString(p.runtimeId, 'Original execution Runtime'),
    agentSessionId: rpcString(p.agentSessionId, 'Original Agent Session'), expectedRun: { runId: rpcString(run.runId, 'Original Run') } }
}
/** A finite target check shared with the routed receiver; full argument semantics
 * and effects still belong to the original Hosted/Provider/Native methods. */
export function assertSpaceMemberCall(target: SpaceMemberTarget, call: { method: string; params: unknown }, stream: boolean): void {
  const allowed: readonly string[] = stream ? SPACE_MEMBER_STREAMS : SPACE_MEMBER_CALLS
  if (!allowed.includes(call.method)) throw new AgentMuxError('This method is outside the original Space member interaction surface.', 'CONTROL_PERMISSION_DENIED')
  const p = rpcRecord(call.params, AGENTMUX_HOSTED_RPC_FIELDS[call.method as keyof typeof AGENTMUX_HOSTED_RPC_FIELDS])
  if (call.method === 'runtime.owner.identity') { if (p.expectedRuntimeId !== target.runtimeId) mismatch(); return }
  const fence = rpcRecord(p.fence, ['runtimeId', 'ownerInstanceId'])
  if (fence.runtimeId !== target.runtimeId) mismatch()
  rpcString(fence.ownerInstanceId, 'Original execution owner'); rpcString(p.consumerId, 'Original reader')
  if (call.method === 'runtime.release-consumer') return
  if (call.method === 'runtime.bootstrap' || call.method === 'runtime.events') {
    if (!Array.isArray(p.agentSessionIds) || p.agentSessionIds.length !== 1 || p.agentSessionIds[0] !== target.agentSessionId || p.sessions !== undefined && p.sessions !== 'full') mismatch()
    return
  }
  const run = (value: unknown) => { if (typeof value === 'string' ? value !== target.expectedRun.runId : rpcRecord(value).runId !== target.expectedRun.runId) mismatch() }
  if (call.method === 'runtime.attachment-watch' || call.method === 'runtime.replay-watch') {
    const ref = rpcRecord(p.target, ['kind', 'agentSessionId', 'runId'])
    if (ref.kind !== 'agent-session' && ref.kind !== 'terminal-run' || ref.kind === 'agent-session' && ref.agentSessionId !== target.agentSessionId) mismatch()
    run(ref); return
  }
  const invocation = rpcRecord(decodeHostedValue(p.invocation), ['method', 'args'])
  if (!(SPACE_MEMBER_INVOCATIONS as readonly unknown[]).includes(invocation.method) || !Array.isArray(invocation.args)) throw new AgentMuxError('This invocation is outside the original Space member controls.', 'CONTROL_PERMISSION_DENIED')
  const [first] = invocation.args
  if (['readAgentSession', 'runtimeSubject', 'inspectAgentInput', 'inspectAgentPromptSubmission', 'inspectAgentInteractionOperation'].includes(String(invocation.method)) && invocation.args.length !== 1) throw new AgentMuxError(
    'This member read accepts one original selector. A caller cannot supply a known Runtime fact or another caller identity.', 'INVALID_CONTROL_REQUEST')
  if (invocation.method === 'readAgentSession') { if (first !== target.agentSessionId) mismatch(); return }
  if (invocation.method === 'runtimeSubject') { const ref = rpcRecord(first); if (ref.kind !== 'agent-session' || ref.agentSessionId !== target.agentSessionId) mismatch(); return }
  if (['attachTerminal', 'refreshRunAttachment', 'readRunReplay', 'releaseRunAttachment', 'resizeTerminal'].includes(String(invocation.method))) { run(first); return }
  const input = rpcRecord(first)
  if (invocation.method === 'inspectAgentInput') {
    const key = rpcRecord(input.key)
    if (key.agentSessionId !== target.agentSessionId) mismatch()
    run(key.expectedRun); return
  }
  if (input.agentSessionId !== target.agentSessionId) mismatch()
  if (invocation.method !== 'inspectAgentInteractionOperation') run(input.expectedRun)
}
export function parseSpaceMemberParams<M extends keyof SpaceMemberParams>(method: M, value: unknown): SpaceMemberParams[M] {
  const p = rpcRecord(value, ['target', 'call']), target = parseSpaceMemberTarget(p.target), call = rpcRecord(p.call, ['method', 'params'])
  const original = { method: rpcString(call.method, 'Original Hosted method'), params: call.params }
  assertSpaceMemberCall(target, original, method === 'space.member.watch')
  return { target, call: original } as SpaceMemberParams[M]
}
