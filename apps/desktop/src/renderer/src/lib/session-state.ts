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
  if (event.type === 'interaction') return event.request.agentSessionId
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

export function removeSessionProjection(
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
 * 一个 run 退出后 Core 不再把它当投影主体（`listRuns` 只列活着的 run），于是它从 `sessions` 里消失、
 * 只出现在 `recoveryCandidates` 里。若只拿 `sessions` 建 canonical 集合，这个**恰恰可以恢复**的
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
          ? (() => {
              const { interruptionReason: _interruptionReason, ...current } = item
              return {
                ...current,
                processState: core.state,
                ...(core.state === 'interrupted' && core.interruptionReason
                  ? { interruptionReason: core.interruptionReason }
                  : {}),
                updatedAt: Math.max(item.updatedAt, core.evidence.observedAt),
                ...(
                  item.kind === 'agent' &&
                  core.state === 'running' &&
                  (item.status.source === 'native-hook' || item.status.source === 'acp')
                    ? {}
                    : {
                        status: {
                          state: displayState,
                          source: core.evidence.source,
                          observedAt: core.evidence.observedAt,
                          ...(core.state === 'interrupted'
                            ? { detail: 'The Run owner interrupted this PTY.' }
                            : {}),
                          ...(core.exitCode === undefined ? {} : { exitCode: core.exitCode }),
                          // 退出原因随退出事件到达就贴到 status 上，让「Exited」横幅能说清是你关的还是它崩的。
                          ...(core.exitReason === undefined ? {} : { exitReason: core.exitReason })
                        }
                      }
                )
              }
            })()
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
        ? (() => {
            const {
              pendingInteraction: _pendingInteraction,
              terminalCapability: _terminalCapability,
              turnUsage: _turnUsage,
              ...current
            } = item
            return {
              ...current,
              providerId: core.session.providerId,
              hostId: core.session.hostId,
              workspacePath: core.session.workspacePath,
              updatedAt: Math.max(item.updatedAt, core.session.updatedAt),
              ...(core.session.terminalCapability
                ? { terminalCapability: structuredClone(core.session.terminalCapability) }
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
              ...(core.session.semanticStatus &&
                item.processState === 'running' &&
                core.session.semanticStatus.observedAt > item.status.observedAt
                ? { status: structuredClone(core.session.semanticStatus) }
                : {}),
              ...(core.session.pendingInteraction
                ? { pendingInteraction: structuredClone(core.session.pendingInteraction.request) }
                : {}),
              control: {
                kind: 'agent' as const,
                hostId: core.session.hostId,
                agentSessionId: core.session.agentSessionId,
                run: { ...core.session.run }
              }
            }
          })()
        : item)
    } }
  }
  if (core.type === 'interaction') {
    return { state: {
      ...state,
      sessions: state.sessions.map((item) => item.kind === 'agent' &&
        item.id === core.request.agentSessionId &&
        acceptsAgentEvidence(item, core.request.evidence)
        ? { ...item, pendingInteraction: structuredClone(core.request) }
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
