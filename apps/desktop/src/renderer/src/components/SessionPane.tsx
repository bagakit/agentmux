import { usePendingDeliveryLayout, type PendingDeliveryLayout } from '../lib/pending-delivery-layout'
import { mintObjectId } from '@agentmux/core/object-id'
import { ConversationLandmarkList, renderConversationLandmarkAction } from './ConversationLandmarks'
import { questionReplyKey } from '@agentmux/client-ui/conversation-question-reply'
import { useObservedAppStore, useObservedConsumerCommit } from '../lib/use-observed-app-store'
import { useSessionLinkOpening } from '../lib/session-link-opening'
import { useConversationReactions } from '../lib/conversation-reactions'
import type { ConversationAnnotationSelection } from '@agentmux/client-ui/conversation-annotation'
import { ConversationMessageAvatar } from './ConversationMessageAvatar'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { cloneElement, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type ReactElement, type ComponentProps } from 'react'
import { agentRegionExecution, useAppStore, currentCoreSpatialGraph } from '../store'
import { sessionNameMetadataFor } from '../lib/session-name-metadata'
import { useShallow } from 'zustand/react/shallow'
import { retainActivityControls } from '../lib/retained-activity'
import { createFirstPromptSelector, createSessionViewModeSelector, effectiveSessionViewMode, sessionPresentationById } from '../lib/session-presentation'
import type { AgentMuxRunExitReason, AgentSessionUserMessage, AgentSessionHistoryPage } from '@agentmux/core'
import { TERMINAL_FONT_SIZE_DEFAULT } from '../../../shared/contracts'
import type { OpenHttpLinkOrigin } from '../lib/open-destination'
import { nativeSourceUnconfirmed, projectNativeSourceFacts } from '../../../shared/agent-native-source'
import { CONNECTION_UNRECOVERABLE_DETAIL, pendingAgentLaunchStorageWait } from '../lib/session-state'
import { originalFrontendRecovery } from '../lib/session-original-recovery'
import { sessionExitPresentation, sessionFrontendPresentation, sessionRecoveryClassName, sessionRecoveryState } from '../lib/session-recovery-banner'
import { currentContinuitySupervision } from '../lib/continuity-supervision'
import { workspaceRootForPath } from '../lib/workbench-tabs'
import { createSessionProjectFileContextSelector } from '../lib/session-project-file-context'
import { api } from '../lib/api'
import { agentSessionIdsOfUserMessages, createSpeakerResolver } from '@agentmux/client-ui/conversation-speaker'
import { createConversationSpeakerFactsSelector, currentConversationSenderDetails, currentConversationSpeakerMetadata } from '../lib/conversation-sender-details'
import { useSessionUserMessages } from '../lib/session-user-messages'
import type { LinkClickModifiers } from '@agentmux/client-ui/components/AgentMarkdown'
import { AgentSessionComposer } from './AgentSessionComposer'
import type { ConversationAnnotation } from '@agentmux/client-ui/components/ConversationMessage'
import { ConversationAnnotationNote, type ConversationAnnotationNoteHandle } from './ConversationAnnotationNote'
import { formatConversationAnnotation } from '../lib/conversation-annotation-delivery'
import { SessionConnectingSurface } from './SessionConnectingSurface'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { ContinuitySupervisionNotice } from './ContinuitySupervisionNotice'
import { SessionRecoveryActions } from './SessionRecoveryActions'
import { unobservedRecoveryReference, rereadUnobservedSession, type RecoverySource } from '../lib/session-recovery-actions'
import { errorIdentity, presentError } from '@agentmux/client-ui/error-presentation'
import { AgentLifecycleFeedback } from './AgentLifecycleFeedback'
import { AgentInteractionCard } from '@agentmux/client-ui/components/AgentInteractionCard'
import { desktopQuestionReplyState, reconcileConversationQuestionReplies, editConversationQuestionDraft, sendConversationQuestionReply } from '../lib/conversation-question'
import { ActivityView } from './ActivityView'
import { OpenDestinationPopover } from './OpenDestinationBar'
import { TerminalView } from './TerminalView'
import {
  classifyContinuityFailure,
  continuityRefreshEnabled,
  continuityRetryEnabled
} from '../lib/continuity-failure-notice'
import { sessionRegionProjectionPolicy } from '../lib/session-region-projection'
import { SessionResultReview } from './SessionResultReview'
import { SessionResultReviewContent } from './SessionResultReviewContent'
import { useFocusHistorySources } from '../lib/focus-history-sources'
import { FullPageLoadingSurface } from './FullPageLoadingSurface'
import { SessionRecap } from './SessionRecap'
import { AgentRegionHeader } from './AgentRegionHeader'
import { useAgentCurrentForkControls } from './AgentCurrentForkControls'
import { SessionTakeoverSurface } from './SessionTakeoverSurface'
import { SessionLearningSurface } from './SessionLearningSurface'
import { takeoverExecution } from '../lib/session-takeover'
import { executionHostProjection, regionExecutionHost } from '../lib/region-execution-host'
import { SessionActivityPresentation } from './SessionActivityPresentation'
import { observeAgentSession } from '../lib/agent-observation'
import { useWorkbenchBrowserPresentation, workbenchSessionStageHostId, type WorkbenchViewTarget } from '../lib/workbench-presentation'
import { agentDisplayName } from '../lib/workbench-tabs'
import { agentProviderLabel } from './AgentProviderIcon'
import { moteConversationIdentity, useMoteConversationOwner } from '../lib/mote-conversation-identity'
import { agentContinuityPresentation, currentRunRecoveryOperation } from '../lib/continuity-presentation'
import { type ConversationItemRef } from '@agentmux/core/conversation'
import { sameWorkbenchProjectionSelection } from '../lib/workbench-projection'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'
import type { ConversationRevealRequest, MailboxMessageNavigationResult } from '../lib/mailbox-message-navigation'

const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeActionResumeSessionIcon = semanticIconComponent('action.resume-session')
const ThemeActionRestartTerminalIcon = semanticIconComponent('action.restart-terminal')
const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeStatusWarningIcon = semanticIconComponent('status.warning')
const ThemeStatusHostUnavailableIcon = semanticIconComponent('status.host-unavailable')
const ThemeActionStopIcon = semanticIconComponent('action.stop')


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
  const observationVisible = visible || presentations.some(target => target.visible !== false)
  useObservedConsumerCommit('sessionPane', observationVisible)
  const consumerScope = useMemo(() => ({ sessionIds: [sessionId], navigation: visible && !readOnly }), [sessionId, visible, readOnly])
  const projectionPolicy = sessionRegionProjectionPolicy(readOnly)
  const [takeoverSelection, setTakeoverSelection] = useState<{ key: string; displayId: string | null; origin: OpenHttpLinkOrigin; trigger: HTMLButtonElement | null } | null>(null)
  const [learningSelection, setLearningSelection] = useState<{ key: string; displayId: string | null; origin: OpenHttpLinkOrigin; trigger: HTMLButtonElement | null; open: boolean } | null>(null)
  const primaryPresentation = useWorkbenchBrowserPresentation()
  const primaryReference = primaryPresentation.reference
  const mailboxOrigin = primaryReference ? { ...linkOrigin, workspaceId: primaryReference.displayWorkspaceId,
    tabGroupId: primaryReference.groupId, tabId: primaryReference.tabId } : linkOrigin
  const selectOwnRegion = useCallback((): void => {
    if (!linkOrigin.regionId) return
    // The current presentation owns navigation. The Session's resource home
    // cannot stand in for a Survey, Mote or Focus selection callback.
    if (primaryPresentation.onSelectRegion) primaryPresentation.onSelectRegion(linkOrigin.regionId)
    else if (mailboxOrigin.tabId && !primaryPresentation.survey && (!primaryPresentation.surface || primaryPresentation.surface === 'space')) {
      useAppStore.getState().focusRegion(mailboxOrigin.workspaceId, mailboxOrigin.tabId, linkOrigin.regionId,
        'pointer', mailboxOrigin.tabGroupId)
    }
  }, [linkOrigin.regionId, primaryPresentation.onSelectRegion, primaryPresentation.survey, primaryPresentation.surface,
    mailboxOrigin.workspaceId, mailboxOrigin.tabId, mailboxOrigin.tabGroupId])
  const session = useObservedAppStore('sessionPane', observationVisible, consumerScope, (state) => sessionPresentationById(state.sessions).get(sessionId))
  const currentConversationActions = useAgentCurrentForkControls({ session: session?.kind === 'agent' ? session : null, linkOrigin: mailboxOrigin, readOnly })
  const pendingLaunch = useObservedAppStore('sessionPane', observationVisible, consumerScope, (state) => state.pendingAgentLaunches[sessionId])
  const storageWait = !session ? pendingAgentLaunchStorageWait(pendingLaunch, sessionId) : undefined
  const pendingTerminal = useObservedAppStore('sessionPane', observationVisible, consumerScope, state => {
    const surface = linkOrigin.tabId && linkOrigin.regionId ? state.tabs[linkOrigin.tabId]?.regions[linkOrigin.regionId] : undefined
    return surface?.kind === 'terminal' && surface.phase === 'launching' && surface.sessionId === sessionId
  })
  const recoveryCandidate = useObservedAppStore('sessionPane', observationVisible, consumerScope, (state) => state.recoveryCandidates.find((candidate) => candidate.agentSessionId === sessionId))
  const nameMetadata = useObservedAppStore('sessionPane', observationVisible, consumerScope, state => sessionNameMetadataFor(state.sessionNameMetadata, sessionId, [
    linkOrigin.tabId && linkOrigin.regionId ? agentRegionExecution({tabId: linkOrigin.tabId, regionId: linkOrigin.regionId, agentSessionId: sessionId})?.hostId : undefined,
    session?.hostId, pendingLaunch?.request?.hostId, recoveryCandidate?.hostId
  ]))
  const historyCatalogue = useFocusHistorySources(!session && !pendingLaunch && surfaceKind === 'agent' && visible && !parked)
  const historyHostId = useObservedAppStore('sessionPane', observationVisible, consumerScope, state => state.config?.workspaces.find(workspace => workspace.id === linkOrigin.workspaceId)?.hostId)
  const retainedHistory = historyCatalogue.sources.find(source => source.agentSessionId === sessionId && source.hostId === historyHostId)
  const unobservedIdentity = !session && retainedHistory?.state !== 'retired' && surfaceKind === 'agent' && visible && !parked && linkOrigin.tabId && linkOrigin.regionId
    ? { agentSessionId: sessionId, tabId: linkOrigin.tabId, regionId: linkOrigin.regionId, displayWorkspaceId: linkOrigin.workspaceId,
        ...(linkOrigin.tabGroupId ? { groupId: linkOrigin.tabGroupId } : {}) } : null
  const unobservedReference = unobservedIdentity ? unobservedRecoveryReference(unobservedIdentity) : null
  // Core creation's `local` is local to its server, not this Desktop. The existing
  // submitted request retains the configured endpoint; missing intent stays unknown.
  const executionHostId = session ? session.kind === 'agent' ? session.control.hostId : session.hostId
    : unobservedReference ? unobservedReference.source?.hostId
      : pendingLaunch ? pendingLaunch.request?.hostId
      : retainedHistory?.state === 'retired' ? retainedHistory.hostId : recoveryCandidate?.hostId
  const configuredExecutionHost = useObservedAppStore('sessionPane', observationVisible, consumerScope, state => state.config?.hosts.find(host => host.id === executionHostId))
  const runtimeHostUnavailable = useObservedAppStore('sessionPane', observationVisible, consumerScope, state => (state.runtimeEndpointWarnings ?? []).some(
    warning => warning.hostId === executionHostId && warning.availability !== 'connected'))
  const connectingExecutorId = pendingLaunch?.request?.executorId ?? (session?.kind === 'agent' ? session.executorId : recoveryCandidate?.executorId ?? retainedHistory?.history?.executorId)
  const connectingExecutor = useObservedAppStore('sessionPane', observationVisible, consumerScope, (state) => connectingExecutorId ? state.config?.executors[connectingExecutorId] : undefined)
  const connectingAppearance = useObservedAppStore('sessionPane', observationVisible, consumerScope, (state) => connectingExecutorId ? state.config?.executors?.[connectingExecutorId]?.avatar : undefined)
  const tabName = useObservedAppStore('sessionPane', observationVisible, consumerScope, (state) => linkOrigin.tabId ? state.tabs?.[linkOrigin.tabId]?.name : undefined)
  const sourceWorkspaceId = useObservedAppStore('sessionPane', observationVisible, consumerScope, state => linkOrigin.tabId ? state.tabs[linkOrigin.tabId]?.workspaceId : undefined)
  const moteOwner = useMoteConversationOwner(linkOrigin.workspaceId, linkOrigin.tabId,
    visible || presentations.some(target => target.visible !== false))
  const timeline = useObservedAppStore('sessionPane', observationVisible, consumerScope, (state) => state.timelines[sessionId]?.items ?? NO_TIMELINE_ITEMS)
  const timelineSnapshot = useObservedAppStore('sessionPane', observationVisible, consumerScope, (state) => state.timelines[sessionId])
  const firstPromptSelector = useMemo(() => createFirstPromptSelector(sessionId), [sessionId])
  const firstPrompt = useObservedAppStore('sessionPane', observationVisible, consumerScope, firstPromptSelector)
  const userName = useObservedAppStore('sessionPane', observationVisible, consumerScope, (state) => state.agentNames?.[sessionId])
  const questionReplies = useObservedAppStore('sessionPane', observationVisible, consumerScope, state => state.questionReplies?.[sessionId])
  const questionSaveWarning = useObservedAppStore('sessionPane', observationVisible, consumerScope, state => state.workbenchSaveWarning)
  const questionDrafts = useObservedAppStore('sessionPane', observationVisible, consumerScope, state => state.questionReplyDrafts?.[sessionId])
  const questionControl = session?.kind === 'agent' ? session.control : undefined
  const questionNotApplied = session?.kind === 'agent' ? session.promptInputNotApplied : undefined
  const questionSessionId = questionControl?.agentSessionId, questionHostId = questionControl?.hostId, questionRunId = questionControl?.run.runId
  const refusedQuestionOperation = questionNotApplied?.submissionId, refusedQuestionRun = questionNotApplied?.run.runId
  useEffect(() => {
    if (questionSessionId && questionHostId && questionRunId && refusedQuestionOperation && refusedQuestionRun) reconcileConversationQuestionReplies(
      { kind: 'agent', agentSessionId: questionSessionId, hostId: questionHostId, run: { runId: questionRunId } },
      { submissionId: refusedQuestionOperation, run: { runId: refusedQuestionRun } })
  }, [questionSessionId, questionHostId, questionRunId, refusedQuestionOperation, refusedQuestionRun, questionReplies])
  const appendAgentComposerDraft = useAppStore.getState().appendAgentComposerDraft
  const terminalThemeId = useObservedAppStore('sessionPane', observationVisible, consumerScope, (state) => state.config?.appearance.terminalTheme)
  const autoFocus = useObservedAppStore('sessionPane', observationVisible, consumerScope, state => {
    if (!visible || readOnly || state.retainedSpatialFocus || state.workbenchNavigationInputPolicy || state.mainSurface !== 'workbench' ||
      state.activeWorkspaceId !== mailboxOrigin.workspaceId || !mailboxOrigin.tabId || !linkOrigin.regionId) return false
    const choice = state.workbenchSpaceSelection
    return choice?.workspaceId === mailboxOrigin.workspaceId && choice.groupId === mailboxOrigin.tabGroupId &&
      choice.tabId === mailboxOrigin.tabId && choice.regionId === linkOrigin.regionId
  })
  const terminalFontSize = useObservedAppStore('sessionPane', observationVisible, consumerScope,
    (state) => state.config?.appearance.terminalFontSize ?? TERMINAL_FONT_SIZE_DEFAULT
  )
  const viewModeSelector = useMemo(() => createSessionViewModeSelector(sessionId), [sessionId])
  const viewMode = useObservedAppStore('sessionPane', observationVisible, consumerScope, viewModeSelector)
  const activitySourceKey = session?.kind === 'agent' ? JSON.stringify([session.control.hostId, session.id, session.control.run.runId]) : sessionId
  // Status/time updates do not change the original native reading source.
  const nativeSourceFacts = useMemo(() => session?.kind === 'agent' ? {
    ...(session.nativeHandle ? { nativeHandle: session.nativeHandle } : {}),
    ...(session.nativeBinding ? { nativeBinding: session.nativeBinding } : {}),
    ...(session.observedNativeHandle ? { observedNativeHandle: session.observedNativeHandle } : {}),
    ...(session.nativeSourceObservation ? { nativeSourceObservation: session.nativeSourceObservation } : {}),
    ...(session.nativeConfirmation ? { nativeConfirmation: session.nativeConfirmation } : {})
  } : {}, [session?.kind, session?.kind === 'agent' ? session.nativeHandle : undefined,
    session?.kind === 'agent' ? session.nativeBinding : undefined,
    session?.kind === 'agent' ? session.observedNativeHandle : undefined,
    session?.kind === 'agent' ? session.nativeSourceObservation : undefined,
    session?.kind === 'agent' ? session.nativeConfirmation : undefined])
  const activityLifetime = useRef({ sourceKey: activitySourceKey, opened: false })
  const activityContent = useRef<ReactElement<ComponentProps<typeof ActivityView>> | null>(null)
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
  const [presentationHistory, setPresentationHistory] = useState<{ displayId: string; trigger: HTMLButtonElement | null } | null>(null)
  useEffect(() => { setPresentationHistory(null) }, [activitySourceKey, viewMode])
  const openTerminal = (): void => {
    useAppStore.getState().setViewMode(sessionId, 'terminal')
    setHistoryOpen(false)
    selectOwnRegion()
    if (projectionPolicy.acceptsInput && !pendingAgentRestore && linkOrigin.regionId) {
      useAppStore.getState().requestRegionCaretFocus(linkOrigin.regionId)
    }
  }
  useEffect(() => {
    if (navigation.current.isCurrent && !navigation.current.isCurrent()) navigation.current.cancel?.()
  })
  const surfaceRef = useRef<HTMLElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const interactionSourceRef = useRef<HTMLDivElement>(null)
  const interactionRef = useRef<HTMLElement>(null)
  const annotationNoteRef = useRef<ConversationAnnotationNoteHandle>(null)
  const selectAnnotation = useCallback((selection: ConversationAnnotationSelection) => {
    annotationNoteRef.current?.select(selection, sessionId)
  }, [sessionId])
  const resultAnchorId = useId()
  const resultSurfaceAnchor = `--result-surface-${resultAnchorId.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const historyReturnFocusRef = useRef<HTMLButtonElement | null>(null)
  const historyReturnContext = JSON.stringify([activitySourceKey, primaryPresentation.tabHostId, primaryPresentation.surface,
    mailboxOrigin.workspaceId, mailboxOrigin.tabGroupId, mailboxOrigin.tabId, linkOrigin.regionId])
  const historyReturnContextRef = useRef(historyReturnContext)
  historyReturnContextRef.current = historyReturnContext
  const historyOpenRef = useRef(historyOpen)
  historyOpenRef.current = historyOpen
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  useEffect(() => {
    setHistoryOpen(false)
    historyReturnFocusRef.current = null
  }, [sessionId])
  useEffect(() => {
    setHistoryOpen(false)
  }, [viewMode])
  const openHistory = (trigger?: HTMLButtonElement): void => {
    const document = surfaceRef.current?.ownerDocument ?? globalThis.document
    const header = !readOnly && headerPortalTargetId
      ? document.getElementById(headerPortalTargetId)
      : surfaceRef.current
    historyReturnFocusRef.current = trigger ?? header?.querySelector<HTMLButtonElement>('.agent-region-header__more') ?? null
    setHistoryOpen(true)
  }
  const closeHistory = useCallback((): void => {
    const document = surfaceRef.current?.ownerDocument ?? globalThis.document
    const reader = surfaceRef.current?.querySelector('.activity-feed')
    const target = historyReturnFocusRef.current
    const closingFocus = document.activeElement
    setHistoryOpen(false)
    selectOwnRegion()
    document.defaultView?.requestAnimationFrame(() => {
      if (historyReturnContextRef.current !== historyReturnContext || !visibleRef.current || historyOpenRef.current ||
        !surfaceRef.current?.isConnected || !target?.isConnected || target.disabled) return
      const active = document.activeElement
      if (active && active !== document.body && (active !== closingFocus || !reader?.contains(active))) return
      target.focus()
    })
  }, [historyReturnContext, selectOwnRegion])
  const pendingAgentRestore = session?.kind === 'agent' && session.processState !== 'running'
  const frontendNotice = sessionFrontendPresentation(session)
  const recoverableFrontendNotice = frontendNotice && frontendNotice.kind !== 'unknown' ? frontendNotice : null
  const frontendSurface = frontendNotice?.fullPage === true
  const needsSessionSurface = pendingAgentRestore || frontendSurface
  const [retainedOutputKey, setRetainedOutputKey] = useState<string | null>(null)
  const readingRetainedOutput = needsSessionSurface && retainedOutputKey === activitySourceKey
  const terminalLifetime = useRef({ sourceKey: activitySourceKey, opened: false })
  if (terminalLifetime.current.sourceKey !== activitySourceKey) terminalLifetime.current = { sourceKey: activitySourceKey, opened: false }
  const startupDecision = session?.kind === 'agent' ? session.continuity : undefined
  const inlineHistory = pendingAgentRestore && startupDecision?.reason === 'idle-window-expired'
  const pendingLayout = usePendingDeliveryLayout({ boundaryRef: surfaceRef, bodyRef, interactionSourceRef, interactionRef,
    interactionId: session?.kind === 'agent' ? session.pendingInteraction?.id : undefined,
    terminal: visible && !parked && !historyOpen && !inlineHistory && viewMode === 'terminal' && session && linkOrigin.regionId
      ? { regionId: linkOrigin.regionId, sessionId: session.id, runId: session.control.run.runId } : undefined,
    active: visible })
  const incomingReveal = useAppStore(state => {
    const intent = state.conversationRevealIntent
    return intent?.itemRef.agentSessionId === sessionId && intent.itemRef.hostId === executionHostId ? intent : null
  })
  // One fact/observation owner, with demand from every actually visible reading stage.
  const activityDemand = !pendingAgentRestore &&
    (visible && (viewMode !== 'terminal' || historyOpen) || presentations.some(target => target.visible !== false && (viewMode !== 'terminal' || presentationHistory?.displayId === workbenchSessionStageHostId(target, linkOrigin.regionId!))))
  const {
    messages: userMessages,
    nativeHistoryPage,
    nativeContextItems
  } = useSessionUserMessages(
    session?.kind === 'agent' ? session.control : undefined,
    { enabled: activityDemand }
  )
  const revealConversationItem = useCallback((itemRef: ConversationItemRef, presentation?: WorkbenchViewTarget, mailboxInputId?: string, isIntentCurrent?: () => boolean, routeHostId = itemRef.hostId): Promise<MailboxMessageNavigationResult> => {
    navigation.current.cancel?.()
    const generation = ++navigation.current.generation
    const control = session?.kind === 'agent' ? session.control : undefined
    const sourceKey = conversationMessageSourceKey(control?.agentSessionId, itemRef.source)
    const unavailable = (detail: string): MailboxMessageNavigationResult => ({ kind: 'unavailable', message: `${detail} 原文仍可阅读和复制。` })
    if (!control || routeHostId !== control.hostId || itemRef.agentSessionId !== control.agentSessionId || !sourceKey) return Promise.resolve(unavailable('记录关系未确认，无法定位。'))
    if (pendingAgentRestore) return Promise.resolve(unavailable('当前对话位置尚不可用，Session 已保留。'))
    if (itemRef.source.kind === 'native' && session?.providerId !== itemRef.source.providerId) {
      return Promise.resolve(unavailable('原生来源已变化，当前阅读窗口保留；请刷新来源后再定位。'))
    }
    const displayId = presentation && linkOrigin.regionId ? workbenchSessionStageHostId(presentation, linkOrigin.regionId) : null
    if (presentation && !displayId) return Promise.resolve(unavailable('当前显示宿主关系未确认，无法定位。'))
    const initialMode = effectiveSessionViewMode(useAppStore.getState(), sessionId)
    const readController = new AbortController()
    let switched = false
    const current = () => {
      if (readController.signal.aborted || isIntentCurrent && !isIntentCurrent()) return false
      const live = sessionPresentationById(useAppStore.getState().sessions).get(sessionId)
      if (live?.kind !== 'agent' || JSON.stringify([live.control.hostId, live.id, live.control.run.runId]) !== activitySourceKey) return false
      if (itemRef.source.kind === 'native' && live.providerId !== itemRef.source.providerId) {
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
      return true
    }
    let resolveResult: (result: MailboxMessageNavigationResult) => void = () => {}
    const result = new Promise<MailboxMessageNavigationResult>(resolve => { resolveResult = resolve })
    let finished = false
    const finish = (outcome: MailboxMessageNavigationResult) => {
      if (finished) return
      finished = true
      readController.abort()
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
    // The exact target owns this explicit demand even while Terminal remains
    // visible. The independent current input summary is never a navigation gate.
    setRevealRequest({ generation, record: itemRef, signal: readController.signal, sourceKey, displayId,
      ...(mailboxInputId ? { inputId: mailboxInputId } : {}), isCurrent: current,
      present: () => {
        if (!current()) return false
        switched = true
        setHistoryOpen(false)
        useAppStore.getState().setViewMode(sessionId, 'activity', { focus: false })
        return true
      },
      complete: (located, error) => {
        if (!current()) { finish({ kind: 'cancelled' }); return }
        finish(located ? { kind: 'located' } : unavailable(error ?? '准确记录尚未呈现在对话中，无法确认位置。'))
      } })
    return result
  }, [activitySourceKey, sessionId, session, pendingAgentRestore, linkOrigin.regionId])
  // Mailbox keeps its original user-input identity contract; Focus may reveal genuine replies.
  const revealMailboxMessage = useCallback((message: AgentSessionUserMessage, reference: ConversationItemRef | null, presentation?: WorkbenchViewTarget) => {
    if (session?.kind !== 'agent' || !reference) return Promise.resolve<MailboxMessageNavigationResult>({ kind: 'unavailable', message: 'Original record reference is unconfirmed. Recorded text remains readable.' })
    return revealConversationItem(reference, presentation, message.id, undefined, session.control.hostId)
  }, [session, revealConversationItem])
  useEffect(() => {
    if (!incomingReveal || incomingReveal.claimed || !incomingReveal.isCurrent() || readOnly) return
    const reference = incomingReveal.reference
    if (linkOrigin.regionId !== reference.regionId) return
    const target = presentations.find(target => target.visible !== false && target.reference &&
      sameWorkbenchProjectionSelection({ ...target.reference, regionId: linkOrigin.regionId! }, reference))
    const primary = visible && mailboxOrigin.workspaceId === reference.displayWorkspaceId && mailboxOrigin.tabGroupId === reference.groupId && mailboxOrigin.tabId === reference.tabId
    if (!target && !primary) return
    incomingReveal.claimed = true
    void revealConversationItem(incomingReveal.itemRef, target, undefined, incomingReveal.isCurrent, incomingReveal.routeHostId).then(incomingReveal.complete)
  }, [incomingReveal, revealConversationItem, readOnly, visible, presentations, mailboxOrigin.workspaceId, mailboxOrigin.tabGroupId, mailboxOrigin.tabId, linkOrigin.regionId])
  const agentInputIdentity = session?.kind === 'agent'
    ? agentDisplayName({
        userName,
        firstPrompt,
        fallbackLabel: session.label,
        providerLabel: agentProviderLabel(session.providerId)
      })
    : undefined
  const agentInputExecutor = session?.kind === 'agent'
    ? (connectingExecutor?.label ?? session.executorId)
    : undefined
  // Observe only identity facts for the Agents actually represented in this reading surface.
  // Output/status from unrelated Sessions cannot refresh these descriptors or read sender goals.
  const speakerIds = useMemo(() => [...new Set([sessionId, ...agentSessionIdsOfUserMessages(userMessages)])], [sessionId, userMessages])
  const speakerScope = useMemo(() => ({ sessionIds: speakerIds, navigation: false }), [speakerIds])
  const speakerFactsSelector = useMemo(() => createConversationSpeakerFactsSelector(speakerIds, activityDemand), [speakerIds, activityDemand])
  const speakerFacts = useObservedAppStore('sessionPane', observationVisible, speakerScope, useShallow(speakerFactsSelector))
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
        } : state.agentNames[id] ? { label: state.agentNames[id] } : undefined
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
  const refreshSession = useAppStore.getState().refreshSession
  const recoverSession = useAppStore.getState().recoverSession
  const respondInteraction = useAppStore.getState().respondInteraction
  const annotateMessage = (annotation: ConversationAnnotation): void => {
    // 「把一段引文送进当前草稿」这个决定归 store 的 `appendAgentComposerDraft` 所有——
    // 浏览器标注那条 dock 动作走的就是它。这里此前手写了一份读-改-写（`getState()` +
    // `setAgentComposerDraft`），两份实现在尾部空白上**不一致**（实测：草稿是 `'Existing\n'` 时
    // 手写那份给出 `Existing\n\nREF`、store 给出 `Existing\n\n\nREF`）。同一个产品动作在两个
    // 表面上给两种结果，而只有其中一份有判据。
    appendAgentComposerDraft(sessionId, formatConversationAnnotation(annotation, sessionId))
  }
  // Topic/Mote Terminal and Activity links share the confirmed physical parsing root,
  // independent of the active Workspace or a moved display. The shared opener translates
  // parsed relative paths to the logical Scratch File address. Other Session, Project
  // and Goal routes retain their existing owners.
  const reportError = useAppStore.getState().reportError
  const activeWorkspaceRoot = useObservedAppStore('sessionPane', observationVisible, consumerScope, (state) =>
    (session ? workspaceRootForPath(state.config ?? null, session) : undefined) ?? ''
  )
  const selectFileContext = useMemo(() => createSessionProjectFileContextSelector(sessionId, mailboxOrigin, currentCoreSpatialGraph),
    [sessionId, mailboxOrigin.workspaceId, mailboxOrigin.tabGroupId, mailboxOrigin.tabId, mailboxOrigin.regionId, mailboxOrigin.sessionId])
  const fileContext = useObservedAppStore('sessionPane', observationVisible, consumerScope, selectFileContext)
  const [fileLinkIssue, setFileLinkIssue] = useState<string | null>(null)
  useEffect(() => { setFileLinkIssue(null) }, [fileContext])
  const fileOrigin = useMemo(() => ({ ...mailboxOrigin, sessionId }), [mailboxOrigin.workspaceId, mailboxOrigin.tabGroupId, mailboxOrigin.tabId, mailboxOrigin.regionId, sessionId])
  const linkOpening = useSessionLinkOpening(fileOrigin, setFileLinkIssue, selectOwnRegion)
  const openProjectFile = useCallback((path: string, location?: { line: number; column?: number }, event?: LinkClickModifiers) => {
    // Freeze the rendered scope and exact display occurrence. Never resolve again from focus.
    if (selectFileContext(useAppStore.getState()) !== fileContext || fileContext.kind === 'unconfirmed') {
      setFileLinkIssue('The rendered file context changed before this click could be confirmed.')
      return
    }
    linkOpening.activateFile(path, location, event)
  }, [fileContext, selectFileContext, linkOpening])
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
  const openWorkspaceFile = openProjectFile
  // A pasted image cited in the conversation is read back through main (the only place that can reach a
  // file outside the workspace) as an <img>-ready data URI. Main confines the read to the pasted
  // directory; a null return means "not a readable pasted image", and the renderer falls back to the
  // plain-text reference. Stable identity so the thumbnail's load effect does not re-fire each render.
  const readPastedImage = useCallback((path: string) => api.ui.readPastedImage(path), [])
  const readHistoryResource = useMemo(() => executionHostId === undefined ? undefined
    : (input: Parameters<typeof api.sessions.historyResource>[1]) => api.sessions.historyResource({ hostId: executionHostId, agentSessionId: sessionId }, input),
  [executionHostId, sessionId])
  // File and HTTP links share the saved Focus destination and explicit modifier gestures.
  const linkRequest = linkOpening.request
  const canSplit = linkOpening.canSplit
  const onProseLinkClick = linkOpening.activateHttp
  const onProseLinkSelect = linkOpening.choose
  const [refreshing, setRefreshing] = useState(false)
  const [originalReadError, setOriginalReadError] = useState<{ source: string; message: string } | null>(null)
  const [unobservedReadError, setUnobservedReadError] = useState<string | null>(null)
  const observationScope = JSON.stringify([sessionId, linkOrigin.tabId, linkOrigin.regionId, linkOrigin.workspaceId, linkOrigin.tabGroupId])
  const observationScopeRef = useRef<string | null>(observationScope)
  observationScopeRef.current = visible && !readOnly && !parked ? observationScope : null
  const observationActive = useRef(true)
  useEffect(() => { observationActive.current = true; return () => { observationActive.current = false } }, [])
  useEffect(() => { setUnobservedReadError(null) }, [observationScope])
  const [observationMounted, setObservationMounted] = useState(false)
  const observationRefreshRef = useRef<(() => Promise<void>) | null>(null)
  const bindObservationRefresh = useCallback((refresh: (() => Promise<void>) | null) => {
    observationRefreshRef.current = refresh
    setObservationMounted(refresh !== null)
  }, [])
  const [recovering, setRecovering] = useState(false)
  const frontendRecoveryIntent = useRef<{ scope: string; operationId: string } | null>(null)
  const reopenRetiredSession = useAppStore.getState().reopenRetiredSession
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
  const takeoverOriginal = takeoverExecution(sessionId, historyCatalogue.sources)
  const takeoverKey = JSON.stringify([activitySourceKey, takeoverOriginal?.hostId, takeoverOriginal?.cwd])
  useEffect(() => {
    if (takeoverSelection !== null && takeoverSelection.key !== takeoverKey) setTakeoverSelection(null)
  }, [takeoverKey, takeoverSelection])
  const takeOverAt = (origin: OpenHttpLinkOrigin, displayId: string | null = null) => surfaceKind === 'agent' && projectionPolicy.allowsRecovery && origin.tabId && origin.regionId
    ? (trigger?: HTMLButtonElement) => setTakeoverSelection({ key: takeoverKey, displayId, origin, trigger: trigger ?? null }) : undefined
  const onTakeOver = takeOverAt(mailboxOrigin)
  const learnAt = (origin: OpenHttpLinkOrigin, displayId: string | null = null) => surfaceKind === 'agent' && projectionPolicy.allowsRecovery && takeoverOriginal?.hostId && origin.tabId && origin.regionId
    ? (trigger?: HTMLButtonElement) => setLearningSelection({ key: takeoverKey, displayId, origin, trigger: trigger ?? null, open: true }) : undefined
  const takeoverAt = (origin: OpenHttpLinkOrigin, active: boolean, displayId: string | null = null) => <>{learningSelection?.key === takeoverKey && learningSelection.displayId === displayId &&
    JSON.stringify(learningSelection.origin) === JSON.stringify(origin) && takeoverOriginal?.hostId ? <SessionLearningSurface key={takeoverKey} active={active && learningSelection.open}
      source={{ hostId: takeoverOriginal.hostId, agentSessionId: sessionId }} label={agentInputIdentity ?? userName ?? tabName ?? session?.label ?? sessionId}
      returnTrigger={learningSelection.trigger} onClose={() => setLearningSelection(value => value ? { ...value, open: false } : null)} /> : null}{takeoverSelection?.key === takeoverKey && takeoverSelection.displayId === displayId &&
    JSON.stringify(takeoverSelection.origin) === JSON.stringify(origin) ? <SessionTakeoverSurface key={takeoverKey} active={active}
    returnTrigger={takeoverSelection.trigger} onClose={() => setTakeoverSelection(null)} source={{
    agentSessionId: sessionId, hostId: takeoverOriginal?.hostId, cwd: takeoverOriginal?.cwd,
    label: agentInputIdentity ?? userName ?? tabName ?? session?.label ?? sessionId,
    executorId: takeoverOriginal?.executorId, origin,
    diagnostic: JSON.stringify({ status: session?.status ?? null, processState: session?.processState ?? 'unobserved',
      interruptionReason: session?.interruptionReason, projectionFailures: pendingLaunch?.projectionFailures ?? [],
      recovery: recoveryCandidate ?? null, pendingRequest: pendingLaunch?.request ?? null }, null, 2)
  }} /> : null}</>
  const takeoverSurface = takeoverAt(mailboxOrigin, visible)
  const presentationOrigin = (target: WorkbenchViewTarget): OpenHttpLinkOrigin => ({ ...linkOrigin,
    workspaceId: target.reference!.displayWorkspaceId, tabGroupId: target.reference!.groupId, tabId: target.reference!.tabId })
  const recoveryActionSource: RecoverySource | null = unobservedReference ? unobservedReference.source : executionHostId && sourceWorkspaceId && linkOrigin.tabId && linkOrigin.regionId ? {
    hostId: executionHostId, agentSessionId: sessionId, workspaceId: sourceWorkspaceId,
    tabId: linkOrigin.tabId, regionId: linkOrigin.regionId, displayWorkspaceId: linkOrigin.workspaceId,
    ...(linkOrigin.tabGroupId ? { groupId: linkOrigin.tabGroupId } : {}),
    diagnostic: continuityNotice?.reason ?? session?.status.detail ?? 'Original Session state is not confirmed.'
  } : null

  async function refreshUnobserved(): Promise<void> {
    if (!unobservedIdentity || refreshing) return
    const scope = observationScope
    const current = () => observationActive.current && observationScopeRef.current === scope
    setRefreshing(true); setUnobservedReadError(null)
    try { await rereadUnobservedSession(unobservedIdentity, current) }
    catch (error) { if (current()) setUnobservedReadError(presentError(error)) }
    finally { if (observationActive.current) setRefreshing(false) }
  }

  const unobservedActionsAt = (origin = mailboxOrigin, displayId: string | null = null) => <>
    {storageWait ? <ServiceWindowNotice summary={{
      step: 'Waiting for storage',
      mode: 'Agent has not started. The original request and initial prompt are kept.',
      restore: 'Free storage to continue automatically.' + (unobservedReadError ? ' Latest check unavailable; see details.' : '')
    }} notice={{ kind: 'indeterminate', notice: {
      step: storageWait.message,
      mode: 'The Agent has not started. The original Session, request and initial prompt are retained.',
      restore: 'Free storage on this host. This original request will continue automatically.' +
        (unobservedReadError ? ` Latest read: ${unobservedReadError}` : '')
    } }} /> : null}
    {projectionPolicy.allowsRecovery && unobservedIdentity ? <>
    {!storageWait && (unobservedReadError || unobservedReference?.issue) ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
      step: unobservedReadError ?? unobservedReference!.issue!,
      mode: 'The original Region and drafts are retained. Current Session facts are not confirmed.',
      restore: 'Re-read this original owner. This action does not start a Run or send input.'
    } }} /> : null}
    {recoveryActionSource ? <SessionRecoveryActions source={recoveryActionSource} onTakeOver={takeOverAt(origin, displayId)} restoring={refreshing}
      workingLabel="Reading…" restoreLabel="Check original" restoreIcon="action.refresh" onRestore={() => void refreshUnobserved()} />
      : <button type="button" className="small-button" disabled={refreshing} onClick={() => void refreshUnobserved()}>
        <ThemeActionRefreshIcon size={12} /> {refreshing ? 'Reading…' : 'Check original identity'}
      </button>}
    </> : null}
  </>

  const unobservedActions = unobservedActionsAt()

  async function recover(trigger: 'manual' | 'startup' = 'manual'): Promise<void> {
    if (recovering) return
    setRecovering(true)
    try {
      if (recoverableFrontendNotice && session?.kind === 'agent') {
        const scope = JSON.stringify([session.control.hostId, session.id, session.control.run.runId, session.terminalFrontend?.frontendId])
        if (frontendRecoveryIntent.current?.scope !== scope) frontendRecoveryIntent.current = { scope, operationId: originalFrontendRecovery(session)?.operationId ?? mintObjectId() }
        await recoverSession(sessionId, frontendRecoveryIntent.current.operationId)
      } else await recoverSession(sessionId, undefined, { trigger })
    } catch (error) {
      useAppStore.getState().reportError(error, session?.kind === 'agent' ? { kind: 'indeterminate', subject: session.control,
        ...(frontendSurface ? { lifecycle: { step: 'resume', subject: session.control, lastProcessState: session.processState } as const } : {}) } : undefined)
    } finally { setRecovering(false) }
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
    const operationId = retainedOperationId ?? mintObjectId()
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

  // Core owns the durable replacement. Remount only reenters that original intent;
  // this automatic observer never authorizes continuing an uncertain creation.
  useEffect(() => {
    if (!session || session.kind !== 'terminal') return
    if (!missing || interruptionReason !== 'daemon_restart') return
    if (autoRecoveredRef.current === session.id) return
    autoRecoveredRef.current = session.id
    void recover('startup')
    // recover()/recovering are stable enough; we intentionally key only on the dead-session signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, session?.kind, missing, interruptionReason])

  const renderMessageActions = useConversationReactions(sessionId, observationVisible && !readOnly && surfaceKind === 'agent')

  const mailboxReading = {
    workspaceRoot: fileContext.workspaceRoot, homeDir: fileContext.homeDir,
    ...(fileContext.kind !== 'unconfirmed' && fileContext.kind !== 'unassigned' ? { openWorkspaceFile: openProjectFile } : {}),
    readPastedImage, openHttpLink: onProseLinkClick, describeSpeaker
  }

  const acceptedLaunch = pendingLaunch?.created && (!session || session.control.run.runId === pendingLaunch.created.run.runId)
    ? pendingLaunch.created : undefined
  const preSnapshotHost = session ? regionExecutionHost(session, configuredExecutionHost)
    : unobservedReference ? executionHostProjection(unobservedReference.source?.hostId, pendingLaunch?.request?.workspacePath ?? recoveryCandidate?.workspacePath, configuredExecutionHost)
      : pendingLaunch ? executionHostProjection(pendingLaunch.request?.hostId, pendingLaunch.request?.workspacePath, configuredExecutionHost)
      : retainedHistory?.state === 'retired' ? executionHostProjection(retainedHistory.hostId, retainedHistory.history?.workspacePath, configuredExecutionHost)
        : executionHostProjection(recoveryCandidate?.hostId, recoveryCandidate?.workspacePath, configuredExecutionHost)
  const sessionHeader = ({ name = agentInputIdentity ?? (session?.kind === 'terminal' ? session.label : surfaceKind === 'terminal' ? 'Terminal' : agentDisplayName({ userName,
    firstPrompt: pendingLaunch?.request?.prompt, fallbackLabel: recoveryCandidate?.label ?? nameMetadata?.label ?? 'Agent · name unconfirmed',
    providerLabel: connectingExecutor?.label ?? (nameMetadata ? agentProviderLabel(nameMetadata.providerId) : 'Agent') })),
    executorLabel = agentInputExecutor ?? connectingExecutor?.label ?? 'Executor unknown', origin = mailboxOrigin,
    portalTargetId = headerPortalTargetId, displayId = null, onHistory, resultReview }: {
    name?: string; executorLabel?: string; origin?: OpenHttpLinkOrigin; portalTargetId?: string | null
    displayId?: string | null; onHistory?: ((trigger?: HTMLButtonElement) => void) | undefined; resultReview?: ReactNode
  } = {}) =>
    <AgentRegionHeader name={name} executorLabel={surfaceKind === 'terminal' ? 'Shell' : executorLabel}
      sessionId={sessionId} sessionKind={surfaceKind} executionHost={preSnapshotHost}
      regionId={origin.regionId} readOnly={readOnly} portalTargetId={portalTargetId} onHistory={onHistory} onTakeOver={takeOverAt(origin, displayId)}
      onLearn={learnAt(origin, displayId)}
      currentConversationActions={currentConversationActions(origin)} resultReview={resultReview}
      onRefreshObservation={session?.kind === 'agent' && observationMounted ? () => void refresh(true) : undefined} refreshing={refreshing}
      nativeSession={session?.kind === 'agent' ? session : recoveryCandidate ? {
        id: recoveryCandidate.agentSessionId, ...projectNativeSourceFacts(recoveryCandidate),
        control: { kind: 'agent', hostId: recoveryCandidate.hostId, agentSessionId: recoveryCandidate.agentSessionId, run: recoveryCandidate.run }
      } : undefined} />
  const presentationHeader = (target: WorkbenchViewTarget, history = false) => {
    const displayId = workbenchSessionStageHostId(target, linkOrigin.regionId!)
    return sessionHeader({ origin: presentationOrigin(target), portalTargetId: target.headerPortalTargetId ?? null, displayId,
      onHistory: history && presentationHistory?.displayId !== displayId
        ? trigger => setPresentationHistory({ displayId, trigger: trigger ?? null }) : undefined })
  }
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
      }} actions={!readOnly && session ? <button type="button" className="small-button" disabled={refreshing}
        onClick={() => { void refresh() }}><ThemeActionRefreshIcon size={12} /> Check again</button> : null} />
    </div>
  )
  // Lifecycle, recovery and observation remain owned here. Each confirmed display
  // receives the same original status surface even before Activity can be rendered.
  const retainPresentations = (content: (target: WorkbenchViewTarget) => ReactNode, primary: ReactNode): ReactNode => <>
    {surfaceKind === 'agent' && renderPresentationFrame ? presentations.map(target => <SessionActivityPresentation
      key={JSON.stringify([activitySourceKey, target.hostId, target.reference!.displayWorkspaceId, target.reference!.groupId, target.reference!.tabId, linkOrigin.regionId])}
      target={target} regionId={linkOrigin.regionId!} sourceKey={activitySourceKey}
      header={presentationHeader(target)}
      takeoverSurface={takeoverAt(presentationOrigin(target), target.visible !== false, workbenchSessionStageHostId(target, linkOrigin.regionId!))}
      sessionId={sessionId} name={agentInputIdentity ?? userName ?? tabName ?? sessionId}
      executorLabel={agentInputExecutor ?? connectingExecutor?.label ?? 'Executor unknown'}
      executionHost={preSnapshotHost} eligible={false} recovery={content(target)}
      readOnly={readOnly} resourceOrigin={linkOrigin} renderFrame={renderPresentationFrame}
      selectRegion={() => onPresentationSelected?.(target)}
      {...(projectionPolicy.allowsRecovery && session?.kind === 'agent' ? { renderComposer: (pendingLayout: PendingDeliveryLayout) => <AgentSessionComposer pendingLayout={pendingLayout} reading={mailboxReading}
        mailboxOrigin={{ ...linkOrigin, workspaceId: target.reference!.displayWorkspaceId, tabGroupId: target.reference!.groupId, tabId: target.reference!.tabId }}
        onRevealMessage={(message, reference) => revealMailboxMessage(message, reference, target)} sessionId={session.id}
        visible={false} {...(tabName ? { tabName } : {})} /> } : {})} />) : null}
    {primary}
  </>
  if (!session && acceptedLaunch) {
    const acceptedSurface = <FullPageLoadingSurface scope="region" phase="parked"
        eyebrow="Original Session" title="Session created"
        detail="Creation is confirmed. Current process and input availability are not yet confirmed."
        actions={unobservedActions} supplement={launchNotice}
        details={{ summary: 'Original reference', content: <dl><dt>Session ID</dt><dd>{acceptedLaunch.agentSessionId}</dd></dl> }} />
    return retainPresentations(target => cloneElement(acceptedSurface, { actions: unobservedActionsAt(presentationOrigin(target), workbenchSessionStageHostId(target, linkOrigin.regionId!)) }), <section ref={surfaceRef} className="agent-surface" data-agent-surface-mode="unconfirmed">
      {sessionHeader()}
      {takeoverSurface}
      <div className="agent-body">{acceptedSurface}</div>
      {!readOnly ? <AgentSessionComposer pendingLayout={pendingLayout} reading={mailboxReading} key={sessionId} sessionId={sessionId} visible={visible} disabled {...(tabName ? { tabName } : {})} /> : null}
    </section>)
  }

  // Retirement is Core's terminal fact, not a missing Runtime observation. Its native history
  // needs only a reading reference; never fabricate a Run or an active Agent to make it readable.
  if (!session && retainedHistory?.state === 'retired' && terminalThemeId) {
    const reference = { hostId: retainedHistory.hostId, agentSessionId: retainedHistory.agentSessionId }
    const metadata = retainedHistory.history
    const label = userName ?? tabName ?? nameMetadata?.label ?? metadata?.executorId ?? 'Agent · name unconfirmed'
    const providerLabel = metadata ? agentProviderLabel(metadata.providerId) : null
    const executorLabel = metadata ? connectingExecutor?.label ?? metadata.executorId : null
    const identityLabel = providerLabel && executorLabel && providerLabel.toLowerCase() !== executorLabel.toLowerCase()
      ? `${providerLabel} · ${executorLabel}` : providerLabel
    const resumeActionAt = (origin = mailboxOrigin, displayId: string | null = null) => projectionPolicy.allowsRecovery && recoveryActionSource ? <SessionRecoveryActions source={recoveryActionSource} onTakeOver={takeOverAt(origin, displayId)}
      restoring={recovering} restoreIcon={continuationUnconfirmed ? 'action.refresh' : 'action.resume-session'} workingLabel={continuationUnconfirmed ? 'Checking…' : 'Restoring…'} restoreLabel={continuationUnconfirmed ? 'Check original restore' : 'Restore original'} onRestore={() => void reopenRetained()} /> : null
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
    const retainedConversation = <ActivityView sessionId={sessionId} executionHostId={reference.hostId} capability="complete-events"
          conversationReading={{ reference, identity: JSON.stringify([reference.hostId, reference.agentSessionId]),
            enabled: visible && !parked, opened: true, readCaptured: true }}
          renderRecordActions={renderConversationLandmarkAction}
          renderReadingTools={(active, revealLoaded) => <ConversationLandmarkList reference={reference} active={active} reveal={revealLoaded}/>}
          readingAction={resumeActionAt()} readingNotice={reopenNotice ?? <div className="activity-feed__read-notice" role="status">
            {metadata ? `${identityLabel}. This Session is closed; its original conversation remains readable.`
              : 'Core confirmed this Session was closed. Its saved identity is retained.'}</div>}
          workspaceRoot={metadata?.workspacePath ?? ''} homeDir={fileContext.homeDir}
          readPastedImage={readPastedImage} readHistoryResource={readHistoryResource} openWorkspaceFile={openWorkspaceFile}
          openHttpLink={onProseLinkClick} describeSpeaker={describeSpeaker} />
    return retainPresentations(target => cloneElement(retainedConversation, { readingAction: resumeActionAt(presentationOrigin(target), workbenchSessionStageHostId(target, linkOrigin.regionId!)), conversationReading: {
      ...retainedConversation.props.conversationReading, enabled: target.visible !== false && !parked
    } }), <section ref={surfaceRef} className="agent-surface" data-agent-surface-mode="retained-history">
      {sessionHeader({ name: label, executorLabel: executorLabel ?? providerLabel ?? 'Executor unknown' })}
      {takeoverSurface}
      <div className="agent-body" data-observation-surface="workflow"><div className="agent-terminal-stage">
        {retainedConversation}

      </div></div>
    </section>)
  }

  // A launching Region exists before Core returns its Session snapshot. Keep that handoff
  // neutral; interrupted and exited Sessions use the explicit recovery banners below.
  if (!session || !terminalThemeId) {
    const connectingSurface = <SessionConnectingSurface key={`connecting:${sessionId}`}
          phase={pendingLaunch ? 'launch' : recoveryCandidate && !unobservedIdentity ? 'restore' : 'connect'}
          unknownTerminalCreation={!session && pendingTerminal}
          surfaceKind={surfaceKind}
          request={pendingLaunch?.request}
          executor={connectingExecutor}
          appearance={connectingAppearance}
          session={{ hostId: executionHostId ?? '', agentSessionId: sessionId }}
          actions={unobservedActions}
          visible={visible && !parked}
        />
    return retainPresentations(target => cloneElement(connectingSurface, { visible: false, actions: unobservedActionsAt(presentationOrigin(target), workbenchSessionStageHostId(target, linkOrigin.regionId!)) }),
      <section ref={surfaceRef} className="agent-surface" data-agent-surface-mode="connecting">
          {sessionHeader()}
          {takeoverSurface}
          {connectingSurface}
        {surfaceKind === 'agent' && !pendingLaunch && historyCatalogue.error ? <ServiceWindowNotice notice={{
          kind: 'indeterminate', notice: { step: `Retained history metadata could not be read: ${historyCatalogue.error}`,
            mode: 'The original Region and Session reference remain visible. Its current state is unconfirmed.',
            restore: 'Check again to read the same Session identity; no Agent will be started.' }
        }} actions={<button type="button" className="small-button" disabled={historyCatalogue.loading}
          onClick={historyCatalogue.refresh}><ThemeActionRefreshIcon size={12} /> Check again</button>} /> : null}
        {!readOnly && surfaceKind === 'agent' ? <AgentSessionComposer pendingLayout={pendingLayout} reading={mailboxReading} key={sessionId} sessionId={sessionId} visible={visible} disabled {...(tabName ? { tabName } : {})} /> : null}
      </section>
    )
  }

  const noun = session.kind === 'agent' ? 'Agent' : 'Terminal'
  // 失联分两类，标题也必须分两类：还在重连 vs 已经放弃。判据取自 detail（连接投影写下的那一对
  // SSOT 常量），而不是另起一个状态位——状态位就是 `disconnected`，两类共用它。只认一个标题的话，
  // 抖动预算用尽后的终局会顶着「Reconnecting…」的皮，用户永远不知道该自己动手了。
  const gaveUpReconnecting =
    disconnected && session.status.detail === CONNECTION_UNRECOVERABLE_DETAIL
  const exitNotice = sessionExitPresentation(session)
  const recoveryTitle = exitNotice?.title ?? recoverableFrontendNotice?.title ?? (continuityNotice
      ? continuityNotice.title
      : gaveUpReconnecting
        ? `Can’t reach this host`
        : disconnected
          ? 'Remote terminal disconnected'
          : exited
            ? `${noun} process exited`
            : `${noun} session unavailable`)
  const recoveryDetail = exitNotice?.detail ?? recoverableFrontendNotice?.detail ?? continuityNotice?.reason ??
    humanizeDetail(session.interruptionReason, session.status.detail, exited || missing, session.status.exitReason)

  async function refreshOriginal(): Promise<void> {
    if (refreshing) return
    const source = activitySourceKey
    setRefreshing(true); setOriginalReadError(null)
    try { await refreshSession(sessionId) }
    catch (error) {
      if (currentSourceKey.current === source) setOriginalReadError({ source, message: presentError(error) })
    } finally { setRefreshing(false) }
  }

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
  const agentRecoveryControlsAt = (origin = mailboxOrigin, displayId: string | null = null) => !projectionPolicy.allowsRecovery ? (
    <span>Open this Session in its Project to restore it.</span>
  ) : recoverableFrontendNotice ? (
    <button type="button" className={frontendSurface ? 'primary-button' : 'small-button'} disabled={recovering || refreshing} onClick={() => void recover()}>
      <ThemeActionResumeSessionIcon size={12} /> {recovering ? 'Checking…' : recoverableFrontendNotice.actionLabel ?? 'Resume'}
    </button>
  ) : recoveryActionSource ? <SessionRecoveryActions source={recoveryActionSource} onTakeOver={takeOverAt(origin, displayId)} restoring={recovering || refreshing}
    workingLabel={refreshing ? 'Re-reading…' : 'Restoring…'}
    restoreIcon={continuityNotice && continuityRefreshEnabled(continuityNotice) ? 'action.refresh' : continuityNotice?.remedy.kind === 'wait' ? 'status.waiting' : 'action.resume-session'}
    restoreDisabled={continuityNotice ? !(continuityRetryEnabled(continuityNotice) || continuityRefreshEnabled(continuityNotice)) : false}
    restoreLabel={continuityNotice && continuityRefreshEnabled(continuityNotice) ? 'Re-read original' : continuityNotice?.remedy.kind === 'wait' ? 'Waiting for operation' : 'Restore original'}
    onRestore={() => { if (continuityNotice && continuityRefreshEnabled(continuityNotice)) void refreshOriginal(); else void recover() }} /> : (
    <button type="button" className="small-button" disabled={recovering} onClick={() => void recover()}>
      <ThemeActionResumeSessionIcon size={12} /> {recovering ? 'Resuming…' : 'Resume'}
    </button>
  )
  const originalReadNotice = originalReadError?.source === activitySourceKey ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
    step: 'Original Session recheck failed', mode: originalReadError.message,
    restore: 'Re-read original to check again. Your Session and draft are kept.'
  } }} /> : null
  const identityNotice = (exitNotice || frontendSurface) && continuityNotice ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
    step: continuityNotice.title, mode: continuityNotice.reason,
    restore: continuityNotice.remedy.kind === 'refresh' ? 'Re-read original checks again without restarting the Agent or resending messages.' : 'Recovery remains a separate explicit action.'
  } }} /> : null
  const frontendObservationCause = originalReadError?.source === activitySourceKey ? originalReadError.message
    : session.kind === 'agent' ? session.terminalFrontend?.message ?? frontendNotice?.detail : frontendNotice?.detail
  const frontendObservationNotice = frontendNotice?.kind === 'unknown' ? <ServiceWindowNotice
    title={frontendNotice.title}
    disclosure={{ scope: JSON.stringify(['frontend-observation', session.control.hostId, session.id, session.control.run.runId]),
      id: 'frontend-observation', cause: frontendObservationCause ?? frontendNotice.detail, visible }}
    notice={{ kind: 'indeterminate', notice: {
      step: frontendObservationCause ?? frontendNotice.title,
      mode: 'The last Run observation is running. Existing terminal and input paths are retained; the frontend connection state is unknown.',
      restore: frontendNotice.detail
    } }}
    actions={projectionPolicy.allowsRecovery ? <button type="button" className="small-button" disabled={refreshing}
      onClick={() => void refreshOriginal()}><ThemeActionRefreshIcon size={12} /> {refreshing ? 'Checking…' : 'Refresh observation'}</button> : undefined}
  /> : null
  const agentRecoveryActionAt = (origin = mailboxOrigin, displayId: string | null = null) => <>{agentRecoveryControlsAt(origin, displayId)}{needsSessionSurface ? <button type="button" className="small-button"
    onClick={() => { setRetainedOutputKey(readingRetainedOutput ? null : activitySourceKey); setHistoryOpen(false); useAppStore.getState().setViewMode(sessionId, 'terminal') }}>
    {readingRetainedOutput ? 'Back to recovery' : 'Read original output'}
  </button> : null}{recoverableFrontendNotice?.actionDetail ? <p className="session-startup-action-detail">{recoverableFrontendNotice.actionDetail}</p> : null}</>
  const agentRecoveryAction = agentRecoveryActionAt()
  const coreRestorePresentation = session.kind === 'agent' ? agentContinuityPresentation(session) : null
  const frontendOperation = session.kind === 'agent' && frontendSurface
    ? session.continuityOperations?.[frontendRecoveryIntent.current?.operationId ?? ''] ?? session.continuity : undefined
  const frontendRecovery = frontendOperation?.agentSessionId === session.id &&
    (frontendOperation.newRun ?? frontendOperation.previousRun).runId === session.control.run.runId ? frontendOperation : undefined
  const recoveryOperation = session.kind === 'agent' && exited ? currentRunRecoveryOperation(session) : frontendRecovery
  const recoveryJoin = session.kind === 'agent' && recoveryOperation ? currentContinuitySupervision(session) : null
  const recoverySupervision = recoveryJoin?.attempt.operationId === recoveryOperation?.operationId ? recoveryJoin?.root.supervision : undefined
  const restoreFailed = continuityNotice || session.status.state === 'error' && coreRestorePresentation?.kind !== 'unconfirmed'
  const restorePresentation = coreRestorePresentation?.kind === 'restoring' ? { ...coreRestorePresentation, phase: 'recovering' as const } : pendingAgentRestore ? {
    phase: recovering ? 'recovering' as const : restoreFailed ? 'failed' as const : 'parked' as const,
    title: recovering ? 'Restoring your session' : exitNotice?.title ?? (continuityNotice ? continuityNotice.title
      : restoreFailed ? recoveryTitle
        : coreRestorePresentation?.title ?? (exited ? 'Agent process exited' : 'Session state unconfirmed')),
    detail: exitNotice?.detail ?? continuityNotice?.reason ?? (restoreFailed
      ? humanizeDetail(session.interruptionReason, session.status.detail, exited, session.status.exitReason)
      : coreRestorePresentation?.detail ?? (exited && !session.runUnobserved
        ? humanizeDetail(session.interruptionReason, session.status.detail, exited, session.status.exitReason)
        : 'The saved Session is retained. Its process state is not yet confirmed.'))
  } : null
  const hasAgentComposer = projectionPolicy.allowsRecovery && surfaceKind === 'agent' && session.kind === 'agent'
  const activityShown = historyOpen || inlineHistory || viewMode !== 'terminal' && !pendingAgentRestore
  const activityRevealPending = revealRequest?.displayId === null
  const conversationReading = session.kind === 'agent' ? {
    reference: session.control, identity: activitySourceKey, nativeSourceFacts, enabled: visible && !parked && (activityShown || activityRevealPending),
    consumer: { runId: session.control.run.runId, ...(linkOrigin.regionId ? { regionId: linkOrigin.regionId } : {}),
      visible, parked, activityShown, viewMode },
    opened: historyOpen || inlineHistory,
    ...(!inlineHistory && historyOpen ? { onClose: closeHistory, returnLabel: pendingAgentRestore ? 'Session' : viewMode === 'terminal' ? 'Terminal' : 'Activity' } : {})
  } : undefined
  const activityProps: ComponentProps<typeof ActivityView> = {
    sessionId: session.id, nativeHistoryPage, nativeContextItems,
    ...(session.kind === 'agent' ? { executionHostId: session.control.hostId, ...(conversationReading ? { conversationReading } : {}) } : {}),
    ...(restorePresentation ? { readingNotice: <div className="activity-feed__read-notice" role="status"><strong>{restorePresentation.title}</strong><span>{restorePresentation.detail}</span></div> } : {}),
    ...(!restorePresentation && recoverableFrontendNotice ? { readingNotice: <div className="activity-feed__read-notice" role="status"><strong>{recoverableFrontendNotice.title}</strong><span>{recoverableFrontendNotice.detail}</span></div> } : {}),
    ...(pendingAgentRestore || recoverableFrontendNotice ? { readingAction: agentRecoveryAction } : {}),
    capability: session.kind === 'agent' ? session.capabilities.timeline : 'unavailable',
    displayState: session.status.state, activitySemantic: session.kind === 'agent' ? observeAgentSession(session, Date.now()).semantic : 'unsupported',
    workspaceRoot: fileContext.workspaceRoot, homeDir: fileContext.homeDir,
    fileReferenceNotice,
    ...(fileContext.kind !== 'unconfirmed' && fileContext.kind !== 'unassigned' ? { openWorkspaceFile: openProjectFile } : {}),
    readPastedImage, readHistoryResource, openHttpLink: onProseLinkClick,
    ...(hasAgentComposer ? { onSelectAnnotation: selectAnnotation } : {}), describeSpeaker,
    moteConversation: moteOwner !== null, renderMessageActions,
    ...(session.kind === 'agent' ? { renderRecordActions: renderConversationLandmarkAction,
      renderReadingTools: (active: boolean) => <ConversationLandmarkList reference={session.control} active={active} reveal={reference => revealConversationItem(reference)}/> } : {}),
    ...(hasAgentComposer ? { questionReplyRoute: session.capabilities.asyncQuestionReply,
      questionReplyTarget: !nativeSourceUnconfirmed(session) && session.nativeHandle?.kind === 'provider' ? {
        source: { providerId: session.nativeHandle.providerId, nativeSessionId: session.nativeHandle.sessionId }, run: session.control.run
      } : undefined,
      questionDraftNotice: questionSaveWarning ? `Draft save unconfirmed. Your latest edits are kept in this running app; copy them before closing. ${questionSaveWarning}` : undefined,
      questionReplyContext: JSON.stringify([session.control.hostId, session.id, session.control.run.runId]),
      onOpenQuestionTerminal: openTerminal,
      questionReplyDraft: target => questionDrafts?.[questionReplyKey(sessionId, target)],
      onQuestionReply: input => sendConversationQuestionReply(session.control, input),
      onQuestionDraftChange: (target, answers) => editConversationQuestionDraft(session.control, target, answers),
      questionReplyState: target => desktopQuestionReplyState(questionReplies, sessionId, target) } : {})
  }
  // Covering/hiding a location freezes that location's already-presented elements.
  if (session.kind === 'agent' && visible && (activityShown || activityRevealPending)) {
    activityLifetime.current.opened = true
    activityContent.current = <ActivityView {...activityProps} revealRequest={revealRequest?.displayId === null ? revealRequest : null} />
  }
  if (activityContent.current) activityContent.current = retainActivityControls(activityContent.current, {
    ...(conversationReading ? { conversationReading } : {}), activitySemantic: activityProps.activitySemantic ?? 'unknown',
    revealRequest: revealRequest?.displayId === null ? revealRequest : null
  })
  const presentedActivity = activityContent.current
  const resultReview = session.kind === 'agent'
    ? <SessionResultReview sessionId={session.id} items={timeline} origin={linkOrigin} visible={visible} surfaceAnchor={resultSurfaceAnchor} />
    : null
  const frontendDiagnostic = frontendSurface && frontendNotice.diagnostic ? <div className="session-frontend-diagnostic">
    <span>{frontendNotice.kind === 'initialization' ? 'Startup diagnostic' : 'Terminal diagnostic'}</span><pre>{frontendNotice.diagnostic}</pre>
  </div> : null

  const restoreSurface = <FullPageLoadingSurface scope="region" phase={frontendSurface ? frontendNotice.phase ?? 'parked' : restorePresentation?.phase ?? 'parked'} eyebrow="Session retained"
                {...(frontendSurface && frontendNotice.kind === 'detached' && frontendNotice.phase === 'failed' ? { className: 'session-frontend-exit' } : {})}
                visible={visible && !parked && !historyOpen}
                title={frontendSurface ? frontendNotice.title : restorePresentation?.title ?? 'Session state unconfirmed'}
                description={frontendSurface ? frontendNotice.description : undefined}
                detail={frontendSurface ? frontendNotice.surfaceDetail ?? frontendNotice.detail : restorePresentation?.detail ?? 'The saved Session is retained. Its process state is not yet confirmed.'}
                actions={!historyOpen ? agentRecoveryAction : null}
                supplement={<>{identityNotice}{originalReadNotice}{session.kind === 'agent' && !frontendSurface ? <SessionRecap session={session.control} visible={visible && !parked && !historyOpen} context /> : null}</>}
                details={{ summary: frontendSurface ? frontendNotice.kind === 'initialization' ? 'Session and startup details' : 'Session and failure details' : 'Retained session', content: <>{frontendDiagnostic}<dl>
                  <dt>Session</dt><dd>{session.label}</dd>
                  <dt>Session ID</dt><dd>{session.id}</dd>
                  <dt>Retained Run</dt><dd>{session.control.run.runId}</dd>
                  {frontendSurface && session.kind === 'agent' ? <>{session.terminalFrontend?.exitCode !== undefined ? <><dt>Terminal exit code</dt><dd>{session.terminalFrontend.exitCode}</dd></> : null}
                    {session.terminalFrontend?.initialization ? <><dt>Initialization</dt><dd>{session.terminalFrontend.initialization.phase}</dd>
                    <dt>Startup operation</dt><dd>{session.terminalFrontend.initialization.lifecycleOperationId}</dd>
                    {session.terminalFrontend.initialization.failure ? <><dt>Startup step</dt><dd>{session.terminalFrontend.initialization.failure.step}</dd>
                      {session.terminalFrontend.initialization.failure.code !== undefined ? <><dt>Diagnostic code</dt><dd>{session.terminalFrontend.initialization.failure.code}</dd></> : null}</> : null}</> : null}
                    <dt>Backend state</dt><dd>{session.terminalFrontend?.backendState}</dd>
                    <dt>Native conversation</dt><dd>{session.terminalFrontend?.initialization?.native.state === 'not-created' ? 'Not created' : session.terminalFrontend?.initialization?.native.state === 'confirmed' ? session.terminalFrontend.initialization.native.sessionId : session.nativeHandle?.kind === 'provider' ? session.nativeHandle.sessionId : 'Unknown'}</dd></> : null}
                  {recoveryOperation ? <><dt>Recovery operation</dt><dd>{recoveryOperation.operationId}</dd>
                    <dt>Recovery status</dt><dd>{recoveryOperation.kind} · {recoveryOperation.reason}</dd>
                    {recoverySupervision ? <><dt>Recovery phase</dt><dd>{recoverySupervision.phase}</dd>
                      <dt>Recovery attempts</dt><dd>{recoverySupervision.attemptCount} of {recoverySupervision.attemptLimit}</dd></> : null}
                    <dt>Recovery details</dt><dd>{recoveryOperation.error?.trim() || 'The recovery attempt did not report a specific cause. Read the original output for details.'}</dd></> : null}
                </dl></> }} />

  return (
    <>
    {session.kind === 'agent' && renderPresentationFrame ? presentations.map(target => <SessionActivityPresentation
      key={JSON.stringify([activitySourceKey, target.hostId, target.reference!.displayWorkspaceId, target.reference!.groupId, target.reference!.tabId, linkOrigin.regionId])}
      target={target} regionId={linkOrigin.regionId!} sourceKey={activitySourceKey}
      header={presentationHeader(target, true)}
      historyOpen={presentationHistory?.displayId === workbenchSessionStageHostId(target, linkOrigin.regionId!)}
      historyReturnTrigger={presentationHistory?.trigger} onCloseHistory={() => setPresentationHistory(null)}
      historyReturnLabel={viewMode === 'terminal' ? 'Session' : 'Activity'}
      takeoverSurface={takeoverAt(presentationOrigin(target), target.visible !== false, workbenchSessionStageHostId(target, linkOrigin.regionId!))}
      sessionId={session.id} name={agentInputIdentity!} executorLabel={agentInputExecutor!}
      executionHost={regionExecutionHost(session, configuredExecutionHost)}
      activity={{ ...activityProps, renderReadingTools: active => <ConversationLandmarkList reference={session.control} active={active} reveal={reference => revealConversationItem(reference, target)}/>, revealRequest: revealRequest?.displayId === workbenchSessionStageHostId(target, linkOrigin.regionId!) ? revealRequest : null }} eligible={presentationHistory?.displayId === workbenchSessionStageHostId(target, linkOrigin.regionId!) || viewMode !== 'terminal' && !pendingAgentRestore}
      recovery={pendingAgentRestore ? cloneElement(restoreSurface, { visible: target.visible !== false && !parked, supplement: null, actions: agentRecoveryActionAt(presentationOrigin(target), workbenchSessionStageHostId(target, linkOrigin.regionId!)) }) : undefined}
      readOnly={readOnly} resourceOrigin={linkOrigin}
      {...(hasAgentComposer ? { onAnnotate: annotateMessage } : {})}
      renderFrame={renderPresentationFrame} selectRegion={() => onPresentationSelected?.(target)}
      {...(hasAgentComposer ? { renderComposer: (pendingLayout: PendingDeliveryLayout) => <AgentSessionComposer pendingLayout={pendingLayout} reading={mailboxReading} mailboxOrigin={{ ...linkOrigin, workspaceId: target.reference!.displayWorkspaceId, tabGroupId: target.reference!.groupId, tabId: target.reference!.tabId }} onRevealMessage={(message, reference) => revealMailboxMessage(message, reference, target)} sessionId={session.id}
        visible={target.visible !== false && viewMode !== 'terminal' && !pendingAgentRestore} {...(tabName ? { tabName } : {})} /> } : {})}
    />) : null}
    <section
      ref={surfaceRef}
      className="agent-surface"
      data-agent-surface-mode={session.kind === 'agent' ? viewMode : 'terminal'}
    >
      {sessionHeader({
        onHistory: session.kind === 'agent' && !historyOpen && !inlineHistory ? () => openHistory() : undefined,
        resultReview: session.kind === 'agent' && !hasAgentComposer ? resultReview : null
      })}
      {takeoverSurface}
      {launchNotice}
      {session.kind === 'agent' ? <ContinuitySupervisionNotice key={activitySourceKey} session={session} readOnly={!projectionPolicy.allowsRecovery} /> : null}
      {session.kind === 'agent' ? <AgentLifecycleFeedback owner={{ subject: session.control }} visible={visible}
        busy={recovering || refreshing} retry={() => void recover()}
        {...(observationMounted ? { refreshObservation: () => void refresh(true) } : {})} /> : null}
      {frontendObservationNotice}
      <div ref={bodyRef} className="agent-body" data-pending-interaction={session.kind === 'agent' && session.pendingInteraction ? '' : undefined} style={{ anchorName: resultSurfaceAnchor }} data-observation-surface={session.kind === 'agent' && activityShown ? 'workflow' : undefined}>
        <div className="agent-terminal-stage">
          {session.kind === 'terminal' || viewMode === 'terminal' || needsSessionSurface || terminalLifetime.current.opened ? (
            <div hidden={session.kind === 'agent' && (historyOpen || inlineHistory || viewMode !== 'terminal' && !pendingAgentRestore)}
              ref={element => { if (element && !pendingAgentRestore && (!frontendSurface || readingRetainedOutput) && !parked && (session.kind === 'terminal' || viewMode === 'terminal')) terminalLifetime.current.opened = true }}
              inert={historyOpen || session.kind === 'agent' && viewMode !== 'terminal' && !pendingAgentRestore} style={{ height: '100%' }}>
            {frontendSurface && !readingRetainedOutput ? restoreSurface : null}
            {pendingAgentRestore && !readingRetainedOutput ? (inlineHistory ? null :
              restoreSurface
            ) : parked ? (
              <FullPageLoadingSurface scope="region" phase="parked" eyebrow="View retained"
                title="Terminal parked"
                detail="Switch back to this tab to restore its terminal view." />
            ) : (
              <div hidden={frontendSurface && !readingRetainedOutput} style={{ height: '100%' }}>
              {!frontendSurface || readingRetainedOutput || terminalLifetime.current.opened ? <TerminalView
                session={session}
                autoFocus={!frontendSurface && !readingRetainedOutput && autoFocus && visible && !historyOpen && viewMode === 'terminal'}
                themeId={terminalThemeId}
                fontSize={terminalFontSize}
                interactiveResize={!readingRetainedOutput && projectionPolicy.interactiveResize && interactiveResize}
                visible={visible && !historyOpen && viewMode === 'terminal' && (!frontendSurface || readingRetainedOutput)}
                readOnly={frontendSurface || readingRetainedOutput || !projectionPolicy.acceptsInput}
                linkOrigin={linkOrigin}
                onObservationRefresh={bindObservationRefresh}
              /> : null}
              </div>
            )
            }</div>
          ) : null}
          {(disconnected || missing || exited || recoverableFrontendNotice) && (!needsSessionSurface || readingRetainedOutput) ? (
            <div className={sessionRecoveryClassName(sessionRecoveryState({ disconnected: disconnected || Boolean(frontendNotice), exited, failed: !frontendNotice && session.status.state === 'error' }))} role="status" aria-live="polite">
              <span className="terminal-recovery__icon">
                {refreshing || recovering ? <ThemeStatusLoadingIcon animation="spin" size={16} /> : !frontendNotice && session.status.state === 'error' ? <ThemeStatusWarningIcon size={16} /> : disconnected || missing || frontendNotice ? <ThemeStatusHostUnavailableIcon size={16} /> : <ThemeActionStopIcon size={16} />}
              </span>
              <div>
                <strong>{recoveryTitle}</strong>
                <span>{recoveryDetail}</span>
                {identityNotice}{originalReadNotice}
              </div>
              <div className={`terminal-recovery__actions${frontendSurface && frontendNotice.kind === 'detached' && frontendNotice.phase === 'failed' ? ' session-frontend-exit__actions' : ''}`}>
                {!projectionPolicy.allowsRecovery ? (
                  <span className="terminal-recovery__readonly">Open this Session in its Project to recover it.</span>
                ) : session.kind === 'terminal' ? (
                  disconnected ? (
                    <button type="button" className="small-button" disabled={refreshing} onClick={() => void refresh()}>
                      <ThemeActionRefreshIcon size={12} /> {refreshing ? 'Checking…' : 'Check again'}
                    </button>
                  ) : (
                    // The PTY is gone for good — relaunch a fresh terminal in the same cwd.
                    <button type="button" className="small-button" disabled={recovering} onClick={() => void recover()}>
                      <ThemeActionRestartTerminalIcon size={12} /> {recovering ? 'Restarting…' : 'Restart terminal'}
                    </button>
                  )
                ) : agentRecoveryAction}
              </div>
            </div>
          ) : null}
          {session.kind === 'agent' && (activityLifetime.current.opened || activityShown) ? (
            <div hidden={!activityShown} inert={!activityShown} style={{ height: '100%' }}>
              {presentedActivity}
            </div>
          ) : null}
        </div>
        {session.kind === 'agent' && session.pendingInteraction ? (
          <div ref={interactionSourceRef} className="agent-interaction-source">
          <AgentInteractionCard surfaceRef={interactionRef}
            key={JSON.stringify([session.hostId, session.id, session.control.run.runId, session.pendingInteraction.id])}
            request={session.pendingInteraction}
            readOnly={!hasAgentComposer}
            responseUnavailableReason={session.interactionResponseUnavailableReason}
            sourceNotice={nativeSourceUnconfirmed(session) ? 'This request belongs to the retained native source, which is pending confirmation.' : undefined}
            {...(hasAgentComposer ? { onOpenTerminal: openTerminal } : {})}
            // A pending request outlives the process that asked it, so the card must go inert on the
            // same terms as the composer below it — otherwise a dead Run still shows live buttons and
            // answering it fails on a Run that can no longer accept input.
            disabled={!visible || session.processState !== 'running' || session.status.state === 'disconnected' || Boolean(session.pendingInteraction.evidence.run && session.pendingInteraction.evidence.run.runId !== session.control.run.runId)}
            onInspect={async operationId => await useAppStore.getState().inspectInteraction(session.id, operationId)}
            onRespond={async (response, intent) => await respondInteraction(session.id, response, intent)}
          />
          </div>
          ) : null}
      </div>
      <OpenDestinationPopover
        request={linkRequest}
        canSplit={canSplit}
        onDismiss={linkOpening.dismiss}
        onSelect={onProseLinkSelect}
      />
      <ConversationAnnotationNote ref={annotationNoteRef} sessionId={sessionId} regionRef={surfaceRef}
        origin={mailboxOrigin}
        active={visible && hasAgentComposer && (historyOpen || inlineHistory || viewMode === 'activity')}
        {...(hasAgentComposer ? { onAnnotate: annotateMessage } : {})} />
      {hasAgentComposer && session.kind === 'agent' ? (
        <div
          className="agent-input-stack"
          data-input-surface={session.kind === 'agent' && viewMode === 'terminal' ? 'terminal' : 'activity'}
          aria-label={viewMode === 'terminal' ? 'Agent input channel' : undefined}
        >
          <AgentSessionComposer pendingLayout={pendingLayout} reading={mailboxReading} mailboxOrigin={mailboxOrigin} onRevealMessage={revealMailboxMessage} onOpenTerminal={openTerminal} key={sessionId} sessionId={session.id} resultReview={(onNavigate) => <SessionResultReviewContent showStatus={false} sessionId={session.id} items={timeline} origin={linkOrigin} onNavigate={onNavigate} />} visible={visible} {...(tabName ? { tabName } : {})} />
        </div>
      ) : null}
    </section>
    </>
  )
}
