import { useWorkbenchBrowserPresentation } from '../lib/workbench-presentation'
import { MoteWorkfaceContext } from '../lib/mote-workface'
import { useMoteDialogueView } from '../lib/mote-dialogue-view'
import { moteInputSource } from '../lib/mote-input-source'
import type { PendingDeliveryLayout } from '../lib/pending-delivery-layout'
import { useWorkbenchWindowDocument } from '../lib/workbench-document'
import { useObservedAppStore, useObservedConsumerCommit } from '../lib/use-observed-app-store'
import { reportMessageDeliveryDiagnostics } from '../lib/message-delivery-diagnostics'
import { scratchTopicsForConfig } from '../lib/scratch-topic-snapshots'
import { PosturePicker } from './PosturePicker'
import { createFirstPromptSelector, createSessionViewModeSelector, sessionPresentationById } from '../lib/session-presentation'
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { ComposerInsertionHandle } from '@agentmux/client-ui/composer-insertion'
import { AgentContextUsage } from './AgentContextUsage'
import { AgentComposerTools } from './AgentComposerTools'
import type { ComposerShortcut, SessionSnapshot } from '../../../shared/contracts'
import { workspaceOwnsSessionPath } from '@agentmux/host/mote-model'
import { sessionResourceContext } from '../lib/session-resource-context'
import { api } from '../lib/api'
import { useComposerAttachments } from '../lib/use-composer-attachments'
import { ComposerFileReferences } from './ComposerFileReferences'
import { expandComposerInput, expandSemanticReferences, type ComposerSemanticReference } from '@agentmux/client-ui/composer-semantic-reference'
import { useComposerCandidates, skillComposerSuggestion } from '../lib/use-composer-candidates'
import { composerSubmitMode, SEND_AFTER_REQUEST_ENDS } from '../lib/composer-submit-mode'
import { interactionNativeComposerBinding } from '../lib/interaction-native-composer-binding'
import {
  caretAtFirstLine,
  caretAtLastLine
} from '../lib/composer-history'
import { ComposerResubmitGuard } from '../lib/composer-resubmit-guard'
import { useAppStore, agentSteerCanEdit, agentSteerExecution, type AgentSteerQueueEntry } from '../store'
import { steerEntryTargetsRun, steerEntryWakesItself, steerQueueCanEverDrain } from '../lib/agent-steer-queue-drain'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { AgentComposer, type AgentComposerProps } from '@agentmux/client-ui/components/AgentComposer'
import { ComposerSource, type ComposerConnection } from '@agentmux/client-ui/components/ComposerHost'
import { moteComposerSessionKey } from './MoteComposer'
import { useLauncherState } from '../lib/launcher-state'
import { AgentIdentity } from './AgentIdentity'
import { agentProviderLabel } from '@agentmux/client-ui/components/AgentProviderIcon'
import { agentDisplayName } from '../lib/workbench-tabs'
import { ComposerFeedback, useComposerFeedback } from './ComposerFeedback'
import { sessionServiceNotices } from '../lib/session-service-notices'
import { useRunService } from '../lib/run-service-projection'
import { SessionMailbox } from './SessionMailbox'
import { useComposerInputHistory } from '../lib/use-composer-input-history'
import { confirmedSteerDelivery } from '../lib/steer-queue-delivery'
import type { ConversationReadingProps } from '@agentmux/client-ui/components/ConversationMessage'
import type { OpenHttpLinkOrigin } from '../lib/open-destination'
import type { RevealMailboxMessage } from '../lib/mailbox-message-navigation'
import { useServiceNotices, type ServiceNoticeItem } from '../lib/use-service-notices'

export type AgentComposerAvailability = {
  disabled: boolean
  placeholder: string
}

/** One shared identity for "no queue", so the selector returns a stable reference when empty. */
const EMPTY_QUEUE: readonly AgentSteerQueueEntry[] = Object.freeze([])

// The resubmit guard survives a Composer remount within the same application run.
// Drafts remain owned by the store; transient operation feedback stays with the mounted Composer.
const lastSubmitBySession = new ComposerResubmitGuard()

// The mailbox retains this layout across Composer renders. Its methods need only
// the supplied layout and the original rollover node, not the Composer's Session.
function rolloverDeliveryLayout(pendingLayout: PendingDeliveryLayout | undefined, rolloverSurface: RefObject<HTMLDetailsElement | null>): PendingDeliveryLayout | undefined {
  return pendingLayout ? {
    ...pendingLayout,
    readOverlapTop(popup) {
      const original = pendingLayout.readOverlapTop(popup), surface = rolloverSurface.current
      if (!surface?.isConnected || surface.closest('[hidden], [inert]')) return original
      const rect = surface.getBoundingClientRect()
      return popup.left < rect.right && popup.right > rect.left && popup.top < rect.bottom && popup.bottom > rect.top
        ? Math.min(original ?? rect.top, rect.top) : original
    },
    subscribe(onChange) {
      const stop = pendingLayout.subscribe(onChange), resize = new ResizeObserver(onChange)
      if (rolloverSurface.current) resize.observe(rolloverSurface.current)
      return () => { stop(); resize.disconnect() }
    }
  } : undefined
}


export function agentComposerAvailability(
  session: SessionSnapshot | undefined,
  forceDisabled = false
): AgentComposerAvailability {
  const mode = composerSubmitMode(session, forceDisabled)
  return { disabled: !mode.canSubmit, placeholder: mode.placeholder }
}

/** Direct Session intent keeps its editor; logical Mote intent publishes to its permanent Host. */
function SessionComposerSurface({ source, ...props }: AgentComposerProps & {
  source?: { ownerKey: string; sourceKey: string; enabled: boolean; connection?: ComposerConnection | null | undefined } | undefined
}) {
  return source ? <ComposerSource {...props} {...source} /> : <AgentComposer {...props} />
}

export function AgentSessionComposer({
  pendingLayout,
  sessionId,
  resourceWorkspaceId,
  disabled = false,
  readOnly = false,
  tabName,
  aboveInput,
  resultReview,
  reading,
  onRevealMessage,
  onOpenTerminal,
  mailboxOrigin,
  visible = true
}: {
  pendingLayout?: PendingDeliveryLayout | undefined
  sessionId: string
  resourceWorkspaceId?: string | undefined
  disabled?: boolean
  readOnly?: boolean
  // Authored Tab name is contextual; the Session identity remains primary.
  tabName?: string
  aboveInput?: ReactNode
  reading?: ConversationReadingProps | undefined
  onRevealMessage?: RevealMailboxMessage | undefined
  onOpenTerminal?(): void
  mailboxOrigin?: OpenHttpLinkOrigin | undefined
  resultReview?: ((onNavigate: () => void) => ReactNode) | undefined
  visible?: boolean
}) {
  const moteWorkface = useContext(MoteWorkfaceContext)
  const motePresentation = useWorkbenchBrowserPresentation()
  const moteDialogue = useMoteDialogueView()
  const main = moteDialogue?.page?.main
  useObservedConsumerCommit('composer', visible)
  const consumerScope = useMemo(() => ({ sessionIds: [sessionId], navigation: false }), [sessionId])
  const insertionRef = useRef<ComposerInsertionHandle>(null)
  useEffect(() => { void reportMessageDeliveryDiagnostics() }, [])
  const feedback = useComposerFeedback(sessionId)
  const memberInput = motePresentation.moteInputIntent === 'member' || Boolean(moteWorkface?.memberIntent)
  const moteComposer = !memberInput && moteWorkface?.presentation === 'conversation' && moteWorkface.section === 'discussion' &&
    moteWorkface.composer?.reference?.sessionId === sessionId ? moteWorkface.composer : undefined
  const moteDraftKey = moteComposer?.draftKey
  const draftOwner = moteDraftKey ?? sessionId
  // The fixed Host observes the Mote text. A Source only supplies actions and never mirrors that text into a Session.
  const text = useObservedAppStore('composer', visible, consumerScope, state => moteDraftKey ? '' : state.agentComposerDrafts[sessionId] ?? '')
  const historyNavigation = useObservedAppStore('composer', visible, consumerScope, state => state.agentComposerHistoryNavigation[draftOwner])
  const historyPhase = historyNavigation ? historyNavigation.entries && historyNavigation.cursor < historyNavigation.entries.length
    ? 'browsing' as const : 'restored' as const : undefined
  const setAgentComposerDraft = useAppStore.getState().setAgentComposerDraft
  function readDraft() {
    const record = moteDraftKey ? useLauncherState.getState().drafts[moteDraftKey] : undefined
    return { record, text: moteDraftKey ? record?.prompt ?? '' : useAppStore.getState().agentComposerDrafts[sessionId] ?? '' }
  }
  function clearDraft(original: ReturnType<typeof readDraft>) {
    if (moteDraftKey) {
      if (useLauncherState.getState().drafts[moteDraftKey] === original.record)
        useAppStore.getState().setAgentComposerDraft(sessionId, '', moteDraftKey)
    } else useAppStore.getState().clearAgentComposerDraftIfUnchanged(sessionId, original.text)
  }
  const enqueueAgentSteer = useAppStore.getState().enqueueAgentSteer
  const archiveAgentSteer = useAppStore.getState().archiveAgentSteer
  const moveAgentSteer = useAppStore.getState().moveAgentSteer
  const sendQueuedAgentSteer = useAppStore.getState().resendRefusedAgentSteer
  // The queue entries, not a count — the badge shows the messages, and derives the count from them, so
  // the two cannot drift. Each entry carries an operationId for retry correlation; only its text renders.
  // Falls back to a shared frozen empty array so an absent queue does not hand a fresh `[]` to the
  // selector on every store update (zustand compares by reference) — the `.map` to text happens once per
  // real render below, not inside the selector, so it does not defeat that reference check.
  const sendingId = useObservedAppStore('composer', visible, consumerScope, (state) => state.agentSteerInFlight?.[sessionId])
  const sendingPhase = useObservedAppStore('composer', visible, consumerScope, (state) => state.agentSteerInFlightPhase?.[sessionId])
  const queuedEntries = useObservedAppStore('composer', visible, consumerScope, (state) => state.agentSteerQueues?.[sessionId] ?? EMPTY_QUEUE)
  const rolloverHandled = useRef<string | null>(null), rolloverChoiceRequired = useRef(false)
  const rollovers = queuedEntries.filter(entry => !entry.archived && entry.mainRollover)
  const rolloverSurface = useRef<HTMLDetailsElement>(null)
  // The existing pending popup must clear the original continuation controls,
  // just as it already clears an interaction card in this workface.
  const deliveryLayout = useMemo(() => rolloverDeliveryLayout(pendingLayout, rolloverSurface), [pendingLayout, rollovers.length > 0])
  const openRollover = (entry: AgentSteerQueueEntry) => {
    if (!entry.mainRollover || !moteWorkface?.startRollover) return
    const accepted = moteWorkface.startRollover({ sessionId, decision: entry.mainRollover, query: { operationId: entry.operationId, prompt: entry.text,
      ...(entry.sourceChannel ? { sourceChannel: entry.sourceChannel } : {}), ...(entry.inputImages ? { inputImages: [...entry.inputImages] } : {}) } })
    if (accepted) { rolloverHandled.current = entry.operationId; feedback.dismiss() }
    else feedback.report('这条输入属于原 Mote，当前页面未接纳。原问题和操作已保留；返回所属 Mote 后继续。')
  }
  useEffect(() => {
    if (rollovers.length > 1) rolloverChoiceRequired.current = true
    else if (!rollovers.length) rolloverChoiceRequired.current = false
    if (visible && !memberInput && !rolloverChoiceRequired.current && rollovers.length === 1 && rolloverHandled.current !== rollovers[0]!.operationId) openRollover(rollovers[0]!)
  }, [visible, queuedEntries, memberInput, moteWorkface?.startRollover])
  const executors = useObservedAppStore('composer', visible, consumerScope, (state) => state.config?.executors)
  const session = useObservedAppStore('composer', visible, consumerScope, (state) => sessionPresentationById(state.sessions).get(sessionId))
  const moteMain = motePresentation.moteInputIntent !== 'member' && !moteWorkface?.memberIntent && moteDialogue?.target && main?.roleRevision && main.current && session?.kind === 'agent' &&
    main.current.sessionId === session.control.agentSessionId && main.current.hostId === session.control.hostId
    ? { target: moteDialogue.target, expectedRoleRevision: main.roleRevision } : undefined
  const nativeService = useRunService(session)
  const viewModeSelector = useMemo(() => createSessionViewModeSelector(sessionId), [sessionId])
  const viewMode = useObservedAppStore('composer', visible, consumerScope, viewModeSelector)
  const setViewMode = useAppStore.getState().setViewMode
  const userName = useObservedAppStore('composer', visible, consumerScope, (state) => state.agentNames?.[sessionId])
  const timeline = useObservedAppStore('composer', visible, consumerScope, (state) => state.timelines?.[sessionId])
  // A published preview revision may append to the same original timeline object.
  useObservedAppStore('composer', visible, consumerScope, state => state.timelines?.[sessionId]?.revision)
  const inputHistory = useComposerInputHistory({ sessionId, draftOwner,
    control: session?.kind === 'agent' ? session.control : undefined, visible, readOnly: readOnly || disabled,
    insertion: insertionRef, ...(timeline ? { timeline } : {}) })
  const firstPromptSelector = useMemo(() => createFirstPromptSelector(sessionId), [sessionId])
  const firstPrompt = useObservedAppStore('composer', visible, consumerScope, firstPromptSelector)
  const displayName = session?.kind === 'agent' ? agentDisplayName({
    userName, firstPrompt, fallbackLabel: tabName || session.label, providerLabel: agentProviderLabel(session.providerId)
  }) : undefined
  const config = useObservedAppStore('composer', visible, consumerScope, state => state.config)
  const topicSnapshots = useObservedAppStore('composer', visible, consumerScope, state => state.scratchTopicSnapshots)
  const topics = useMemo(() => scratchTopicsForConfig(config, topicSnapshots), [config, topicSnapshots])
  const toolExecution = session?.kind === 'agent' ? session.toolExecution : undefined
  const runtimeWorkspace = useMemo(() => config?.workspaces.find(item =>
    session?.kind === 'agent' && workspaceOwnsSessionPath(item, session, topics)
  ), [config, topics, session?.kind, session?.hostId, session?.workspacePath])
  const resource = useMemo(() => sessionResourceContext(config, session, topics, resourceWorkspaceId),
    [config, topics, resourceWorkspaceId, session?.kind, session?.hostId, session?.workspacePath,
      toolExecution?.resourceHostId, toolExecution?.workspacePath, session?.kind === 'agent' ? session.workPlacement?.resourceHostId : undefined])
  const workspace = resource.workspace
  const activeFile = useObservedAppStore('composer', visible, consumerScope, (state) =>
    workspace ? state.lastActiveFileByWorkspace[workspace.id] : undefined
  )
  // The posture control is drawn purely from the Provider's catalog declaration, looked up by the
  // session's providerId. A Provider that declares none yields undefined, so the composer draws nothing.
  const postureControl = useObservedAppStore('composer', visible, consumerScope, (state) =>
    session?.kind === 'agent'
      ? state.providerCatalog.find((entry) => entry.id === session.providerId)?.postureControl
      : undefined
  )
  const composerOptions = useObservedAppStore('composer', visible, consumerScope, (state) => session?.kind === 'agent'
    ? state.providerCatalog.find((entry) => entry.id === session.providerId)?.composer : undefined)
  const send = useAppStore.getState().send
  const interrupt = useAppStore.getState().interrupt
  const setPosture = useAppStore.getState().setPosture
  const reportError = useAppStore.getState().reportError
  // One decision answers three questions the old `availability + isWorking` pair conflated: can the user
  // type, does the surface permit a submit (true while working — that IS steer), and is the primary button
  // Send or Stop. availability stays for other consumers; this component reads only submitMode.
  const submitMode = composerSubmitMode(session, disabled || readOnly)
  const completion = useComposerCandidates({ scope: JSON.stringify([draftOwner, sessionId, session?.hostId, workspace?.id, session?.kind === 'agent' ? session.providerId : null]),
    active: visible && submitMode.canType, config, resourceWorkspace: workspace, runtimeWorkspace, resourceIssue: resource.issue, sessionId,
    providerId: session?.kind === 'agent' ? session.providerId : undefined, commands: composerOptions?.commands ?? [], insertion: insertionRef })
  const requestPending = session?.kind === 'agent' && Boolean(session.pendingInteraction)
  const nativeQueuePending = session?.kind === 'agent' && Boolean(interactionNativeComposerBinding(session))

  function acceptsMoteMainInput(): boolean {
    const direct = motePresentation.moteInputIntent === 'member' || moteWorkface?.memberIntent
    const logicalMain = !direct && (motePresentation.moteInputIntent === 'main' || motePresentation.surface === 'mote' || moteWorkface?.section === 'discussion')
    if (logicalMain && !moteMain) {
      feedback.report(main?.status === 'ready'
        ? '主 Agent 已更换或解除绑定。原输入尚未发送，草稿保留；返回当前主对话，或从 Threads 明确选择这位 Agent 继续。'
        : '主对话的原角色来源暂未确认。原输入尚未发送，草稿保留；重读主对话，或从 Threads 明确选择这位 Agent 继续。')
      return false
    }
    return true
  }

  function sendStatusPrompt(prompt: ComposerShortcut): boolean {
    if (disabled || readOnly || !submitMode.canSubmit || !acceptsMoteMainInput()) return false
    // State actions leave the independently authored Composer draft intact.
    if (!send(sessionId, prompt.body, feedback.report, 'manual', undefined, { moteSource: moteInputSource(sessionId, mailboxOrigin), moteMain })) return false
    feedback.dismiss()
    return true
  }

  function submit(): void {
    const original = readDraft()
    if (!submitMode.canSubmit || !original.text.trim() || !acceptsMoteMainInput()) return
    const { text: value, inputImages } = expandComposerInput(original.text)
    if (lastSubmitBySession.isDuplicate(sessionId, value)) return
    if (!send(sessionId, value, feedback.report, 'manual', undefined, { inputImages, moteSource: moteInputSource(sessionId, mailboxOrigin), moteMain })) return
    feedback.dismiss()
    clearDraft(original)
    lastSubmitBySession.record(sessionId, value)
    useAppStore.getState().recordAgentComposerHistory(sessionId, value)
  }

  function queue(): void {
    if (!acceptsMoteMainInput()) return
    const original = readDraft()
    const { text: value, inputImages } = expandComposerInput(original.text)
    if (!value.trim()) return
    if (lastSubmitBySession.isDuplicate(sessionId, value)) return
    // Clear the draft only once the queue has actually taken the text. A refused enqueue (oversized)
    // must leave the words in the box — the store has already said why, and clearing here would strand
    // the user's message in a banner they cannot copy from.
    if (!enqueueAgentSteer(sessionId, value, feedback.report, undefined, 'manual', undefined, { inputImages, moteSource: moteInputSource(sessionId, mailboxOrigin), moteMain })) return
    feedback.dismiss()
    clearDraft(original)
    void useAppStore.getState().flushAgentSteerQueue(sessionId)
    lastSubmitBySession.record(sessionId, value)
    useAppStore.getState().recordAgentComposerHistory(sessionId, value)
  }

  // A message the person sent while this Mote's Main was still being read. Only the Composer whose Session the role owner
  // confirms as the current Main (moteMain) sends it, once, through the same submit as typing.
  const held = moteWorkface?.heldInput
  const heldStarted = useRef<string | null>(null)
  useEffect(() => {
    if (!held || !visible || !moteMain || !submitMode.canSubmit || heldStarted.current === held.operationId) return
    heldStarted.current = held.operationId
    const { text: value, inputImages } = expandComposerInput(held.prompt)
    const accepted = send(sessionId, value, feedback.report, 'manual', undefined, { inputImages, moteSource: moteInputSource(sessionId, mailboxOrigin), moteMain })
    if (accepted) {
      useAppStore.getState().recordAgentComposerHistory(sessionId, value)
      lastSubmitBySession.record(sessionId, value)
    }
    moteWorkface?.settleHeldInput?.(held.operationId, accepted)
  }, [held?.operationId, visible, Boolean(moteMain), submitMode.canSubmit])

  // Enter history only at the editing boundary. Once browsing, every plain arrow navigates,
  // including a multiline entry whose editor selection is at its end.
  function historyRecall(direction: 'older' | 'newer', draft: string, caret: number): string | null {
    const state = useAppStore.getState()
    const navigation = state.agentComposerHistoryNavigation[draftOwner]
    const browsing = navigation?.entries && navigation.cursor < navigation.entries.length
    if (!browsing && direction === 'older' && !caretAtFirstLine(draft, caret)) return null
    if (!browsing && direction === 'newer' && !caretAtLastLine(draft, caret)) return null
    return state.recallAgentComposerHistory(sessionId, direction, draft, inputHistory.entries, moteDraftKey)
  }


  const dialogDocument = useWorkbenchWindowDocument() ?? undefined

  const [fileReferencesOpen, setFileReferencesOpen] = useState(false)
  const onRemoteFiles = useMemo(() => setFileReferencesOpen.bind(null, true), [setFileReferencesOpen])
  const attachmentScope = JSON.stringify([draftOwner, sessionId, session?.hostId, session?.workspacePath, resource.address, workspace?.id])
  useEffect(() => { setFileReferencesOpen(false) }, [attachmentScope, visible])
  const attachments = useComposerAttachments({ scope: attachmentScope, sessionControl: session?.kind === 'agent' ? session.control : undefined, hostId: session?.hostId,
    workspacePath: session?.workspacePath,
    ...(session?.kind === 'agent' && session.toolExecution ? {
      fileResource: workspace ? { hostId: workspace.hostId, workspacePath: workspace.path } : null
    } : {}),
    disabled: !submitMode.canType, insertion: insertionRef, feedback,
    document: dialogDocument, shortcutActive: visible && !readOnly, ...(workspace ? { onRemoteFiles } : {}) })

  const notices: ServiceNoticeItem[] = sessionServiceNotices(session, queuedEntries, sendingId,
    nativeService).map(notice => notice.id === 'timeline-observation'
      ? { ...notice, action: { label: 'Retry work history', run: () => { void useAppStore.getState().resyncTimeline(sessionId, { observationOnly: true }) } } }
      : notice.id === 'interaction-receipt' && onOpenTerminal
        ? { ...notice, action: { label: 'Open terminal', run: onOpenTerminal } }
      : notice)
  if (feedback.failure) notices.push({ id: 'tool', notice: { kind: 'indeterminate', notice: {
    step: 'A message tool action did not complete', mode: feedback.failure.message,
    restore: 'Your draft is kept. You can try the action again.'
  } }, ...(feedback.failure.retry ? { action: { label: 'Retry', run: feedback.failure.retry } } : {}) })
  const inbox = useServiceNotices(sessionId, notices, session?.kind === 'agent')

  const sourceProps = moteComposer ? { ownerKey: moteComposer.draftKey, connection: moteComposer.connection,
    sourceKey: moteComposerSessionKey(moteComposer.reference!, moteMain?.expectedRoleRevision),
    enabled: Boolean(visible && moteComposer.active && moteMain && session?.kind === 'agent' && moteComposer.reference?.hostId === session.control.hostId) } : undefined

  return (
    <SessionMailbox pendingLayout={deliveryLayout} key={sessionId} inputHistory={inputHistory} historyResourceReader={inputHistory.resourceReader} userMessages={inputHistory.messages} onHistoryVisible={inputHistory.setMailboxOpen} mailboxOrigin={mailboxOrigin} reading={reading} onRevealMessage={onRevealMessage} visible={visible} system={inbox} timeline={timeline}
        noticePresentation={feedback.failure ? { id: 'tool', content: <ComposerFeedback compact failure={feedback.failure} onDismiss={feedback.dismiss} /> } : undefined}
        progressSession={!readOnly && session?.kind === 'agent' ? session : undefined}
        control={session?.kind === 'agent' ? session.control : undefined}
        queued={queuedEntries.map((entry) => ({
          id: entry.operationId,
          ...(entry.directInputControl && entry.directInputBinding ? { inputOrigin: {
            hostId: entry.directInputControl.hostId, key: entry.inputReceipt?.key ?? { kind: 'prompt' as const,
              agentSessionId: entry.directInputControl.agentSessionId, expectedRun: entry.directInputBinding.expectedRun, submissionId: entry.operationId }
          } } : entry.resumeInputIntent && entry.resumeInputReceipt?.key ? { inputOrigin: {
            hostId: entry.resumeInputIntent.control.hostId, key: entry.resumeInputReceipt.key
          } } : {}),
          text: entry.text,
          ...(entry.archived ? { archived: true as const } : {}),
          inputControlled: Boolean(entry.directInputBinding || entry.resumeInputIntent),
          confirmed: Boolean(entry.resumeInputReceipt && ['launch-carried', 'terminal-confirmed'].includes(entry.resumeInputReceipt.state)) || (entry.inputReceipt?.status === 'admitted' || entry.inputReceipt?.status === 'terminal-confirmed' || entry.inputReceipt?.status === 'launch-carried') || !entry.directInputBinding && Boolean(confirmedSteerDelivery(timeline, session?.kind === 'agent' ? session.control : undefined, entry.operationId)),
          ...(entry.inputReceipt ? { inputReceipt: entry.inputReceipt } : {}),
          ...(entry.resumeInputReceipt ? { resumeInputReceipt: entry.resumeInputReceipt } : {}),
          ...(entry.inputStopReceipt ? { inputStopReceipt: entry.inputStopReceipt } : {}),
          ...(entry.enqueuedAt !== undefined ? { enqueuedAt: entry.enqueuedAt } : {}),
          status: entry.status,
          editable: agentSteerCanEdit(entry, sendingId),
          immediateSend: session?.kind === 'agent' && agentSteerExecution(entry, session.capabilities) === 'immediate',
          preparing: !entry.archived && entry.operationId === sendingId && sendingPhase !== 'submitting',
          sending: !entry.archived && entry.operationId === sendingId && sendingPhase === 'submitting',
          unconfirmed: entry.resumeInputReceipt ? !['launch-carried', 'terminal-confirmed', 'not-applied'].includes(entry.resumeInputReceipt.state) : entry.inputReceipt ? entry.inputReceipt.status === 'unknown'
            : Boolean(entry.inputIntakeStarted) || entry.promptCondition !== null && !entry.preparationInputNotApplied && (entry.status === 'deferred' || entry.status === 'failed'),
          ...(entry.awaitingExplicitSend ? { awaitingExplicitSend: true as const } : {}),
          wakesItself: session?.kind === 'agent' && steerEntryWakesItself(entry, session.control.run.runId),
          deliverable: session?.kind === 'agent' && (entry.runId === undefined ||
            steerQueueCanEverDrain(session.processState) && (steerEntryTargetsRun(entry, session.control.run.runId) ||
              agentSteerCanEdit(entry, sendingId) && entry.goalContinuation === undefined)),
          ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
          ...(entry.logId ? { logId: entry.logId } : {}),
          ...(entry.error ? { error: entry.error } : {}),
          ...(entry.preparationWait ? { preparationWait: entry.preparationWait } : {}),
        }))}
        {...(!readOnly ? { onArchiveQueued: async (operationId: string, expectedText: string, archived: boolean) => {
          await feedback.run(async () => { await archiveAgentSteer(sessionId, operationId, expectedText, archived) })
        } } : {})}
        {...(!readOnly && session?.kind === 'agent' ? { onMoveQueuedToDraft: async (operationId: string, expectedText: string) => {
          await feedback.run(async () => { await useAppStore.getState().moveQueuedAgentSteerToDraft(sessionId, operationId, expectedText, session.control.run.runId, moteDraftKey) })
        } } : {})}
        onMoveQueued={(operationId, direction) => moveAgentSteer(sessionId, operationId, direction)}
        sendImmediately={session?.kind === 'agent' && queuedEntries.some(entry => agentSteerExecution(entry, session.capabilities) === 'immediate')}
        pendingInteraction={session?.kind === 'agent' && Boolean(session.pendingInteraction)}
        {...(!readOnly ? { onSendQueued: (operationId: string) => { void feedback.run(async () => { await sendQueuedAgentSteer(sessionId, operationId) }) } } : {})}
        {...(!readOnly ? { onCancelQueuedPreparation: (operationId: string) => { void feedback.run(async () => { await useAppStore.getState().cancelAgentSteerPreparation(sessionId, operationId) }) } } : {})}
        {...(!disabled && !readOnly ? { onEditQueued: async (id: string, expectedText: string, nextText: string) => {
          feedback.dismiss()
          try { useAppStore.getState().editQueuedAgentSteer(sessionId, id, expectedText, nextText) }
          catch (error) { feedback.report(error); throw error }
        } } : {})}
        onCopyQueued={async (text) => { feedback.dismiss(); return copyTextToClipboard(text, feedback.report) }}
    >
    {(mailbox, pending, composerRef) => (
    <>
    {moteComposer ? aboveInput : null}
    {fileReferencesOpen && workspace && visible ? <ComposerFileReferences key={attachmentScope} workspace={workspace}
      onClose={() => setFileReferencesOpen(false)} onSelect={path => { void attachments.referencePaths([path]) }} /> : null}
    <SessionComposerSurface source={sourceProps} surfaceRef={composerRef} key={sessionId}
      onFocusCapture={event => { inputHistory.setFocused(true); attachments.claimScreenshotTarget(event) }}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) inputHistory.setFocused(false) }} active={visible} aboveInput={<>{!moteComposer ? aboveInput : null}{pending}{rollovers.length > 0 && moteWorkface?.startRollover ? <details ref={rolloverSurface} className="mote-conversation__muted" open={rollovers.length === 1}><summary>待承接到新对话的输入</summary>{rollovers.map(entry => <div className="mote-conversation__handoff" data-mote-rollover={entry.operationId} key={entry.operationId}><p style={{ margin: 0, flex: '1 1 12rem' }}>{entry.text.slice(0, 80)}</p><button className="small-button" style={{ flexShrink: 0 }} type="button" onClick={() => openRollover(entry)}>接到新对话</button></div>)}</details> : null}</>} mailbox={mailbox}
      readPastedImage={api.ui.readPastedImage}
      insertionRef={insertionRef}
      identity={session?.kind === 'agent' && displayName ? <AgentIdentity session={session} name={displayName}
        executorLabel={executors?.[session.executorId]?.label ?? session.executorId}
        appearance={executors?.[session.executorId]?.avatar} prompts={completion.prompts} visible={visible}
        disabled={!submitMode.canSubmit}
        inputAction={!submitMode.canType ? 'Messages are unavailable on this surface.' : requestPending
          ? nativeQueuePending ? 'Send to the Agent’s message queue. The request remains open.' : `${SEND_AFTER_REQUEST_ENDS}.` : !submitMode.canSubmit ? submitMode.placeholder
            : session.processState !== 'running' || session.status.state === 'disconnected'
              ? 'Send to restore this Session.' : 'Send a message to this Session.'}
        onSelect={sendStatusPrompt} resultReview={resultReview} /> : null}
      contextUsage={<AgentContextUsage visible={visible} source={session?.kind === 'agent' ? JSON.stringify([session.hostId, session.id, session.providerId, session.control.run.runId]) : sessionId} usage={session?.kind === 'agent' ? session.turnUsage : undefined} />}
      {...(workspace || runtimeWorkspace ? { onActivateSemanticReference: (reference: ComposerSemanticReference) => {
        if (reference.kind === 'agent') { void api.ui.openObjectLink(reference.reference).catch(reportError); return }
        const target = reference.kind === 'file' ? workspace : runtimeWorkspace
        if (!target) { feedback.report(new Error(resource.issue ?? 'The original file Workspace is unconfirmed. Your draft and Agent are kept.')); return }
        const path = reference.reference.startsWith('@') ? reference.reference.slice(1) : reference.reference
        const store = useAppStore.getState()
        void store.selectWorkspace(target.id).catch(reportError)
        void store.openFile(path, undefined, undefined, target.id).catch(reportError)
      } } : {})}
      completionConfig={completion.completionConfig}
      commands={completion.commands} skills={completion.skills} references={completion.references}
      promptKeywords={completion.promptKeywords} onCompletionQuery={completion.onCompletionQuery}
      completionFeedback={completion.completionFeedback}
      tools={(referenceTools) => <AgentComposerTools key={completion.scope} active={visible} disabled={!submitMode.canType} commands={completion.commands} referenceTools={referenceTools}
        viewMode={viewMode} onViewModeChange={(mode) => setViewMode(sessionId, mode)}
        loadSkills={completion.loadSkills} onChooseSkill={skill => { void feedback.run(() => completion.insertCandidate(skillComposerSuggestion(skill))) }}
        onCommand={(_command, candidate) => { void feedback.run(() => completion.insertCandidate(candidate)) }}
        {...(session?.hostId === 'local' ? { onCapture: attachments.capture } : {})} runAction={feedback.run} />}
      value={text}
      disabled={!submitMode.canType}
      placeholder={nativeQueuePending ? 'Message the Agent; the request stays open…' : submitMode.placeholder}
      primaryAction={submitMode.primaryAction}
      {...(requestPending && !nativeQueuePending ? { submitLabel: SEND_AFTER_REQUEST_ENDS } : {})}
      onHistoryRecall={historyRecall}
      {...(historyPhase ? { historyNavigation: historyPhase } : {})}
      {...(activeFile ? { activeFile } : {})}
      onChange={(value) => setAgentComposerDraft(sessionId, value, moteDraftKey)}
      // Interrupt follows `primaryAction`, never `canSubmit`: composer-submit-mode.ts answers "is a turn in
      // flight" and "may Enter submit" separately, so Stop stays wired whatever the submit axis says,
      // including while a request card is up. Core's interrupt path (client.signalAgent → kernel.interrupt)
      // has no pendingInteraction or processState gate, so withholding it here would take away a capability
      // the runtime still honours (RED-LINES.md 判定流程 question 2).
      {...(submitMode.primaryAction === 'stop' ? { onInterrupt: () => void interrupt(sessionId) } : {})}
      // Resource helpers edit the existing draft, including while a request is pending.
      // Submission eligibility stays with Core; it does not disable local drafting.
      {...(submitMode.canType ? {
        onAttach: () => { void attachments.chooseFiles() },
        onPasteImage: attachments.pasteImage,
        onDropFiles: attachments.dropFiles,
        ...(activeFile ? { onReferenceActiveFile: () => { void attachments.referencePaths([activeFile]) } } : {})
      } : {})}
      {...(submitMode.canSubmit ? { onSubmit: () => void submit() } : {})}
      // Typed Send may restore a Session. Posture is a raw keystroke for the current live Run; it cannot be
      // buffered or replayed through that restoration boundary. Core writes it like any terminal input, so
      // while a request is pending it would land in the open native dialog and be recorded as native input
      // on that request, retiring the card's answer. It is offered only when no request owns the input.
      {...(postureControl && submitMode.canSubmit && session?.kind === 'agent' && !session.pendingInteraction &&
        session.processState === 'running' && session.status.state !== 'disconnected'
        ? { postureTool: <PosturePicker control={postureControl} disabled={!submitMode.canType} onSet={(modeId: string) => void setPosture(sessionId, modeId)} /> } : {})}
      {...(session?.kind === 'agent' && (moteDraftKey || text.trim()) && (session.pendingInteraction || submitMode.primaryAction === 'stop') ? {
        onQueue: () => queue()
      } : {})}
    />
    </>
    )}
    </SessionMailbox>
  )
}
