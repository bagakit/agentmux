import { mintObjectId } from '@agentmux/core/object-id'
import { parseAgentTakeoverCancellationResult, type AgentTakeoverCancellationResult } from '@agentmux/core/agent-takeover'
import { api } from './api'
import { agentOperationKey, type AgentOperationFeedback, type TakeoverCancellation } from './agent-operation'
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
    const next = weaker ? { ...cancellation, pending: false, result: known } : cancellation
    return { agentOperations: { ...state.agentOperations, [key]: { ...held, cancellation: next,
      ...(accepted ? { phase: accepted.outcome === 'cancelled' ? 'cancelled' : accepted.outcome === 'created' ? 'partial' : 'unconfirmed' } : {}) } } }
  })
}
async function saveResult() {
  try { await checkpointAgentOperations() }
  catch (cause) { useAppStore.getState().reportError(new Error('The original cancellation result is retained; saving this client projection is unconfirmed. ' + String(cause))) }
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
  await saveResult()
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
  const request = held.takeoverSource.coreRequest
  if (!request || request.operationId !== held.operationId || request.content.kind !== 'takeover-agent')
    throw new Error('The complete original Takeover request is unavailable. Inspect its source; no replacement intent was selected.')
  const cancellation: TakeoverCancellation = held.cancellation ?? { input: { expectedRuntimeId: held.takeoverSource.coreRuntimeId ?? (await api.spatial.owner()).owner.runtimeId,
    operationId: 'cancel-takeover:' + mintObjectId(), request: structuredClone(request) }, pending: false, dispatch: 'not-submitted' }
  // Persist a possibly-dispatched reference before the original owner can receive it.
  const pending = { ...cancellation, pending: true, dispatch: 'unconfirmed' as const, issue: undefined }
  retain(held, pending)
  try { await checkpointAgentOperations() }
  catch (cause) {
    retain(held, { ...pending, pending: false, dispatch: cancellation.dispatch, issue: '这次取消尚未提交：原请求的保存未确认。' })
    throw cause
  }
  try {
    const result = parseAgentTakeoverCancellationResult(await api.sessions.takeoverCancel(cancellation.input), cancellation.input)
    retain(held, { ...pending, pending: false, result, issue: result.issue ?? undefined }, result)
  } catch (cause) {
    retain(held, { ...pending, pending: false, issue: cause instanceof Error ? cause.message : String(cause) })
  }
  await saveResult()
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
