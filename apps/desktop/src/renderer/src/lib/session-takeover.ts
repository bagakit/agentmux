import { agentTakeoverPrompt } from '@agentmux/core/mote-dialogue'
import { agentDerivedActionPrompt, type AgentDerivedAction } from '@agentmux/core/agent-derived-actions'
import { mintObjectId } from '@agentmux/core/object-id'
import type { AgentMuxSpaceMutationReport } from '@agentmux/core/control'
import type { AgentNativeResumeSource, AgentSessionHistoryDescriptor, AgentMuxRunRef, AgentMuxRpcParams, AgentMuxRpcResult, SpaceAuthorityRef } from '@agentmux/core'
import type { AgentTakeoverSource } from '@agentmux/core/agent-takeover'
import type { OpenHttpLinkOrigin } from './open-destination'
import { checkpointAgentOperations, checkpointSpatialWorkbench, currentCoreSpatialGraph, currentDisplayNameRevision, useAppStore } from '../store'
import { spatialCatalog } from './space-agent-control'
import { firstPromptFromTimeline } from '@agentmux/client-ui/display-name'
import { api } from './api'
import { requireAgentNewTabDestination, type AgentNewTabDestination } from './agent-new-tab-destination'
import { beginAgentOperation, retainTakeoverRequest, updateAgentOperation, settleAgentCreation, type AgentOperationFeedback } from './agent-operation-feedback'
import { agentOperationKey, agentOperationsForSubject } from './agent-operation'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { originalTopicAddress, topicSpatialAddress } from '../../../shared/space-addresses'
import { desktopAgentPresentationFromSpatial } from './desktop-agent-presentation'

type TakeoverSourceDetails = {
  hostId: string | undefined
  cwd: string | undefined
  label: string
  executorId: string | undefined
  diagnostic: string
  origin: Partial<OpenHttpLinkOrigin>
  destination?: AgentNewTabDestination
  organization?: SpaceAuthorityRef | null
  /** Entry presentation only; Core determines the actual nature from original organization facts. */
  destinationKind?: 'club'
  expectedRuntimeId?: string
  /** The original spatial admission owner, independently pinned from the source Agent. */
  coreRuntimeId?: string
  /** The existing Club preparation owner retains these exact identities before content writes. */
  clubPreparation?: { operationId: string; expectedResource: import('@agentmux/core/mote-preferences').MotePreferencesTarget['expectedResource']; topicId: string; tabId: string }
  /** The full original Core request is retained only for this client intent and its recovery. */
  coreRequest?: AgentMuxRpcParams<'agent.open'> & { operationId: string }
  /** A user's custom derived action retains its own instruction and creation contract. */
  derived?: Pick<AgentDerivedAction, 'id' | 'label' | 'instruction'>
}

export type TakeoverSource = TakeoverSourceDetails & (
  { kind: 'session'; agentSessionId: string; presentationSessionId: string; expectedRun: AgentMuxRunRef; nativeSource?: never } |
  { kind?: 'region'; agentSessionId: string; nativeSource?: never } |
  { kind: 'saved'; agentSessionId: string; nativeSource?: AgentNativeResumeSource } |
  { kind: 'saved'; agentSessionId?: undefined; nativeSource: AgentNativeResumeSource }
)

export function takeoverOperationSubject(source: TakeoverSource) {
  if (source.kind === 'saved' && !source.origin.regionId) {
    return { hostId: source.hostId!, agentSessionId: source.agentSessionId, regionId: undefined }
  }
  const state = useAppStore.getState()
  const snapshot = state.sessions.find(item => item.id === (source.kind === 'session' ? source.presentationSessionId : source.agentSessionId))
  const graph = currentCoreSpatialGraph()
  const region = graph?.regions.find(region => region.tabId === source.origin.tabId && region.regionId === source.origin.regionId)
  const presentation = graph && region ? desktopAgentPresentationFromSpatial(graph, region) : null
  const original = region?.kind === 'agent' && region.execution?.hostId === source.hostId &&
    (region.agentSessionId === source.agentSessionId || presentation?.sessionId === source.agentSessionId) ? region.agentSessionId ?? undefined : undefined
  return { hostId: source.hostId!, agentSessionId: snapshot?.kind === 'agent' && snapshot.control.hostId === source.hostId
    ? snapshot.control.agentSessionId : original ?? source.agentSessionId, regionId: source.origin.regionId }
}

/** The display Workspace never establishes the execution source. Conflicts stay unknown. */
export function takeoverExecution(agentSessionId: string, histories: readonly AgentSessionHistoryDescriptor[]) {
  const state = useAppStore.getState()
  const active = state.sessions.filter(item => item.id === agentSessionId)
  if (active.length) return active.length === 1 && active[0]?.kind === 'agent'
    ? { hostId: active[0].control.hostId, cwd: active[0].workspacePath, executorId: active[0].executorId } : null
  const request = state.pendingAgentLaunches[agentSessionId]?.request
  if (request) return { hostId: request.hostId, cwd: request.workspacePath, executorId: request.executorId }
  const facts = [
    ...state.recoveryCandidates.filter(item => item.agentSessionId === agentSessionId).map(item => ({ hostId: item.hostId, cwd: item.workspacePath, executorId: item.executorId })),
    ...histories.filter(item => item.agentSessionId === agentSessionId && item.history).map(item => ({ hostId: item.hostId, cwd: item.history!.workspacePath, executorId: item.history!.executorId }))
  ]
  const identities = new Map(facts.map(item => [JSON.stringify([item.hostId, item.cwd, item.executorId]), item]))
  return identities.size === 1 ? [...identities.values()][0] ?? null : null
}

/** A source and its explicit predecessor identify one durable intent, including repeated clicks. */
export async function takeoverRequestId(source: TakeoverSource, previousRequestId?: string): Promise<string> {
  const identity = source.kind === 'session' ? ['session', source.agentSessionId, source.expectedRun.runId] : source.kind === 'saved' ? ['saved', source.agentSessionId ?? null, source.nativeSource?.nativeHandle.providerId ?? null, source.nativeSource?.nativeHandle.sessionId ?? null] : source.agentSessionId
  const parts: unknown[] = [source.hostId, identity, source.origin.tabId, source.origin.regionId]
  if (previousRequestId !== undefined) parts.push(previousRequestId)
  // A derived action is its own intent on the same source, frozen with the instruction it was started with.
  if (source.derived) parts.push(['derived', source.derived.id, source.derived.instruction])
  const key = JSON.stringify(parts)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  return `${source.derived ? 'derived' : 'takeover'}:${Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')}`
}

/** Follow only this source's retained intent chain; no second ledger or write on reads. */
async function latestTakeoverRequestId(source: TakeoverSource): Promise<string> {
  const requests = useAppStore.getState().spatialRequests
  const visited = new Set<string>()
  let requestId = await takeoverRequestId(source)
  while (Object.hasOwn(requests, requestId)) {
    const binding = requests[requestId]
    if (visited.has(requestId) || !binding || binding.requestId !== requestId ||
      binding.operation !== 'agent.open' || !binding.createAgent || !binding.agentSessionId ||
      !binding.tabId || !binding.regionId || !binding.executionHostId || binding.executionHostId !== source.hostId) {
      throw new Error('The retained takeover request has a conflicting or incomplete identity. Its result is unconfirmed; keep the original request and check it again.')
    }
    visited.add(requestId)
    const next = await takeoverRequestId(source, requestId)
    if (!Object.hasOwn(requests, next)) break
    requestId = next
  }
  return requestId
}

function ownsTakeoverRegion(source: TakeoverSource): boolean {
  if (source.kind === 'session') return ownsTakeoverSource(source)
  const state = useAppStore.getState(), tab = source.origin.tabId ? state.tabs[source.origin.tabId] : undefined
  const region = source.origin.regionId ? tab?.regions[source.origin.regionId] : undefined
  return source.kind === 'saved' ? region?.kind === 'launcher' : region?.kind === 'agent' && region.sessionId === source.agentSessionId
}
export function ownsTakeoverSource(source: TakeoverSource): boolean {
  if (source.kind === 'session') {
    const matches = useAppStore.getState().sessions.filter(item => item.kind === 'agent' && item.id === source.presentationSessionId &&
      item.control.hostId === source.hostId && item.control.agentSessionId === source.agentSessionId)
    const current = matches.length === 1 ? matches[0] : undefined
    return current?.kind === 'agent' && current.control.run.runId === source.expectedRun.runId && current.workspacePath === source.cwd
  }
  if (!ownsTakeoverRegion(source)) return false
  const state = useAppStore.getState()
  if (source.kind === 'saved') {
    const execution = source.agentSessionId ? takeoverExecution(source.agentSessionId, []) : null
    return !execution || execution.hostId === source.hostId && execution.cwd === source.cwd
  }
  const session = state.sessions.find(item => item.id === source.agentSessionId)
  if (session) return session.kind === 'agent' && session.control.hostId === source.hostId && session.workspacePath === source.cwd
  const request = state.pendingAgentLaunches[source.agentSessionId]?.request
  if (request) return request.hostId === source.hostId && request.workspacePath === source.cwd
  return false
}

async function exactTakeoverSource(source: TakeoverSource): Promise<TakeoverSource> {
  if (!ownsTakeoverRegion(source)) throw new Error('The original Region or Session changed. Its work is kept.')
  if (source.kind === 'session') return source
  const state = useAppStore.getState()
  if (source.kind === 'saved') {
    // The picker passes the exact Core discovery candidate. A failed preview is
    // not a reason to require native resume or another history read before handover.
    const execution = source.agentSessionId ? takeoverExecution(source.agentSessionId, []) : null
    if (execution && (execution.hostId !== source.hostId || execution.cwd !== source.cwd) ||
      source.nativeSource && source.nativeSource.workspacePath !== source.cwd) {
      throw new Error('The original saved execution identity conflicts with the selected source. Refresh this conversation; its history and existing work are kept.')
    }
    return source
  }
  if (state.sessions.some(item => item.id === source.agentSessionId) || (source.agentSessionId && state.pendingAgentLaunches[source.agentSessionId]?.request)) {
    if (!ownsTakeoverSource(source)) throw new Error('The original execution identity changed. No replacement source was used.')
    return source
  }
  // No current snapshot: re-read the original Core spatial binding and durable
  // metadata. A display move or a stale picker cannot substitute another Host.
  const [spatialRead, historyRead] = await Promise.allSettled([api.spatial.read(), api.sessions.historySources()])
  const spatial = spatialRead.status === 'fulfilled' ? spatialRead.value : null
  if (!ownsTakeoverRegion(source)) throw new Error('The original Region or Session changed. Its work is kept.')
  const region = spatial?.graph.regions.find(item => item.regionId === source.origin.regionId && item.tabId === source.origin.tabId)
  if (region && (region.kind !== 'agent' || region.agentSessionId !== source.agentSessionId)) {
    throw new Error('Core confirms the original Region now belongs to another Session. No replacement source was used; its work is kept.')
  }
  const execution = region?.execution
  const histories = historyRead.status === 'fulfilled' ? historyRead.value : []
  if (execution) {
    if (source.hostId && source.hostId !== execution.hostId || source.cwd && source.cwd !== execution.cwd) {
      throw new Error('The original execution identity changed. No replacement source was used.')
    }
    const metadata = histories.filter(item => item.agentSessionId === source.agentSessionId && item.hostId === execution.hostId && item.history?.workspacePath === execution.cwd)
    return { ...source, hostId: execution.hostId, cwd: execution.cwd,
      executorId: metadata.length === 1 ? metadata[0]!.history!.executorId : source.executorId,
      diagnostic: historyRead.status === 'rejected' ? `${source.diagnostic}\n\nOriginal history observation unavailable: ${historyRead.reason instanceof Error ? historyRead.reason.message : String(historyRead.reason)}. Core confirms the exact original execution source; retain every available context reference.` : source.diagnostic }
  }
  if (historyRead.status === 'rejected') throw historyRead.reason
  const originals = histories.filter(item => item.agentSessionId === source.agentSessionId && item.history)
  if (originals.length !== 1 || !originals[0]?.history) throw new Error('The original execution source is unconfirmed or ambiguous. Re-read this Session; its work and draft are kept.')
  const original = originals[0]
  if (source.hostId && source.hostId !== original.hostId || source.cwd && source.cwd !== original.history!.workspacePath) {
    throw new Error('The original execution identity changed. No replacement source was used.')
  }
  return { ...source, hostId: original.hostId, cwd: original.history!.workspacePath, executorId: original.history!.executorId,
    diagnostic: spatialRead.status === 'rejected' ? `${source.diagnostic}\n\nOriginal spatial observation unavailable: ${spatialRead.reason instanceof Error ? spatialRead.reason.message : String(spatialRead.reason)}. The unique durable Session source is retained.` : source.diagnostic }
}

export function takeoverPrompt(source: TakeoverSource): string {
  const state = useAppStore.getState(), sessionId = source.agentSessionId
  const initial = sessionId ? state.pendingAgentLaunches[sessionId]?.request?.prompt ?? firstPromptFromTimeline(state.timelines[sessionId]) : undefined
  return source.derived ? agentDerivedActionPrompt(source.derived, source, initial ?? undefined) : agentTakeoverPrompt(source, initial ?? undefined)
}

/** Display naming follows the confirmed creation; inspection never overwrites a later edit. */
async function nameTakeover(source: TakeoverSource, report: AgentMuxSpaceMutationReport): Promise<AgentMuxSpaceMutationReport> {
  if (report.outcome !== 'opened' || !report.agent) return report
  const { agentSessionId } = report.agent
  // Core's local Host is relative to that Core; Desktop routes via the exact source Host.
  const hostId = report.agent.hostId
  const state = useAppStore.getState()
  if (currentDisplayNameRevision('agent-session', agentSessionId) > 0 || state.agentNames[agentSessionId]) return report
  try {
    const observed = state.sessions.find(session => session.kind === 'agent' && session.id === agentSessionId && session.control.hostId === hostId)
    const created = observed ? null : await api.sessions.creation(hostId, agentSessionId)
    if (created && created.agentSessionId !== agentSessionId) throw new Error('The creation reply belongs to another Agent; its name was not used.')
    if (created?.kind === 'retired-agent') {
      if (created.history?.creation?.createOperationId !== report.requestId) throw new Error('The retired creation reply belongs to another operation; its name was not used.')
      return { ...report, outcome: 'retired', agent: { ...report.agent, runId: created.run.runId,
        retirement: { source: created.source, observedAt: created.observedAt } } }
    }
    if (created && created.kind !== 'agent') throw new Error('The original creation has no confirmed Session. Its request and inherited name are retained; check the same operation again.')
    if (currentDisplayNameRevision('agent-session', agentSessionId) > 0) return report
    const createdAt = observed?.createdAt ?? created!.createdAt
    const time = new Date(createdAt), pad = (value: number) => String(value).padStart(2, '0')
    if (!Number.isFinite(time.getTime())) throw new Error('The new Agent creation time is unconfirmed.')
    const suffix = `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`
    const original = source.label.replace(/ - \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, '')
    // A derived Agent says where it came from and what it does; only Take over carries the time.
    await useAppStore.getState().renameAgent(agentSessionId, source.derived ? `${original} - ${source.derived.label}` : `${original} - ${suffix}`, 0)
  } catch (error) {
    useAppStore.setState({ nameEditFailure: { operationId: `takeover-name:${report.requestId}`,
      target: { kind: 'agent-session', id: agentSessionId },
      message: `The new Agent is available; its inherited name is unconfirmed: ${error instanceof Error ? error.message : String(error)}. Inspect this Agent's name before editing it.` } })
  }
  return report
}

/** Only a locally retained request for this exact source can carry an earlier result. */
export async function retainsTakeoverRequest(source: TakeoverSource): Promise<boolean> {
  if (source.coreRequest) return true
  return Boolean(source.hostId) && Object.hasOwn(useAppStore.getState().spatialRequests, await takeoverRequestId(source))
}

export async function inspectTakeover(source: TakeoverSource): Promise<AgentMuxSpaceMutationReport | null> {
  if (source.coreRequest) return inspectTakeoverOperation(source, source.coreRequest.operationId)
  // Reading an already-admitted Session intent does not require that its old
  // source Run still be current. Creation below retains the full source fence.
  if (source.kind !== 'session') source = await exactTakeoverSource(source)
  const requestId = await latestTakeoverRequestId(source), state = useAppStore.getState()
  if (!state.spatialRequests[requestId]) return null
  return inspectTakeoverOperation(source, requestId)
}

/** Reconcile this submitted request even after its source presentation has gone away. */
export async function inspectTakeoverOperation(source: TakeoverSource, requestId: string): Promise<AgentMuxSpaceMutationReport> {
  if (source.coreRequest) {
    if (source.coreRequest.operationId !== requestId) throw new Error('The retained Takeover request belongs to another operation.')
    const result = await api.spatial.inspectOperation({ target: { operationId: requestId } })
    if (result.request?.operationId !== requestId || result.request.report?.operationId !== requestId) throw new Error('The original Core Takeover result is unconfirmed. Keep this request and inspect it again.')
    return takeoverReport(result.request.report)
  }
  const state = useAppStore.getState()
  const result = await state.executeControl({ schemaVersion: 5, requestId: `inspect:${mintObjectId()}`,
    operation: 'space.inspect', target: { requestId } })
  if (result.operation !== 'space.inspect') throw new Error('The original creation inspection returned another operation. Its result is unconfirmed.')
  if (!result.request?.report || result.request.requestId !== requestId || result.request.report.requestId !== requestId) {
    throw new Error('The original takeover intent is retained; its exact creation result is unconfirmed. Check this same request again.')
  }
  return result.request.report
}

/** Renderer navigation consumes a confirmed result, including later inspection. */
export function focusTakeoverResult(source: TakeoverSource, report: AgentMuxSpaceMutationReport): void {
  const provenance = report.agent?.takeover?.source
  const historyReceipt = source.kind === 'saved' && !source.origin.regionId && source.agentSessionId &&
    provenance?.hostId === source.hostId && provenance?.agentSessionId === source.agentSessionId &&
    (!source.expectedRuntimeId || provenance.runtimeId === source.expectedRuntimeId)
  if (!['opened', 'partial'].includes(report.outcome) || !report.to || !report.agent || (!historyReceipt && !ownsTakeoverRegion(source))) return
  const state = useAppStore.getState()
  const exact = { ...source, hostId: source.hostId ?? report.agent.hostId, cwd: source.cwd ?? report.agent.cwd }
  if (!historyReceipt && (state.sessions.some(item => item.id === source.agentSessionId) || (source.agentSessionId && state.pendingAgentLaunches[source.agentSessionId]?.request)) && !ownsTakeoverSource(exact)) return
  const target = report.to, region = state.tabs[target.tabId]?.regions[target.regionId]
  if (region?.kind !== 'agent') return
  const session = state.sessions.find(session => session.id === region.sessionId)
  const original = currentCoreSpatialGraph()?.regions.find(item => item.regionId === target.regionId && item.tabId === target.tabId)
  if (session ? session.kind !== 'agent' || session.control.hostId !== report.agent.hostId || session.control.agentSessionId !== report.agent.agentSessionId
    : historyReceipt || source.coreRequest ? original?.agentSessionId !== report.agent.agentSessionId || original.execution?.hostId !== report.agent.hostId
      : region.sessionId !== report.agent.agentSessionId) return
  state.activateTab(target.displayWorkspaceId, target.groupId, target.tabId)
  state.focusRegion(target.displayWorkspaceId, target.tabId, target.regionId, 'pointer', target.groupId)
}

export async function takeOverSession(source: TakeoverSource, executorId: string, current: () => boolean, previousRequestId?: string,
  onSubmitted?: (operation: AgentOperationFeedback) => void): Promise<AgentMuxSpaceMutationReport> {
  if (!source.derived) return takeOverAtDestination(source, executorId, current, previousRequestId, onSubmitted)
  if (!current() || !ownsTakeoverRegion(source)) throw new Error('The original Region or Session changed. No replacement source was used; its work is kept.')
  source = await exactTakeoverSource(source)
  const assertSource = () => {
    if (!current() || !ownsTakeoverRegion(source)) throw new Error('The original Region or Session changed. No replacement source was used; its work is kept.')
    const latest = useAppStore.getState()
    if ((latest.sessions.some(item => item.id === source.agentSessionId) || (source.agentSessionId && latest.pendingAgentLaunches[source.agentSessionId]?.request)) && !ownsTakeoverSource(source)) {
      throw new Error('The original execution identity changed. No replacement source was used.')
    }
  }
  assertSource()
  const existing = await inspectTakeover(source)
  // Only a fresh choice made after presenting this exact retirement authorizes
  // a successor. Another surface's admission converges on its retained result.
  if (existing && (previousRequestId !== existing.requestId || existing.outcome !== 'retired')) return existing
  if (previousRequestId !== undefined && !existing) throw new Error('The previous takeover request is no longer observed. Keep its identity and check it again before creating another Agent.')
  const requestId = await takeoverRequestId(source, previousRequestId)
  assertSource()
  const state = useAppStore.getState()
  if (!source.hostId || !source.cwd) throw new Error('The original execution Host or directory is unconfirmed. Re-read this Session; its work and draft are kept.')
  if (!state.config?.executors[executorId]) throw new Error('This Agent configuration changed. Refresh the choices before taking over.')
  if (source.kind === 'saved' && !state.config?.workspaces.some(workspace => workspace.hostId === source.hostId && workspace.path === source.cwd)) {
    await api.workspaces.add({ hostId: source.hostId, path: source.cwd })
    assertSource()
  }
  const currentState = useAppStore.getState()
  const topics = Object.values(currentState.scratchTopicSnapshots).flatMap(snapshot => snapshot.topics ?? [])
  const catalog = spatialCatalog(currentState, topics)
  async function submit(request: Extract<Parameters<typeof state.executeControl>[0], { operation: 'agent.open' }>) {
    // These are the already-reviewed source and destination. Closing their picker
    // now releases presentation only; the caller retains this exact admitted intent.
    const original = currentState.sessions.find(item => item.kind === 'agent' && item.id === source.agentSessionId && item.control.hostId === source.hostId)
    const operation = beginAgentOperation({ kind: 'takeover', operationId: requestId, phase: 'pending', startedAt: Date.now(),
      takeoverSource: structuredClone(source),
      subject: { hostId: source.hostId!, agentSessionId: original?.kind === 'agent' ? original.control.agentSessionId : source.agentSessionId,
        regionId: source.origin.regionId } })
    updateAgentOperation(operation, { phase: 'pending', message: undefined })
    try {
      onSubmitted?.(operation)
      const result = await state.executeControl(request)
      if (result.operation !== 'agent.open') throw new Error('The takeover creation returned another operation. Its original result is unconfirmed; do not repeat creation.')
      const report = await nameTakeover(source, result)
      settleAgentCreation(operation, report)
      return report
    } catch (error) {
      const retained = useAppStore.getState().agentOperations
      const observed = Object.values(retained).find(item => item.kind === 'takeover' && item.operationId === operation.operationId && item.subject.hostId === operation.subject.hostId)
      if (observed?.phase === 'pending') updateAgentOperation(operation, { phase: 'unconfirmed', message: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }
  if (source.kind === 'session') {
    if (!source.destination) throw new Error('Choose an exact existing Space, Zone and Group for the takeover Tab. The original Agent is kept.')
    const destination = requireAgentNewTabDestination(source.destination, catalog, currentState.layouts, { hostId: source.hostId, cwd: source.cwd })
    assertSource()
    return submit({ schemaVersion: 5, requestId, operation: 'agent.open', focus: false,
      destination, content: { kind: 'new-agent', executorId, prompt: takeoverPrompt(source) } })
  }
  const location = catalog.locations.find(item => item.tabId === source.origin.tabId && item.regionId === source.origin.regionId &&
    item.displayWorkspaceId === source.origin.workspaceId && item.groupId === source.origin.tabGroupId)
  const zones = catalog.zones.filter(zone => zone.hostId === source.hostId && zone.directoryPath === source.cwd)
  const zone = zones.find(item => item.zoneId === location?.zoneId) ?? (zones.length === 1 ? zones[0] : undefined)
  if (!zone || !location) throw new Error('The original execution location is unconfirmed. Re-read its Project; the original Session and draft are kept.')
  // The display may have moved to another Host. Execution stays at the source
  // Zone; the new Tab may still appear beside the original in this display.
  return submit({ schemaVersion: 5, requestId, operation: 'agent.open', focus: false,
    destination: { zoneId: zone.zoneId, displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId, newTab: true },
    content: { kind: 'new-agent', executorId, prompt: takeoverPrompt(source) } })
}


function takeoverReport(result: AgentMuxRpcResult<'agent.open'>): AgentMuxSpaceMutationReport {
  const { operationId, ...report } = result
  return { ...report, requestId: operationId }
}

/** Source organization is a selected original membership, never an inference from cwd or a name. */
async function originalTakeoverSource(source: TakeoverSource): Promise<AgentTakeoverSource> {
  if (!source.hostId) throw new Error('The original Takeover Host is not confirmed. Its work remains available.')
  const state = useAppStore.getState()
  // A saved history row has no current Run claim. Core checks its exact Host and Session.
  const snapshot = source.kind === 'saved' && !source.origin.regionId ? undefined : state.sessions.find(session => session.kind === 'agent' &&
    (session.id === (source.kind === 'session' ? source.presentationSessionId : source.agentSessionId)))
  if (snapshot && (snapshot.kind !== 'agent' || snapshot.control.hostId !== source.hostId)) throw new Error('The original Agent route changed. No replacement source was selected.')
  const agentSessionId = takeoverOperationSubject(source).agentSessionId
  const expectedRun = source.kind === 'session' ? source.expectedRun : snapshot?.kind === 'agent' ? snapshot.control.run : undefined
  const originalRegion = currentCoreSpatialGraph()?.regions.find(region => region.regionId === source.origin.regionId && region.tabId === source.origin.tabId &&
    region.agentSessionId === agentSessionId && region.execution?.hostId === source.hostId)
  let expectedRuntimeId = source.expectedRuntimeId ?? originalRegion?.execution?.runtimeId
  let organization = source.organization ?? null
  if (source.organization === undefined && agentSessionId && source.origin.tabId && source.origin.regionId) {
    const [owner, spatial] = await Promise.allSettled([api.spatial.owner(), api.spatial.read()])
    if (owner.status === 'fulfilled' && spatial.status === 'fulfilled' && spatial.value) {
      const graph = spatial.value.graph
      const region = graph.regions.find(region => region.regionId === source.origin.regionId && region.tabId === source.origin.tabId &&
        region.kind === 'agent' && region.agentSessionId === agentSessionId && region.execution?.hostId === source.hostId)
      expectedRuntimeId ??= region?.execution?.runtimeId
      const tab = region && graph.tabs.find(tab => tab.tabId === region.tabId && tab.regionIds.includes(region.regionId))
      const spaces = tab ? graph.spaces.filter(space => (space.kind === 'mote' || space.kind === 'folder' && space.projectId !== null) &&
        graph.bindings.some(binding => binding.zoneId === tab.zoneId && binding.spaceId === space.spaceId)) : []
      if (spaces.length === 1) organization = { runtimeId: owner.value.owner.runtimeId, spaceId: spaces[0]!.spaceId }
    }
    // A read gap does not invent an organization or block the original Core's exact source check.
  }
  if (!agentSessionId && (!source.nativeSource || !source.executorId)) throw new Error('The original Agent or native conversation is unconfirmed. Keep its source and reread it.')
  return { hostId: source.hostId, ...(expectedRuntimeId ? { expectedRuntimeId } : {}), ...(agentSessionId ? { agentSessionId } : {}), ...(expectedRun ? { expectedRun } : {}), organization,
    ...(source.nativeSource ? { nativeSource: source.nativeSource } : {}), ...(source.executorId ? { executorId: source.executorId } : {}) }
}

/** All new Takeover work uses the original public Core owner; custom derived tasks keep their own owner. */
async function takeOverAtDestination(source: TakeoverSource, executorId: string, current: () => boolean, previousRequestId?: string,
  onSubmitted?: (operation: AgentOperationFeedback) => void): Promise<AgentMuxSpaceMutationReport> {
  if (!current()) throw new Error('The original Takeover choice was closed. Its work remains available.')
  let request = source.coreRequest
  if (!request) {
    if (!source.destination) throw new Error('Choose the exact new Takeover destination. The original location and Agent are kept.')
    const state = useAppStore.getState(), topics = Object.values(state.scratchTopicSnapshots).flatMap(snapshot => snapshot.topics ?? [])
    const destination = requireAgentNewTabDestination(source.destination, spatialCatalog(state, topics), state.layouts)
    const original = await originalTakeoverSource(source)
    if (!current()) throw new Error('The original Takeover choice was closed before submission.')
    const originals = new Map(agentOperationsForSubject(useAppStore.getState().agentOperations, { hostId: source.hostId!,
      agentSessionId: original.agentSessionId, regionId: source.origin.regionId }).map(item => [item.operationId, item]))
    let predecessor = previousRequestId, operationId: string, held: AgentOperationFeedback | undefined
    do {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
        await takeoverRequestId(source, predecessor), destination, executorId
      ])))
      operationId = source.clubPreparation && !predecessor ? source.clubPreparation.operationId :
        'takeover:' + Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
      held = originals.get(operationId)
      if (held?.kind !== 'takeover' || held.cancellation?.result?.outcome !== 'cancelled') break
      // Only this new explicit selection can succeed the confirmed cancelled intent.
      predecessor = operationId
    } while (held)
    request = held?.kind === 'takeover' && held.takeoverSource.coreRequest ? held.takeoverSource.coreRequest : {
      operationId, focus: false, destination, content: { kind: 'takeover-agent', executorId, source: original }
    }
  }
  const frozen: TakeoverSource = { ...source, coreRequest: structuredClone(request) }
  const reference = beginAgentOperation({ kind: 'takeover', operationId: request.operationId, phase: 'pending', startedAt: Date.now(),
    takeoverSource: frozen, subject: { hostId: source.hostId!, agentSessionId: request.content.kind === 'takeover-agent' ? request.content.source.agentSessionId : source.agentSessionId,
      regionId: source.origin.regionId } })
  if (reference.kind !== 'takeover') throw new Error('The retained operation belongs to another action.')
  const operation = retainTakeoverRequest(reference, frozen)
  if (operation.cancellation) throw new Error('The original Takeover has a retained cancellation. Inspect its result; do not continue that original request.')
  // Reopening an exact completed or retired intent reads that result before the surface yields.
  // Observation failure leaves the original public action available with its immutable identity.
  if (!source.coreRequest) {
    try {
      const observed = await api.spatial.inspectOperation({ target: { operationId: request.operationId } })
      if (observed.request?.operationId === request.operationId && observed.request.report &&
        ['opened', 'retired'].includes(observed.request.report.outcome)) {
        const held = useAppStore.getState().agentOperations[agentOperationKey(operation)]
        const report = held?.kind === 'takeover' && held.cancellation ? takeoverReport(observed.request.report) : await nameTakeover(frozen, takeoverReport(observed.request.report))
        settleAgentCreation(operation, report)
        return report
      }
    } catch (cause) { useAppStore.getState().reportError(new Error('The original Takeover observation is unavailable. Its exact request is kept. ' + String(cause))) }
  }
  updateAgentOperation(operation, { phase: 'pending', message: undefined })
  try {
    onSubmitted?.(operation)
    // A lost reply or Renderer restart must retain this full intent before Core admits it.
    await checkpointAgentOperations()
    const result = await api.spatial.openAgent(request)
    if (result.operationId !== request.operationId) throw new Error('The Core result belongs to another Takeover operation. The original request is retained.')
    // Core owns new identities and topology. Refresh only the projection, preserving later user navigation.
    try { await useAppStore.getState().refreshSpatialState() }
    catch (cause) { useAppStore.getState().reportError(new Error('The original Takeover result is retained; its workface refresh is unconfirmed. ' + String(cause))) }
    const held = useAppStore.getState().agentOperations[agentOperationKey(operation)]
    const report = held?.kind === 'takeover' && held.cancellation ? takeoverReport(result) : await nameTakeover(frozen, takeoverReport(result))
    settleAgentCreation(operation, report)
    return report
  } catch (cause) {
    updateAgentOperation(operation, { phase: 'unconfirmed', message: cause instanceof Error ? cause.message : String(cause) })
    throw cause
  }
}

export async function inspectTakeoverClub(source: TakeoverSource) {
  const prepared = source.clubPreparation
  if (!prepared) throw new Error('The original Club preparation identity is unavailable.')
  const [topic, spatial] = await Promise.all([
    api.scratch.readTopic(prepared.expectedResource.workspaceId, prepared.topicId, prepared.expectedResource), api.spatial.read()
  ])
  if (!topic) return null
  if (topic.id !== prepared.topicId || topic.kind !== 'mote' || topic.readError)
    throw new Error('The original Club content is unconfirmed. Keep its exact Topic and workface.')
  const graph = spatial?.graph
  const address = originalTopicAddress({ id: prepared.expectedResource.workspaceId, hostId: prepared.expectedResource.hostId,
    path: prepared.expectedResource.workspacePath }, topic, {})
  const spaces = graph?.spaces.filter(space => space.spaceId === address?.spaceId && space.kind === 'mote' && space.topicId === prepared.topicId &&
    space.hostId === prepared.expectedResource.hostId) ?? []
  const confirmed = spaces.length === 1 && graph!.bindings.some(binding => binding.zoneId === address?.zoneId && binding.spaceId === spaces[0]!.spaceId &&
    graph!.zones.some(zone => zone.zoneId === binding.zoneId && zone.workspaceId === prepared.expectedResource.workspaceId &&
      zone.hostId === prepared.expectedResource.hostId && zone.directoryPath === topic.physicalDirectoryPath))
  if (!confirmed) throw new Error('The Club content is retained; its original Core binding is not yet confirmed. Continue this same preparation to finish its spatial checkpoint.')
  return topic
}

/** Explicit two-level preparation retains one client intent and uses the original Club factory. */
export async function prepareTakeoverClub(source: TakeoverSource, onRetained?: (operation: Extract<AgentOperationFeedback, { kind: 'takeover' }>) => void) {
  if (!source.hostId) throw new Error('The original Takeover source Host is unconfirmed. Its work is kept.')
  const workspace = useAppStore.getState().config?.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)
  if (!workspace) throw new Error('The original Club resource is unavailable. Existing work is kept.')
  const prepared = source.clubPreparation ?? { operationId: 'takeover:' + mintObjectId(),
    expectedResource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path },
    topicId: mintObjectId(), tabId: mintObjectId() }
  if (workspace.hostId !== prepared.expectedResource.hostId || workspace.id !== prepared.expectedResource.workspaceId || workspace.path !== prepared.expectedResource.workspacePath)
    throw new Error('The original Club resource changed. Keep this same preparation; no replacement directory was selected.')
  const frozen = { ...source, clubPreparation: prepared }
  const operation = beginAgentOperation({ kind: 'takeover', operationId: prepared.operationId, subject: takeoverOperationSubject(source),
    startedAt: Date.now(), phase: 'pending', takeoverSource: frozen })
  if (operation.kind !== 'takeover' || operation.takeoverSource.clubPreparation?.topicId !== prepared.topicId)
    throw new Error('The original Club preparation belongs to another intent. No new Club was requested.')
  onRetained?.(operation)
  try {
    await checkpointAgentOperations()
    const topic = await useAppStore.getState().createScratchTopic('mote', undefined, undefined, { reveal: false,
      preparation: { topicId: prepared.topicId, tabId: prepared.tabId, createPresentation: !source.clubPreparation, expectedResource: prepared.expectedResource } })
    // A subsequent public Takeover needs the original new Club binding, including content-only preparation.
    await checkpointSpatialWorkbench()
    const state = useAppStore.getState(), address = topicSpatialAddress(state.config, topic, state.spaceZoneBindings, state.topicCategories)
    if (!address) throw new Error('The original Club destination is unconfirmed. Keep this same preparation.')
    updateAgentOperation(operation, { phase: 'partial', message: 'Club 已建立；尚未选择接手 Agent。原工作保留。' })
    return { source: operation.takeoverSource, topic, address }
  } catch (cause) {
    updateAgentOperation(operation, { phase: 'unconfirmed', message: cause instanceof Error ? cause.message : String(cause) })
    throw cause
  }
}

/** Explicit continuation sends the full retained request back to its original Core owner. */
export async function continueTakeoverOperation(operation: Extract<AgentOperationFeedback, { kind: 'takeover' }>) {
  if (operation.cancellation) throw new Error('This original Takeover has a retained cancellation. Inspect that cancellation; a new Takeover requires an explicit new choice.')
  const request = operation.takeoverSource.coreRequest
  if (!request || request.operationId !== operation.operationId || request.content.kind !== 'takeover-agent')
    throw new Error('The full original Core Takeover request is unavailable. Inspect this same operation; its work is kept.')
  return takeOverAtDestination(operation.takeoverSource, request.content.executorId, () => true)
}
