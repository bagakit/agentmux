import type {
  AgentLaunchResult,
  AgentSessionControl,
  AgentTimelineSnapshot,
  RuntimeEvent,
  RuntimeSnapshot,
  SessionControl,
  SessionSnapshot
} from '../../../shared/contracts'
import { runInterruptionFact } from '../../../shared/contracts'
import { configValuesEqual } from '../../../shared/config-edit'
import type { AgentMuxAgentSession, AgentMuxEvidence, AgentMuxRunRef } from '@agentmux/core'
import { agentInteractionResponseUnavailableReason } from '@agentmux/core/agent-interaction-state'
import { agentPromptPredecessor } from '@agentmux/core/prompt-condition'
import { applyAgentTimelineMutation } from '@agentmux/core/timeline'
import { agentDisplayState, isAgentActivityStatusSource } from '@agentmux/core/agent-status'
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
  type WorkbenchSurface,
  type WorkbenchTab
} from './workbench-tabs'
import { isSessionSurface } from './workbench-surface-kinds'

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
  request?: { executorId: string; prompt?: string }
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
  if (incoming.updatedAt < session.agentSessionUpdatedAt) return false
  if (incoming.updatedAt === session.agentSessionUpdatedAt) return sameRun(session.control.run, incoming.run)
  if (sameRun(session.control.run, incoming.run)) return true
  return incoming.retiredRuns.some((run) => sameRun(run, session.control.run))
}

/** A diagnostic explains a failed step; only Session/Run facts can change Agent status. */
export function runtimeDiagnosticNotice(
  state: Pick<SessionProjectionState, 'sessions'>,
  event: RuntimeEvent
): { message: string; summary: string; subject?: SessionControl } | null {
  const core = event.event
  if (core.type !== 'agent-error') return null
  const run = core.evidence.run
  let session: SessionSnapshot | undefined
  if (core.agentSessionId) {
    const named = state.sessions.filter(item => item.kind === 'agent' && item.id === core.agentSessionId)
    if (named.length > 0) {
      const current = named.filter(item => item.hostId === event.hostId && (!run || sameRun(item.control.run, run)))
      // An explicit Agent identity cannot be reassigned to another Session by its Run.
      if (current.length !== 1) return null
      session = current[0]
    }
  } else if (run) {
    const current = state.sessions.filter(item => item.hostId === event.hostId && sameRun(item.control.run, run))
    if (current.length === 1) session = current[0]
  }
  const confirmed = run !== undefined ? session : undefined
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
    ? `\nObserved at (Unix ms): ${core.evidence.observedAt}. Gap phase: ${gap.kind}. Cause: unknown.` +
      (gap.kind === 'live-stream'
        ? `\nGap latest output byte: ${gap.latestOutputBytes}. Core published-through byte: ${gap.publishedThroughByte ?? 'unknown'}. Representation: ${gap.representation ?? 'unknown'}.\nThe publication boundary is not a Renderer parsing or Input acknowledgement.`
        : `\nReplay requested after byte: ${gap.requestedAfterByte}. First available byte: ${gap.firstAvailableByte}. Snapshot latest output byte: ${gap.latestOutputBytes}.`)
    : ''
  const summary = `${scope}${run ? `; Run "${run.runId}"` : ''}: ${core.code}: ${core.message}`
  return {
    message: `${summary}\n\nDiagnostic:\nSource: ${core.evidence.source}. ${mode}${observation}\n${recovery}`,
    summary,
    ...(confirmed ? { subject: confirmed.control } : {})
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
  return epoch !== undefined && event.hostId === session.hostId && agentSessionId === session.id && mutation.agentSessionId === session.id &&
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
  if (item.agentSessionId !== session.id || item.kind !== 'tool_call') return retained
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
  snapshot: AgentTimelineSnapshot
): SessionProjectionState {
  if (!state.sessions.some((session) => session.kind === 'agent' && session.id === snapshot.agentSessionId)) {
    return state
  }
  const current = state.timelines[snapshot.agentSessionId]
  const pending = state.pendingAgentLaunches[snapshot.agentSessionId]
  const failures = pending?.projectionFailures?.filter(failure => failure.step !== 'timeline')
  return {
    ...state,
    ...(current && (snapshot.revision < current.revision || snapshot.revision === current.revision && !current.liveTool) ? {} : {
      timelines: { ...state.timelines, [snapshot.agentSessionId]: { agentSessionId: snapshot.agentSessionId, revision: snapshot.revision, items: snapshot.items } }
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

/**
 * 用一份 canonical 快照对齐 agent 成员：快照里没有的 agent 就是已经不在了，摘掉它的面。
 *
 * **一份空快照不能当作「一个 agent 都没有」。**它同样可能是 Core 尚未就绪、连接刚建立、或根目录
 * 接错时的回答——而此刻本地还记着好几个正在跑的 agent。把这一份回答当权威，就会把用户离开时留下的
 * 格子在他不看着的时候删掉：切走再切回来，几个 agent 格没了，同 tab 的终端和文件却还在。
 *
 * 启动那条路已经有这道守卫（见 store 里 `retainUnknownSessionViews` 那段，它的注释写着这正是
 * 「重启抹掉布局」的历史成因）。**同一个判断此前只装在一侧出口**：运行时的成员对齐没有等价保护，
 * 也没有测试。删除是不可逆的，而多留一格只是等下一份快照来纠正——所以这里 fail open：一份 session
 * 与恢复候选双双为空的快照不作为退役依据，原样返回。
 *
 * 注意判据是**整份快照为空**，不是「这个 agent 不在快照里」。后者正是这个函数存在的理由：一份说得
 * 出别的 session 的快照有资格说某个 agent 不在了。恢复候选也算说得出话——一个候选就是「这个 agent
 * 还在，只是要重连」，这与启动那侧的判据逐字对齐。
 *
 * 而正因为一个候选的含义是「还在，只是要重连」，**被点名为候选的那个 agent 自己必须免于删除**。
 * Runtime 保留的已结束 Run 仍可出现在 `sessions`；Run 已缺失但 durable Session 还在时，
 * Session 则只出现在 `recoveryCandidates`。若只拿 `sessions` 建 canonical 集合，这个**恰恰可以恢复**的
 * agent 会在下一次成员对齐里被连 tab 带 layout 摘掉，而 partialize 随后把删剩的投影落盘——不可逆，
 * 且没有任何理由显示。那正是这个 Feature 要消灭的失败本身（用户原话：「有些 Region 会消失」）。
 * 启动那侧对同一个候选是「保留 + 恢复」，两侧必须对同一个 Core 概念给出同一个语义。
 */
export function reduceAgentMembershipSnapshot(
  state: SessionProjectionState,
  snapshot: RuntimeSnapshot,
  protectedAgentSessionIds: ReadonlySet<string>
): SessionProjectionState {
  const pendingIds = new Set(Object.keys(state.pendingAgentLaunches))
  // 被 Core 点名为恢复候选的 agent 免于删除：候选的含义就是「还在，只是要重连」。见函数注释。
  const recoverableIds = new Set(snapshot.recoveryCandidates.map((candidate) => candidate.agentSessionId))
  const removalProtectedIds = new Set([...pendingIds, ...protectedAgentSessionIds, ...recoverableIds])
  const canonicalAgents = snapshot.sessions.filter((session): session is Extract<SessionSnapshot, { kind: 'agent' }> => (
    session.kind === 'agent' && !pendingIds.has(session.id)
  ))
  const canonicalIds = new Set(canonicalAgents.map((session) => session.id))
  // 空快照不作为退役依据——见上面的函数注释。判据只需要"这一份说不出话"：一份空快照里没有 canonical
  // agent 可合并，所以再检查一遍"本地是否还记着 agent"不会改变任何结果，那个条件是多余的。
  if (snapshot.sessions.length === 0 && snapshot.recoveryCandidates.length === 0) return state
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

/**
 * Reconcile Terminal projections against an authoritative Runtime snapshot.
 *
 * Terminal Sessions have no semantic continuity record: once Core gives us a non-empty
 * snapshot that does not contain a terminal run, the old PTY is gone and its saved Region
 * must not remain as a title-only shell. An empty snapshot is deliberately fail-open — it
 * can still mean that Runtime is connecting or rooted at the wrong state directory.
 * Unlike Agent membership, this reducer never creates Tabs for unrepresented terminal runs;
 * it only updates or removes terminal Sessions that are already projected in the Workbench.
 */
export function reduceTerminalMembershipSnapshot(
  state: SessionProjectionState,
  snapshot: RuntimeSnapshot
): SessionProjectionState {
  if (snapshot.sessions.length === 0 && snapshot.recoveryCandidates.length === 0) return state

  const canonicalTerminals = snapshot.sessions.filter((session): session is Extract<SessionSnapshot, { kind: 'terminal' }> => (
    session.kind === 'terminal'
  ))
  const canonicalIds = new Set(canonicalTerminals.map((session) => session.id))
  const projectedTerminalIds = new Set([
    ...state.sessions.flatMap((session) => session.kind === 'terminal' ? [session.id] : []),
    ...Object.values(state.tabs).flatMap((tab) => workbenchSurfaces(tab).flatMap((surface) => (
      surface.kind === 'terminal' ? [surface.sessionId] : []
    )))
  ])
  let projected = state
  for (const sessionId of projectedTerminalIds) {
    if (!canonicalIds.has(sessionId)) projected = removeSessionProjection(projected, sessionId)
  }

  const canonicalById = new Map(canonicalTerminals.map((session) => [session.id, session]))
  const sessions = projected.sessions.map((session) => canonicalById.get(session.id) ?? session)
  if (sessions.every((session, index) => session === projected.sessions[index])) return projected
  return { ...projected, sessions }
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

/**
 * 连接失联时写进 `status.detail` 的两句话。**这一对必须说两件相反的事**：一句说「在自愈，等着就好」，
 * 一句说「已经放弃，得你动手」。用户对这两种局面的正确反应完全不同，措辞近似就等于把终局伪装成暂时。
 *
 * 导出为 SSOT：守卫据此断言两条互不重叠，且渲染层引用它们而不是手抄字面量（手抄的那份必然漂移）。
 */
export const CONNECTION_LOST_DETAIL =
  'Reconnecting to this host. Your Agent processes keep running; only this window’s link dropped.'
export const CONNECTION_UNRECOVERABLE_DETAIL =
  'Gave up after repeated drops on this host. Your Agent processes may still be running — use Resume to reattach.'

export function projectRuntimeEvent(
  state: SessionProjectionState,
  event: RuntimeEvent
): RuntimeEventReduction {
  const core = event.event
  if (core.type === 'terminal-output') return { state }
  if (core.type === 'connection-state') {
    // 单 daemon 语义：这台 Host 的实时连接是所有 Agent 共享的，断了就是全体失联。这里正是那 8 处
    // `disconnected` UX 唯一的触发源——没有它，掉线时用户只会看到一屏冻住的 Agent，毫无交代。
    //
    // `lost` 与 `unrecoverable` **都**要置 `disconnected`：两者都意味着连接没了。区别不在状态位，
    // 在 detail 上——它决定用户读到「正在重连」还是「已放弃，请手动处理」。之所以必须两条都接：
    // 抖动预算用尽时 Core 直接发 `unrecoverable` 而**不再发 lost**（检查点前移，见 client 的
    // handleConnectionLost），只认 lost 的话连接判死了、整屏 Agent 还挂着 running，那是最坏的谎话。
    //
    // `restored` 不在这里改状态：由 republishLiveRunState 补发的 process-state/agent-status 事件把
    // 每个 run 拉回进程真相，比这里猜一个状态准。
    if (core.state === 'restored') return { state }
    const detail = core.state === 'unrecoverable'
      ? CONNECTION_UNRECOVERABLE_DETAIL
      : CONNECTION_LOST_DETAIL
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
  if (core.type === 'run-service') {
    const index = state.sessions.findIndex(item => item.hostId === event.hostId &&
      ownsRunEvent(item, core.agentSessionId, core.run))
    if (index < 0) return { state }
    const current = state.sessions[index]!
    if (current.nativeService !== null && core.nativeService.revision <= current.nativeService.revision) return { state }
    const sessions = state.sessions.slice()
    sessions[index] = { ...current, nativeService: structuredClone(core.nativeService),
      updatedAt: Math.max(current.updatedAt, core.evidence.observedAt) }
    return { state: { ...state, sessions } }
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
        ownsRunEvent(item, core.agentSessionId, core.run) &&
        core.evidence.observedAt >= item.status.observedAt
          ? (() => {
              const { interruptionReason: _interruptionReason, ...current } = item
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
      ...(core.detail === undefined ? {} : { detail: core.detail })
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
      interactionResponseUnavailableReason: _interactionResponseUnavailableReason,
      semanticStatus: _semanticStatus,
      terminalCapability: _terminalCapability,
      terminalPromptDelivery: _terminalPromptDelivery,
      terminalOutputChannel: _terminalOutputChannel,
      turnUsage: _turnUsage,
      ...current
    } = item
    const reason = core.session.pendingInteraction ? agentInteractionResponseUnavailableReason(core.session.pendingInteraction) : undefined
    const next = {
      ...current,
      providerId: core.session.providerId,
      hostId: core.session.hostId,
      workspacePath: core.session.workspacePath,
      updatedAt: Math.max(item.updatedAt, core.session.updatedAt),
      agentSessionUpdatedAt: core.session.updatedAt,
      nativeService: sameRun(item.control.run, core.session.run) ? item.nativeService : null,
      ...(core.session.creation ? { creation: structuredClone(core.session.creation) } : {}),
      promptSubmissionPredecessor: agentPromptPredecessor(core.session),
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
      // 同样不许洗掉 `disconnected`（见上面 agent-status arm 的完整论证）：掉线不改 processState，
      // 所以 running 这个条件挡不住它——一条随会话快照重发的 semanticStatus 会把 disconnected 洗成
      // 正常态。`disconnected` 只由 process-state 清，语义状态不是它的解除手。
      ...(core.session.semanticStatus &&
        item.processState === 'running' &&
        item.status.state !== 'disconnected' &&
        core.session.semanticStatus.observedAt > item.status.observedAt
        ? { status: structuredClone(core.session.semanticStatus) }
        : {}),
      ...(core.session.pendingInteraction
        ? { pendingInteraction: structuredClone(core.session.pendingInteraction.request) }
        : {}),
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
    const session = state.sessions.find((item) => item.id === core.agentSessionId)
    if (!session) return { state }
    const previous = state.timelines[core.agentSessionId]
    const applied = applyTimelineEvent(
      state.timelines[core.agentSessionId] ?? {
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
        timelineGapSessionId: core.agentSessionId }
    }
    if (applied.snapshot === state.timelines[core.agentSessionId]) return { state }
    const liveTool = projectLiveTool(previous, session, event as AgentTimelineRuntimeEvent)
    return { state: {
      ...state,
      sessions: state.sessions.map((item) => item.id === core.agentSessionId
        ? { ...item, updatedAt: Math.max(item.updatedAt, core.evidence.observedAt) }
        : item),
      timelines: {
        ...state.timelines,
        [core.agentSessionId]: { ...applied.snapshot, ...(liveTool ? { liveTool } : {}) }
      }
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
