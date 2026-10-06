import type {
  AgentLaunchResult,
  AgentSessionControl,
  AgentTimelineSnapshot,
  RuntimeEvent,
  RuntimeEndpointWarning,
  RuntimeSnapshot,
  SessionControl,
  SessionSnapshot
} from '../../../shared/contracts'
import { runInterruptionFact } from '../../../shared/contracts'
import { nativeBindingKey, projectNativeSourceFacts } from '../../../shared/agent-native-source'
import { configValuesEqual } from '../../../shared/config-edit'
import type { AgentMuxAgentSession, AgentMuxEvidence, AgentMuxRunRef, AgentMuxAttachmentGapObservation, AgentMuxOutputGapCauses } from '@agentmux/core'
import { agentInteractionActiveRequest, agentInteractionResponseUnavailableReason } from '@agentmux/core/agent-interaction-state'
import { agentPromptNotApplied, agentPromptPredecessor } from '@agentmux/core/prompt-condition'
import { applyAgentTimelineMutation } from '@agentmux/core/timeline'
import { agentDisplayState, isAgentActivityStatusSource, currentAgentSemanticStatus } from '@agentmux/core/agent-status'
// 进程事实的投影走 node-free 子路径，与主进程侧 import 的是同一个模块（包根那条链拖 node:crypto，
// renderer 引不动）。
import { projectRunProcessStatus, runExitFacts } from '@agentmux/core/run-status'
import type { WorkspaceLayout } from '@agentmux/layout'
import {
  findWorkbenchRegion,
  removeWorkbenchRegion,
  removeTabsFromLayouts,
  replaceWorkbenchRegion,
  updateWorkbenchRegion,
  workbenchSurfaces,
  type LauncherWorkbenchSurface,
  type WorkbenchSurface,
  type WorkbenchTab
} from './workbench-tabs'
import { isSessionSurface } from './workbench-surface-kinds'
import { agentSessionPresentationIndex } from './session-presentation'

export type SessionViewMode = 'terminal' | 'activity'

/** Renderer-only live provenance on the original timeline slot. Never persisted or transported by Core. */
export type RendererAgentTimelineSnapshot = AgentTimelineSnapshot & {
  liveTool?: { itemId: string; hostId: string; runId: string; epoch: number; observedAt: number; startedAt: number }
}

function clearLiveTool(timelines: SessionProjectionState['timelines'], sessionId: string): SessionProjectionState['timelines'] {
  const original = timelines[sessionId]
  if (!original?.liveTool) return timelines
  const { liveTool: _liveTool, ...history } = original
  return { ...timelines, [sessionId]: history }
}

export type SessionProjectionState = {
  displacedAgentSessionIds?: string[]
  noticeReadReceipts?: Record<string, Record<string, string>>
  sessions: SessionSnapshot[]
  timelines: Record<string, RendererAgentTimelineSnapshot>
  pendingAgentLaunches: Record<string, PendingAgentLaunch>
  tabs: Record<string, WorkbenchTab>
  layouts: Record<string, WorkspaceLayout>
  viewModes: Record<string, SessionViewMode>
}

type AgentTimelineRuntimeEvent = RuntimeEvent & {
  event: Extract<RuntimeEvent['event'], { type: 'agent-timeline' }>
}

export type PendingAgentLaunch = {
  /** Exact submitted request, captured before launch; never reconstructed from an editable draft. */
  request?: { executorId: string; hostId?: string; workspacePath?: string; createOperationId?: string; prompt?: string; agentMuxNote?: string; goalPmo?: import('../../../shared/goal-pmo-origin').GoalPmoIntent }
  events: RuntimeEvent[]
  overflowed: boolean
  /** Accepted Core identity while optional display reads are unavailable. */
  created?: AgentLaunchResult['created']
  projectionFailures?: AgentLaunchResult['projectionFailures']
}

export type RuntimeEventReduction = {
  state: SessionProjectionState
  timelineGapSessionId?: string
  sessionMembershipGap?: boolean
}

const MAX_PENDING_AGENT_LAUNCH_EVENTS = 256

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

function sameRun(left: AgentMuxRunRef, right: AgentMuxRunRef): boolean {
  return left.runId === right.runId
}

function ownsRunEvent(
  session: SessionSnapshot,
  agentSessionId: string | undefined,
  run: AgentMuxRunRef
): boolean {
  return (session.kind === 'agent' ? session.control.agentSessionId === agentSessionId : session.id === run.runId) && sameRun(session.control.run, run)
}

function acceptsAgentEvidence(session: SessionSnapshot, evidence: AgentMuxEvidence): boolean {
  return evidence.run === undefined || sameRun(session.control.run, evidence.run)
}

function acceptsAgentSessionTransition(
  session: Extract<SessionSnapshot, { kind: 'agent' }>,
  incoming: AgentMuxAgentSession
): boolean {
  if (session.control.agentSessionId !== incoming.agentSessionId) return false
  if (sameRun(session.control.run, incoming.run) && nativeBindingKey(session) === nativeBindingKey(incoming) &&
    (incoming.semanticStatus?.currentActivityRevision ?? 0) < (session.semanticStatus?.currentActivityRevision ?? 0)) return false
  if (incoming.updatedAt < session.agentSessionUpdatedAt) return false
  if (incoming.updatedAt === session.agentSessionUpdatedAt) return sameRun(session.control.run, incoming.run)
  if (sameRun(session.control.run, incoming.run)) return true
  return incoming.retiredRuns.some((run) => sameRun(run, session.control.run))
}

/** A diagnostic explains a failed step; only Session/Run facts can change Agent status. */
const GAP_CAUSE_LABELS: Record<keyof AgentMuxOutputGapCauses, string> = {
  liveEventPressure: 'Runtime output pressure', subscriberLag: 'slow Attachment subscriber',
  sourceDiscontinuity: 'source output discontinuity', terminalCatchup: 'terminal catch-up',
  geometryLag: 'missed terminal geometry', clientViewPressure: 'client view pressure', unknown: 'unknown'
}

/** Display recovery-relevant facts from this observation without inferring permanent loss. */
function gapObservationDetail(o: AgentMuxAttachmentGapObservation): string {
  const origin = o.origins.daemon ? o.origins.client ? 'mixed (daemon + client)' : 'daemon' : 'client'
  return `\nOrigin: ${origin}. Attachment: ${o.attachmentId}; Run: ${o.runId}.` +
    `\nRuntime: ${o.runtime?.runtimeId ?? 'unknown'}; Native instance: ${o.runtime?.daemonInstanceId ?? 'unknown'}.` +
    `\nSDK received output head: ${o.receivedOutputHeadByte ?? 'unknown'}; continuous delivery through: ${o.deliveredThroughByte ?? 'unknown'}.` +
    `\nRequested after byte: ${o.requestedAfterByte}; recovery after byte: ${o.recoveryAfterByte}; decoded output missed by this observation: ${o.missingOutputBytes ?? 'unknown'}.` +
    `\nThese are Attachment observations, not proof of permanent history loss, Renderer parsing or Input delivery.`
}

export function runtimeDiagnosticNotice(
  state: Pick<SessionProjectionState, 'sessions'>,
  event: RuntimeEvent
): { message: string; summary: string; subject?: SessionControl; cause?: 'AGENT_NATIVE_IDENTITY_UNCONFIRMED' } | null {
  const core = event.event
  if (core.type !== 'agent-error') return null
  const run = core.evidence.run
  let session: SessionSnapshot | undefined
  if (core.agentSessionId) {
    const named = state.sessions.filter(item => item.kind === 'agent' && item.id === core.agentSessionId)
    if (named.length > 0) {
      const current = named.filter(item => item.hostId === event.hostId && (!run || sameRun(item.control.run, run)))
      // An explicit Agent identity cannot be reassigned to another Session by its Run.
      if (current.length !== 1) {
        // A complete failure of an original operation remains readable after
        // that Run changes. It is not a state or subject of the replacement.
        // Existing identity/source notices still settle with their original Run.
        if (!core.failure || core.code === 'AGENT_NATIVE_IDENTITY_UNCONFIRMED' ||
          core.code === 'AGENT_NATIVE_SOURCE_UNCONFIRMED') return null
      } else session = current[0]
    }
  } else if (run) {
    const current = state.sessions.filter(item => item.hostId === event.hostId && sameRun(item.control.run, run))
    if (current.length === 1) session = current[0]
  }
  const confirmed = run !== undefined ? session : undefined
  // The exact Core source observation has its persistent Region service window.
  // Do not duplicate that fact in an unrelated global error that survives its resolution.
  // Missing facts and failed persistence still need the original diagnostic surface.
  if (confirmed?.kind === 'agent' && confirmed.nativeSourceObservation?.run.runId === run?.runId &&
    (core.code === 'AGENT_NATIVE_SOURCE_UNCONFIRMED' || core.code === 'AGENT_NATIVE_IDENTITY_UNCONFIRMED')) return null
  const scope = session
    ? `${session.kind === 'agent' ? 'Agent' : 'Terminal'} "${session.label}" on host "${event.hostId}"`
    : core.agentSessionId
      ? `Agent "${core.agentSessionId}" on host "${event.hostId}"`
      : `Host "${event.hostId}"`
  const mode = confirmed
    ? confirmed.kind === 'agent'
      ? `Last confirmed Agent state: ${confirmed.status.state}; Run state: ${confirmed.processState}.`
      : `Last confirmed Run state: ${confirmed.processState}.`
    : 'The affected current Session could not be confirmed.'
  const recovery = core.code === 'OUTPUT_GAP'
    ? 'Refresh the terminal observation to check available output. This does not establish complete history or confirm input delivery.'
    : 'Check the terminal and error details before choosing a recovery action.'
  const gap = core.code === 'OUTPUT_GAP' ? core.evidence.outputGap : undefined
  const observation = gap
    ? `\nObserved at (Unix ms): ${core.evidence.observedAt}. Gap phase: ${gap.kind}. Cause: ${gap.kind === 'live-stream' ? Object.entries(gap.causes).filter(([, observed]) => observed).map(([cause]) => GAP_CAUSE_LABELS[cause as keyof AgentMuxOutputGapCauses]).join(', ') : 'unknown'}.` +
      (gap.kind === 'live-stream'
        ? `\nGap latest output byte: ${gap.latestOutputBytes}. Core published-through byte: ${gap.publishedThroughByte ?? 'unknown'}. Representation: ${gap.representation ?? 'unknown'}.\nThe publication boundary is not a Renderer parsing or Input acknowledgement.` + gapObservationDetail(gap.observation)
        : `\nReplay requested after byte: ${gap.requestedAfterByte}. First available byte: ${gap.firstAvailableByte}. Snapshot latest output byte: ${gap.latestOutputBytes}.`)
    : ''
  const summary = `${scope}${run ? `; Run "${run.runId}"` : ''}: ${core.code}: ${core.message}`
  return {
    message: `${summary}\n\nDiagnostic:\nSource: ${core.evidence.source}. ${mode}${observation}\n${recovery}` +
      (core.failure ? `\n\nOriginal failure:\n${JSON.stringify(core.failure, null, 2)}` : ''),
    summary,
    ...(confirmed ? { subject: confirmed.control } : {}),
    // Only an absent main identity has this success condition. Source conflicts and failed
    // persistence retain their own cause; matching text or a generic error code cannot settle them.
    ...(confirmed?.kind === 'agent' && !confirmed.nativeHandle && !confirmed.observedNativeHandle &&
      !confirmed.nativeSourceObservation && core.evidence.source === 'agentmux' &&
      core.code === 'AGENT_NATIVE_IDENTITY_UNCONFIRMED' ? { cause: core.code } : {})
  }
}

export function ownsSessionLaunch(
  surface: WorkbenchSurface | undefined,
  kind: 'agent' | 'terminal',
  sessionId: string
): boolean {
  return surface?.kind === kind && surface.phase === 'launching' && surface.sessionId === sessionId
}

export function reduceSessionLaunchAttached(
  state: SessionProjectionState,
  regionId: string,
  session: SessionSnapshot
): SessionProjectionState {
  const owner = findWorkbenchRegion(state.tabs, regionId)
  if (!owner || !ownsSessionLaunch(owner.surface, session.kind, session.id)) return state
  const projected = {
    ...state,
    sessions: [...state.sessions.filter((item) => item.id !== session.id), session]
  }
  const tab = projected.tabs[owner.tab.id]
  return {
    ...projected,
    tabs: tab
      ? {
          ...projected.tabs,
          [tab.id]: updateWorkbenchRegion(tab, regionId, (surface) => (
            isSessionSurface(surface)
              ? { ...surface, phase: 'attached' }
              : surface
          ))
        }
      : projected.tabs,
    ...(session.kind === 'agent'
      ? { viewModes: { ...projected.viewModes, [session.id]: 'terminal' as const } }
      : {})
  }
}

function applyTimelineEvent(
  snapshot: AgentTimelineSnapshot,
  event: AgentTimelineRuntimeEvent['event']
): { snapshot: AgentTimelineSnapshot; gap: boolean } {
  if (event.revision <= snapshot.revision) return { snapshot, gap: false }
  if (event.revision !== snapshot.revision + 1) return { snapshot, gap: true }
  return {
    snapshot: {
      agentSessionId: snapshot.agentSessionId,
      revision: event.revision,
      items: applyAgentTimelineMutation(snapshot.items, event.mutation)
    },
    gap: false
  }
}

function workingToolEpoch(session: SessionSnapshot): number | undefined {
  return session.kind === 'agent' && session.status.state === 'working' && !session.pendingInteraction &&
    session.semanticStatus?.state === 'working' ? session.semanticStatus.stateEnteredAt : undefined
}

function acceptsCurrentToolEvent(session: SessionSnapshot, event: AgentTimelineRuntimeEvent, epoch: number | undefined, observedAt = 0): boolean {
  const { evidence, mutation, agentSessionId } = event.event
  const updateAt = mutation.type === 'update' ? mutation.updatedAt : mutation.item.updatedAt
  return epoch !== undefined && event.hostId === session.hostId && session.kind === 'agent' && agentSessionId === session.control.agentSessionId && mutation.agentSessionId === session.control.agentSessionId &&
    evidence.run?.runId === session.control.run.runId && ['native-hook', 'acp'].includes(evidence.source) &&
    evidence.observedAt >= epoch && evidence.observedAt >= observedAt && updateAt >= epoch &&
    (mutation.type === 'update' || mutation.item.createdAt >= epoch)
}

function projectLiveTool(previous: RendererAgentTimelineSnapshot | undefined, session: SessionSnapshot, event: AgentTimelineRuntimeEvent): RendererAgentTimelineSnapshot['liveTool'] {
  const live = previous?.liveTool, epoch = workingToolEpoch(session)
  const retained = epoch !== undefined && live?.hostId === session.hostId && live.runId === session.control.run.runId && live.epoch === epoch ? live : undefined
  const core = event.event, evidence = core.evidence, mutation = core.mutation
  if (!acceptsCurrentToolEvent(session, event, epoch, retained?.observedAt)) return retained
  const updateAt = mutation.type === 'update' ? mutation.updatedAt : mutation.item.updatedAt
  if (mutation.type === 'update') {
    // Updates cannot promote an unknown historical item into a live tool. Its exact admitted start is required.
    if (!retained || retained.itemId !== mutation.itemId || updateAt < retained.startedAt) return retained
    return mutation.status === 'complete' || mutation.status === 'failed' ? undefined : { ...retained, observedAt: evidence.observedAt }
  }
  const item = mutation.item
  if (session.kind !== 'agent' || item.agentSessionId !== session.control.agentSessionId || item.kind !== 'tool_call') return retained
  if (item.status !== 'streaming') return retained?.itemId === item.id && item.createdAt === retained.startedAt && updateAt >= retained.startedAt ? undefined : retained
  if (item.createdAt < epoch!) return retained
  return { itemId: item.id, hostId: session.hostId, runId: session.control.run.runId, epoch: epoch!, observedAt: evidence.observedAt, startedAt: item.createdAt }
}

function eventAgentSessionId(event: RuntimeEvent['event']): string | null {
  if (event.type === 'agent-timeline' || event.type === 'agent-status') return event.agentSessionId
  if (event.type === 'interaction') return event.request.agentSessionId
  if (event.type === 'agent-session') return event.session.agentSessionId
  if (
    event.type === 'process-state' ||
    event.type === 'run-service' ||
    event.type === 'agent-error' ||
    event.type === 'run-removed'
  ) return event.agentSessionId ?? null
  return null
}

/** Keep local slots only when the native identity, Host and original Run select one presentation. */
export function runtimeEventSession(sessions: SessionSnapshot[], event: RuntimeEvent): SessionSnapshot | undefined {
  const id = eventAgentSessionId(event.event)
  if (id === null) return undefined
  const core = event.event
  const run = core.type === 'agent-session' ? core.session.run
    : 'run' in core ? core.run : 'evidence' in core ? core.evidence.run : undefined
  const matches = (agentSessionPresentationIndex(sessions).get(id) ?? []).filter(session =>
    session.control.agentSessionId === id && session.hostId === event.hostId && session.control.hostId === event.hostId &&
    (session.id === id || run !== undefined && sameRun(session.control.run, run)))
  return matches.length === 1 ? matches[0] : undefined
}

export function pendingAgentLaunchEventId(
  state: SessionProjectionState,
  event: RuntimeEvent
): string | null {
  const agentSessionId = eventAgentSessionId(event.event)
  return agentSessionId !== null &&
    !agentSessionPresentationIndex(state.sessions).has(agentSessionId) &&
    state.pendingAgentLaunches[agentSessionId] !== undefined
    ? agentSessionId
    : null
}

export function ownsPendingAgentLaunchEvent(
  state: SessionProjectionState,
  event: RuntimeEvent
): boolean {
  return pendingAgentLaunchEventId(state, event) !== null
}

export function bufferPendingAgentEvent(
  state: SessionProjectionState,
  event: RuntimeEvent,
  agentSessionId: string
): SessionProjectionState {
  const current = state.pendingAgentLaunches[agentSessionId]
  if (!current) return state
  const events = [...current.events, event]
  return {
    ...state,
    pendingAgentLaunches: {
      ...state.pendingAgentLaunches,
      [agentSessionId]: {
        ...current,
        events: events.slice(-MAX_PENDING_AGENT_LAUNCH_EVENTS),
        overflowed: current.overflowed || events.length > MAX_PENDING_AGENT_LAUNCH_EVENTS
      }
    }
  }
}

export function discardPendingAgentLaunch(
  state: SessionProjectionState,
  agentSessionId: string
): SessionProjectionState {
  if (!state.pendingAgentLaunches[agentSessionId]) return state
  return {
    ...state,
    pendingAgentLaunches: withoutKey(state.pendingAgentLaunches, agentSessionId)
  }
}

function projectAgentLaunchResult(
  state: SessionProjectionState,
  result: AgentLaunchResult
): RuntimeEventReduction {
  const id = result.created.agentSessionId
  const pending = state.pendingAgentLaunches[id]
  const current = state.sessions.find((session) => session.id === id)
  // A later canonical Run must never be replaced by an old creation receipt.
  const newer = current?.kind === 'agent' &&
    !sameRun(current.control.run, result.created.run) && current.updatedAt >= result.created.updatedAt
  const incoming = !newer && result.session?.id === id &&
    sameRun(result.session.control.run, result.created.run) ? result.session : undefined
  const session = incoming && current?.kind === 'agent' && current.updatedAt > incoming.updatedAt
    ? current : incoming
  const timeline = result.timeline?.agentSessionId === id ? result.timeline : undefined
  const failures = newer ? [] : result.projectionFailures
  const unresolved = !newer && (!session || !timeline || failures.length > 0)
  let projected: SessionProjectionState = {
    ...state,
    ...(session ? { sessions: [...state.sessions.filter((item) => item.id !== id), session] } : {}),
    ...(timeline && (!state.timelines[id] || timeline.revision > state.timelines[id].revision)
      ? { timelines: { ...state.timelines, [id]: timeline } } : {}),
    pendingAgentLaunches: unresolved
      ? { ...state.pendingAgentLaunches, [id]: {
          ...pending, events: session ? [] : pending?.events ?? [], overflowed: pending?.overflowed ?? false,
          created: result.created, projectionFailures: failures
        } }
      : withoutKey(state.pendingAgentLaunches, id)
  }
  let gap = Boolean(session && !timeline)
  if (session) for (const buffered of pending?.events ?? []) {
    const reduced = projectRuntimeEvent(projected, buffered)
    projected = reduced.state
    gap ||= reduced.timelineGapSessionId === id
  }
  return { state: projected, ...(gap ? { timelineGapSessionId: id } : {}) }
}

export function reduceAgentSessionLaunchAttached(
  state: SessionProjectionState,
  regionId: string,
  result: AgentLaunchResult
): RuntimeEventReduction {
  const owner = findWorkbenchRegion(state.tabs, regionId)
  if (!owner || !ownsSessionLaunch(owner.surface, 'agent', result.created.agentSessionId)) return { state }
  const attached = {
    ...state,
    tabs: { ...state.tabs, [owner.tab.id]: updateWorkbenchRegion(owner.tab, regionId, (surface) => (
      surface.kind === 'agent' ? { ...surface, phase: 'attached' } : surface
    )) },
    viewModes: { ...state.viewModes, [result.created.agentSessionId]: 'terminal' as const }
  }
  return projectAgentLaunchResult(attached, result)
}

export function reduceDetachedAgentLaunch(
  state: SessionProjectionState,
  result: AgentLaunchResult
): RuntimeEventReduction {
  return projectAgentLaunchResult(state, result)
}

export function reduceTimelineSnapshot(
  state: SessionProjectionState,
  snapshot: AgentTimelineSnapshot,
  sessionId = snapshot.agentSessionId,
  observedControl?: AgentSessionControl
): SessionProjectionState {
  if (!state.sessions.some((session) => session.kind === 'agent' && session.id === sessionId && session.control.agentSessionId === snapshot.agentSessionId)) return state
  const current = state.timelines[sessionId]
  const pending = state.pendingAgentLaunches[snapshot.agentSessionId]
  const failures = pending?.projectionFailures?.filter(failure => failure.step !== 'timeline')
  return {
    ...state,
    ...(observedControl ? { sessions: state.sessions.map(session => {
      if (session.kind !== 'agent' || session.id !== sessionId || !session.timelineObservation ||
        session.control.hostId !== observedControl.hostId || session.control.agentSessionId !== observedControl.agentSessionId ||
        !sameRun(session.control.run, observedControl.run) || !sameRun(session.timelineObservation.run, observedControl.run)) return session
      const { timelineObservation: _resolved, ...recovered } = session
      return recovered
    }) } : {}),
    ...(current && (snapshot.revision < current.revision || snapshot.revision === current.revision && !current.liveTool) ? {} : {
      timelines: { ...state.timelines, [sessionId]: { agentSessionId: snapshot.agentSessionId, revision: snapshot.revision, items: snapshot.items } }
    }),
    ...(pending?.created && failures ? { pendingAgentLaunches: failures.length > 0
      ? { ...state.pendingAgentLaunches, [snapshot.agentSessionId]: { ...pending, projectionFailures: failures } }
      : withoutKey(state.pendingAgentLaunches, snapshot.agentSessionId) } : {})
  }
}

export function removeSessionProjection(
  state: SessionProjectionState,
  sessionId: string
): SessionProjectionState {
  // A startup snapshot can leave a saved Region projected before its Session has ever been
  // published into Renderer state. Cleanup must still remove that orphan Region; otherwise the
  // title survives as an empty Tab forever even though the Session list is already canonical.
  const hasProjectedSession = state.sessions.some((session) => session.id === sessionId)
  const hasProjectedView = Object.values(state.tabs).some((tab) => workbenchSurfaces(tab).some((surface) => (
    isSessionSurface(surface) && surface.sessionId === sessionId
  )))
  if (!hasProjectedSession && !hasProjectedView) return state
  const removedTabIds: string[] = []
  const tabs = { ...state.tabs }
  for (const tab of Object.values(state.tabs)) {
    const removedRegionIds = workbenchSurfaces(tab).flatMap((surface) => (
      isSessionSurface(surface) && surface.sessionId === sessionId
        ? [surface.regionId]
        : []
    ))
    let nextTab: WorkbenchTab | null = tab
    for (const regionId of removedRegionIds) {
      if (!nextTab) break
      nextTab = removeWorkbenchRegion(nextTab, regionId)
    }
    if (!nextTab) {
      removedTabIds.push(tab.id)
      delete tabs[tab.id]
    } else if (nextTab !== tab) {
      tabs[tab.id] = nextTab
    }
  }
  return {
    sessions: state.sessions.filter((session) => session.id !== sessionId),
    ...(state.displacedAgentSessionIds ? { displacedAgentSessionIds: state.displacedAgentSessionIds.filter((id) => id !== sessionId) } : {}),
    ...(state.noticeReadReceipts ? { noticeReadReceipts:
      withoutKey(withoutKey(state.noticeReadReceipts, sessionId), `mail:${sessionId}`) } : {}),
    timelines: withoutKey(state.timelines, sessionId),
    pendingAgentLaunches: withoutKey(state.pendingAgentLaunches, sessionId),
    tabs,
    layouts: removeTabsFromLayouts(state.layouts, removedTabIds),
    viewModes: withoutKey(state.viewModes, sessionId)
  }
}

/** An endpoint's availability describes this read; it cannot retire an absent Session. */
export function runtimeSnapshotHostUnavailable(snapshot: RuntimeSnapshot, hostId: string): boolean {
  return (snapshot.runtimeEndpointWarnings ?? []).some((warning) => warning.scope !== 'observation' && warning.hostId === hostId && warning.availability !== 'connected')
}

/** Availability is a display projection. It never replaces cached Run/native facts or their clocks. */
export function projectRuntimeEndpointSessions(
  sessions: SessionSnapshot[],
  warnings: RuntimeEndpointWarning[] | undefined
): SessionSnapshot[] {
  const unavailable = new Map((warnings ?? []).filter(warning => warning.scope !== 'observation' && warning.availability !== 'connected').map(warning => [warning.hostId, warning]))
  if (unavailable.size === 0) return sessions
  let changed = false
  const projected = sessions.map(session => {
    const warning = session.kind === 'agent' ? unavailable.get(session.hostId) : undefined
    if (!warning || (session.status.state === 'disconnected' && session.status.detail === warning.message)) return session
    changed = true
    return { ...session, status: { ...session.status, state: 'disconnected' as const, detail: warning.message } }
  })
  return changed ? projected : sessions
}

/** Merge positive membership facts; exact removal/retirement receipts own deletion. */
export function reduceAgentMembershipSnapshot(
  state: SessionProjectionState,
  snapshot: RuntimeSnapshot
): SessionProjectionState {
  const pendingIds = new Set(Object.keys(state.pendingAgentLaunches))
  const canonicalAgents = snapshot.sessions.filter((session): session is Extract<SessionSnapshot, { kind: 'agent' }> => (
    session.kind === 'agent' && !pendingIds.has(session.id) && !runtimeSnapshotHostUnavailable(snapshot, session.hostId)
  ))
  if (snapshot.sessions.length === 0 && snapshot.recoveryCandidates.length === 0) {
    const sessions = projectRuntimeEndpointSessions(state.sessions, snapshot.runtimeEndpointWarnings)
    return sessions === state.sessions ? state : { ...state, sessions }
  }
  const canonicalById = new Map(canonicalAgents.map((session) => [session.id, session]))
  const existingIds = new Set(state.sessions.map((session) => session.id))
  const sessions = state.sessions.map((session) => canonicalById.get(session.id) ?? session)
  for (const session of canonicalAgents) {
    if (!existingIds.has(session.id)) sessions.push(session)
  }
  const timelines = { ...state.timelines }
  for (const session of canonicalAgents) {
    const incoming = snapshot.timelines[session.id]
    if (!incoming && session.timelineObservation && sameRun(session.timelineObservation.run, session.control.run)) continue
    if (!incoming || incoming.agentSessionId !== session.id) {
      throw new Error(`Runtime snapshot is missing the matching Timeline for Agent Session: ${session.id}`)
    }
    const current = timelines[session.id]
    if (!current || incoming.revision >= current.revision) timelines[session.id] = incoming
  }
  return { ...state, sessions: projectRuntimeEndpointSessions(sessions, snapshot.runtimeEndpointWarnings), timelines }
}

/**
 * Merge positive Terminal facts into original Workbench references. Absence in a
 * catalogue is not an exact removal receipt; explicit removal and user close keep
 * their existing owners. Unrepresented inventory never creates a Tab.
 */
export function reduceTerminalMembershipSnapshot(
  state: SessionProjectionState,
  snapshot: RuntimeSnapshot
): SessionProjectionState {
  if (snapshot.sessions.length === 0 && snapshot.recoveryCandidates.length === 0) return state
  const canonicalTerminals = snapshot.sessions.filter((session): session is Extract<SessionSnapshot, { kind: 'terminal' }> => (
    session.kind === 'terminal' && !runtimeSnapshotHostUnavailable(snapshot, session.hostId)
  ))
  const projectedTerminalIds = new Set([
    ...state.sessions.flatMap((session) => session.kind === 'terminal' ? [session.id] : []),
    ...Object.values(state.tabs).flatMap((tab) => workbenchSurfaces(tab).flatMap((surface) => (
      surface.kind === 'terminal' ? [surface.sessionId] : []
    )))
  ])
  const canonicalById = new Map(canonicalTerminals.map((session) => [session.id, session]))
  const sessions = state.sessions.map((session) => canonicalById.get(session.id) ?? session)
  // Saved Regions can precede their first verified endpoint read. Adopt only their
  // original referenced Runs; unrelated inventory does not create a View.
  const existingIds = new Set(sessions.map(session => session.id))
  for (const session of canonicalTerminals) {
    if (projectedTerminalIds.has(session.id) && !existingIds.has(session.id)) sessions.push(session)
  }
  if (sessions.length === state.sessions.length && sessions.every((session, index) => session === state.sessions[index])) return state
  return { ...state, sessions }
}

export function reduceSessionLaunchFailed(
  state: SessionProjectionState,
  regionId: string,
  kind: 'agent' | 'terminal',
  sessionId: string,
  launcher?: LauncherWorkbenchSurface
): SessionProjectionState {
  const executorId = kind === 'agent' ? state.pendingAgentLaunches[sessionId]?.request?.executorId : undefined
  const cleaned = kind === 'agent' ? discardPendingAgentLaunch(state, sessionId) : state
  const owner = findWorkbenchRegion(cleaned.tabs, regionId)
  if (!owner || !ownsSessionLaunch(owner.surface, kind, sessionId)) return cleaned
  return {
    ...cleaned,
    tabs: {
      ...cleaned.tabs,
      [owner.tab.id]: replaceWorkbenchRegion(owner.tab, regionId, {
        ...launcher,
        regionId,
        kind: 'launcher',
        workspaceId: owner.surface.workspaceId,
        ...(executorId ? { executorId } : {})
      })
    }
  }
}

/** Connection service phases share disconnected process observation, with distinct recovery actions. */
export const CONNECTION_LOST_DETAIL =
  'Reconnecting to this host. Your Agent processes keep running; only this window’s link dropped.'
export const CONNECTION_RETRYING_DETAIL =
  'Recovery has slowed to one attempt every 30 seconds. Your Agent processes may still be running; use Resume to retry now.'
export const CONNECTION_UNRECOVERABLE_DETAIL =
  'Gave up after repeated drops on this host. Your Agent processes may still be running — use Resume to reattach.'

export function projectRuntimeEvent(
  state: SessionProjectionState,
  event: RuntimeEvent
): RuntimeEventReduction {
  const core = event.event
  if (core.type === 'terminal-output' || core.type === 'run-service') return { state }
  if (core.type === 'connection-state') {
    // 单 daemon 语义：这台 Host 的实时连接是所有 Agent 共享的，断了就是全体失联。这里正是那 8 处
    // `disconnected` UX 唯一的触发源——没有它，掉线时用户只会看到一屏冻住的 Agent，毫无交代。
    //
    // Restored status comes from authoritative per-Run facts, not a guessed healthy state.
    if (core.state === 'restored') return { state }
    const detail = core.state === 'unrecoverable'
      ? CONNECTION_UNRECOVERABLE_DETAIL
      : core.state === 'retrying' ? CONNECTION_RETRYING_DETAIL : CONNECTION_LOST_DETAIL
    return { state: {
      ...state,
      timelines: state.sessions.reduce((timelines, item) => item.kind === 'agent' && item.hostId === event.hostId ? clearLiveTool(timelines, item.id) : timelines, state.timelines),
      sessions: state.sessions.map((item) => item.kind === 'agent' &&
        item.hostId === event.hostId
        ? {
            ...item,
            updatedAt: Math.max(item.updatedAt, core.evidence.observedAt),
            status: {
              state: 'disconnected' as const,
              source: core.evidence.source,
              observedAt: core.evidence.observedAt,
              detail
            }
          }
        : item)
    } }
  }
  const pendingAgentSessionId = eventAgentSessionId(core)
  const existingEventSession = runtimeEventSession(state.sessions, event)
  // A stale or ambiguous existing presentation is an observation gap, never new membership.
  if (pendingAgentSessionId && !existingEventSession && agentSessionPresentationIndex(state.sessions).has(pendingAgentSessionId)) return { state }
  if (
    pendingAgentSessionId &&
    ownsPendingAgentLaunchEvent(state, event)
  ) {
    return { state: bufferPendingAgentEvent(state, event, pendingAgentSessionId) }
  }
  if (pendingAgentSessionId && !existingEventSession) {
    return { state, sessionMembershipGap: true }
  }
  if (core.type === 'process-state') {
    // 「进程事实 → 界面那一行状态」走 Core 的共享投影，与主进程快照路径（runtime-controller 的
    // projectSession）是**同一个**实现。这里只负责把事件的字段形状取出来喂给它。
    //
    // 曾经这段是本地手写的，于是它比快照路径少一整条事实：内核报的终止信号在这里根本没被读过。后果是
    // 同一个被 SIGSEGV 打死的 Agent，崩溃**当下**只显示一个没有下文的 error，关掉窗口重开反而看到了
    // `signal SIGSEGV`——最需要那条信息的时刻恰好没有。
    //
    // 三条退出事实走 runExitFacts 而不是在这里逐条 spread：正因为那三行曾经是两处各抄一份，漏一行
    // 没有任何东西会红（字段可选、投影不要求在场），exitSignal 和 exitReason 才各自独立地漏过一次。
    // 本地只保留事件形状独有的部分——source 和 observedAt 在这条路上要从 evidence 里取。
    const processStatus = projectRunProcessStatus({
      state: core.state,
      source: core.evidence.source,
      observedAt: core.evidence.observedAt,
      ...runExitFacts(core)
    })
    return { state: {
      ...state,
      ...(core.state !== 'running' && existingEventSession && ownsRunEvent(existingEventSession, core.agentSessionId, core.run) && core.evidence.observedAt >= existingEventSession.status.observedAt
        ? { timelines: clearLiveTool(state.timelines, existingEventSession.id) } : {}),
      sessions: state.sessions.map((item) =>
        item.hostId === event.hostId && (core.agentSessionId === undefined || item === existingEventSession) && ownsRunEvent(item, core.agentSessionId, core.run) &&
        core.evidence.observedAt >= item.status.observedAt
          ? (() => {
              const { interruptionReason: _interruptionReason, runUnobserved: _runUnobserved, ...current } = item
              return {
                ...current,
                processState: core.state,
                ...runInterruptionFact(core),
                updatedAt: Math.max(item.updatedAt, core.evidence.observedAt),
                ...(
                  item.kind === 'agent' &&
                  core.state === 'running' &&
                  isAgentActivityStatusSource(item.status.source)
                    ? {}
                    : { status: processStatus }
                )
              }
            })()
          : item
      )
    } }
  }
  if (core.type === 'agent-status') {
    const item = existingEventSession
    // Hook observations cannot restore a disconnected byte channel. Only the Run's
    // process-state publication after rebuilding that channel can clear disconnected.
    if (!item || !acceptsAgentEvidence(item, core.evidence) ||
      core.evidence.observedAt < item.status.observedAt || item.status.state === 'disconnected') return { state }
    const updatedAt = Math.max(item.updatedAt, core.evidence.observedAt)
    const status: SessionSnapshot['status'] = {
      state: agentDisplayState(core.state),
      source: core.evidence.source,
      observedAt: core.evidence.observedAt,
      ...(core.detail === undefined ? {} : { detail: core.detail }),
      ...(core.failure ? { failure: structuredClone(core.failure) } : {})
    }
    // Compare the actual projection, including removed optional facts, before replacing
    // its collection. A rejected or repeated observation must not wake unrelated consumers.
    const statusKeys = Object.keys(status) as (keyof typeof status)[]
    if (updatedAt === item.updatedAt && Object.keys(item.status).length === statusKeys.length &&
      statusKeys.every((key) => Object.is(item.status[key], status[key]))) return { state }
    const sessions = state.sessions.slice()
    sessions[state.sessions.indexOf(item)] = { ...item, updatedAt, status }
    return { state: { ...state, sessions, ...(status.state !== 'working' || item.status.state !== 'working' ? { timelines: clearLiveTool(state.timelines, item.id) } : {}) } }
  }
  if (core.type === 'agent-session') {
    const item = existingEventSession
    if (!item || item.kind !== 'agent' || !acceptsAgentSessionTransition(item, core.session)) return { state }
    const {
      pendingInteraction: _pendingInteraction,
      completedInteractionResponse: _completedInteractionResponse,
      interactionResponseUnavailableReason: _interactionResponseUnavailableReason,
      semanticStatus: _semanticStatus,
      terminalCapability: _terminalCapability,
      terminalPromptDelivery: _terminalPromptDelivery,
      terminalOutputChannel: _terminalOutputChannel,
      timelineObservation,
      turnUsage: _turnUsage,
      nativeSessionId: _nativeSessionId,
      nativeHandle: _nativeHandle,
      nativeHandlePersistence: _nativeHandlePersistence,
      observedNativeHandle: _observedNativeHandle,
      nativeSourceObservation: _nativeSourceObservation,
      hookIngressObservation: _hookIngressObservation,
      nativeConfirmation: _nativeConfirmation,
      ...current
    } = item
    const semantic = currentAgentSemanticStatus(core.session.semanticStatus)
    const currentActivityAdvanced = sameRun(item.control.run, core.session.run) &&
      (core.session.semanticStatus?.currentActivityRevision ?? 0) > (item.semanticStatus?.currentActivityRevision ?? 0)
    const reason = core.session.pendingInteraction ? agentInteractionResponseUnavailableReason(core.session.pendingInteraction) : undefined
    const pending = core.session.pendingInteraction
    const activeRequest = agentInteractionActiveRequest(pending)
    const next = {
      ...current,
      providerId: core.session.providerId,
      ...projectNativeSourceFacts(core.session),
      ...(core.session.hookIngressObservation
        ? { hookIngressObservation: structuredClone(core.session.hookIngressObservation) }
        : {}),
      nativeService: sameRun(item.control.run, core.session.run) ? item.nativeService ?? null : null,
      ...(timelineObservation && sameRun(timelineObservation.run, core.session.run) ? { timelineObservation } : {}),
      ...(core.session.nativeHandle ? { nativeSessionId: core.session.nativeHandle.sessionId } : {}),
      hostId: core.session.hostId,
      workspacePath: core.session.workspacePath,
      updatedAt: Math.max(item.updatedAt, core.session.updatedAt),
      agentSessionUpdatedAt: core.session.updatedAt,
      ...(core.session.creation ? { creation: structuredClone(core.session.creation) } : {}),
      promptSubmissionPredecessor: agentPromptPredecessor(core.session),
      promptInputNotApplied: agentPromptNotApplied(core.session),
      ...(nativeBindingKey(item) !== nativeBindingKey(core.session) && item.status.state !== 'disconnected' && !semantic
        ? { status: projectRunProcessStatus({ state: item.processState, source: 'run-process', observedAt: core.session.updatedAt }) }
        : {}),
      // Mirror the Core fact independently of the display freshness gate below.
      // An accepted snapshot may clear an idle epoch without a new observation.
      ...(core.session.semanticStatus
        ? { semanticStatus: structuredClone(core.session.semanticStatus) }
        : {}),
      ...(core.session.terminalCapability
        ? { terminalCapability: structuredClone(core.session.terminalCapability) }
        : {}),
      ...(core.session.terminalPromptDelivery
        ? { terminalPromptDelivery: structuredClone(core.session.terminalPromptDelivery) }
        : {}),
      ...(core.session.terminalOutputChannel
        ? { terminalOutputChannel: structuredClone(core.session.terminalOutputChannel) }
        : {}),
      // 最近一 turn 的真实用量随收尾事件的 agent-session 快照到达 —— 权威镜像 Core：带就复制、
      // 缺就丢弃（destructure 把陈旧值从 ...current 里剔掉）。缺一条条件复制，live 路径就永远读不到
      // 真数、状态栏卡在等待记号「—」；只加复制不加 destructure，则 Core 侧清空（读 transcript 失败
      // 那一轮）永远传不到 UI，上一轮的数字会一直挂在「Last turn」标签下。两半必须成对。
      ...(core.session.turnUsage
        ? { turnUsage: structuredClone(core.session.turnUsage) }
        : {}),
      // status 走 observedAt 严格单调门禁，与核心侧 persistSemanticStatus 的 `>` 同口径。
      // agent-session 是「会话快照」：同一条 semanticStatus 会随任意会话变更（终端能力降级、
      // prompt 投递清理等约十处）被反复重发，其 observedAt 不变。若无门禁，一条被本地衰减为
      // running（衰减刻意保留 observedAt）的状态会被这类陈旧重发按原 observedAt 又贴回 working，
      // 闪一帧再被重新衰减；一条滞后的旧快照也会盖掉更新的状态。要求严格新于当前观测才套用：
      // 真正的新证据 observedAt 一定更大、照常点亮，同 observedAt 的重发一律跳过。
      // Core 的 currentActivityRevision 独立排序已证子活动与输入消费。消费可以撤回较新的子活动投影，
      // 而不移动历史主轮/原生 observedAt；只认更大的 owner revision，重复快照不能再次点亮旧 working。
      // 同样不许洗掉 `disconnected`（见上面 agent-status arm 的完整论证）：掉线不改 processState，
      // 所以 running 这个条件挡不住它——一条随会话快照重发的 semanticStatus 会把 disconnected 洗成
      // 正常态。`disconnected` 只由 process-state 清，语义状态不是它的解除手。
      ...(semantic &&
        item.processState === 'running' &&
        item.status.state !== 'disconnected' &&
        (semantic.observedAt > item.status.observedAt || currentActivityAdvanced)
        ? { status: structuredClone(semantic) }
        : {}),
      ...(activeRequest
        ? { pendingInteraction: structuredClone(activeRequest) }
        : {}),
      ...(pending?.response && activeRequest?.id !== pending.request.id ? { completedInteractionResponse: {
        requestId: pending.request.id, operationId: pending.response.operationId, acknowledged: pending.response.acknowledged
      } } : {}),
      ...(reason ? { interactionResponseUnavailableReason: reason } : {}),
      control: {
        kind: 'agent' as const,
        hostId: core.session.hostId,
        agentSessionId: core.session.agentSessionId,
        run: { ...core.session.run }
      }
    }
    // Compare this one plain-data projection, including removed optional facts. An equal timestamp
    // is not equality; a rejected/equal projection must not notify the Session collection.
    if (configValuesEqual(item, next)) return { state }
    const sessions = state.sessions.slice()
    sessions[state.sessions.indexOf(item)] = next
    return { state: { ...state, sessions, ...(next.status.state !== 'working' || next.pendingInteraction ||
      !sameRun(item.control.run, next.control.run) || next.semanticStatus?.stateEnteredAt !== item.semanticStatus?.stateEnteredAt
      ? { timelines: clearLiveTool(state.timelines, item.id) } : {}) } }
  }
  // Interaction events announce observations, including additional native requests.
  // Only the authoritative agent-session record chooses the current answerable request.
  if (core.type === 'agent-timeline') {
    const session = existingEventSession
    if (!session) return { state }
    const previous = state.timelines[session.id]
    const applied = applyTimelineEvent(
      state.timelines[session.id] ?? {
        agentSessionId: core.agentSessionId,
        revision: 0,
        items: []
      },
      core
    )
    if (applied.gap) {
      // Any admitted current-round gap could conceal completion, even when this event is readable history.
      // Foreign/old-Run/old-epoch events retain the current tool; history, gap repair and healthy input stay unchanged.
      const live = previous?.liveTool, epoch = workingToolEpoch(session)
      const currentGap = live?.hostId === session.hostId && live.runId === session.control.run.runId && live.epoch === epoch &&
        acceptsCurrentToolEvent(session, event as AgentTimelineRuntimeEvent, epoch, live.observedAt)
      return { state: currentGap ? { ...state, timelines: clearLiveTool(state.timelines, session.id) } : state,
        timelineGapSessionId: session.id }
    }
    if (applied.snapshot === state.timelines[session.id]) return { state }
    const liveTool = projectLiveTool(previous, session, event as AgentTimelineRuntimeEvent)
    return { state: {
      ...state,
      sessions: state.sessions.map((item) => item === session
        ? { ...item, updatedAt: Math.max(item.updatedAt, core.evidence.observedAt) }
        : item),
      timelines: {
        ...state.timelines,
        [session.id]: { ...applied.snapshot, ...(liveTool ? { liveTool } : {}) }
      }
    } }
  }
  if (core.type !== 'run-removed') return { state }
  const session = core.agentSessionId === undefined
    ? state.sessions.find((item) => item.hostId === event.hostId && ownsRunEvent(item, undefined, core.run))
    : existingEventSession && ownsRunEvent(existingEventSession, core.agentSessionId, core.run) ? existingEventSession : undefined
  if (!session) return { state }
  return { state: removeSessionProjection(state, session.id) }
}

export function reduceRuntimeEvent(
  state: SessionProjectionState,
  event: RuntimeEvent
): SessionProjectionState {
  return projectRuntimeEvent(state, event).state
}
