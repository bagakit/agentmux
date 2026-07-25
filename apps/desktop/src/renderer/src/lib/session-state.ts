import type {
  AgentLaunchResult,
  AgentTimelineSnapshot,
  RuntimeEvent,
  RuntimeSnapshot,
  SessionSnapshot
} from '../../../shared/contracts'
import type { AgentMuxAgentSession, AgentMuxEvidence, AgentMuxRunRef } from '@agentmux/core'
import { applyAgentTimelineMutation } from '@agentmux/core/timeline'
import type { WorkspaceLayout } from './workbench-layout'
import {
  findWorkbenchRegion,
  removeWorkbenchRegion,
  removeTabsFromLayouts,
  replaceWorkbenchRegion,
  updateWorkbenchRegion,
  workbenchSurfaces,
  type WorkbenchSurface,
  type WorkbenchTab
} from './workbench-tabs'

export type SessionViewMode = 'terminal' | 'activity'

export type SessionProjectionState = {
  sessions: SessionSnapshot[]
  timelines: Record<string, AgentTimelineSnapshot>
  pendingAgentLaunches: Record<string, PendingAgentLaunch>
  tabs: Record<string, WorkbenchTab>
  layouts: Record<string, WorkspaceLayout>
  viewModes: Record<string, SessionViewMode>
}

type AgentTimelineRuntimeEvent = RuntimeEvent & {
  event: Extract<RuntimeEvent['event'], { type: 'agent-timeline' }>
}

export type PendingAgentLaunch = {
  events: RuntimeEvent[]
  overflowed: boolean
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
  return session.id === (agentSessionId ?? run.runId) && sameRun(session.control.run, run)
}

function acceptsAgentEvidence(session: SessionSnapshot, evidence: AgentMuxEvidence): boolean {
  return evidence.run === undefined || sameRun(session.control.run, evidence.run)
}

function acceptsAgentSessionTransition(
  session: Extract<SessionSnapshot, { kind: 'agent' }>,
  incoming: AgentMuxAgentSession
): boolean {
  if (session.id !== incoming.agentSessionId) return false
  if (incoming.updatedAt < session.updatedAt) return false
  if (incoming.updatedAt === session.updatedAt) return sameRun(session.control.run, incoming.run)
  if (sameRun(session.control.run, incoming.run)) return true
  return incoming.retiredRuns.some((run) => sameRun(run, session.control.run))
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
            surface.kind === 'agent' || surface.kind === 'terminal'
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

function eventAgentSessionId(event: RuntimeEvent['event']): string | null {
  if (event.type === 'agent-timeline' || event.type === 'agent-status') return event.agentSessionId
  if (event.type === 'agent-session') return event.session.agentSessionId
  if (
    event.type === 'process-state' ||
    event.type === 'agent-error' ||
    event.type === 'run-removed'
  ) return event.agentSessionId ?? null
  return null
}

export function pendingAgentLaunchEventId(
  state: SessionProjectionState,
  event: RuntimeEvent
): string | null {
  const agentSessionId = eventAgentSessionId(event.event)
  return agentSessionId !== null &&
    !state.sessions.some((session) => session.id === agentSessionId) &&
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

function bufferPendingAgentEvent(
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
  const pending = state.pendingAgentLaunches[result.session.id]
  let gap = false
  let projected: SessionProjectionState = {
    ...state,
    timelines: { ...state.timelines, [result.session.id]: result.timeline },
    pendingAgentLaunches: withoutKey(state.pendingAgentLaunches, result.session.id)
  }
  for (const buffered of pending?.events ?? []) {
    const reduced = projectRuntimeEvent(projected, buffered)
    projected = reduced.state
    gap ||= reduced.timelineGapSessionId === result.session.id
  }
  return {
    state: projected,
    ...(gap ? { timelineGapSessionId: result.session.id } : {})
  }
}

export function reduceAgentSessionLaunchAttached(
  state: SessionProjectionState,
  regionId: string,
  result: AgentLaunchResult
): RuntimeEventReduction {
  const attached = reduceSessionLaunchAttached(state, regionId, result.session)
  return attached === state ? { state } : projectAgentLaunchResult(attached, result)
}

export function reduceDetachedAgentLaunch(
  state: SessionProjectionState,
  result: AgentLaunchResult
): RuntimeEventReduction {
  const projected = {
    ...state,
    sessions: [...state.sessions.filter((session) => session.id !== result.session.id), result.session]
  }
  return projectAgentLaunchResult(projected, result)
}

export function reduceTimelineSnapshot(
  state: SessionProjectionState,
  snapshot: AgentTimelineSnapshot
): SessionProjectionState {
  if (!state.sessions.some((session) => session.kind === 'agent' && session.id === snapshot.agentSessionId)) {
    return state
  }
  const current = state.timelines[snapshot.agentSessionId]
  if (current && snapshot.revision <= current.revision) return state
  return {
    ...state,
    timelines: { ...state.timelines, [snapshot.agentSessionId]: snapshot }
  }
}

function removeSessionProjection(
  state: SessionProjectionState,
  sessionId: string
): SessionProjectionState {
  if (!state.sessions.some((session) => session.id === sessionId)) return state
  const removedTabIds: string[] = []
  const tabs = { ...state.tabs }
  for (const tab of Object.values(state.tabs)) {
    const removedRegionIds = workbenchSurfaces(tab).flatMap((surface) => (
      (surface.kind === 'agent' || surface.kind === 'terminal') && surface.sessionId === sessionId
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
    timelines: withoutKey(state.timelines, sessionId),
    pendingAgentLaunches: withoutKey(state.pendingAgentLaunches, sessionId),
    tabs,
    layouts: removeTabsFromLayouts(state.layouts, removedTabIds),
    viewModes: withoutKey(state.viewModes, sessionId)
  }
}

export function reduceAgentMembershipSnapshot(
  state: SessionProjectionState,
  snapshot: RuntimeSnapshot,
  protectedAgentSessionIds: ReadonlySet<string>
): SessionProjectionState {
  const pendingIds = new Set(Object.keys(state.pendingAgentLaunches))
  const removalProtectedIds = new Set([...pendingIds, ...protectedAgentSessionIds])
  const canonicalAgents = snapshot.sessions.filter((session): session is Extract<SessionSnapshot, { kind: 'agent' }> => (
    session.kind === 'agent' && !pendingIds.has(session.id)
  ))
  const canonicalIds = new Set(canonicalAgents.map((session) => session.id))
  let projected = state
  for (const session of state.sessions) {
    if (session.kind === 'agent' && !removalProtectedIds.has(session.id) && !canonicalIds.has(session.id)) {
      projected = removeSessionProjection(projected, session.id)
    }
  }

  const canonicalById = new Map(canonicalAgents.map((session) => [session.id, session]))
  const existingIds = new Set(projected.sessions.map((session) => session.id))
  const sessions = projected.sessions.map((session) => canonicalById.get(session.id) ?? session)
  for (const session of canonicalAgents) {
    if (!existingIds.has(session.id)) sessions.push(session)
  }

  const timelines = { ...projected.timelines }
  for (const session of canonicalAgents) {
    const incoming = snapshot.timelines[session.id]
    if (!incoming || incoming.agentSessionId !== session.id) {
      throw new Error(`Runtime snapshot is missing the matching Timeline for Agent Session: ${session.id}`)
    }
    const current = timelines[session.id]
    if (!current || incoming.revision >= current.revision) timelines[session.id] = incoming
  }
  return { ...projected, sessions, timelines }
}

export function reduceSessionLaunchFailed(
  state: SessionProjectionState,
  regionId: string,
  kind: 'agent' | 'terminal',
  sessionId: string
): SessionProjectionState {
  const cleaned = kind === 'agent' ? discardPendingAgentLaunch(state, sessionId) : state
  const owner = findWorkbenchRegion(cleaned.tabs, regionId)
  if (!owner || !ownsSessionLaunch(owner.surface, kind, sessionId)) return cleaned
  return {
    ...cleaned,
    tabs: {
      ...cleaned.tabs,
      [owner.tab.id]: replaceWorkbenchRegion(owner.tab, regionId, {
        regionId,
        kind: 'launcher',
        workspaceId: owner.surface.workspaceId
      })
    }
  }
}

export function projectRuntimeEvent(
  state: SessionProjectionState,
  event: RuntimeEvent
): RuntimeEventReduction {
  const core = event.event
  if (core.type === 'terminal-output') return { state }
  const pendingAgentSessionId = eventAgentSessionId(core)
  const existingEventSession = pendingAgentSessionId
    ? state.sessions.find((session) => session.id === pendingAgentSessionId)
    : undefined
  if (existingEventSession && existingEventSession.hostId !== event.hostId) return { state }
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
    const displayState = core.state === 'interrupted' ? 'error' : core.state
    return { state: {
      ...state,
      sessions: state.sessions.map((item) =>
        ownsRunEvent(item, core.agentSessionId, core.run) &&
        core.evidence.observedAt >= item.status.observedAt
          ? {
              ...item,
              processState: core.state,
              updatedAt: Math.max(item.updatedAt, core.evidence.observedAt),
              status: {
                state: displayState,
                source: core.evidence.source,
                observedAt: core.evidence.observedAt,
                // 保留内核原始中断原因（如 daemon_restart）——与 refresh 路径
                // (runtime-controller.ts projectSession) 一致，交给 SessionPane 渲染层
                // 的 humanizeDetail 统一翻译成人类可读文案。无 reason 时回退旧句子。
                ...(core.state === 'interrupted'
                  ? { detail: core.interruptionReason ?? 'The Run owner interrupted this PTY.' }
                  : {}),
                ...(core.exitCode === undefined ? {} : { exitCode: core.exitCode })
              }
            }
          : item
      )
    } }
  }
  if (core.type === 'agent-status') {
    return { state: {
      ...state,
      sessions: state.sessions.map((item) => item.id === core.agentSessionId &&
        acceptsAgentEvidence(item, core.evidence) &&
        core.evidence.observedAt >= item.status.observedAt
        ? {
            ...item,
            updatedAt: Math.max(item.updatedAt, core.evidence.observedAt),
            status: {
              state: core.state === 'unknown' ? 'running' : core.state,
              source: core.evidence.source,
              observedAt: core.evidence.observedAt,
              ...(core.detail === undefined ? {} : { detail: core.detail })
            }
          }
        : item)
    } }
  }
  if (core.type === 'agent-session') {
    return { state: {
      ...state,
      sessions: state.sessions.map((item) => item.kind === 'agent' &&
        acceptsAgentSessionTransition(item, core.session)
        ? {
            ...item,
            providerId: core.session.providerId,
            hostId: core.session.hostId,
            workspacePath: core.session.workspacePath,
            updatedAt: Math.max(item.updatedAt, core.session.updatedAt),
            control: {
              kind: 'agent' as const,
              hostId: core.session.hostId,
              agentSessionId: core.session.agentSessionId,
              run: { ...core.session.run }
            }
          }
        : item)
    } }
  }
  if (core.type === 'agent-timeline') {
    const session = state.sessions.find((item) => item.id === core.agentSessionId)
    if (!session) return { state }
    const applied = applyTimelineEvent(
      state.timelines[core.agentSessionId] ?? {
        agentSessionId: core.agentSessionId,
        revision: 0,
        items: []
      },
      core
    )
    if (applied.gap) return { state, timelineGapSessionId: core.agentSessionId }
    if (applied.snapshot === state.timelines[core.agentSessionId]) return { state }
    return { state: {
      ...state,
      sessions: state.sessions.map((item) => item.id === core.agentSessionId
        ? { ...item, updatedAt: Math.max(item.updatedAt, core.evidence.observedAt) }
        : item),
      timelines: {
        ...state.timelines,
        [core.agentSessionId]: applied.snapshot
      }
    } }
  }
  if (core.type === 'permission') return { state }
  if (core.type === 'agent-error') {
    if (!core.agentSessionId) return { state }
    return { state: {
      ...state,
      sessions: state.sessions.map((item) => item.id === core.agentSessionId &&
        acceptsAgentEvidence(item, core.evidence) &&
        core.evidence.observedAt >= item.status.observedAt
        ? {
            ...item,
            updatedAt: Math.max(item.updatedAt, core.evidence.observedAt),
            status: {
              state: 'error',
              source: core.evidence.source,
              observedAt: core.evidence.observedAt,
              detail: core.message
            }
          }
        : item)
    } }
  }
  if (core.type !== 'run-removed') return { state }
  const session = state.sessions.find((item) => ownsRunEvent(item, core.agentSessionId, core.run))
  if (!session) return { state }
  return { state: removeSessionProjection(state, session.id) }
}

export function reduceRuntimeEvent(
  state: SessionProjectionState,
  event: RuntimeEvent
): SessionProjectionState {
  return projectRuntimeEvent(state, event).state
}
