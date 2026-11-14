import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import { parseHostedAgentSessionRead, decodeHostedValue } from './hosted-value.js'
import { validateAgentPromptInputKey } from './agent-prompt-condition.js'
import { validateAgentInputWaitRef } from './agent-input-wait.js'
import { executionRouteRpc } from './host-route-rpc.js'
import { resolveSpaceMember } from './space-member-owner.js'
import type { AgentMuxSpatialStateStore } from './spatial-state.js'
import type { HostRouteGateway } from './host-route-gateway.js'
import type { AgentMuxRpcCallContext, AgentMuxRpcCoreClient } from './public-rpc-service.js'
import type { SpaceMemberParams, SpaceMemberCallMethod, SpaceMemberStreamMethod } from './space-member.js'
import type { AgentMuxHostedStreamEvent } from './hosted-client-contract.js'

type RuntimePort = {
  call(method: SpaceMemberCallMethod, params: unknown, context: AgentMuxRpcCallContext): Promise<unknown>
  subscribe(method: SpaceMemberStreamMethod, params: unknown, emit: (event: AgentMuxHostedStreamEvent) => void | Promise<void>, context: AgentMuxRpcCallContext): Promise<{
    initial: unknown; start?(): void | Promise<void>; dispose(): void | Promise<void>
  }>
}
/** Only the original authenticated user may borrow a direct transport. Routed
 * viewers always use their current exact parent and receiver-approved child. */
export async function spaceMemberRuntime(ports: {
  store: AgentMuxSpatialStateStore; local: RuntimePort; clients(hostId: string): Promise<readonly AgentMuxRpcCoreClient[]>; gateway?: HostRouteGateway
}, input: SpaceMemberParams[keyof SpaceMemberParams], original: AgentMuxRpcCallContext) {
  const initial = await resolveSpaceMember(ports.store, input.target)
  const assertPlacementCurrent = async () => {
    if (!isDeepStrictEqual(await resolveSpaceMember(ports.store, input.target), initial)) throw new AgentMuxError('The original member placement or route changed. Keep the original input and inspect that source.', 'SPACE_MEMBER_TARGET_MISMATCH')
  }
  const assertCurrent = async () => {
    original.signal?.throwIfAborted(); await original.assertCurrent?.()
    await assertPlacementCurrent()
  }
  const p = rpcRecord(input.call.params)
  const invocation = input.call.method === 'runtime.invoke' ? rpcRecord(decodeHostedValue(p.invocation)) : undefined
  const prompt = invocation?.method === 'submitAgentPrompt' && Array.isArray(invocation.args) ? rpcRecord(invocation.args[0]) : undefined
  const rejoin = invocation?.method === 'rejoinAgentInputWaiting' && Array.isArray(invocation.args) ? rpcRecord(invocation.args[0]) : undefined
  const inputKey = prompt?.admissionIntent ? validateAgentPromptInputKey({ kind: 'prompt', agentSessionId: prompt.agentSessionId, expectedRun: prompt.expectedRun, submissionId: prompt.operationId })
    : rejoin ? validateAgentInputWaitRef(rejoin.ref).key : undefined
  const context: AgentMuxRpcCallContext = { ...original, assertCurrent, ...(inputKey ? { retainAcceptedInputAuthority: async key => {
    if (!isDeepStrictEqual(key, inputKey)) throw new AgentMuxError('This accepted input differs from the original member Session, Run or operation.', 'SPACE_MEMBER_TARGET_MISMATCH')
    await assertCurrent()
    const accepted = await original.retainAcceptedInputAuthority?.(key)
    // The original Core owns accepted waiting. Retain the member/author checks,
    // while this reply reader keeps only its own cancellation lifetime.
    return { assertCurrent: async () => {
      if (accepted) await accepted.assertCurrent()
      else await original.assertCurrent?.()
      await assertPlacementCurrent()
    }, release: () => { accepted?.release() } }
  } } : {}) }, key = createHash('sha256').update(JSON.stringify(input.target)).digest('hex')
  const ended = (emit: (event: AgentMuxHostedStreamEvent) => void | Promise<void>) => (error?: Error) => {
    if (error && !original.signal?.aborted) return emit({ type: 'error', error: {
      code: error instanceof AgentMuxError ? error.code : 'SPACE_MEMBER_OBSERVATION_UNAVAILABLE', message: error.message } })
  }
  const scoped = (params: unknown) => {
    const p = rpcRecord(params)
    return typeof p.consumerId === 'string' ? { ...p, consumerId: key + ':' + p.consumerId } : p
  }
  let port: RuntimePort
  if (initial.adoptedRoute) {
    if (!ports.gateway || !initial.createOperationId) throw new AgentMuxError('This member has no original verified current-viewer route.', 'HOST_ROUTE_AUTHORIZATION_REQUIRED')
    const authorization = await ports.gateway.authorizeMemberControl({ ...input, createOperationId: initial.createOperationId }, context)
    const rpc = executionRouteRpc(ports.gateway, initial.adoptedRoute, authorization, undefined, context)
    port = {
      call: (method, params) => rpc.call(method, params as import('./hosted-client-contract.js').AgentMuxHostedRuntimeParameterMap[SpaceMemberCallMethod], original.signal ? { signal: original.signal } : {}),
      subscribe: async (method, params, emit) => {
        let initial: unknown
        const reader = await rpc.subscribe(method, params as import('./hosted-client-contract.js').AgentMuxHostedRuntimeParameterMap[SpaceMemberStreamMethod], {
          onInitial: value => { initial = value }, onEvent: value => emit(value), onEnd: ended(emit), ...(original.signal ? { signal: original.signal } : {}) })
        return { initial, dispose: () => reader.dispose() }
      }
    }
  } else if (initial.hostId === 'local' && input.target.runtimeId === input.target.reference.runtimeId) {
    port = { call: (method, params) => ports.local.call(method, scoped(params), context),
      subscribe: (method, params, emit) => ports.local.subscribe(method, scoped(params), emit, context) }
  } else {
    if (original.routeDelegation || original.caller || original.principal?.kind !== 'user') throw new AgentMuxError('This foreign member needs the current viewer’s original verified route and receiver grant.', 'HOST_ROUTE_AUTHORIZATION_REQUIRED')
    const matches = (await ports.clients(initial.hostId)).filter(item => item.hostId === initial.hostId)
    original.openingSignal?.throwIfAborted()
    if (matches.length !== 1) throw new AgentMuxError('The original member carrier is unavailable or ambiguous.', 'UNKNOWN_HOST')
    const client = matches[0]!.client
    if (!client.forwardRpc || !client.subscribeRpc) throw new AgentMuxError('The original carrier has no public member interaction transport.', 'RUNTIME_UNAVAILABLE')
    port = {
      call: (method, params) => client.forwardRpc!(method, scoped(params) as import('./hosted-client-contract.js').AgentMuxHostedRuntimeParameterMap[SpaceMemberCallMethod], context),
      subscribe: async (method, params, emit) => {
        let initial: unknown
        const reader = await client.subscribeRpc!(method, scoped(params) as import('./hosted-client-contract.js').AgentMuxHostedRuntimeParameterMap[SpaceMemberStreamMethod], {
          onInitial: value => { initial = value }, onEvent: value => emit(value), onEnd: ended(emit), ...(original.signal ? { signal: original.signal } : {}) })
        return { initial, dispose: () => reader.dispose() }
      }
    }
  }
  await assertCurrent()
  // These original methods already validate the exact SID/expected Run at D.
  // Re-reading it here would add a second network admission before each key.
  const fencedInput = invocation && ['writeAgent', 'pasteAgent', 'submitAgentPrompt', 'stopAgentInputWaiting', 'rejoinAgentInputWaiting', 'signalAgent'].includes(String(invocation.method))
  const originalReceipt = invocation && ['inspectAgentInput', 'inspectAgentPromptSubmission', 'inspectAgentInteractionOperation'].includes(String(invocation.method))
  const exactAttachment = (input.call.method === 'runtime.attachment-watch' || input.call.method === 'runtime.replay-watch') && rpcRecord(p.target).kind === 'agent-session'
  if ('expectedRun' in input.target && input.call.method !== 'runtime.owner.identity' && input.call.method !== 'runtime.release-consumer' && !fencedInput && !originalReceipt && !exactAttachment) {
    const read = rpcRecord(await port.call('runtime.invoke', { consumerId: rpcString(p.consumerId, 'Original member reader'),
      fence: p.fence, invocation: { method: 'readAgentSession', args: [input.target.agentSessionId] } }, context))
    const session = parseHostedAgentSessionRead(decodeHostedValue(read.value), input.target.agentSessionId)
    if (!session || session.run.runId !== input.target.expectedRun.runId) throw new AgentMuxError('The original member now refers to another Run. Keep this input and refresh its exact source.', 'STALE_AGENT_SESSION_BINDING')
    await assertCurrent()
  }
  return { port, context, assertCurrent }
}
