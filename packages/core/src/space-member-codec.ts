import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import { decodeHostedValue } from './hosted-value.js'
import { AGENTMUX_HOSTED_RPC_FIELDS } from './hosted-client-contract.js'
import { parseSpaceMemberIdentity, SPACE_MEMBER_CALLS, SPACE_MEMBER_STREAMS, SPACE_MEMBER_INVOCATIONS, parseSpaceMemberAdmission, type SpaceMemberTarget, type SpaceMemberRoute, type SpaceMemberParams } from './space-member.js'
import { validateAgentInputControlId, validateAgentInputWaitRef } from './agent-input-wait.js'
import { parseConversationTimelineReadInput, parseConversationCheckpointInput, parseConversationChangesInput, parseConversationWatchInput, parseConversationViewReleaseInput } from './conversation-changes.js'
import { validateSessionHistoryReadInput, type AgentSessionHistoryReadInput } from './session-history-read-codec.js'
import { parseSessionHistoryResourceParams } from './session-history-resource.js'
import { parseAgentInputMailboxRead } from './agent-input-mailbox.js'

function mismatch(): never { throw new AgentMuxError('This operation does not identify the original Space member and Run. Its Session and other controls are retained.', 'SPACE_MEMBER_TARGET_MISMATCH') }
export { parseSpaceMemberIdentity } from './space-member.js'
export function parseSpaceMemberTarget(value: unknown): SpaceMemberTarget {
  const p = rpcRecord(value, ['reference', 'regionId', 'runtimeId', 'agentSessionId', 'expectedRun', 'expectedAdmission'])
  const { expectedRun, ...identity } = p, run = rpcRecord(expectedRun, ['runId'])
  return { ...parseSpaceMemberIdentity(identity), expectedRun: { runId: rpcString(run.runId, 'Original Run') } }
}
export function parseSpaceMemberRoute(value: unknown): SpaceMemberRoute {
  const p = rpcRecord(value)
  if (p.kind !== 'conversation') return parseSpaceMemberTarget(value)
  rpcRecord(p, ['kind', 'reference', 'regionId', 'runtimeId', 'agentSessionId', 'expectedAdmission'])
  const { kind: _kind, ...identity } = p
  return { ...parseSpaceMemberIdentity(identity), kind: 'conversation', expectedAdmission: parseSpaceMemberAdmission(p.expectedAdmission) }
}
/** A finite target check shared with the routed receiver; full argument semantics
 * and effects still belong to the original Hosted/Provider/Native methods. */
export function assertSpaceMemberCall(target: SpaceMemberRoute, call: { method: string; params: unknown }, stream: boolean): void {
  const allowed: readonly string[] = stream ? SPACE_MEMBER_STREAMS : SPACE_MEMBER_CALLS
  if (!allowed.includes(call.method)) throw new AgentMuxError('This method is outside the original Space member interaction surface.', 'CONTROL_PERMISSION_DENIED')
  if (call.method === 'skill.ls') {
    const p = rpcRecord(call.params, ['hostId', 'agentSessionId'])
    if (p.hostId !== 'local' || p.agentSessionId !== target.agentSessionId) mismatch()
    return
  }
  if (!('expectedRun' in target) && (call.method === 'runtime.bootstrap' || call.method === 'runtime.events')) throw new AgentMuxError(
    'Conversation access does not open another Session or process observation.', 'CONTROL_PERMISSION_DENIED')
  const p = rpcRecord(call.params, AGENTMUX_HOSTED_RPC_FIELDS[call.method as keyof typeof AGENTMUX_HOSTED_RPC_FIELDS])
  if (call.method === 'runtime.owner.identity') { if (p.expectedRuntimeId !== target.runtimeId) mismatch(); return }
  const fence = rpcRecord(p.fence, ['runtimeId', 'ownerInstanceId'])
  if (fence.runtimeId !== target.runtimeId) mismatch()
  rpcString(fence.ownerInstanceId, 'Original execution owner'); rpcString(p.consumerId, 'Original reader')
  if (call.method === 'runtime.release-consumer') return
  if (call.method === 'runtime.conversation-watch') {
    const ref = parseConversationWatchInput(p.reference)
    if (ref.hostId !== 'local' || ref.agentSessionId !== target.agentSessionId) mismatch()
    rpcRecord(p.options ?? {}, [])
    return
  }
  if (call.method === 'runtime.bootstrap' || call.method === 'runtime.events') {
    if (!Array.isArray(p.agentSessionIds) || p.agentSessionIds.length !== 1 || p.agentSessionIds[0] !== target.agentSessionId || p.sessions !== undefined && p.sessions !== 'full') mismatch()
    return
  }
  const run = (value: unknown) => { if (!('expectedRun' in target) || (typeof value === 'string' ? value !== target.expectedRun.runId : rpcRecord(value).runId !== target.expectedRun.runId)) mismatch() }
  if (call.method === 'runtime.attachment-watch' || call.method === 'runtime.replay-watch') {
    const ref = rpcRecord(p.target, ['kind', 'agentSessionId', 'runId'])
    if (ref.kind !== 'agent-session' && ref.kind !== 'terminal-run' || ref.kind === 'agent-session' && ref.agentSessionId !== target.agentSessionId) mismatch()
    run(ref); return
  }
  const invocation = rpcRecord(decodeHostedValue(p.invocation), ['method', 'args'])
  if (!(SPACE_MEMBER_INVOCATIONS as readonly unknown[]).includes(invocation.method) || !Array.isArray(invocation.args)) throw new AgentMuxError('This invocation is outside the original Space member controls.', 'CONTROL_PERMISSION_DENIED')
  const [first] = invocation.args
  const conversationParser = invocation.method === 'readAgentConversation' ? parseConversationTimelineReadInput
    : invocation.method === 'conversationCheckpoint' ? parseConversationCheckpointInput
      : invocation.method === 'readConversationChanges' ? parseConversationChangesInput
        : invocation.method === 'releaseConversationView' ? parseConversationViewReleaseInput : undefined
  if (conversationParser) {
    if (invocation.args.length < 1 || invocation.args.length > (invocation.method === 'releaseConversationView' ? 1 : 2)) mismatch()
    const ref = conversationParser(first)
    if (ref.hostId !== 'local' || ref.agentSessionId !== target.agentSessionId) mismatch()
    if (invocation.args.length === 2) rpcRecord(invocation.args[1], [])
    return
  }
  if (invocation.method === 'readAgentSessionHistory') {
    if (invocation.args.length < 1 || invocation.args.length > 2) mismatch()
    const ref = rpcRecord(first, ['hostId', 'agentSessionId', 'source', 'limit', 'cursor', 'maxBytes', 'kind', 'query', 'scanLimit'])
    validateSessionHistoryReadInput(ref as AgentSessionHistoryReadInput)
    if (ref.hostId !== 'local' || ref.agentSessionId !== target.agentSessionId) mismatch()
    if (invocation.args.length === 2) rpcRecord(invocation.args[1], [])
    return
  }
  if (invocation.method === 'sessionHistoryResource') {
    if (invocation.args.length !== 2 || first !== target.agentSessionId) mismatch()
    // Source readers supply original record selectors, never Executor options.
    const options = rpcRecord(invocation.args[1], ['source', 'turnId', 'recordId', 'partIndex', 'expectedReference', 'maxBytes', 'offsetBytes', 'representation', 'markdownImage'])
    parseSessionHistoryResourceParams({ ...options, hostId: 'local', agentSessionId: target.agentSessionId })
    return
  }
  if (invocation.method === 'readAgentInputMailbox') {
    if (invocation.args.length !== 1 || parseAgentInputMailboxRead(first).agentSessionId !== target.agentSessionId) mismatch()
    return
  }
  if (invocation.method === 'readAgentInputEpoch') { if (invocation.args.length !== 0) mismatch(); return }
  if (!('expectedRun' in target)) throw new AgentMuxError('This original member target grants conversation reading only, without Native or input control.', 'CONTROL_PERMISSION_DENIED')
  if (invocation.method === 'rejoinAgentInputWaiting') {
    if (invocation.args.length !== 1) throw new AgentMuxError('Member rejoin accepts only its original waiting reference.', 'INVALID_CONTROL_REQUEST')
    const input = rpcRecord(first, ['ref']), ref = validateAgentInputWaitRef(input.ref)
    if (ref.key.kind !== 'prompt' || ref.key.agentSessionId !== target.agentSessionId) mismatch()
    run(ref.key.expectedRun); return
  }
  if (invocation.method === 'stopAgentInputWaiting') {
    if (invocation.args.length !== 1) throw new AgentMuxError('Member waiting stop accepts only its original reference and cancel operation.', 'INVALID_CONTROL_REQUEST')
    const input = rpcRecord(first, ['ref', 'cancelOperationId']), ref = validateAgentInputWaitRef(input.ref)
    validateAgentInputControlId(input.cancelOperationId)
    if (ref.key.kind !== 'prompt' || ref.key.agentSessionId !== target.agentSessionId) mismatch()
    run(ref.key.expectedRun); return
  }
  if (invocation.method === 'statusAgent') {
    if (invocation.args.length !== 1) throw new AgentMuxError('Member status accepts only its original Session.', 'INVALID_CONTROL_REQUEST')
    if (first !== target.agentSessionId) mismatch()
    return
  }
  if (invocation.method === 'signalAgent') {
    if (invocation.args.length !== 3) throw new AgentMuxError('Member interrupt accepts only its original Session, Run and SIGINT.', 'INVALID_CONTROL_REQUEST')
    if (first !== target.agentSessionId) mismatch()
    run(invocation.args[1])
    if (invocation.args[2] !== 'SIGINT') throw new AgentMuxError('This member surface exposes only the shared Composer interrupt.', 'CONTROL_PERMISSION_DENIED')
    return
  }
  if (invocation.method === 'submitAgentPrompt' && invocation.args.length !== 1) throw new AgentMuxError(
    'Member prompt submission accepts one original input. A caller cannot supply another identity.', 'INVALID_CONTROL_REQUEST')
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
  const p = rpcRecord(value, ['target', 'call']), target = parseSpaceMemberRoute(p.target), call = rpcRecord(p.call, ['method', 'params'])
  const original = { method: rpcString(call.method, 'Original Hosted method'), params: call.params }
  assertSpaceMemberCall(target, original, method === 'space.member.watch')
  return { target, call: original } as SpaceMemberParams[M]
}
