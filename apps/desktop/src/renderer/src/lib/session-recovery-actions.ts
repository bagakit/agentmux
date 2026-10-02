import type { AgentMuxSpaceMutationReport } from '@agentmux/core/control'
import type { SessionHistoryReference } from '../../../shared/contracts'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { api } from './api'
import { scratchTopicsForWorkspace, scratchTopicKind } from './scratch-topic-snapshots'
import { spatialCatalog } from './space-agent-control'
import { useAppStore, retainRecoveryMessageIntent, agentRegionExecution, rereadAgentRegionExecution, adoptAgentRegionObservation } from '../store'

export type RecoveryMode = 'takeover' | 'analyze'
export type RecoverySource = SessionHistoryReference & {
  workspaceId: string; tabId: string; regionId: string; displayWorkspaceId: string; groupId?: string
  diagnostic: string
  observation?: 'unconfirmed'
}
export type RecoveryMoteTarget = { topicId: string; tabId: string; regionId: string; agentSessionId: string; hostId: string; label: string }
export type RecoveryActionResult = { kind: 'confirmed' | 'unknown'; message: string; requestId: string; report?: AgentMuxSpaceMutationReport }

export type RecoveryRegionIdentity = Pick<RecoverySource, 'agentSessionId' | 'tabId' | 'regionId' | 'displayWorkspaceId' | 'groupId'>

/** Missing observations retain the original reference; conflicting owners never select a winner. */
export function unobservedRecoveryReference(identity: RecoveryRegionIdentity): { source: RecoverySource | null; issue: string | null } {
  const state = useAppStore.getState(), tab = state.tabs[identity.tabId], region = tab?.regions[identity.regionId]
  if (region?.kind !== 'agent' || region.sessionId !== identity.agentSessionId)
    return { source: null, issue: 'The original Region no longer contains this Session. Its work is retained.' }
  const session = state.sessions.find(item => item.id === identity.agentSessionId)
  const hosts = new Set([
    session?.kind === 'agent' ? session.control.hostId : undefined,
    state.pendingAgentLaunches[identity.agentSessionId]?.request?.hostId,
    ...state.recoveryCandidates.filter(candidate => candidate.agentSessionId === identity.agentSessionId).map(candidate => candidate.hostId),
    agentRegionExecution(identity)?.hostId
  ].filter((host): host is string => Boolean(host)))
  if (hosts.size > 1) return { source: null, issue: 'Original Host references conflict. Re-read the original owner; no replacement Host is selected.' }
  const hostId = [...hosts][0]
  if (!hostId) return { source: null, issue: 'The original execution Host is not confirmed. The display Project does not establish it.' }
  return { source: { ...identity, hostId, workspaceId: tab!.workspaceId, diagnostic: 'Original Session state is not confirmed.', observation: 'unconfirmed' }, issue: null }
}

/** Read canonical facts only. Neither a missing Run nor a failed read authorizes native recovery. */
export async function rereadUnobservedSession(identity: RecoveryRegionIdentity, current: () => boolean): Promise<void> {
  const originalIntent = useAppStore.getState().pendingAgentLaunches[identity.agentSessionId]?.request
  const originalWorkspace = useAppStore.getState().tabs[identity.tabId]?.workspaceId
  const originalOperation = useAppStore.getState().pendingAgentLaunches[identity.agentSessionId]?.created?.creation?.createOperationId
  const initial = unobservedRecoveryReference(identity)
  const assertSource = (expectedHost?: string) => {
    const next = unobservedRecoveryReference(identity)
    const pending = useAppStore.getState().pendingAgentLaunches[identity.agentSessionId], request = pending?.request
    const operation = pending?.created?.creation?.createOperationId
    if (!current() || (request && request !== originalIntent) || (originalOperation && operation && operation !== originalOperation) || useAppStore.getState().tabs[identity.tabId]?.workspaceId !== originalWorkspace ||
      useAppStore.getState().tabs[identity.tabId]?.regions[identity.regionId]?.kind !== 'agent' ||
      (useAppStore.getState().tabs[identity.tabId]?.regions[identity.regionId] as { sessionId?: string } | undefined)?.sessionId !== identity.agentSessionId)
      throw new Error('The original observation scope or creation intent changed. Its work is retained.')
    if (expectedHost && next.source?.hostId !== expectedHost)
      throw new Error(next.issue ?? 'The original execution Host changed during observation.')
    return next
  }
  assertSource(initial.source?.hostId)
  if (!initial.source) {
    await rereadAgentRegionExecution(identity)
    assertSource()
  }
  const reference = unobservedRecoveryReference(identity)
  if (!reference.source) throw new Error(reference.issue!)
  const hostId = reference.source.hostId
  const canonical = await api.sessions.creation(hostId, identity.agentSessionId)
  assertSource(hostId)
  if (canonical.agentSessionId !== identity.agentSessionId) throw new Error('The original Core owner returned another Session identity.')
  if (originalOperation && canonical.creation?.createOperationId !== originalOperation)
    throw new Error('The original creation operation is not confirmed. No replacement is attached.')
  const session = await api.sessions.refresh({ kind: 'agent', hostId, agentSessionId: identity.agentSessionId, run: canonical.run })
  assertSource(hostId)
  if (session.kind !== 'agent' || session.id !== identity.agentSessionId || session.control.hostId !== hostId ||
    session.control.agentSessionId !== identity.agentSessionId || session.control.run.runId !== canonical.run.runId)
    throw new Error('The original Session observation returned another Host, Session or Run.')
  adoptAgentRegionObservation({ ...identity, hostId }, { created: canonical, session, projectionFailures: [] })
}

/** The original display reference must still contain the exact original Session. */
export function ownsRecoverySource(source: RecoverySource): boolean {
  const state = useAppStore.getState(), tab = state.tabs[source.tabId], region = tab?.regions[source.regionId]
  const session = state.sessions.find(item => item.id === source.agentSessionId)
  return tab?.workspaceId === source.workspaceId && region?.kind === 'agent' && region.sessionId === source.agentSessionId &&
    (session ? session.kind === 'agent' && session.control.hostId === source.hostId && session.control.agentSessionId === source.agentSessionId
      : source.observation !== 'unconfirmed' || unobservedRecoveryReference(source).source?.hostId === source.hostId)
}

/** Deterministic correlation is retained by the existing spatial intent / message queue owners. */
export async function recoveryOperationId(source: RecoverySource, mode: RecoveryMode): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
    source.hostId, source.agentSessionId, source.workspaceId, source.tabId, source.regionId, mode
  ])))
  return 'recovery:' + [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

const shellWord = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'"
export function recoveryReferenceNote(source: RecoverySource, mode: RecoveryMode, historySource: 'captured' | 'native'): string {
  const reference = `--host ${shellWord(source.hostId)} --session ${shellWord(source.agentSessionId)}`
  return [
    `Original Agent Session reference: ${JSON.stringify({ hostId: source.hostId, agentSessionId: source.agentSessionId, historySource, mode })}`,
    `This is ${mode === 'takeover' ? 'an independent takeover Agent, not native resume' : 'an analysis request, not authorization to continue or execute the original task'}. Keep the original Session and unsent inputs intact.`,
    'Read the original owner before answering or continuing:',
    `agentmux agent history ${reference} --source ${historySource} --limit 20 --max-bytes 32768`,
    `Optional diagnostics: agentmux agent inspect --session ${shellWord(source.agentSessionId)}. This inspect command is not Host-qualified. Consume its diagnostics only after verifying the returned execution Host matches ${JSON.stringify(source.hostId)}; otherwise report diagnostics unavailable and use the Host-qualified history above. Do not infer a cross-Host binding from the Session ID alone.`,
    'Follow nextCursor with the same exact Host, Session and source. Preserve revision, provenance, gaps and unavailable/empty distinctions. For a fragment, read its contiguous continuation, concatenate json-utf8-base64 bytes, verify sha256, then decode the item; do not silently skip oversized items. An invalid cursor requires re-reading the first page.',
    mode === 'takeover' ? 'First establish what the user asked, what was completed and what remains; then continue the original task. Do not replay unconfirmed old input.' : 'Report completed work, unfinished work, blockers and suggested next steps. Do not execute those steps or switch into takeover without a new user instruction.',
    `Observed recovery diagnostic (not a lifetime claim): ${source.diagnostic.slice(0, 700) || 'Current native resume identity or state is unconfirmed.'}`
  ].join('\n\n')
}

export function recoveryMoteTargets(): RecoveryMoteTarget[] {
  const state = useAppStore.getState(), scratch = state.config?.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)
  const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, scratch)
  return Object.values(state.tabs).flatMap(tab => {
    const topic = topics?.find(item => item.id === tab.topicId && scratchTopicKind(item.id, topics) === 'mote' && item.moteArchive?.state !== 'archived' && !item.readError)
    if (tab.workspaceId !== SCRATCH_WORKSPACE_ID || !topic) return []
    return Object.values(tab.regions).flatMap(region => {
      if (region.kind !== 'agent' || tab.layout.activeRegionId !== region.regionId) return []
      const session = state.sessions.find(item => item.id === region.sessionId)
      return session?.kind === 'agent' ? [{ topicId: topic.id, tabId: tab.id, regionId: region.regionId,
        agentSessionId: session.id, hostId: session.control.hostId, label: `${topic.title} · ${state.agentNames[session.id] ?? session.label}` }] : []
    })
  })
}
export function ownsRecoveryMote(target: RecoveryMoteTarget): boolean {
  const state = useAppStore.getState(), tab = state.tabs[target.tabId], region = tab?.regions[target.regionId]
  return recoveryMoteTargets().some(item => item.topicId === target.topicId && item.tabId === target.tabId &&
    item.regionId === target.regionId && item.agentSessionId === target.agentSessionId && item.hostId === target.hostId) &&
    tab?.layout.activeRegionId === target.regionId && region?.kind === 'agent'
}

function assertSource(source: RecoverySource, current: () => boolean): void {
  if (!current() || !ownsRecoverySource(source)) throw new Error('The original Session or this selection changed. Its request and work are retained; no replacement target is used.')
}
export async function inspectRecoveryRequest(source: RecoverySource, mode: RecoveryMode): Promise<RecoveryActionResult | null> {
  const requestId = await recoveryOperationId(source, mode)
  const binding = useAppStore.getState().spatialRequests[requestId]
  if (!binding) return null
  if (binding.operation === 'agent.message') {
    if (!binding.recoveryRecipient) return { requestId, kind: 'unknown', message: 'The original message recipient reference is unavailable. No replacement recipient or input will be used.' }
    const delivered = await readRecoveryDelivery(binding.recoveryRecipient, requestId)
    return { requestId, kind: delivered ? 'confirmed' : 'unknown', message: delivered
      ? 'Core confirms the original analysis message was delivered to the chosen Mote. No message was resent.'
      : 'The original analysis intent is retained, but Core has not confirmed delivery. It may not have been sent. Check this same recipient and operation; no message is resent.' }
  }
  const result = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: `inspect:${crypto.randomUUID()}`,
    operation: 'space.inspect', target: { requestId } })
  if (result.operation !== 'space.inspect') throw new Error('The original request inspection returned another operation.')
  const report = result.request?.report ?? undefined
  return { requestId, kind: report?.outcome === 'opened' ? 'confirmed' : 'unknown', ...(report ? { report } : {}),
    message: report?.outcome === 'opened' ? 'The existing new Agent is confirmed. The original Session remains available.' :
      `The original creation result remains unknown. ${report?.issues.map(item => item.message).join(' ') ?? ''} Check this same request; creation is not resent.` }
}

async function readRecoveryDelivery(target: Pick<RecoveryMoteTarget, 'hostId' | 'agentSessionId'>, requestId: string): Promise<boolean> {
  const timeline = await api.sessions.timeline({ hostId: target.hostId, agentSessionId: target.agentSessionId })
  if (timeline.agentSessionId !== target.agentSessionId) throw new Error('Mote delivery read returned another Session. The original request remains unconfirmed.')
  return timeline.items.some(item => item.id === `prompt:${requestId}` && item.agentSessionId === target.agentSessionId && item.kind === 'user_message' && item.status === 'complete')
}

export async function createRecoveryAgent(source: RecoverySource, mode: RecoveryMode, executorId: string,
  historySource: 'captured' | 'native', current: () => boolean): Promise<RecoveryActionResult> {
  const requestId = await recoveryOperationId(source, mode)
  assertSource(source, current)
  const original = await inspectRecoveryRequest(source, mode)
  if (original) return original
  assertSource(source, current)
  const state = useAppStore.getState()
  if (Object.values(state.agentSteerQueues).some(queue => queue.some(entry => entry.operationId === requestId))) {
    throw new Error('This analysis already belongs to a retained Mote message. Check that original message instead of creating another Agent.')
  }
  if (!executorId || !state.config?.executors[executorId]) throw new Error('Choose an exact configured Executor before creating an Agent.')
  const scratch = state.config.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)
  const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, scratch) ?? []
  const catalog = spatialCatalog(state, topics)
  const location = catalog.locations.find(item => item.tabId === source.tabId && item.regionId === source.regionId &&
    item.displayWorkspaceId === source.displayWorkspaceId && (!source.groupId || item.groupId === source.groupId))
  if (!location?.spaceId || !location.zoneId) throw new Error('The original Project placement is unconfirmed. Its Session and work remain; re-read the same Project before creating a new Agent.')
  const result = await state.executeControl({ schemaVersion: 5, requestId, operation: 'agent.open', focus: false,
    destination: { spaceId: location.spaceId, zoneId: location.zoneId, displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId, newTab: true },
    content: { kind: 'new-agent', executorId, prompt: mode === 'takeover' ? 'Read the referenced original work, then take over the unfinished task.' : 'Read and analyze the referenced original work. Do not continue or execute its task.' }
  }, undefined, { agentMuxNote: recoveryReferenceNote(source, mode, historySource), authorize: () => current() && ownsRecoverySource(source), recovery: {
    hostId: source.hostId, agentSessionId: source.agentSessionId, tabId: source.tabId, regionId: source.regionId, mode, historySource, executorId
  } })
  if (result.operation !== 'agent.open') throw new Error('Creation returned another operation; its result is unknown. Check the original request.')
  return { requestId, report: result, kind: result.outcome === 'opened' ? 'confirmed' : 'unknown', message: result.outcome === 'opened'
    ? `New ${mode === 'takeover' ? 'takeover' : 'analysis'} Agent created in a separate Tab. The original Session is retained.`
    : `Creation is unconfirmed. ${result.issues.map(item => item.message).join(' ')}` }
}

export async function analyzeWithRecoveryMote(source: RecoverySource, target: RecoveryMoteTarget,
  historySource: 'captured' | 'native', current: () => boolean): Promise<RecoveryActionResult> {
  const requestId = await recoveryOperationId(source, 'analyze')
  assertSource(source, current)
  const existing = await inspectRecoveryRequest(source, 'analyze')
  if (existing) return existing
  const assertTarget = () => { assertSource(source, current); if (!ownsRecoveryMote(target)) throw new Error('The chosen Mote Topic, Tab or input Region changed. Nothing was sent to a replacement target.') }
  assertTarget()
  const pendingOwner = Object.entries(useAppStore.getState().agentSteerQueues).find(([, queue]) => queue.some(entry => entry.operationId === requestId))
  if (pendingOwner && pendingOwner[0] !== target.agentSessionId) throw new Error(`This request belongs to Mote Session ${pendingOwner[0]}. Check that original recipient; no message was sent to another Mote.`)
  const retained = pendingOwner?.[1].find(entry => entry.operationId === requestId)
  const recipient = `Chosen analysis recipient: ${JSON.stringify({ topicId: target.topicId, tabId: target.tabId, regionId: target.regionId, hostId: target.hostId, agentSessionId: target.agentSessionId })}`
  if (retained && !retained.agentMuxNote?.split('\n').includes(recipient)) throw new Error('The retained analysis belongs to another exact Mote input. Check that original Topic, Tab and Region; no replacement input was used.')
  const admitted = await retainRecoveryMessageIntent({ requestId, inputDigest: requestId, operation: 'agent.message', createAgent: false,
    agentSessionId: target.agentSessionId, executionHostId: target.hostId, tabId: target.tabId, regionId: target.regionId,
    target: { tabId: target.tabId, regionId: target.regionId }, recovery: { hostId: source.hostId, agentSessionId: source.agentSessionId,
      tabId: source.tabId, regionId: source.regionId, mode: 'analyze', historySource }, recoveryRecipient: {
      hostId: target.hostId, agentSessionId: target.agentSessionId, topicId: target.topicId, tabId: target.tabId, regionId: target.regionId
    } })
  assertTarget()
  if (admitted === null) return (await inspectRecoveryRequest(source, 'analyze'))!
  if (!admitted.localStorageWritten) throw new Error('The original recipient reference could not be written. Analysis has not been dispatched; keep and check that same intent.')
  // Read the Core delivery witness before admitting the original queue identity.
  const deliveredBefore = await readRecoveryDelivery(target, requestId)
  assertTarget()
  if (deliveredBefore) {
    return { requestId, kind: 'confirmed', message: 'Core confirms the original analysis message was delivered to the chosen Mote. No message was resent.' }
  }
  const state = useAppStore.getState()
  const queued = state.agentSteerQueues[target.agentSessionId]?.some(entry => entry.operationId === requestId)
  if (!queued && !state.enqueueAgentSteer(target.agentSessionId, 'Analyze the referenced original work; report progress, blockers and suggested next steps without executing them.',
    undefined, requestId, 'manual', recoveryReferenceNote(source, 'analyze', historySource) + '\n\n' + recipient)) throw new Error('The chosen Mote could not admit this request. Both original drafts are retained.')
  await useAppStore.getState().sendQueuedAgentSteer(target.agentSessionId, requestId)
  assertTarget()
  const entry = useAppStore.getState().agentSteerQueues[target.agentSessionId]?.find(item => item.operationId === requestId)
  const delivered = await readRecoveryDelivery(target, requestId)
  assertTarget()
  return { requestId, kind: delivered ? 'confirmed' : 'unknown', message: delivered
    ? 'Core confirms the analysis message was delivered to the chosen Mote. The original Session and both drafts are retained.'
    : `The original analysis intent is retained; delivery is unconfirmed. ${entry?.error ?? 'The local queue is not a delivery receipt; the message may not have been sent.'} Check the same recipient and operation; no new message is sent.` }
}
