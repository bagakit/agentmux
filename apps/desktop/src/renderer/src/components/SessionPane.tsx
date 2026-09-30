import { AlertTriangle, CircleStop, LoaderCircle, RefreshCw, RotateCcw, ServerOff } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAppStore } from '../store'
import { effectiveSessionViewMode, sessionPresentationById } from '../lib/session-presentation'
import type { AgentMuxRunExitReason } from '@agentmux/core'
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
import { createSpeakerResolver } from '../lib/conversation-speaker'
import { currentConversationSenderDetails } from '../lib/conversation-sender-details'
import { useSessionUserMessages } from '../lib/session-user-messages'
import type { LinkClickModifiers } from './AgentMarkdown'
import { AgentSessionComposer } from './AgentSessionComposer'
import type { ConversationAnnotation } from './ConversationMessage'
import { ConversationAnnotationNote, type ConversationAnnotationNoteHandle, type ConversationAnnotationSelection } from './ConversationAnnotationNote'
import { SessionConnectingSurface } from './SessionConnectingSurface'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { errorIdentity } from '../lib/error-presentation'
import { AgentLifecycleFeedback } from './AgentLifecycleFeedback'
import { AgentInteractionCard } from './AgentInteractionCard'
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
import { FullPageLoadingSurface } from './FullPageLoadingSurface'
import { AgentRegionHeader } from './AgentRegionHeader'
import { agentDisplayName, firstPromptFromTimeline } from '../lib/workbench-tabs'
import { agentProviderLabel } from './AgentProviderIcon'
import { agentStartupRecoveryDecision, agentStartupRecoveryDetail } from '../lib/idle-agent-restore-policy'

const NO_TIMELINE_ITEMS: never[] = []

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
  linkOrigin: OpenHttpLinkOrigin
}) {
  const projectionPolicy = sessionRegionProjectionPolicy(readOnly)
  const session = useAppStore((state) => sessionPresentationById(state.sessions).get(sessionId))
  const pendingLaunch = useAppStore((state) => state.pendingAgentLaunches[sessionId])
  const recoveryCandidate = useAppStore((state) => state.recoveryCandidates.find((candidate) => candidate.agentSessionId === sessionId))
  const runtimeOwnershipWarnings = useAppStore((state) => state.runtimeOwnershipWarnings)
  const connectingExecutorId = pendingLaunch?.request?.executorId ?? (session?.kind === 'agent' ? session.executorId : recoveryCandidate?.executorId)
  const connectingExecutor = useAppStore((state) => connectingExecutorId ? state.config?.executors[connectingExecutorId] : undefined)
  const connectingAppearance = useAppStore((state) => connectingExecutorId ? state.config?.executors?.[connectingExecutorId]?.avatar : undefined)
  const tabName = useAppStore((state) => linkOrigin.tabId ? state.tabs?.[linkOrigin.tabId]?.name : undefined)
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
  const activityLifetime = useRef({ sessionId, opened: false })
  const activityContent = useRef<ReactNode>(null)
  if (activityLifetime.current.sessionId !== sessionId) {
    activityLifetime.current = { sessionId, opened: false }
    activityContent.current = null
  }
  if (viewMode !== 'terminal') activityLifetime.current.opened = true
  const [historyOpen, setHistoryOpen] = useState(false)
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
  const startupDecision = session?.kind === 'agent' ? agentStartupRecoveryDecision({
    runState: session.processState,
    ...(session.semanticStatus ? { semanticStatus: session.semanticStatus } : {}),
    canonical: !(runtimeOwnershipWarnings ?? []).includes(session.hostId),
    now: Date.now()
  }) : undefined
  const inlineHistory = pendingAgentRestore && startupDecision?.kind === 'pending' &&
    startupDecision.reason === 'idle-over-day'
  const {
    messages: userMessages,
    nativeHistoryPage,
    loading: userMessagesLoading,
    error: userMessagesError,
    hasMore: hasEarlierUserRecords,
    refresh: refreshUserMessages
  } = useSessionUserMessages(
    session?.kind === 'agent' ? session.control : undefined,
    { enabled: visible && viewMode !== 'terminal' && !historyOpen && !pendingAgentRestore }
  )
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
  // Resolve actual sender identities without subscribing this pane to unrelated Session output.
  const describeSpeaker = useMemo(
    () => createSpeakerResolver({
      lookupAgent: (id) => {
        const sender = useAppStore.getState().sessions.find((agent) => agent.id === id)
        return sender?.kind === 'agent' ? {
          label: sender.label,
          providerId: sender.providerId,
          readDetails: () => {
            const state = useAppStore.getState()
            return currentConversationSenderDetails(id, {
              sessions: state.sessions,
              workspaces: state.config?.workspaces ?? [],
              agentNames: state.agentNames,
              demands: state.demands
            })
          }
        } : undefined
      },
      ...(session?.kind === 'agent' ? { currentSession: session } : {})
    }),
    [session?.id, session?.label, session?.kind, session?.kind === 'agent' ? session.providerId : undefined]
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
    appendAgentComposerDraft(sessionId, `Regarding message ${JSON.stringify(annotation.messageId)}:\n> ${annotation.quote.replace(/\n/gu, '\n> ')}\n\nNote: ${annotation.note}`)
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
  // session /Users/me/proj/repo/src/auth.ts under a wrong root of /Users/me/proj renders `repo/src/auth.ts`,
  // which reads as a real answer. A wrong path that looks right is worse than a long one.
  //
  // workspaceRootForPath asks containment, not ownership — a subdirectory terminal (/repo/sub) is
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

  async function recover(): Promise<void> {
    if (recovering) return
    setRecovering(true)
    await recoverSession(sessionId)
    setRecovering(false)
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

  const acceptedLaunch = pendingLaunch?.created && (!session || session.control.run.runId === pendingLaunch.created.run.runId)
    ? pendingLaunch.created : undefined
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
      <div className="agent-body">{launchNotice}<p>Agent created · {acceptedLaunch.agentSessionId}</p></div>
      {!readOnly ? <AgentSessionComposer key={sessionId} sessionId={sessionId} visible={visible} disabled {...(tabName ? { tabName } : {})} /> : null}
    </section>
  }

  // A launching Region exists before Core returns its Session snapshot. Keep that handoff
  // neutral; interrupted and exited Sessions use the explicit recovery banners below.
  if (!session || !terminalThemeId) {
    return (
      <section className="agent-surface" data-agent-surface-mode="connecting">
          <SessionConnectingSurface key={`connecting:${sessionId}`}
          phase={pendingLaunch ? 'launch' : recoveryCandidate ? 'restore' : 'connect'}
          surfaceKind={surfaceKind}
          request={pendingLaunch?.request}
          executor={connectingExecutor}
          appearance={connectingAppearance}
        />
        {!readOnly && surfaceKind === 'agent' ? <AgentSessionComposer key={sessionId} sessionId={sessionId} visible={visible} disabled {...(tabName ? { tabName } : {})} /> : null}
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
  ) : continuityNotice ? (
    <button type="button" className="small-button"
      disabled={!(continuityRetryEnabled(continuityNotice) || continuityRefreshEnabled(continuityNotice)) || recovering || refreshing}
      title={continuityNotice.reason}
      onClick={continuityRefreshEnabled(continuityNotice)
        ? () => void refresh() : continuityRetryEnabled(continuityNotice) ? () => void recover() : undefined}>
      <RotateCcw size={12} /> {recovering && continuityRetryEnabled(continuityNotice)
        ? 'Resuming…' : refreshing && continuityRefreshEnabled(continuityNotice) ? 'Re-reading…' : continuityNotice.actionLabel}
    </button>
  ) : (
    <button type="button" className="small-button" disabled={recovering} onClick={() => void recover()}>
      <RotateCcw size={12} /> {recovering ? 'Resuming…' : 'Resume'}
    </button>
  )
  const pendingRestoreDetail = pendingAgentRestore && startupDecision ? continuityNotice?.reason ?? (recoveryCandidate
    ? session.status.detail
    : agentStartupRecoveryDetail(startupDecision)) : undefined
  const hasAgentComposer = projectionPolicy.allowsRecovery && surfaceKind === 'agent' && session.kind === 'agent'
  // Reuse the original element while covered/hidden, so late observations do not
  // repaint its rows or disturb selected text. Return applies only current visible facts.
  if (session.kind === 'agent' && visible && viewMode !== 'terminal' && !historyOpen && !pendingAgentRestore) {
    activityContent.current = <ActivityView
      sessionId={session.id}
      items={timeline}
      userMessages={userMessages}
      nativeHistoryPage={nativeHistoryPage}
      userMessageRead={{
        loading: userMessagesLoading,
        error: userMessagesError,
        hasMore: hasEarlierUserRecords,
        onRetry: () => { void refreshUserMessages() },
        onReadEarlier: openHistory
      }}
      capability={session.kind === 'agent' ? session.capabilities.timeline : 'unavailable'}
      displayState={session.status.state}
      workspaceRoot={fileContext.workspaceRoot}
      homeDir={fileContext.homeDir}
      fileReferenceNotice={fileReferenceNotice}
      {...(fileContext.kind !== 'unconfirmed' ? { openWorkspaceFile: openProjectFile } : {})}
      readPastedImage={readPastedImage}
      openHttpLink={onProseLinkClick}
      {...(hasAgentComposer ? { onSelectAnnotation: selectAnnotation } : {})}
      describeSpeaker={describeSpeaker}
              />
  }
  const resultReview = session.kind === 'agent'
    ? <SessionResultReview sessionId={session.id} items={timeline} origin={linkOrigin} visible={visible} surfaceAnchor={resultSurfaceAnchor} />
    : null

  return (
    <section
      ref={surfaceRef}
      className="agent-surface"
      data-agent-surface-mode={session.kind === 'agent' ? viewMode : 'terminal'}
    >
      {session.kind === 'agent' ? <AgentRegionHeader
        name={agentInputIdentity!} executorLabel={agentInputExecutor!} sessionId={session.id}
        regionId={linkOrigin.regionId} readOnly={readOnly}
        portalTargetId={headerPortalTargetId}
        onHistory={!historyOpen && !inlineHistory ? () => openHistory() : undefined}
        onRefreshObservation={observationMounted ? () => void refresh(true) : undefined}
        refreshing={refreshing}
        resultReview={hasAgentComposer ? null : resultReview}
      /> : null}
      {launchNotice}
      {session.kind === 'agent' ? <AgentLifecycleFeedback owner={{ subject: session.control }} visible={visible}
        busy={recovering || refreshing} retry={() => void recover()}
        {...(observationMounted ? { refreshObservation: () => void refresh(true) } : {})} /> : null}
      <div className="agent-body" data-pending-interaction={session.kind === 'agent' && session.pendingInteraction ? '' : undefined} style={{ anchorName: resultSurfaceAnchor }} data-observation-surface={session.kind === 'agent' && viewMode !== 'terminal' ? 'workflow' : undefined}>
        <div className="agent-terminal-stage">
          {session.kind === 'terminal' || viewMode === 'terminal' || pendingAgentRestore ? (
            pendingAgentRestore ? (inlineHistory ? null :
              <FullPageLoadingSurface scope="region" phase="parked" eyebrow="Session retained"
                title="Ready to restore"
                detail="Existing history and your draft are kept. Send your next request or use Resume."
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
                autoFocus={autoFocus}
                themeId={terminalThemeId}
                fontSize={terminalFontSize}
                interactiveResize={projectionPolicy.interactiveResize && interactiveResize}
                visible={visible && !historyOpen && viewMode === 'terminal'}
                readOnly={!projectionPolicy.acceptsInput}
                linkOrigin={linkOrigin}
                onObservationRefresh={bindObservationRefresh}
              />
            )
          ) : null}
          {(historyOpen || inlineHistory || historyEverOpenedRef.current) && session.kind === 'agent' ? <SessionHistoryView
            key={JSON.stringify([session.control.hostId, session.id, session.control.run.runId])}
            control={session.control}
            label={agentInputIdentity ?? session.label}
            {...(!inlineHistory ? { onClose: closeHistory } : {})}
            visible={visible && (historyOpen || inlineHistory)}
            returnLabel={pendingAgentRestore ? 'Session' : viewMode === 'terminal' ? 'Terminal' : 'Activity'}
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
              serviceNotice: <><span><strong>Ready to restore.</strong> {pendingRestoreDetail}</span>{agentRecoveryAction}</>
            } : {})}
          /> : null}
          {(disconnected || missing || exited) && !(pendingAgentRestore && (historyOpen || inlineHistory)) ? (
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
          <AgentSessionComposer key={sessionId} sessionId={session.id} resultReview={(onNavigate) => <SessionResultReviewContent showStatus={false} sessionId={session.id} items={timeline} origin={linkOrigin} onNavigate={onNavigate} />} visible={visible} {...(tabName ? { tabName } : {})} />
        </div>
      ) : null}
    </section>
  )
}
