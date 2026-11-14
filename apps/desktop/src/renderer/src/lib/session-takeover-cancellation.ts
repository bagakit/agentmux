import { parseAgentTakeoverCancellationResult, type AgentTakeoverCancellationInput, type AgentTakeoverCancellationResult } from '@agentmux/core/agent-takeover'
import { api } from './api'
import { agentOperationKey, isDurableTakeoverCancellation, withoutCancellationFeedback, type AgentOperationFeedback, type TakeoverCancellation } from './agent-operation'
import { checkpointAgentOperations, currentCoreSpatialGraph, useAppStore } from '../store'

type Takeover = Extract<AgentOperationFeedback, { kind: 'takeover' }>
// Only coalesces this client's preparation/wait. Core owns every business result.
const waits = new Map<string, Promise<void>>()
function current(operation: Takeover) {
  const held = useAppStore.getState().agentOperations[agentOperationKey(operation)]
  return held?.kind === 'takeover' ? held : undefined
}
function retain(operation: Takeover, cancellation: TakeoverCancellation, result?: AgentTakeoverCancellationResult) {
  const key = agentOperationKey(operation)
  useAppStore.setState(state => {
    const held = state.agentOperations[key]
    if (held?.kind !== 'takeover' || held.cancellation && held.cancellation.input.operationId !== cancellation.input.operationId) return state
    const known = held.cancellation?.result
    const weaker = known && known.outcome !== 'unconfirmed' &&
      (!result || result.outcome === 'unconfirmed' || known.diskDurability === 'confirmed' && result.outcome === known.outcome && result.diskDurability !== 'confirmed')
    const accepted = weaker ? undefined : result
    const newlySettled = isDurableTakeoverCancellation(accepted) && !isDurableTakeoverCancellation(known)
    const next: TakeoverCancellation = { ...withoutCancellationFeedback(cancellation), ...(weaker ? { pending: false, result: known } : {}),
      ...(held.cancellation?.settlingFeedback || newlySettled ? { settlingFeedback: true } : {}) }
    return { agentOperations: { ...state.agentOperations, [key]: { ...held, cancellation: next,
      ...(accepted ? { phase: accepted.outcome === 'cancelled' ? 'cancelled' : accepted.outcome === 'created' ? 'partial' : 'unconfirmed' } : {}) } } }
  })
}
async function saveResult() {
  try { await checkpointAgentOperations() }
  catch (cause) { useAppStore.getState().reportError(new Error('The original cancellation result is retained; saving this client projection is unconfirmed. ' + String(cause))) }
}

export class TakeoverCancellationOwnerUnconfirmed extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}

async function originalCancellationInput(operation: Takeover): Promise<AgentTakeoverCancellationInput> {
  const request = operation.takeoverSource.coreRequest
  if (!request || request.operationId !== operation.operationId || request.content.kind !== 'takeover-agent')
    throw new Error('原接手请求不完整，无法定位取消。可以检查原操作。')
  const expectedRuntimeId = operation.takeoverSource.coreRuntimeId ?? await api.spatial.owner()
    .then(({ owner }) => owner.runtimeId)
    .catch(cause => { throw new TakeoverCancellationOwnerUnconfirmed(cause) })
  // The persisted original request can find the same cancellation after a failed client save.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request.operationId))
  const operationId = 'cancel-takeover:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  return { expectedRuntimeId, operationId, request: structuredClone(request) }
}

/** An explicit Check can locate the same original cancellation even if Desktop did not save its projection. */
export async function recoverTakeoverCancellation(operation: Takeover): Promise<boolean> {
  if (!operation.takeoverSource.coreRequest || operation.cancellation) return false
  try {
    const input = await originalCancellationInput(operation)
    const result = parseAgentTakeoverCancellationResult(await api.sessions.takeoverCancelInspect(input), input)
    // An unrecorded or unqualified read does not create a cancellation locally.
    if (result.cancellationAdmission !== 'observed' && result.outcome === 'unconfirmed') return false
    if (current(operation) !== operation) return false
    retain(operation, { input, dispatch: 'unconfirmed', pending: false, result, issue: result.issue ?? undefined }, result)
    void saveResult()
    return true
  } catch {
    // Keep the independent original creation check available if cancellation cannot be observed.
    return false
  }
}

/** Reading this exact control never sends cancellation, Start, Stop or input. */
export async function inspectTakeoverCancellation(operation: Takeover) {
  const held = current(operation), cancellation = held?.cancellation
  if (!held || !cancellation) return
  try {
    const result = parseAgentTakeoverCancellationResult(await api.sessions.takeoverCancelInspect(cancellation.input), cancellation.input)
    retain(held, { ...cancellation, pending: false, result, issue: result.issue ?? undefined }, result)
  } catch (cause) {
    retain(held, { ...cancellation, pending: false, issue: cause instanceof Error ? cause.message : String(cause) })
  }
  void saveResult()
}

/** One explicit original intent; an unknown write is inspected rather than replayed. */
export function cancelTakeoverOperation(operation: Takeover, options: { continueOriginal?: boolean } = {}): Promise<void> {
  const key = agentOperationKey(operation), waiting = waits.get(key)
  if (waiting && !options.continueOriginal) return waiting
  const waitingForResult = cancel(operation, options.continueOriginal === true).finally(() => { if (waits.get(key) === waitingForResult) waits.delete(key) })
  waits.set(key, waitingForResult)
  return waitingForResult
}
async function cancel(operation: Takeover, continueOriginal: boolean) {
  const held = current(operation)
  if (!held) throw new Error('The original Takeover reference is unavailable. Its work was not changed.')
  if (held.cancellation?.dispatch === 'unconfirmed' && !continueOriginal) return inspectTakeoverCancellation(held)
  if (continueOriginal && held.cancellation?.result?.outcome !== 'unconfirmed')
    throw new Error('Inspect this exact cancellation before explicitly continuing its original control.')
  const cancellation: TakeoverCancellation = held.cancellation ?? {
    input: await originalCancellationInput(held), pending: false, dispatch: 'not-submitted'
  }
  // The original Core owns admission. The exact control is recoverable from the original request.
  const pending = { ...cancellation, pending: true, dispatch: 'unconfirmed' as const, issue: undefined }
  retain(held, pending)
  try {
    const result = parseAgentTakeoverCancellationResult(await api.sessions.takeoverCancel(cancellation.input), cancellation.input)
    retain(held, { ...pending, pending: false, result, issue: result.issue ?? undefined }, result)
  } catch (cause) {
    retain(held, { ...pending, pending: false, issue: cause instanceof Error ? cause.message : String(cause) })
  }
  void saveResult()
}

/** Navigation and Stop resolve the receipt's exact target, never the source Agent. */
export async function cancelledTakeoverTarget(operation: Takeover) {
  const cancellation = current(operation)?.cancellation, result = cancellation?.result
  if (!cancellation || result?.outcome !== 'created' || !result.agent || !result.to)
    throw new Error('The created Takeover target is not confirmed. Check the original cancellation result.')
  if ((await api.spatial.owner()).owner.runtimeId !== cancellation.input.expectedRuntimeId)
    throw new Error('The original spatial owner is unavailable. No other Agent was selected.')
  await useAppStore.getState().refreshSpatialState()
  const target = result.to, region = currentCoreSpatialGraph()?.regions.find(item => item.tabId === target.tabId && item.regionId === target.regionId)
  if (region?.agentSessionId !== result.agent.agentSessionId || region.execution?.hostId !== result.agent.hostId ||
    region.execution.runtimeId && region.execution.runtimeId !== result.agent.runtimeId)
    throw new Error('The created Agent is not confirmed at its original position. Keep its receipt and recheck the original workface.')
  const session = useAppStore.getState().sessions.find(item => item.kind === 'agent' && item.control.hostId === result.agent!.hostId &&
    item.control.agentSessionId === result.agent!.agentSessionId && item.control.run.runId === result.agent!.run?.runId)
  return { target, session: session?.kind === 'agent' ? session : undefined, agent: result.agent }
}
export async function cancelledTakeoverStopTarget(operation: Takeover) {
  const target = await cancelledTakeoverTarget(operation)
  if (!target.session) throw new Error('This created Agent’s exact Run is not currently confirmed. Open its original workface and refresh before choosing Stop.')
  const owner = await api.sessions.owner(target.agent.hostId, target.agent.runtimeId)
  if (owner.owner.runtimeId !== target.agent.runtimeId) throw new Error('The created Agent execution owner changed. No Stop was sent to another Runtime.')
  return { ...target, session: target.session }
}
export async function openCancelledTakeoverTarget(operation: Takeover) {
  const { target } = await cancelledTakeoverTarget(operation), state = useAppStore.getState()
  if (!state.selectMainRegion({ displayWorkspaceId: target.displayWorkspaceId, groupId: target.groupId, tabId: target.tabId, regionId: target.regionId }))
    throw new Error('The original created workface is not currently displayed. Its Agent and receipt are retained.')
  state.activateTab(target.displayWorkspaceId, target.groupId, target.tabId)
  state.focusRegion(target.displayWorkspaceId, target.tabId, target.regionId, 'pointer', target.groupId)
}
