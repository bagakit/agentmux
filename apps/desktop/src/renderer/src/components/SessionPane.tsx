import type { ConversationAnnotationSelection } from '@agentmux/client-ui/conversation-annotation'
import { ConversationMessageAvatar } from './ConversationMessageAvatar'
import { AlertTriangle, CircleStop, LoaderCircle, RefreshCw, RotateCcw, ServerOff } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type ComponentProps } from 'react'
import { useAppStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { effectiveSessionViewMode, sessionPresentationById } from '../lib/session-presentation'
import type { AgentMuxRunExitReason, AgentSessionUserMessage } from '@agentmux/core'
import { TERMINAL_FONT_SIZE_DEFAULT } from '../../../shared/contracts'
import {
  dismissOpenDestinationRequest,
  type OpenDestination,
  type OpenHttpLinkOrigin
} from '../lib/open-destination'
import { terminalLinkModifierOpensSystemBrowser } from '../lib/terminal-link-gesture'
import { CONNECTION_UNRECOVERABLE_DETAIL } from '../lib/session-state'
import { sessionRecoveryClassName, sessionRecoveryState } from '../lib/session-recovery-banner'
import { workspaceRootForPath } from '../lib/workbench-tabs'
import { createSessionProjectFileContextSelector } from '../lib/session-project-file-context'
import { api } from '../lib/api'
import { createSpeakerResolver } from '@agentmux/client-ui/conversation-speaker'
import { currentConversationSenderDetails, currentConversationSpeakerMetadata } from '../lib/conversation-sender-details'
import { useSessionUserMessages } from '../lib/session-user-messages'
import type { LinkClickModifiers } from '@agentmux/client-ui/components/AgentMarkdown'
import { AgentSessionComposer } from './AgentSessionComposer'
import type { ConversationAnnotation } from '@agentmux/client-ui/components/ConversationMessage'
import { ConversationAnnotationNote, type ConversationAnnotationNoteHandle } from './ConversationAnnotationNote'
import { SessionConnectingSurface } from './SessionConnectingSurface'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { SessionRecoveryActions } from './SessionRecoveryActions'
import type { RecoverySource } from '../lib/session-recovery-actions'
import { errorIdentity, presentError } from '@agentmux/client-ui/error-presentation'
import { AgentLifecycleFeedback } from './AgentLifecycleFeedback'
import { AgentInteractionCard } from '@agentmux/client-ui/components/AgentInteractionCard'
import { ActivityView } from './ActivityView'
import { OpenDestinationPopover, type OpenDestinationRequest } from './OpenDestinationBar'
import { TerminalView } from './TerminalView'
import { isMacPlatform } from '../lib/host-platform'
import {
  classifyContinuityFailure,
  continuityRefreshEnabled,
  continuityRetryEnabled
} from '../lib/continuity-failure-notice'
import { sessionRegionProjectionPolicy } from '../lib/session-region-projection'
import { SessionResultReview } from './SessionResultReview'
import { SessionResultReviewContent } from './SessionResultReviewContent'
import { SessionHistoryView } from './SessionHistoryView'
import { useFocusHistorySources } from '../lib/focus-history-sources'
import { FullPageLoadingSurface } from './FullPageLoadingSurface'
import { SessionRecap } from './SessionRecap'
import { AgentRegionHeader } from './AgentRegionHeader'
import { executionHostProjection, regionExecutionHost } from '../lib/region-execution-host'
import { SessionActivityPresentation } from './SessionActivityPresentation'
import { useWorkbenchBrowserPresentation, workbenchSessionStageHostId, type WorkbenchViewTarget } from '../lib/workbench-presentation'
import { agentDisplayName, firstPromptFromTimeline } from '../lib/workbench-tabs'
import { agentProviderLabel } from './AgentProviderIcon'
import { moteConversationIdentity, useMoteConversationOwner } from '../lib/mote-conversation-identity'
import { agentStartupRecoveryDecision, agentStartupRecoveryDetail } from '../lib/idle-agent-restore-policy'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'
import type { ConversationRevealRequest, MailboxMessageNavigationResult } from '../lib/mailbox-message-navigation'

const NO_TIMELINE_ITEMS: never[] = []
const NO_PRESENTATIONS: readonly WorkbenchViewTarget[] = []

function humanizeDetail(
  interruptionReason: string | undefined,
  detail: string | undefined,
  exited: boolean,
  exitReason: AgentMuxRunExitReason | undefined
): string {
  if (interruptionReason === 'daemon_restart') {
    return 'The Runtime restarted and interrupted this process. Use the recovery action below to continue.'
  }
  // 退出时，先按 Core 合成的原因说清「是你关的还是它崩的」——这正是 T-012 要区分的事。
  if (exited && exitReason) {
    if (exitReason === 'user-stopped') return 'You stopped this session.'
    if (exitReason === 'crashed') return 'The process exited on its own.'
    // unknown：诚实说读不出结论，绝不把裸 0 冒充成干净完成。
    return 'The process is no longer running; the reason could not be determined.'
  }
  if (!detail) return exited ? 'The process is no longer running.' : 'Check the host and try again.'
  return detail
}

export function SessionPane({
  sessionId,
  surfaceKind,
  interactiveResize,
  visible,
  parked = false,
  readOnly = false,
  headerPortalTargetId = null,
  presentations = NO_PRESENTATIONS,
  renderPresentationFrame,
  onPresentationSelected,
  linkOrigin
}: {
  sessionId: string
  surfaceKind: 'agent' | 'terminal'
  interactiveResize: boolean
  // 这一格看不看得见。隐藏的 Tab 留在 DOM 里保住终端实例，但里面的终端一律停工。
  visible: boolean
  /** Long-hidden, replayable terminal views may release xterm/addons while keeping this Region alive. */
  parked?: boolean
  /** Observation projection: no PTY input, Agent composer, interaction response or recovery. */
  readOnly?: boolean
  headerPortalTargetId?: string | null
  presentations?: readonly WorkbenchViewTarget[]
  renderPresentationFrame?: ((content: ReactNode, target: WorkbenchViewTarget) => ReactNode) | undefined
  onPresentationSelected?: ((target: WorkbenchViewTarget) => void) | undefined
  linkOrigin: OpenHttpLinkOrigin
}) {
  const projectionPolicy = sessionRegionProjectionPolicy(readOnly)
  const { reference: primaryReference } = useWorkbenchBrowserPresentation()
  const mailboxOrigin = primaryReference ? { ...linkOrigin, workspaceId: primaryReference.displayWorkspaceId,
    tabGroupId: primaryReference.groupId, tabId: primaryReference.tabId } : linkOrigin
  const session = useAppStore((state) => sessionPresentationById(state.sessions).get(sessionId))
  const pendingLaunch = useAppStore((state) => state.pendingAgentLaunches[sessionId])
  const recoveryCandidate = useAppStore((state) => state.recoveryCandidates.find((candidate) => candidate.agentSessionId === sessionId))
  const historyCatalogue = useFocusHistorySources(!session && !pendingLaunch && surfaceKind === 'agent' && visible && !parked)
  const historyHostId = useAppStore(state => state.config?.workspaces.find(workspace => workspace.id === linkOrigin.workspaceId)?.hostId)
  const retainedHistory = historyCatalogue.sources.find(source => source.agentSessionId === sessionId && source.hostId === historyHostId)
  // Core creation's `local` is local to its server, not this Desktop. The existing
  // submitted request retains the configured endpoint; missing intent stays unknown.
  const executionHostId = session ? session.kind === 'agent' ? session.control.hostId : session.hostId
    : pendingLaunch ? pendingLaunch.request?.hostId
      : retainedHistory?.state === 'retired' ? retainedHistory.hostId : recoveryCandidate?.hostId
  const configuredExecutionHost = useAppStore(state => state.config?.hosts.find(host => host.id === executionHostId))
  const runtimeOwnershipWarnings = useAppStore((state) => state.runtimeOwnershipWarnings)
  const connectingExecutorId = pendingLaunch?.request?.executorId ?? (session?.kind === 'agent' ? session.executorId : recoveryCandidate?.executorId ?? retainedHistory?.history?.executorId)
  const connectingExecutor = useAppStore((state) => connectingExecutorId ? state.config?.executors[connectingExecutorId] : undefined)
  const connectingAppearance = useAppStore((state) => connectingExecutorId ? state.config?.executors?.[connectingExecutorId]?.avatar : undefined)
  const tabName = useAppStore((state) => linkOrigin.tabId ? state.tabs?.[linkOrigin.tabId]?.name : undefined)
  const sourceWorkspaceId = useAppStore(state => linkOrigin.tabId ? state.tabs[linkOrigin.tabId]?.workspaceId : undefined)
  const moteOwner = useMoteConversationOwner(linkOrigin.workspaceId, linkOrigin.tabId,
    visible || presentations.some(target => target.visible !== false))
  const timeline = useAppStore((state) => state.timelines[sessionId]?.items ?? NO_TIMELINE_ITEMS)
  const timelineSnapshot = useAppStore((state) => state.timelines[sessionId])
  const userName = useAppStore((state) => state.agentNames?.[sessionId])
  const appendAgentComposerDraft = useAppStore((state) => state.appendAgentComposerDraft)
  const terminalThemeId = useAppStore((state) => state.config?.appearance.terminalTheme)
  const autoFocus = useAppStore(state => {
    if (!visible || readOnly || state.retainedSpatialFocus || state.workbenchNavigationInputPolicy || state.mainSurface !== 'workbench' ||
      state.activeWorkspaceId !== linkOrigin.workspaceId || !linkOrigin.tabId || !linkOrigin.regionId) return false
    const layout = state.layouts[linkOrigin.workspaceId]
    const group = layout?.groups.find(one => one.id === layout.activeGroupId)
    return group?.activeTabId === linkOrigin.tabId && state.tabs[linkOrigin.tabId]?.layout.activeRegionId === linkOrigin.regionId
  })
  const terminalFontSize = useAppStore(
    (state) => state.config?.appearance.terminalFontSize ?? TERMINAL_FONT_SIZE_DEFAULT
  )
  const viewMode = useAppStore(state => effectiveSessionViewMode(state, sessionId))
  const activitySourceKey = session?.kind === 'agent' ? JSON.stringify([session.control.hostId, session.id, session.control.run.runId]) : sessionId
  const activityLifetime = useRef({ sourceKey: activitySourceKey, opened: false })
  const activityContent = useRef<ReactNode>(null)
  const currentSourceKey = useRef(activitySourceKey)
  currentSourceKey.current = activitySourceKey
  const currentPresentations = useRef(presentations)
  currentPresentations.current = presentations
  const navigation = useRef({ generation: 0, cancel: null as (() => void) | null, isCurrent: null as (() => boolean) | null })
  const [revealRequest, setRevealRequest] = useState<(ConversationRevealRequest & { displayId: string | null }) | null>(null)
  useEffect(() => () => { navigation.current.cancel?.() }, [activitySourceKey])
  if (activityLifetime.current.sourceKey !== activitySourceKey) {
    activityLifetime.current = { sourceKey: activitySourceKey, opened: false }
    activityContent.current = null
  }
  if (viewMode !== 'terminal') activityLifetime.current.opened = true
  const [historyOpen, setHistoryOpen] = useState(false)
  useEffect(() => {
    if (navigation.current.isCurrent && !navigation.current.isCurrent()) navigation.current.cancel?.()
  })
  const surfaceRef = useRef<HTMLElement>(null)
  const annotationNoteRef = useRef<ConversationAnnotationNoteHandle>(null)
  const selectAnnotation = useCallback((selection: ConversationAnnotationSelection) => {
    annotationNoteRef.current?.select(selection, sessionId)
  }, [sessionId])
  const resultAnchorId = useId()
  const resultSurfaceAnchor = `--result-surface-${resultAnchorId.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const historyReturnFocusRef = useRef<HTMLButtonElement | null>(null)
  const historyOpenRef = useRef(historyOpen)
  historyOpenRef.current = historyOpen
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const historyEverOpenedRef = useRef(false)
  if (historyOpen) historyEverOpenedRef.current = true
  const [historyDisclosures, setHistoryDisclosures] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    setHistoryOpen(false)
    historyReturnFocusRef.current = null
    historyEverOpenedRef.current = false
    setHistoryDisclosures(new Set())
  }, [sessionId])
  useEffect(() => {
    setHistoryOpen(false)
  }, [viewMode])
  const openHistory = (trigger?: HTMLButtonElement): void => {
    const header = !readOnly && headerPortalTargetId
      ? document.getElementById(headerPortalTargetId)
      : surfaceRef.current
    historyReturnFocusRef.current = trigger ?? header?.querySelector<HTMLButtonElement>('.agent-region-header__more') ?? null
    setHistoryOpen(true)
  }
  const closeHistory = (): void => {
    const reader = surfaceRef.current?.querySelector('.session-history')
    const target = historyReturnFocusRef.current
    setHistoryOpen(false)
    if (linkOrigin.tabId && linkOrigin.regionId) {
      useAppStore.getState().focusRegion(linkOrigin.workspaceId, linkOrigin.tabId, linkOrigin.regionId, 'pointer')
    }
    requestAnimationFrame(() => {
      if (!visibleRef.current || historyOpenRef.current || !surfaceRef.current?.isConnected || !target?.isConnected || target.disabled) return
      const active = document.activeElement
      if (active && active !== document.body && !reader?.contains(active)) return
      target.focus()
    })
  }
  const pendingAgentRestore = session?.kind === 'agent' && session.processState !== 'running'
  const terminalLifetime = useRef({ sourceKey: activitySourceKey, opened: false })
  if (terminalLifetime.current.sourceKey !== activitySourceKey) terminalLifetime.current = { sourceKey: activitySourceKey, opened: false }
  const startupDecision = session?.kind === 'agent' ? agentStartupRecoveryDecision({
    runState: session.processState,
    ...(session.semanticStatus ? { semanticStatus: session.semanticStatus } : {}),
    canonical: !(runtimeOwnershipWarnings ?? []).includes(session.hostId),
    now: Date.now()
  }) : undefined
  const inlineHistory = pendingAgentRestore && startupDecision?.kind === 'pending' &&
    startupDecision.reason === 'idle-over-day'
  // One fact/observation owner, with demand from every actually visible reading stage.
  const activityDemand = viewMode !== 'terminal' && !pendingAgentRestore &&
    (visible && !historyOpen || presentations.some(target => target.visible !== false))
  const {
    messages: userMessages,
    nativeHistoryPage,
    loading: userMessagesLoading,
    error: userMessagesError,
    observationError: userMessagesObservationError,
    windowFrozen: userMessagesWindowFrozen,
    windowIncomplete: userMessagesWindowIncomplete,
    sourceChanged: userMessagesSourceChanged,
    hasMore: hasEarlierUserRecords,
    refresh: refreshUserMessages,
    readForReveal
  } = useSessionUserMessages(
    session?.kind === 'agent' ? session.control : undefined,
    { enabled: activityDemand }
  )
  const nativeRevealSource = useRef({ page: nativeHistoryPage, changed: userMessagesSourceChanged })
  nativeRevealSource.current = { page: nativeHistoryPage, changed: userMessagesSourceChanged }
  const revealMailboxMessage = useCallback((message: AgentSessionUserMessage, presentation?: WorkbenchViewTarget): Promise<MailboxMessageNavigationResult> => {
    navigation.current.cancel?.()
    const generation = ++navigation.current.generation
    const control = session?.kind === 'agent' ? session.control : undefined
    const sourceKey = conversationMessageSourceKey(control?.agentSessionId, message.source)
    const unavailable = (detail: string): MailboxMessageNavigationResult => ({ kind: 'unavailable', message: `${detail} 原文仍可阅读和复制。` })
    if (!control || message.agentSessionId !== control.agentSessionId || !sourceKey) return Promise.resolve(unavailable('记录关系未确认，无法定位。'))
    if (pendingAgentRestore) return Promise.resolve(unavailable('当前对话位置尚不可用，Session 已保留。'))
    if (message.source.kind === 'native' && session?.providerId !== message.source.providerId) {
      return Promise.resolve(unavailable('原生来源已变化，当前阅读窗口保留；请刷新来源后再定位。'))
    }
    const displayId = presentation && linkOrigin.regionId ? workbenchSessionStageHostId(presentation, linkOrigin.regionId) : null
    if (presentation && !displayId) return Promise.resolve(unavailable('当前显示宿主关系未确认，无法定位。'))
    const initialMode = effectiveSessionViewMode(useAppStore.getState(), sessionId)
    let switched = false
    const current = () => {
      const live = sessionPresentationById(useAppStore.getState().sessions).get(sessionId)
      if (live?.kind !== 'agent' || JSON.stringify([live.control.hostId, live.id, live.control.run.runId]) !== activitySourceKey) return false
      if (message.source.kind === 'native' && live.providerId !== message.source.providerId) {
        finish(unavailable('原生来源已变化，当前阅读窗口保留；请刷新来源后再定位。'))
        return false
      }
      const displayVisible = displayId ? currentPresentations.current.some(target => linkOrigin.regionId &&
        workbenchSessionStageHostId(target, linkOrigin.regionId) === displayId && target.visible !== false) : visibleRef.current
      if (generation !== navigation.current.generation || currentSourceKey.current !== activitySourceKey ||
        !displayVisible || historyOpenRef.current || effectiveSessionViewMode(useAppStore.getState(), sessionId) !== (switched ? 'activity' : initialMode)) return false
      if (live.processState !== 'running') {
        finish(unavailable('当前对话位置尚不可用，Session 已保留。'))
        return false
      }
      if (!useAppStore.getState().config?.appearance.terminalTheme) {
        finish(unavailable('当前对话界面尚未就绪，无法确认位置。'))
        return false
      }
      const page = nativeRevealSource.current.page
      if (switched && message.source.kind === 'native' && (nativeRevealSource.current.changed || page &&
        (page.source.providerId !== message.source.providerId || page.source.nativeSessionId !== message.source.nativeSessionId))) {
        finish(unavailable('原生来源已变化，当前阅读窗口保留；请刷新来源后再定位。'))
        return false
      }
      return true
    }
    let resolveResult: (result: MailboxMessageNavigationResult) => void = () => {}
    const result = new Promise<MailboxMessageNavigationResult>(resolve => { resolveResult = resolve })
    let finished = false
    const finish = (outcome: MailboxMessageNavigationResult) => {
      if (finished) return
      finished = true
      for (const event of ['pointerdown', 'keydown', 'wheel', 'touchmove', 'focusin']) document.removeEventListener(event, changedIntent, true)
      if (navigation.current.cancel === cancel) { navigation.current.cancel = null; navigation.current.isCurrent = null }
      setRevealRequest(previous => previous?.generation === generation ? null : previous)
      resolveResult(outcome)
    }
    const changedIntent = (event: Event) => {
      // The one focus handoff belongs to this reveal; any other later user intent cancels it.
      const destination = displayId ? document.getElementById(displayId) : surfaceRef.current
      if (event.type === 'focusin' && event.target instanceof HTMLElement && event.target.dataset.messageSourceKey === sourceKey &&
        destination?.contains(event.target) && event.target.closest('.activity-feed')) return
      ++navigation.current.generation
      finish({ kind: 'cancelled' })
    }
    const cancel = () => { ++navigation.current.generation; finish({ kind: 'cancelled' }) }
    navigation.current.cancel = cancel
    navigation.current.isCurrent = current
    for (const event of ['pointerdown', 'keydown', 'wheel', 'touchmove', 'focusin']) document.addEventListener(event, changedIntent, true)
    void (async () => {
    let present = false
    if (message.source.kind === 'captured') {
      present = projectSessionUserMessages({ agentSessionId: control.agentSessionId, timeline: useAppStore.getState().timelines[sessionId] })
        .some(record => record.id === message.id && conversationMessageSourceKey(record.agentSessionId, record.source) === sourceKey)
    } else {
      const read = await readForReveal(message.source)
      if (!current()) { finish({ kind: 'cancelled' }); return result }
      if (read.sourceChanged || read.page && (read.page.source.providerId !== message.source.providerId ||
        read.page.source.nativeSessionId !== message.source.nativeSessionId)) {
        finish(unavailable('原生来源已变化，当前阅读窗口保留；请刷新来源后再定位。')); return result
      }
      if (read.error) { finish(unavailable(`读取对话失败：${read.error.message}`)); return result }
      if (read.windowFrozen) { finish(unavailable('当前阅读窗口已达边界，无法确认位置。')); return result }
      present = projectSessionUserMessages({ agentSessionId: control.agentSessionId, historyPage: read.page ?? undefined })
        .some(record => record.id === message.id && conversationMessageSourceKey(record.agentSessionId, record.source) === sourceKey)
    }
    if (!current()) { finish({ kind: 'cancelled' }); return result }
    if (!present) { finish(unavailable('当前有界对话窗口中没有这条记录，无法确认位置。')); return result }
    switched = true
    setHistoryOpen(false)
    setRevealRequest({ generation, sourceKey, displayId, isCurrent: current, complete: located => {
      if (!current()) { finish({ kind: 'cancelled' }); return }
      finish(located ? { kind: 'located' } : unavailable('准确记录尚未呈现在对话中，无法确认位置。'))
    } })
    useAppStore.getState().setViewMode(sessionId, 'activity', { focus: false })
    })().catch(error => {
      finish(current() ? unavailable(`读取对话失败：${error instanceof Error ? error.message : String(error)}`) : { kind: 'cancelled' })
    })
    return result
  }, [activitySourceKey, sessionId, session, pendingAgentRestore, readForReveal, linkOrigin.regionId])
  const agentInputIdentity = session?.kind === 'agent'
    ? agentDisplayName({
        userName,
        firstPrompt: firstPromptFromTimeline(timelineSnapshot),
        fallbackLabel: session.label,
        providerLabel: agentProviderLabel(session.providerId)
      })
    : undefined
  const agentInputExecutor = session?.kind === 'agent'
    ? (connectingExecutor?.label ?? session.executorId)
    : undefined
  // Observe only identity facts for the Agents actually represented in this reading surface.
  // Output/status from unrelated Sessions cannot refresh these descriptors or read sender goals.
  const speakerIds = useMemo(() => [...new Set([sessionId, ...userMessages.flatMap(message =>
    message.author.kind === 'agent' ? [message.author.agentSessionId] : [])])], [sessionId, userMessages])
  const speakerFacts = useAppStore(useShallow(state => activityDemand ? speakerIds.flatMap(id => {
    const sender = sessionPresentationById(state.sessions).get(id)
    if (!sender || sender.kind !== 'agent') return [id]
    const workspaces = state.config?.workspaces ?? []
    const workspace = workspaces.find(item => item.hostId === sender.hostId && item.path === sender.workspacePath)
    const projectRoot = workspace ? workspaces.find(item => item.hostId === workspace.hostId &&
      item.path === (workspace.repoPath ?? workspace.path) && item.kind === 'folder') : undefined
    return [id, state.agentNames[id], sender.label, sender.providerId, sender.hostId, sender.workspacePath,
      firstPromptFromTimeline(state.timelines[id]), workspace?.id, workspace?.repoPath, workspace?.branch,
      workspace?.name, projectRoot?.id, projectRoot?.name]
  }) : []))
  const describeSpeaker = useMemo(() => {
    const original = createSpeakerResolver({
      lookupAgent: (id) => {
        const state = useAppStore.getState()
        const sender = currentConversationSpeakerMetadata(id, {
          sessions: state.sessions, workspaces: state.config?.workspaces ?? [],
          agentNames: state.agentNames, timelines: state.timelines
        })
        return sender ? {
          label: sender.label,
          providerId: sender.providerId,
          ...(sender.project ? { project: sender.project } : {}),
          readDetails: () => {
            const current = useAppStore.getState()
            return currentConversationSenderDetails(id, {
              sessions: current.sessions, workspaces: current.config?.workspaces ?? [],
              agentNames: current.agentNames, timelines: current.timelines, demands: current.demands
            })
          }
        } : undefined
      },
      ...(session?.kind === 'agent' ? { currentSession: session } : {})
    })
    return (speaker: Parameters<typeof original>[0], avatarSize?: number) => {
      const described = original(speaker)
      const mote = speaker.role === 'agent' ? moteConversationIdentity(moteOwner,
        sessionPresentationById(useAppStore.getState().sessions).get(speaker.id)) : undefined
      return mote ? { ...described, name: mote.name, avatar: <ConversationMessageAvatar speaker={speaker} name={mote.name} mote={mote} providerId={described.providerId} project={described.project} {...(avatarSize === undefined ? {} : { size: avatarSize })} /> } : described
    }
  }, [session?.id, session?.label, session?.kind, session?.kind === 'agent' ? session.providerId : undefined, speakerFacts, moteOwner]
  )
  const refreshSession = useAppStore((state) => state.refreshSession)
  const recoverSession = useAppStore((state) => state.recoverSession)
  const respondInteraction = useAppStore((state) => state.respondInteraction)
  const annotateMessage = (annotation: ConversationAnnotation): void => {
    // 「把一段引文送进当前草稿」这个决定归 store 的 `appendAgentComposerDraft` 所有——
    // 浏览器标注那条 dock 动作走的就是它。这里此前手写了一份读-改-写（`getState()` +
    // `setAgentComposerDraft`），两份实现在尾部空白上**不一致**（实测：草稿是 `'Existing\n'` 时
    // 手写那份给出 `Existing\n\nREF`、store 给出 `Existing\n\n\nREF`）。同一个产品动作在两个
    // 表面上给两种结果，而只有其中一份有判据。
    appendAgentComposerDraft(sessionId, `Regarding message ${JSON.stringify(annotation.messageId)}:\n> ${annotation.quote.replace(/\n/gu, '\n> ')}\n\n批注： ${annotation.note}`)
  }
  // Same two reads TerminalView makes for its path links, for the same reason: an Agent that writes
  // `src/foo.ts` means the same file in the Activity projection as in the Terminal one. The root comes
  // from the WorkspaceRecord (NOT session.workspacePath) so worktree/scratch sessions still relativize
  // absolute paths against the base main actually resolves against.
  //
  // Keyed on THIS pane's own session, not on activeWorkspaceId. The two diverge after "Move to
  // Workspace": that reducer relocates the display identity and deliberately never touches
  // session.workspacePath (see move-session-view.ts), so a moved pane's session still lives under its
  // original root while the active workspace is the target. Reading the active root there is not merely
  // "unshortened" — when the wrong root is an ANCESTOR of the session path, the boundary guard in
  // shortenPath matches and strips it, producing a relative path rooted at the wrong repo. Measured:
  // session homeFixture/proj/repo/src/auth.ts under a wrong root of homeFixture/proj renders `repo/src/auth.ts`,
  // which reads as a real answer. A wrong path that looks right is worse than a long one.
  //
  // workspaceRootForPath asks containment, not ownership — a subdirectory terminal (fixtureRoot/repo/sub) is
  // owned by no workspace exactly, and answering '' there would make its absolute path links
  // unclickable. See the same note in TerminalView.
  const openFile = useAppStore((state) => state.openFile)
  const reportError = useAppStore((state) => state.reportError)
  const activeWorkspaceRoot = useAppStore((state) =>
    (session ? workspaceRootForPath(state.config ?? null, session) : undefined) ?? ''
  )
  const selectFileContext = useMemo(() => createSessionProjectFileContextSelector(sessionId, linkOrigin),
    [sessionId, linkOrigin.workspaceId, linkOrigin.tabGroupId, linkOrigin.tabId, linkOrigin.regionId, linkOrigin.sessionId])
  const fileContext = useAppStore(selectFileContext)
  const [fileLinkIssue, setFileLinkIssue] = useState<string | null>(null)
  useEffect(() => { setFileLinkIssue(null) }, [fileContext])
  const openProjectFile = useCallback((path: string, location?: { line: number; column?: number }) => {
    // Freeze the rendered scope and exact display occurrence. Never resolve again from focus.
    if (selectFileContext(useAppStore.getState()) !== fileContext || fileContext.kind === 'unconfirmed') {
      setFileLinkIssue('The rendered file context changed before this click could be confirmed.')
      return
    }
    void openFile(path, linkOrigin.tabGroupId, location,
      fileContext.project?.workspaceId ?? linkOrigin.workspaceId, undefined, fileContext.placement).then((opened) => {
      if (!opened) setFileLinkIssue('The file resource or original display occurrence could not be confirmed.')
    }).catch((error: unknown) => {
      setFileLinkIssue(error instanceof Error ? error.message : String(error))
    })
  }, [fileContext, selectFileContext, openFile, linkOrigin.tabGroupId, linkOrigin.workspaceId])
  const fileReferenceNotice = fileContext.kind !== 'session' || fileLinkIssue ? <>
    {fileContext.kind === 'goal' ? <div className="activity-feed__read-notice" data-file-reference-scope="current-goal">
      <span>File links use current Goal project: {fileContext.project!.name}.{!fileContext.homeDir ? ' Home paths are unconfirmed for this Host; ~/ references stay as written.' : ''} Earlier messages may have another origin.</span>
    </div> : null}
    {fileContext.issue || fileLinkIssue ? <ServiceWindowNotice notice={{
      kind: 'indeterminate', notice: {
        step: fileContext.issue ?? fileLinkIssue!,
        mode: fileContext.kind === 'session' ? 'The original Session keeps running. Its file resource or display occurrence is unconfirmed.'
          : fileContext.kind === 'goal' ? 'Project-relative files remain available; unconfirmed references stay as written. The PMO keeps running.'
          : 'Project file context is unconfirmed; references stay as written. The PMO keeps running.',
        restore: fileContext.kind === 'session' ? 'Check this Session’s original Workspace and Host, then retry the original reference.'
          : 'Check this Goal’s project association and registered Workspace/Host, then retry the original reference.'
      }
    }} /> : null}
  </> : null
  // Lands the file in this pane's own Tab Group, exactly as a terminal path click does. A miss
  // surfaces through reportError — "click opened nothing" is never silent.
  const openWorkspaceFile = useCallback(
    (path: string, location?: { line: number; column?: number }) => {
      void openFile(path, linkOrigin.tabGroupId, location, linkOrigin.workspaceId).catch(reportError)
    },
    [openFile, reportError, linkOrigin.tabGroupId, linkOrigin.workspaceId]
  )
  // A pasted image cited in the conversation is read back through main (the only place that can reach a
  // file outside the workspace) as an <img>-ready data URI. Main confines the read to the pasted
  // directory; a null return means "not a readable pasted image", and the renderer falls back to the
  // plain-text reference. Stable identity so the thumbnail's load effect does not re-fire each render.
  const readPastedImage = useCallback((path: string) => api.ui.readPastedImage(path), [])
  // An http(s) link in agent prose gets the SAME destination menu the Terminal gives, opening into this
  // pane's own Region — never a jump straight to the system browser. This is the host that owns the menu
  // because it is the host that holds the Region origin, mirroring TerminalView exactly.
  const openHttpLink = useAppStore((state) => state.openHttpLink)
  const [linkRequest, setLinkRequest] = useState<OpenDestinationRequest | null>(null)
  const nextLinkRequestIdRef = useRef(0)
  // canSplit reports the TRUTH of this origin: a directional destination needs a precise Tab+Region, and
  // choosing one without them throws in the Store. Only when both are present are the split items live.
  const canSplit = Boolean(linkOrigin.tabId && linkOrigin.regionId)
  const onProseLinkClick = useCallback(
    (url: string, event: LinkClickModifiers) => {
      const isMac = isMacPlatform()
      // Cmd (macOS) / Ctrl (elsewhere) + click opens the system browser immediately, skipping the menu —
      // the SAME judgement the Terminal uses, so the two surfaces cannot drift on the modifier.
      if (terminalLinkModifierOpensSystemBrowser(event, isMac)) {
        void openHttpLink(linkOrigin, url, 'system').catch(reportError)
        return
      }
      setLinkRequest({
        id: ++nextLinkRequestIdRef.current,
        url,
        x: event.clientX,
        y: event.clientY
      })
    },
    [openHttpLink, linkOrigin, reportError]
  )
  const onProseLinkSelect = useCallback(
    (destination: OpenDestination) => {
      const request = linkRequest
      if (!request) return
      setLinkRequest((current) => dismissOpenDestinationRequest(current, request.id))
      void openHttpLink(linkOrigin, request.url, destination).catch(reportError)
    },
    [linkRequest, openHttpLink, linkOrigin, reportError]
  )
  const [refreshing, setRefreshing] = useState(false)
  const [observationMounted, setObservationMounted] = useState(false)
  const observationRefreshRef = useRef<(() => Promise<void>) | null>(null)
  const bindObservationRefresh = useCallback((refresh: (() => Promise<void>) | null) => {
    observationRefreshRef.current = refresh
    setObservationMounted(refresh !== null)
  }, [])
  const [recovering, setRecovering] = useState(false)
  const reopenRetiredSession = useAppStore(state => state.reopenRetiredSession)
  const retainedReopenRef = useRef<object | null>(null)
  const retainedUnconfirmedIntent = useRef<string | null>(null)
  const clearedRetainedIntent = useRef<string | null>(null)
  const [retainedReopenError, setRetainedReopenError] = useState<string | null>(null)
  const [retainedReopenUnconfirmed, setRetainedReopenUnconfirmed] = useState(false)
  const pendingReopen = retainedHistory?.pendingReopen &&
    retainedHistory.pendingReopen.operationId !== clearedRetainedIntent.current ? retainedHistory.pendingReopen : undefined
  const continuationUnconfirmed = retainedReopenUnconfirmed || Boolean(pendingReopen)
  useEffect(() => {
    if (retainedReopenRef.current) setRecovering(false)
    retainedReopenRef.current = null
    retainedUnconfirmedIntent.current = null
    clearedRetainedIntent.current = null
    setRetainedReopenError(null)
    setRetainedReopenUnconfirmed(false)
  }, [sessionId, historyHostId, retainedHistory?.retiredAt])
  // daemon_restart auto-recovery fires at most once per dead session id, so a flapping
  // daemon can't spin us into a relaunch loop. Keyed by the session id we last recovered from.
  const autoRecoveredRef = useRef<string | null>(null)

  const disconnected = session?.processState === 'running' && session.status.state === 'disconnected'
  const missing = session?.processState === 'interrupted'
  const exited = session?.processState === 'exited'
  const interruptionReason = session?.interruptionReason
  const continuity = session?.status.continuity
  // Which of Core's reasons this is decides the title, the body and whether retry can work.
  // The conflict class comes along too: its two values ask for opposite actions.
  const continuityNotice = classifyContinuityFailure(
    continuity,
    session?.status.continuityReason,
    session?.status.continuityConflict
  )
  const recoveryActionSource: RecoverySource | null = executionHostId && sourceWorkspaceId && linkOrigin.tabId && linkOrigin.regionId ? {
    hostId: executionHostId, agentSessionId: sessionId, workspaceId: sourceWorkspaceId,
    tabId: linkOrigin.tabId, regionId: linkOrigin.regionId, displayWorkspaceId: linkOrigin.workspaceId,
    ...(linkOrigin.tabGroupId ? { groupId: linkOrigin.tabGroupId } : {}),
    diagnostic: continuityNotice?.reason ?? session?.status.detail ?? 'Original Session state is not confirmed.'
  } : null

  async function recover(): Promise<void> {
    if (recovering) return
    setRecovering(true)
    try { await recoverSession(sessionId) }
    finally { setRecovering(false) }
  }

  async function reopenRetained(): Promise<void> {
    const source = retainedHistory
    if (!projectionPolicy.allowsRecovery || !source || retainedReopenRef.current) return
    const attempt = {}
    const retainedOperationId = retainedUnconfirmedIntent.current ?? pendingReopen?.operationId
    if ((pendingReopen && !retainedOperationId) || historyCatalogue.error) {
      setRetainedReopenError(historyCatalogue.error ?? 'Core retains an original continue operation, but its correlation is unavailable. Its result remains unknown.')
      setRetainedReopenUnconfirmed(true)
      historyCatalogue.refresh()
      return
    }
    const observeOnly = retainedOperationId !== undefined
    const operationId = retainedOperationId ?? crypto.randomUUID()
    retainedUnconfirmedIntent.current = operationId
    retainedReopenRef.current = attempt
    setRecovering(true)
    try {
      const reopened = await reopenRetiredSession(source, operationId, observeOnly)
      if (retainedReopenRef.current !== attempt) return
      if (reopened) {
        setHistoryOpen(false)
        setRetainedReopenError(null)
        retainedUnconfirmedIntent.current = null
        setRetainedReopenUnconfirmed(false)
      }
    } catch (error) {
      if (retainedReopenRef.current === attempt) {
        // Electron transport failure cannot prove a native launch was not applied. Only the
        // Core's structured disposition authorizes a later, new explicit launch intent.
        const notApplied = error instanceof Error &&
          'controlFailure' in error &&
          (error.controlFailure as { disposition?: unknown } | undefined)?.disposition === 'not_applied'
        if (notApplied) {
          retainedUnconfirmedIntent.current = null
          clearedRetainedIntent.current = operationId
          historyCatalogue.refresh()
        }
        setRetainedReopenUnconfirmed(!notApplied)
        setRetainedReopenError(presentError(error))
      }
    } finally {
      if (retainedReopenRef.current === attempt) {
        retainedReopenRef.current = null
        setRecovering(false)
      }
    }
  }

  // Terminals whose backend restarted (daemon_restart) can never come back by refreshing —
  // the PTY is gone. Auto-relaunch a fresh terminal in the same cwd and rebind the tab,
  // replacing the useless "Check again" with a seamless recovery. One-shot per session id.
  useEffect(() => {
    if (!session || session.kind !== 'terminal') return
    if (!missing || interruptionReason !== 'daemon_restart') return
    if (autoRecoveredRef.current === session.id) return
    autoRecoveredRef.current = session.id
    void recover()
    // recover()/recovering are stable enough; we intentionally key only on the dead-session signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, session?.kind, missing, interruptionReason])

  const mailboxReading = {
    workspaceRoot: fileContext.workspaceRoot, homeDir: fileContext.homeDir,
    ...(fileContext.kind !== 'unconfirmed' && fileContext.kind !== 'unassigned' ? { openWorkspaceFile: openProjectFile } : {}),
    readPastedImage, openHttpLink: onProseLinkClick, describeSpeaker
  }

  const acceptedLaunch = pendingLaunch?.created && (!session || session.control.run.runId === pendingLaunch.created.run.runId)
    ? pendingLaunch.created : undefined
  const preSnapshotHost = session ? regionExecutionHost(session, configuredExecutionHost)
    : pendingLaunch ? executionHostProjection(pendingLaunch.request?.hostId, pendingLaunch.request?.workspacePath, configuredExecutionHost)
      : retainedHistory?.state === 'retired' ? executionHostProjection(retainedHistory.hostId, retainedHistory.history?.workspacePath, configuredExecutionHost)
        : executionHostProjection(recoveryCandidate?.hostId, recoveryCandidate?.workspacePath, configuredExecutionHost)
  const preSnapshotHeader = (name = agentInputIdentity ?? (session?.kind === 'terminal' ? session.label : surfaceKind === 'terminal' ? 'Terminal' : agentDisplayName({ userName,
    firstPrompt: pendingLaunch?.request?.prompt, fallbackLabel: recoveryCandidate?.label ?? sessionId,
    providerLabel: connectingExecutor?.label ?? sessionId })), executorLabel = agentInputExecutor ?? connectingExecutor?.label ?? 'Executor unknown') =>
    <AgentRegionHeader name={name} executorLabel={surfaceKind === 'terminal' ? 'Shell' : executorLabel}
      sessionId={sessionId} sessionKind={surfaceKind} executionHost={preSnapshotHost}
      regionId={linkOrigin.regionId} readOnly={readOnly} portalTargetId={headerPortalTargetId} onHistory={undefined} />
  const launchFailures = pendingLaunch?.projectionFailures ?? []
  const launchNotice = (
    <div className={acceptedLaunch && launchFailures.length > 0 ? 'agent-launch-notice' : 'service-disclosure-home'}>
      <ServiceWindowNotice disclosure={{ scope: JSON.stringify(['local:projection', acceptedLaunch?.hostId ?? session?.hostId,
        sessionId, acceptedLaunch?.run.runId ?? session?.control.run.runId]),
        id: 'projection', cause: JSON.stringify(launchFailures.map(failure => [failure.step, errorIdentity(failure.message)])),
        available: Boolean(pendingLaunch || session) && !pendingAgentRestore, visible }} notice={acceptedLaunch && launchFailures.length > 0 ? {
        kind: session?.processState === 'running' ? 'process-degraded' : 'indeterminate',
        notice: {
          step: `Agent created; ${launchFailures.map(failure => `${failure.step}: ${failure.message}`).join('; ')}`,
          mode: session?.processState === 'running'
            ? 'The confirmed running Session and its input remain available.'
            : 'Creation is confirmed. Process observation and input availability are not yet confirmed.',
          restore: 'Check again to re-read this same Session and Timeline. No new Agent will be created.'
        }
      } : null} summary={{
        step: 'Agent created; projection unconfirmed',
        mode: session?.processState === 'running' ? 'Confirmed Session running; input remains available.'
          : 'Creation confirmed; process and input unconfirmed.',
        restore: 'Check again for this same Session and Timeline.'
      }} actions={!readOnly ? <button type="button" className="small-button" disabled={refreshing}
        onClick={() => { void refresh() }}><RefreshCw size={12} /> Check again</button> : null} />
    </div>
  )
  if (!session && acceptedLaunch) {
    return <section className="agent-surface" data-agent-surface-mode="unconfirmed">
      {preSnapshotHeader()}
      <div className="agent-body">{launchNotice}<p>Agent created · {acceptedLaunch.agentSessionId}</p></div>
      {!readOnly ? <AgentSessionComposer reading={mailboxReading} key={sessionId} sessionId={sessionId} visible={visible} disabled {...(tabName ? { tabName } : {})} /> : null}
    </section>
  }

  // Retirement is Core's terminal fact, not a missing Runtime observation. Its native history
  // needs only a reading reference; never fabricate a Run or an active Agent to make it readable.
  if (!session && retainedHistory?.state === 'retired' && terminalThemeId) {
    const reference = { hostId: retainedHistory.hostId, agentSessionId: retainedHistory.agentSessionId }
    const metadata = retainedHistory.history
    const label = userName ?? tabName ?? metadata?.executorId ?? sessionId
    const providerLabel = metadata ? agentProviderLabel(metadata.providerId) : null
    const executorLabel = metadata ? connectingExecutor?.label ?? metadata.executorId : null
    const identityLabel = providerLabel && executorLabel && providerLabel.toLowerCase() !== executorLabel.toLowerCase()
      ? `${providerLabel} · ${executorLabel}` : providerLabel
    const resumeAction = projectionPolicy.allowsRecovery && recoveryActionSource ? <SessionRecoveryActions source={recoveryActionSource}
      restoring={recovering} workingLabel={continuationUnconfirmed ? 'Checking…' : 'Restoring…'} restoreLabel={continuationUnconfirmed ? 'Check original restore' : 'Restore original'} onRestore={() => void reopenRetained()} /> : null
    const reopenCause = retainedReopenError ?? (pendingReopen
      ? pendingReopen.operationId ? 'Core retains the original continue operation. Its result is not yet confirmed.'
        : 'Core retains the original continue operation, but its correlation is unavailable. Its result remains unknown.' : null)
    const reopenNotice = reopenCause ? <ServiceWindowNotice disclosure={{
      scope: JSON.stringify(['retained-reopen', reference.hostId, reference.agentSessionId, retainedHistory.retiredAt]),
      id: 'reopen', cause: reopenCause, visible
    }} title={continuationUnconfirmed ? 'Continuation unconfirmed' : 'Conversation could not be continued'} notice={{ kind: 'indeterminate', notice: {
      step: `Continuing this conversation was not confirmed: ${reopenCause}`,
      mode: 'The original conversation and Region are kept. Its saved history remains readable.',
      restore: continuationUnconfirmed
        ? pendingReopen && !pendingReopen.operationId && !retainedUnconfirmedIntent.current
          ? 'Check again refreshes the Core correlation. Keep reading the original history while its result is unknown.'
          : 'Check again reads the original Core Session and Run. The unconfirmed operation is not resent.'
        : 'Check the Host and current Executor configuration, then explicitly try again. No new message is sent.'
    } }} /> : null
    return <section ref={surfaceRef} className="agent-surface" data-agent-surface-mode="retained-history">
      {preSnapshotHeader(label, executorLabel ?? providerLabel ?? 'Executor unknown')}
      <div className="agent-body"><div className="agent-terminal-stage">
        {historyOpen ? <SessionHistoryView
          key={JSON.stringify([reference.hostId, reference.agentSessionId])}
          control={reference} label={label} onClose={closeHistory} visible={visible && !parked}
          returnLabel="Session" themeId={terminalThemeId} fontSize={terminalFontSize}
          primaryAction={resumeAction} serviceNotice={reopenNotice}
          workspaceRoot={metadata?.workspacePath ?? ''} openWorkspaceFile={openWorkspaceFile}
          openHttpLink={onProseLinkClick} describeSpeaker={describeSpeaker}
        /> : <FullPageLoadingSurface scope="region" phase="parked" eyebrow="Retained conversation"
          title="Session closed"
          detail={metadata ? `${identityLabel}. Read the original conversation or continue it with the current Executor configuration.`
            : 'Core confirmed this Session was closed. Its saved identity is retained.'}
          actions={<>{resumeAction}<button type="button" className="small-button" onClick={event => openHistory(event.currentTarget)}>
            Read conversation history
          </button></>}
          details={{ summary: label, content: <dl>
            <dt>Session ID</dt><dd>{reference.agentSessionId}</dd>
            {metadata ? <><dt>Provider</dt><dd>{agentProviderLabel(metadata.providerId)}</dd>
              <dt>Executor</dt><dd>{connectingExecutor?.label ?? metadata.executorId}</dd>
              <dt>Native Session</dt><dd>{metadata.nativeHandle?.sessionId ?? 'Not recorded'}</dd></> : null}
          </dl> }} />}
        {!historyOpen ? reopenNotice : null}
      </div></div>
    </section>
  }

  // A launching Region exists before Core returns its Session snapshot. Keep that handoff
  // neutral; interrupted and exited Sessions use the explicit recovery banners below.
  if (!session || !terminalThemeId) {
    return (
      <section className="agent-surface" data-agent-surface-mode="connecting">
          {preSnapshotHeader()}
          <SessionConnectingSurface key={`connecting:${sessionId}`}
          phase={pendingLaunch ? 'launch' : recoveryCandidate ? 'restore' : 'connect'}
          surfaceKind={surfaceKind}
          request={pendingLaunch?.request}
          executor={connectingExecutor}
          appearance={connectingAppearance}
          session={{ hostId: session?.kind === 'agent' ? session.control.hostId : recoveryCandidate?.hostId ?? retainedHistory?.hostId ?? '', agentSessionId: sessionId }}
          visible={visible && !parked}
        />
        {surfaceKind === 'agent' && !pendingLaunch && historyCatalogue.error ? <ServiceWindowNotice notice={{
          kind: 'indeterminate', notice: { step: `Retained history metadata could not be read: ${historyCatalogue.error}`,
            mode: 'The original Region and Session reference remain visible. Its current state is unconfirmed.',
            restore: 'Check again to read the same Session identity; no Agent will be started.' }
        }} actions={<button type="button" className="small-button" disabled={historyCatalogue.loading}
          onClick={historyCatalogue.refresh}><RefreshCw size={12} /> Check again</button>} /> : null}
        {!readOnly && surfaceKind === 'agent' ? <AgentSessionComposer reading={mailboxReading} key={sessionId} sessionId={sessionId} visible={visible} disabled {...(tabName ? { tabName } : {})} /> : null}
      </section>
    )
  }

  const noun = session.kind === 'agent' ? 'Agent' : 'Terminal'
  // 失联分两类，标题也必须分两类：还在重连 vs 已经放弃。判据取自 detail（连接投影写下的那一对
  // SSOT 常量），而不是另起一个状态位——状态位就是 `disconnected`，两类共用它。只认一个标题的话，
  // 抖动预算用尽后的终局会顶着「Reconnecting…」的皮，用户永远不知道该自己动手了。
  const gaveUpReconnecting =
    disconnected && session.status.detail === CONNECTION_UNRECOVERABLE_DETAIL
  // A continuity failure names its own class; the generic banner copy only covers the rest.
  const recoveryTitle = continuityNotice
      ? continuityNotice.title
      : gaveUpReconnecting
        ? `Can’t reach this host`
        : disconnected
          ? 'Remote terminal disconnected'
          : exited
            ? `${noun} process exited`
            : `${noun} session unavailable`

  async function refresh(observationOnly = false): Promise<void> {
    if (refreshing) return
    setRefreshing(true)
    try {
      if (observationRefreshRef.current) await observationRefreshRef.current()
      else if (observationOnly) reportError(new Error('No terminal observation is mounted in this Region. Open Terminal to refresh its output connection.'))
      else await refreshSession(sessionId)
    } catch { /* The owning Store/Terminal already retains and presents the actual cause. */ }
    finally { setRefreshing(false) }
  }

  // The history notice and the underlying Session share one Core-reasoned action.
  const agentRecoveryAction = !projectionPolicy.allowsRecovery ? (
    <span>Open this Session in its Project to restore it.</span>
  ) : recoveryActionSource ? <SessionRecoveryActions source={recoveryActionSource} restoring={recovering || refreshing}
    workingLabel={refreshing ? 'Re-reading…' : 'Restoring…'}
    restoreDisabled={continuityNotice ? !(continuityRetryEnabled(continuityNotice) || continuityRefreshEnabled(continuityNotice)) : false}
    restoreLabel={continuityNotice && continuityRefreshEnabled(continuityNotice) ? 'Re-read original' : continuityNotice?.remedy.kind === 'wait' ? 'Waiting for operation' : 'Restore original'}
    onRestore={() => { if (continuityNotice && continuityRefreshEnabled(continuityNotice)) void refresh(); else void recover() }} /> : (
    <button type="button" className="small-button" disabled={recovering} onClick={() => void recover()}>
      <RotateCcw size={12} /> {recovering ? 'Resuming…' : 'Resume'}
    </button>
  )
  const pendingRestoreDetail = pendingAgentRestore && startupDecision ? continuityNotice?.reason ?? (recoveryCandidate
    ? session.status.detail
    : agentStartupRecoveryDetail(startupDecision)) : undefined
  const hasAgentComposer = projectionPolicy.allowsRecovery && surfaceKind === 'agent' && session.kind === 'agent'
  const activityProps: ComponentProps<typeof ActivityView> = {
    sessionId: session.id, items: timeline, userMessages, nativeHistoryPage,
    userMessageRead: { loading: userMessagesLoading, error: userMessagesError,
      observationError: userMessagesObservationError, windowFrozen: userMessagesWindowFrozen,
      windowIncomplete: userMessagesWindowIncomplete,
      hasMore: hasEarlierUserRecords, onRetry: () => { void refreshUserMessages() }, onReadEarlier: openHistory },
    capability: session.kind === 'agent' ? session.capabilities.timeline : 'unavailable',
    displayState: session.status.state, workspaceRoot: fileContext.workspaceRoot, homeDir: fileContext.homeDir,
    fileReferenceNotice,
    ...(fileContext.kind !== 'unconfirmed' && fileContext.kind !== 'unassigned' ? { openWorkspaceFile: openProjectFile } : {}),
    readPastedImage, openHttpLink: onProseLinkClick,
    ...(hasAgentComposer ? { onSelectAnnotation: selectAnnotation } : {}), describeSpeaker,
    moteConversation: moteOwner !== null
  }
  // Covering/hiding a location freezes that location's already-presented elements.
  if (session.kind === 'agent' && visible && viewMode !== 'terminal' && !historyOpen && !pendingAgentRestore) {
    activityContent.current = <ActivityView {...activityProps} revealRequest={revealRequest?.displayId === null ? revealRequest : null} />
  }
  const resultReview = session.kind === 'agent'
    ? <SessionResultReview sessionId={session.id} items={timeline} origin={linkOrigin} visible={visible} surfaceAnchor={resultSurfaceAnchor} />
    : null

  return (
    <>
    {session.kind === 'agent' && renderPresentationFrame ? presentations.map(target => <SessionActivityPresentation
      key={JSON.stringify([activitySourceKey, target.hostId, target.reference!.displayWorkspaceId, target.reference!.groupId, target.reference!.tabId, linkOrigin.regionId])}
      target={target} regionId={linkOrigin.regionId!} sourceKey={activitySourceKey}
      sessionId={session.id} name={agentInputIdentity!} executorLabel={agentInputExecutor!}
      executionHost={regionExecutionHost(session, configuredExecutionHost)}
      activity={{ ...activityProps, revealRequest: revealRequest?.displayId === workbenchSessionStageHostId(target, linkOrigin.regionId!) ? revealRequest : null }} eligible={viewMode !== 'terminal' && !pendingAgentRestore}
      readOnly={readOnly} resourceOrigin={linkOrigin}
      {...(hasAgentComposer ? { onAnnotate: annotateMessage } : {})}
      renderFrame={renderPresentationFrame} selectRegion={() => onPresentationSelected?.(target)}
      {...(hasAgentComposer ? { composer: <AgentSessionComposer reading={mailboxReading} mailboxOrigin={{ ...linkOrigin, workspaceId: target.reference!.displayWorkspaceId, tabGroupId: target.reference!.groupId, tabId: target.reference!.tabId }} onRevealMessage={message => revealMailboxMessage(message, target)} sessionId={session.id}
        visible={target.visible !== false && viewMode !== 'terminal' && !pendingAgentRestore} {...(tabName ? { tabName } : {})} /> } : {})}
    />) : null}
    <section
      ref={surfaceRef}
      className="agent-surface"
      data-agent-surface-mode={session.kind === 'agent' ? viewMode : 'terminal'}
    >
      <AgentRegionHeader
        name={session.kind === 'agent' ? agentInputIdentity! : session.label}
        executorLabel={session.kind === 'agent' ? agentInputExecutor! : 'Shell'} sessionId={session.id}
        sessionKind={session.kind} executionHost={regionExecutionHost(session, configuredExecutionHost)}
        regionId={linkOrigin.regionId} readOnly={readOnly}
        portalTargetId={headerPortalTargetId}
        onHistory={session.kind === 'agent' && !historyOpen && !inlineHistory ? () => openHistory() : undefined}
        onRefreshObservation={session.kind === 'agent' && observationMounted ? () => void refresh(true) : undefined}
        refreshing={refreshing}
        resultReview={session.kind === 'agent' && !hasAgentComposer ? resultReview : null}
      />
      {launchNotice}
      {session.kind === 'agent' ? <AgentLifecycleFeedback owner={{ subject: session.control }} visible={visible}
        busy={recovering || refreshing} retry={() => void recover()}
        {...(observationMounted ? { refreshObservation: () => void refresh(true) } : {})} /> : null}
      <div className="agent-body" data-pending-interaction={session.kind === 'agent' && session.pendingInteraction ? '' : undefined} style={{ anchorName: resultSurfaceAnchor }} data-observation-surface={session.kind === 'agent' && viewMode !== 'terminal' ? 'workflow' : undefined}>
        <div className="agent-terminal-stage">
          {session.kind === 'terminal' || viewMode === 'terminal' || pendingAgentRestore || terminalLifetime.current.opened ? (
            <div hidden={session.kind === 'agent' && viewMode !== 'terminal' && !pendingAgentRestore}
              ref={element => { if (element && !pendingAgentRestore && !parked && (session.kind === 'terminal' || viewMode === 'terminal')) terminalLifetime.current.opened = true }}
              inert={historyOpen || session.kind === 'agent' && viewMode !== 'terminal' && !pendingAgentRestore} style={{ height: '100%' }}>
            {pendingAgentRestore ? (inlineHistory ? null :
              <FullPageLoadingSurface scope="region" phase={recovering ? 'recovering' : continuityNotice || session.status.state === 'error' ? 'failed' : 'parked'} eyebrow="Session retained"
                title={recovering ? 'Restoring your session' : continuityNotice ? continuityNotice.title : session.status.state === 'error' ? recoveryTitle : 'Ready to restore'}
                detail={continuityNotice?.reason ?? (session.status.state === 'error'
                  ? humanizeDetail(session.interruptionReason, session.status.detail, exited, session.status.exitReason)
                  : pendingRestoreDetail ?? 'The saved Session is retained. Its process state is not yet confirmed.')}
                actions={!historyOpen ? agentRecoveryAction : null}
                supplement={session.kind === 'agent' ? <SessionRecap session={session.control} visible={visible && !parked && !historyOpen} context /> : null}
                details={{ summary: 'Retained session', content: <dl>
                  <dt>Session</dt><dd>{session.label}</dd>
                  <dt>Session ID</dt><dd>{session.id}</dd>
                  <dt>Retained Run</dt><dd>{session.control.run.runId}</dd>
                </dl> }} />
            ) : parked ? (
              <FullPageLoadingSurface scope="region" phase="parked" eyebrow="View retained"
                title="Terminal parked"
                detail="Switch back to this tab to restore its terminal view." />
            ) : (
              <TerminalView
                session={session}
                autoFocus={autoFocus && visible && !historyOpen && viewMode === 'terminal'}
                themeId={terminalThemeId}
                fontSize={terminalFontSize}
                interactiveResize={projectionPolicy.interactiveResize && interactiveResize}
                visible={visible && !historyOpen && viewMode === 'terminal'}
                readOnly={!projectionPolicy.acceptsInput}
                linkOrigin={linkOrigin}
                onObservationRefresh={bindObservationRefresh}
              />
            )
            }</div>
          ) : null}
          {(historyOpen || inlineHistory || historyEverOpenedRef.current) && session.kind === 'agent' ? <SessionHistoryView
            key={JSON.stringify([session.control.hostId, session.id, session.control.run.runId])}
            control={session.control}
            readingKey={session.control.run.runId}
            label={agentInputIdentity ?? session.label}
            {...(!inlineHistory ? { onClose: closeHistory } : {})}
            visible={visible && (historyOpen || inlineHistory)}
            returnLabel={pendingAgentRestore ? 'Session' : viewMode === 'terminal' ? 'Terminal' : 'Activity'}
            primaryAction={pendingAgentRestore ? agentRecoveryAction : undefined}
            themeId={terminalThemeId}
            fontSize={terminalFontSize}
            workspaceRoot={activeWorkspaceRoot}
            openWorkspaceFile={openWorkspaceFile}
            openHttpLink={onProseLinkClick}
            describeSpeaker={describeSpeaker}
            expandedTraces={historyDisclosures}
            {...(hasAgentComposer ? { onSelectAnnotation: selectAnnotation } : {})}
            onToggleTrace={(traceId, open) => {
              setHistoryDisclosures((prev) => {
                const next = new Set(prev)
                if (open) next.add(traceId)
                else next.delete(traceId)
                return next
              })
            }}
            {...(pendingAgentRestore ? {
              serviceNotice: <span><strong>Ready to restore.</strong> {pendingRestoreDetail}</span>
            } : {})}
          /> : null}
          {(disconnected || missing || exited) && !pendingAgentRestore ? (
            <div className={sessionRecoveryClassName(sessionRecoveryState({ disconnected, exited, failed: session.status.state === 'error' }))} role="status" aria-live="polite">
              <span className="terminal-recovery__icon">
                {refreshing || recovering ? <LoaderCircle className="spin" size={16} /> : session.status.state === 'error' ? <AlertTriangle size={16} /> : disconnected || missing ? <ServerOff size={16} /> : <CircleStop size={16} />}
              </span>
              <div>
                <strong>{recoveryTitle}</strong>
                <span>{
                  continuityNotice
                    ? continuityNotice.reason
                    : humanizeDetail(session.interruptionReason, session.status.detail, exited || missing, session.status.exitReason)
                }</span>
              </div>
              <div className="terminal-recovery__actions">
                {!projectionPolicy.allowsRecovery ? (
                  <span className="terminal-recovery__readonly">Open this Session in its Project to recover it.</span>
                ) : session.kind === 'terminal' ? (
                  disconnected ? (
                    <button type="button" className="small-button" disabled={refreshing} onClick={() => void refresh()}>
                      <RefreshCw size={12} /> {refreshing ? 'Checking…' : 'Check again'}
                    </button>
                  ) : (
                    // The PTY is gone for good — relaunch a fresh terminal in the same cwd.
                    <button type="button" className="small-button" disabled={recovering} onClick={() => void recover()}>
                      <RotateCcw size={12} /> {recovering ? 'Restarting…' : 'Restart terminal'}
                    </button>
                  )
                ) : agentRecoveryAction}
              </div>
            </div>
          ) : null}
          {session.kind === 'agent' && activityLifetime.current.opened ? (
            <div hidden={viewMode === 'terminal' || pendingAgentRestore} inert={historyOpen || viewMode === 'terminal' || pendingAgentRestore} style={{ height: '100%' }}>
              {activityContent.current}
            </div>
          ) : null}
        </div>
        {session.kind === 'agent' && session.pendingInteraction ? (
          <AgentInteractionCard
            key={JSON.stringify([session.hostId, session.id, session.control.run.runId, session.pendingInteraction.id])}
            request={session.pendingInteraction}
            readOnly={!hasAgentComposer}
            responseUnavailableReason={session.interactionResponseUnavailableReason}
            {...(hasAgentComposer ? { onOpenTerminal: () => {
              useAppStore.getState().setViewMode(session.id, 'terminal')
              setHistoryOpen(false)
              if (linkOrigin.tabId && linkOrigin.regionId) {
                useAppStore.getState().focusRegion(linkOrigin.workspaceId, linkOrigin.tabId, linkOrigin.regionId)
              }
            } } : {})}
            // A pending request outlives the process that asked it, so the card must go inert on the
            // same terms as the composer below it — otherwise a dead Run still shows live buttons and
            // answering it fails on a Run that can no longer accept input.
            disabled={!visible || session.processState !== 'running' || session.status.state === 'disconnected' || Boolean(session.pendingInteraction.evidence.run && session.pendingInteraction.evidence.run.runId !== session.control.run.runId)}
            onRespond={async (response) => await respondInteraction(session.id, response)}
          />
          ) : null}
      </div>
      <OpenDestinationPopover
        request={linkRequest}
        canSplit={canSplit}
        onDismiss={(requestId) =>
          setLinkRequest((current) => dismissOpenDestinationRequest(current, requestId))
        }
        onSelect={onProseLinkSelect}
      />
      <ConversationAnnotationNote ref={annotationNoteRef} sessionId={sessionId} regionRef={surfaceRef}
        active={visible && hasAgentComposer && (historyOpen || inlineHistory || viewMode === 'activity')}
        {...(hasAgentComposer ? { onAnnotate: annotateMessage } : {})} />
      {hasAgentComposer && session.kind === 'agent' ? (
        <div
          className="agent-input-stack"
          data-input-surface={session.kind === 'agent' && viewMode === 'terminal' ? 'terminal' : 'activity'}
          aria-label={viewMode === 'terminal' ? 'Agent input channel' : undefined}
        >
          <AgentSessionComposer reading={mailboxReading} mailboxOrigin={mailboxOrigin} onRevealMessage={revealMailboxMessage} key={sessionId} sessionId={session.id} resultReview={(onNavigate) => <SessionResultReviewContent showStatus={false} sessionId={session.id} items={timeline} origin={linkOrigin} onNavigate={onNavigate} />} visible={visible} {...(tabName ? { tabName } : {})} />
        </div>
      ) : null}
    </section>
    </>
  )
}
