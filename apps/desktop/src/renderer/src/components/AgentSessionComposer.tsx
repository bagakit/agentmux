import type { PendingDeliveryLayout } from '../lib/pending-delivery-layout'
import { useWorkbenchWindowDocument } from '../lib/workbench-document'
import { useObservedAppStore, useObservedConsumerCommit } from '../lib/use-observed-app-store'
import { reportMessageDeliveryDiagnostics } from '../lib/message-delivery-diagnostics'
import { scratchTopicsForConfig } from '../lib/scratch-topic-snapshots'
import { PosturePicker } from './PosturePicker'
import { createFirstPromptSelector, createSessionViewModeSelector, sessionPresentationById } from '../lib/session-presentation'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ComposerInsertionHandle } from '@agentmux/client-ui/composer-insertion'
import { AgentContextUsage } from './AgentContextUsage'
import { AgentComposerTools } from './AgentComposerTools'
import type { ComposerShortcut, SessionSnapshot } from '../../../shared/contracts'
import { workspaceOwnsSessionPath } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import { useComposerAttachments } from '../lib/use-composer-attachments'
import { ComposerFileReferences } from './ComposerFileReferences'
import { expandSemanticReferences, type ComposerSemanticReference } from '@agentmux/client-ui/composer-semantic-reference'
import { useComposerCandidates, skillComposerSuggestion } from '../lib/use-composer-candidates'
import { composerSubmitMode } from '../lib/composer-submit-mode'
import {
  caretAtFirstLine,
  caretAtLastLine
} from '../lib/composer-history'
import { ComposerResubmitGuard } from '../lib/composer-resubmit-guard'
import { useAppStore, agentSteerCanEdit, agentSteerExecution, type AgentSteerQueueEntry } from '../store'
import { steerEntryTargetsRun, steerQueueCanEverDrain } from '../lib/agent-steer-queue-drain'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { AgentComposer } from '@agentmux/client-ui/components/AgentComposer'
import { AgentIdentity } from './AgentIdentity'
import { agentProviderLabel } from './AgentProviderIcon'
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


export function agentComposerAvailability(
  session: SessionSnapshot | undefined,
  forceDisabled = false
): AgentComposerAvailability {
  const mode = composerSubmitMode(session, forceDisabled)
  return { disabled: !mode.canSubmit, placeholder: mode.placeholder }
}

export function AgentSessionComposer({
  pendingLayout,
  sessionId,
  disabled = false,
  readOnly = false,
  tabName,
  resultReview,
  reading,
  onRevealMessage,
  onOpenTerminal,
  mailboxOrigin,
  visible = true
}: {
  pendingLayout?: PendingDeliveryLayout | undefined
  sessionId: string
  disabled?: boolean
  readOnly?: boolean
  // Authored Tab name is contextual; the Session identity remains primary.
  tabName?: string
  reading?: ConversationReadingProps | undefined
  onRevealMessage?: RevealMailboxMessage | undefined
  onOpenTerminal?(): void
  mailboxOrigin?: OpenHttpLinkOrigin | undefined
  resultReview?: ((onNavigate: () => void) => ReactNode) | undefined
  visible?: boolean
}) {
  useObservedConsumerCommit('composer', visible)
  const consumerScope = useMemo(() => ({ sessionIds: [sessionId], navigation: false }), [sessionId])
  const insertionRef = useRef<ComposerInsertionHandle>(null)
  useEffect(() => { void reportMessageDeliveryDiagnostics() }, [])
  const feedback = useComposerFeedback(sessionId)
  const text = useObservedAppStore('composer', visible, consumerScope, (state) => state.agentComposerDrafts[sessionId] ?? '')
  const historyNavigation = useObservedAppStore('composer', visible, consumerScope, state => state.agentComposerHistoryNavigation[sessionId])
  const historyPhase = historyNavigation ? historyNavigation.entries && historyNavigation.cursor < historyNavigation.entries.length
    ? 'browsing' as const : 'restored' as const : undefined
  const setAgentComposerDraft = useAppStore.getState().setAgentComposerDraft
  const clearAgentComposerDraftIfUnchanged = useAppStore.getState().clearAgentComposerDraftIfUnchanged
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
  const executors = useObservedAppStore('composer', visible, consumerScope, (state) => state.config?.executors)
  const session = useObservedAppStore('composer', visible, consumerScope, (state) => sessionPresentationById(state.sessions).get(sessionId))
  const nativeService = useRunService(session)
  const viewModeSelector = useMemo(() => createSessionViewModeSelector(sessionId), [sessionId])
  const viewMode = useObservedAppStore('composer', visible, consumerScope, viewModeSelector)
  const setViewMode = useAppStore.getState().setViewMode
  const userName = useObservedAppStore('composer', visible, consumerScope, (state) => state.agentNames?.[sessionId])
  const timeline = useObservedAppStore('composer', visible, consumerScope, (state) => state.timelines?.[sessionId])
  // A published preview revision may append to the same original timeline object.
  useObservedAppStore('composer', visible, consumerScope, state => state.timelines?.[sessionId]?.revision)
  const inputHistory = useComposerInputHistory({ sessionId,
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
  const workspace = useMemo(() => config?.workspaces.find(item =>
    session?.kind === 'agent' && workspaceOwnsSessionPath(item, session, topics)
  ), [config, topics, session?.kind, session?.hostId, session?.workspacePath])
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
  const completion = useComposerCandidates({ scope: JSON.stringify([sessionId, session?.hostId, workspace?.id, session?.kind === 'agent' ? session.providerId : null]),
    active: visible && submitMode.canType, config, workspace, sessionId,
    providerId: session?.kind === 'agent' ? session.providerId : undefined, commands: composerOptions?.commands ?? [], insertion: insertionRef })
  const queueStatusPrompt = submitMode.canType && session?.kind === 'agent' && Boolean(session.pendingInteraction)

  function sendStatusPrompt(prompt: ComposerShortcut): boolean {
    if (disabled || readOnly || (!submitMode.canSubmit && !queueStatusPrompt)) return false
    // State actions leave the independently authored Composer draft intact.
    const accepted = queueStatusPrompt
      ? enqueueAgentSteer(sessionId, prompt.body, feedback.report, undefined, 'manual')
      : send(sessionId, prompt.body, feedback.report, 'manual')
    if (!accepted) return false
    feedback.dismiss()
    if (queueStatusPrompt) void useAppStore.getState().flushAgentSteerQueue(sessionId)
    return true
  }

  function submit(): void {
    if (!submitMode.canSubmit || !text.trim()) return
    const value = expandSemanticReferences(text)
    if (lastSubmitBySession.isDuplicate(sessionId, value)) return
    if (!send(sessionId, value, feedback.report, 'manual')) return
    feedback.dismiss()
    clearAgentComposerDraftIfUnchanged(sessionId, text)
    lastSubmitBySession.record(sessionId, value)
    useAppStore.getState().recordAgentComposerHistory(sessionId, value)
  }

  function queue(): void {
    const value = expandSemanticReferences(text)
    if (!value.trim()) return
    if (lastSubmitBySession.isDuplicate(sessionId, value)) return
    // Clear the draft only once the queue has actually taken the text. A refused enqueue (oversized)
    // must leave the words in the box — the store has already said why, and clearing here would strand
    // the user's message in a banner they cannot copy from.
    if (!enqueueAgentSteer(sessionId, value, feedback.report, undefined, 'manual')) return
    feedback.dismiss()
    clearAgentComposerDraftIfUnchanged(sessionId, text)
    void useAppStore.getState().flushAgentSteerQueue(sessionId)
    lastSubmitBySession.record(sessionId, value)
    useAppStore.getState().recordAgentComposerHistory(sessionId, value)
  }

  // Enter history only at the editing boundary. Once browsing, every plain arrow navigates,
  // including a multiline entry whose editor selection is at its end.
  function historyRecall(direction: 'older' | 'newer', draft: string, caret: number): string | null {
    const state = useAppStore.getState()
    const navigation = state.agentComposerHistoryNavigation[sessionId]
    const browsing = navigation?.entries && navigation.cursor < navigation.entries.length
    if (!browsing && direction === 'older' && !caretAtFirstLine(draft, caret)) return null
    if (!browsing && direction === 'newer' && !caretAtLastLine(draft, caret)) return null
    return state.recallAgentComposerHistory(sessionId, direction, draft, inputHistory.entries)
  }


  const dialogDocument = useWorkbenchWindowDocument() ?? undefined

  const [fileReferencesOpen, setFileReferencesOpen] = useState(false)
  const attachmentScope = JSON.stringify([sessionId, session?.hostId, session?.workspacePath])
  useEffect(() => { setFileReferencesOpen(false) }, [attachmentScope, visible])
  const attachments = useComposerAttachments({ scope: attachmentScope, hostId: session?.hostId,
    workspacePath: session?.workspacePath, disabled: !submitMode.canType, insertion: insertionRef, feedback,
    document: dialogDocument, shortcutActive: visible && !readOnly, ...(workspace ? { onRemoteFiles: () => setFileReferencesOpen(true) } : {}) })

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

  return (
    <SessionMailbox pendingLayout={pendingLayout} key={sessionId} inputHistory={inputHistory} historyResourceReader={inputHistory.resourceReader} userMessages={inputHistory.messages} onHistoryVisible={inputHistory.setMailboxOpen} mailboxOrigin={mailboxOrigin} reading={reading} onRevealMessage={onRevealMessage} visible={visible} system={inbox} timeline={timeline}
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
          confirmed: Boolean(entry.resumeInputReceipt && ['launch-carried', 'terminal-confirmed'].includes(entry.resumeInputReceipt.state)) || (entry.inputReceipt?.status === 'admitted' || entry.inputReceipt?.status === 'terminal-confirmed') || !entry.directInputBinding && Boolean(confirmedSteerDelivery(timeline, session?.kind === 'agent' ? session.control : undefined, entry.operationId)),
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
          await feedback.run(async () => { await useAppStore.getState().moveQueuedAgentSteerToDraft(sessionId, operationId, expectedText, session.control.run.runId) })
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
    <div style={{ display: 'contents' }} onFocusCapture={event => { inputHistory.setFocused(true); attachments.claimScreenshotTarget(event) }}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) inputHistory.setFocused(false) }}>
    {fileReferencesOpen && workspace && visible ? <ComposerFileReferences key={attachmentScope} workspace={workspace}
      onClose={() => setFileReferencesOpen(false)} onSelect={path => { void attachments.referencePaths([path]) }} /> : null}
    <AgentComposer surfaceRef={composerRef} key={sessionId} active={visible} aboveInput={pending} mailbox={mailbox}
      readPastedImage={api.ui.readPastedImage}
      insertionRef={insertionRef}
      identity={session?.kind === 'agent' && displayName ? <AgentIdentity session={session} name={displayName}
        executorLabel={executors?.[session.executorId]?.label ?? session.executorId}
        appearance={executors?.[session.executorId]?.avatar} prompts={completion.prompts} visible={visible}
        disabled={!submitMode.canType || (!submitMode.canSubmit && !queueStatusPrompt)} queue={queueStatusPrompt}
        inputAction={!submitMode.canType ? 'Messages are unavailable on this surface.' : queueStatusPrompt
          ? 'Queue a message until the pending request is answered.' : session.processState !== 'running' || session.status.state === 'disconnected'
            ? 'Send to restore this Session.' : 'Send a message to this Session.'}
        onSelect={sendStatusPrompt} resultReview={resultReview} /> : null}
      contextUsage={<AgentContextUsage visible={visible} source={session?.kind === 'agent' ? JSON.stringify([session.hostId, session.id, session.providerId, session.control.run.runId]) : sessionId} usage={session?.kind === 'agent' ? session.turnUsage : undefined} />}
      {...(workspace ? { onActivateSemanticReference: (reference: ComposerSemanticReference) => {
        if (reference.kind === 'agent') { void api.ui.openObjectLink(reference.reference).catch(reportError); return }
        const path = reference.reference.startsWith('@') ? reference.reference.slice(1) : reference.reference
        const store = useAppStore.getState()
        void store.selectWorkspace(workspace.id).catch(reportError)
        void store.openFile(path, undefined, undefined, workspace.id).catch(reportError)
      } } : {})}
      completionConfig={completion.completionConfig}
      commands={completion.commands} skills={completion.skills} references={completion.references}
      promptKeywords={completion.promptKeywords} onCompletionQuery={completion.onCompletionQuery}
      completionFeedback={completion.completionFeedback}
      tools={(referenceTools) => <AgentComposerTools key={completion.scope} disabled={!submitMode.canType} commands={completion.commands} referenceTools={referenceTools}
        viewMode={viewMode} onViewModeChange={(mode) => setViewMode(sessionId, mode)}
        loadSkills={completion.loadSkills} onChooseSkill={skill => { void feedback.run(() => completion.insertCandidate(skillComposerSuggestion(skill))) }}
        onCommand={(_command, candidate) => { void feedback.run(() => completion.insertCandidate(candidate)) }}
        {...(session?.hostId === 'local' ? { onCapture: attachments.capture } : {})} runAction={feedback.run} />}
      value={text}
      disabled={!submitMode.canType}
      placeholder={submitMode.placeholder}
      primaryAction={submitMode.primaryAction}
      onHistoryRecall={historyRecall}
      {...(historyPhase ? { historyNavigation: historyPhase } : {})}
      {...(activeFile ? { activeFile } : {})}
      onChange={(value) => setAgentComposerDraft(sessionId, value)}
      // Interrupt rides `primaryAction`, NOT `canSubmit`. They answer different questions and
      // composer-submit-mode.ts keeps them apart on purpose ("Stop … independent of `canSubmit`"); wiring
      // Interrupt into the submit spread collapsed them again. The state that exposed it: a `working`
      // Agent with a pending permission card has `canSubmit:false` while `primaryAction` stays `'stop'`,
      // so the ■ button rendered with `onInterrupt` undefined — `disabled={disabled || !onInterrupt}` —
      // and the only UI path to interrupt a turn was dead exactly when a card was up.
      //
      // 原则 11 第 2 类: the daemon never stopped honouring it. store.interrupt → runtime.interrupt →
      // client.signalAgent → kernel.interrupt(runId) carries no pendingInteraction gate and no
      // processState gate — contrast writeAgentInput, which deliberately DOES throw
      // AGENT_INTERACTION_PENDING. So this took away an ability the runtime still has: RED-LINES.md
      // 判定流程 "绕过我这段代码，这条路还能不能通？→ 能" ⇒ red line.
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
      // Typed Send may restore a Session. Posture is a raw keystroke for the current live Run;
      // it cannot be buffered or replayed through that restoration boundary.
      {...(postureControl && submitMode.canSubmit && session?.kind === 'agent' &&
        session.processState === 'running' && session.status.state !== 'disconnected'
        ? { postureTool: <PosturePicker control={postureControl} disabled={!submitMode.canType} onSet={(modeId: string) => void setPosture(sessionId, modeId)} /> } : {})}
      {...(session?.kind === 'agent' && text.trim() && (session.pendingInteraction || submitMode.primaryAction === 'stop') ? {
        onQueue: () => queue()
      } : {})}
    />
    </div>
    )}
    </SessionMailbox>
  )
}
