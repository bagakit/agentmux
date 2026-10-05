import { useObservedAppStore, useObservedConsumerCommit } from '../lib/use-observed-app-store'
import { reportMessageDeliveryDiagnostics } from '../lib/message-delivery-diagnostics'
import { scratchTopicsForConfig } from '../lib/scratch-topic-snapshots'
import { PosturePicker } from './PosturePicker'
import { createFirstPromptSelector, createSessionViewModeSelector, sessionPresentationById } from '../lib/session-presentation'
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { ComposerInsert, ComposerInsertionHandle } from '@agentmux/client-ui/composer-insertion'
import { AgentContextUsage } from './AgentContextUsage'
import { AgentComposerTools } from './AgentComposerTools'
import type { ComposerShortcut, SessionSnapshot } from '../../../shared/contracts'
import { workspaceOwnsSessionPath } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import { appendFileReferences } from '@agentmux/client-ui/composer-file-reference'
import { appendSemanticReference, encodeSemanticReference, expandSemanticReferences, semanticReferenceKind, semanticReferenceLabel, type ComposerSemanticReference } from '@agentmux/client-ui/composer-semantic-reference'
import { AGENT_COMMAND_GROUP_LABEL, composerShortcutForBareWord, composerShortcutSuggestion, composerShortcutsForProvider, resolveComposerShortcuts } from '../../../shared/composer-shortcut-library'
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
import { SessionMailbox } from './SessionMailbox'
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
  sessionId,
  disabled = false,
  readOnly = false,
  tabName,
  resultReview,
  reading,
  onRevealMessage,
  mailboxOrigin,
  visible = true
}: {
  sessionId: string
  disabled?: boolean
  readOnly?: boolean
  // Authored Tab name is contextual; the Session identity remains primary.
  tabName?: string
  reading?: ConversationReadingProps | undefined
  onRevealMessage?: RevealMailboxMessage | undefined
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
  const setAgentComposerDraft = useAppStore.getState().setAgentComposerDraft
  const clearAgentComposerDraftIfUnchanged = useAppStore.getState().clearAgentComposerDraftIfUnchanged
  const enqueueAgentSteer = useAppStore.getState().enqueueAgentSteer
  const archiveAgentSteer = useAppStore.getState().archiveAgentSteer
  const moveAgentSteer = useAppStore.getState().moveAgentSteer
  const sendQueuedAgentSteer = useAppStore.getState().sendQueuedAgentSteer
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
  const lifecycleFailure = useObservedAppStore('composer', visible, consumerScope, state => state.errorNoticeContext?.lifecycle)
  const lifecycleMessage = useObservedAppStore('composer', visible, consumerScope, state => state.error ?? state.lastError)
  const viewModeSelector = useMemo(() => createSessionViewModeSelector(sessionId), [sessionId])
  const viewMode = useObservedAppStore('composer', visible, consumerScope, viewModeSelector)
  const setViewMode = useAppStore.getState().setViewMode
  const userName = useObservedAppStore('composer', visible, consumerScope, (state) => state.agentNames?.[sessionId])
  const timeline = useObservedAppStore('composer', visible, consumerScope, (state) => state.timelines?.[sessionId])
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
  // 用户自己的 prompt，按这个 Session 的 Provider 过滤。读的是**实时配置**而不是构造时的快照：
  // 在设置页改完回到 Composer，候选必须已经是新的（本仓「替身写成常量会藏起被测性质」同一族）。
  // 走共用取值层而不是就地 `?? []`：缺席即空、缺 providerId 即通用这两个默认必须只有一处，且它
  // 缺席时返回共享冻结的同一个引用——zustand 按引用比较，就地新建 `[]` 会无限重渲染。
  const myShortcuts = useObservedAppStore('composer', visible, consumerScope, (state) => resolveComposerShortcuts(state.config))
  const shortcutsHere = composerShortcutsForProvider(
    myShortcuts,
    session?.kind === 'agent' ? session.providerId : undefined
  )
  // 候选来源是**并集**：Provider 原生命令 ∪ 我自己的 prompt，各自标出来源。此前这里只有前者，
  // 而那句 `COMPOSER_SHORTCUT_PRESETS.find((entry) => entry.text === item)` 恒返回 undefined——
  // `commands` 只装 Provider catalog 声明的命令，13 家内置加起来是
  // `/compact /context /cost /diff /help /model /status`，没有一个等于 `/review-changes`。
  // 于是打 `/review` 一条候选都不出，而 tsc 干净、测试全绿：那句 `.find()` 长得就是「已经合并了」
  // 的样子（判「两套是否真的合并」要从消费侧的数据来源反推，不读桥接代码的意图）。
  //
  // Shortcut 段排在 Agent 原生命令**之前**：这是用户自己配的那套，也是他来这个列表要找的东西；
  // 段序即此处的拼装序（AgentComposer 用保插入序的 Map 分组，不另立优先级表）。
  const commandCandidates = [
    ...shortcutsHere.map(composerShortcutSuggestion),
    ...(composerOptions?.commands ?? []).map((command) => ({ ...command, group: AGENT_COMMAND_GROUP_LABEL }))
  ]
  // 识别词：同一批 Shortcut 的**裸** keyword（无 `/`）。同一个 keyword 字段供两处识别（`/` 候选与裸词），
  // 不建第二份注册表——那两份必然漂移，一处认得的词另一处不认。
  const keywordCandidates = shortcutsHere.map((shortcut) => ({ text: shortcut.keyword, description: `${shortcut.label} · Shortcut` }))
  const send = useAppStore.getState().send
  const interrupt = useAppStore.getState().interrupt
  const setPosture = useAppStore.getState().setPosture
  const reportError = useAppStore.getState().reportError
  // One decision answers three questions the old `availability + isWorking` pair conflated: can the user
  // type, does the surface permit a submit (true while working — that IS steer), and is the primary button
  // Send or Stop. availability stays for other consumers; this component reads only submitMode.
  const submitMode = composerSubmitMode(session, disabled || readOnly)
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

  // Shell-style up/down history recall. The multiline resolution: recall only fires at the line boundary
  // (ArrowUp on the first line, ArrowDown on the last line), so a bare arrow inside a multi-line draft
  // still moves the caret. The reducer preserves the half-typed draft: arrowing up stashes it, arrowing
  // back down to the live position restores it verbatim. Returns the value to place, or null to fall
  // through to caret movement. Everything decidable lives in the two pure lib modules.
  function historyRecall(direction: 'older' | 'newer', draft: string, caret: number): string | null {
    if (direction === 'older' && !caretAtFirstLine(draft, caret)) return null
    if (direction === 'newer' && !caretAtLastLine(draft, caret)) return null
    return useAppStore.getState().recallAgentComposerHistory(sessionId, direction, draft)
  }


  function addFileReference(): void {
    if (!activeFile || !submitMode.canType) return
    void feedback.run(() => insertionRef.current?.insert(() => appendFileReferences('', [activeFile]), { separate: true }))
  }

  async function attachFiles(): Promise<void> {
    if (!submitMode.canType) return
    const workspacePath = session?.kind === 'agent' ? session.workspacePath : undefined
    await insertionRef.current?.insert(async () => {
      const chosen = await api.ui.chooseFiles(workspacePath ? { defaultPath: workspacePath } : undefined)
      return chosen?.length ? appendFileReferences('', chosen, workspacePath) : null
    }, { separate: true })
  }

  async function pasteImage(file: File, insert: ComposerInsert): Promise<void> {
    if (!submitMode.canType) return
    await insert(async () => {
      const path = await api.ui.savePastedImage({ bytes: new Uint8Array(await file.arrayBuffer()), extension: file.type.slice(6).split('+')[0] ?? 'png' })
      return appendFileReferences('', [path])
    }, { separate: true })
  }

  function insertSemanticReference(reference: { name: string; path: string }): void {
    const kind = semanticReferenceKind(reference.path)
    const token = kind === 'subcommand' ? reference.path : `$${reference.name.replace(/[^A-Za-z0-9._-]+/g, '-')}`
    const item: ComposerSemanticReference = {
      token,
      label: semanticReferenceLabel(reference.name),
      kind,
      reference: kind === 'subcommand' ? reference.path : `@${reference.path}`
    }
    setAgentComposerDraft(sessionId, appendSemanticReference(useAppStore.getState().agentComposerDrafts[sessionId] ?? '', item))
  }

  async function capture(): Promise<void> {
    await insertionRef.current?.insert(async () => {
      const path = await api.ui.captureScreenshot()
      return path ? appendFileReferences('', [path]) : null
    }, { separate: true })
  }

  const notices: ServiceNoticeItem[] = sessionServiceNotices(session, queuedEntries, sendingId,
    { message: lifecycleMessage, failure: lifecycleFailure }).map(notice => notice.id === 'timeline-observation'
      ? { ...notice, action: { label: 'Retry work history', run: () => { void useAppStore.getState().resyncTimeline(sessionId, { observationOnly: true }) } } }
      : notice)
  if (feedback.failure) notices.push({ id: 'tool', notice: { kind: 'indeterminate', notice: {
    step: 'A message tool action did not complete', mode: feedback.failure.message,
    restore: 'Your draft is kept. You can try the action again.'
  } }, ...(feedback.failure.retry ? { action: { label: 'Retry', run: feedback.failure.retry } } : {}) })
  const inbox = useServiceNotices(sessionId, notices, session?.kind === 'agent')

  return (
    <SessionMailbox key={sessionId} mailboxOrigin={mailboxOrigin} reading={reading} onRevealMessage={onRevealMessage} visible={visible} system={inbox} timeline={timeline}
        progressSession={!readOnly && session?.kind === 'agent' ? session : undefined}
        control={session?.kind === 'agent' ? session.control : undefined}
        queued={queuedEntries.map((entry) => ({
          id: entry.operationId,
          text: entry.text,
          ...(entry.archived ? { archived: true as const } : {}),
          confirmed: Boolean(confirmedSteerDelivery(timeline, session?.kind === 'agent' ? session.control : undefined, entry.operationId)),
          ...(entry.enqueuedAt !== undefined ? { enqueuedAt: entry.enqueuedAt } : {}),
          status: entry.status,
          editable: agentSteerCanEdit(entry, sendingId),
          immediateSend: session?.kind === 'agent' && agentSteerExecution(entry, session.capabilities) === 'immediate',
          preparing: entry.operationId === sendingId && sendingPhase !== 'submitting',
          sending: entry.operationId === sendingId && sendingPhase === 'submitting',
          unconfirmed: entry.promptCondition !== null && !entry.preparationInputNotApplied && (entry.status === 'deferred' || entry.status === 'failed'),
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
        onMoveQueued={(operationId, direction) => moveAgentSteer(sessionId, operationId, direction)}
        sendImmediately={session?.kind === 'agent' && queuedEntries.some(entry => agentSteerExecution(entry, session.capabilities) === 'immediate')}
        pendingInteraction={session?.kind === 'agent' && Boolean(session.pendingInteraction)}
        {...(!readOnly ? { onSendQueued: (operationId: string) => { void feedback.run(async () => { await sendQueuedAgentSteer(sessionId, operationId) }) } } : {})}
        {...(!readOnly ? { onCancelQueuedPreparation: (operationId: string) => { useAppStore.getState().cancelAgentSteerPreparation(sessionId, operationId) } } : {})}
        {...(!disabled && !readOnly ? { onEditQueued: async (id: string, expectedText: string, nextText: string) => {
          feedback.dismiss()
          try { useAppStore.getState().editQueuedAgentSteer(sessionId, id, expectedText, nextText) }
          catch (error) { feedback.report(error); throw error }
        } } : {})}
        onCopyQueued={async (text) => { feedback.dismiss(); return copyTextToClipboard(text, feedback.report) }}
    >
    {(mailbox, pending) => (
    <AgentComposer key={sessionId} aboveInput={pending} mailbox={mailbox}
      feedback={<ComposerFeedback failure={feedback.failure} onDismiss={feedback.dismiss} />}
      readPastedImage={(path) => api.ui.readPastedImage(path)}
      insertionRef={insertionRef}
      identity={session?.kind === 'agent' && displayName ? <AgentIdentity session={session} name={displayName}
        executorLabel={executors?.[session.executorId]?.label ?? session.executorId}
        appearance={executors?.[session.executorId]?.avatar} prompts={shortcutsHere} visible={visible}
        disabled={!submitMode.canType || (!submitMode.canSubmit && !queueStatusPrompt)} queue={queueStatusPrompt}
        inputAction={!submitMode.canType ? 'Messages are unavailable on this surface.' : queueStatusPrompt
          ? 'Queue a message until the pending request is answered.' : session.processState !== 'running' || session.status.state === 'disconnected'
            ? 'Send to restore this Session.' : 'Send a message to this Session.'}
        onSelect={sendStatusPrompt} resultReview={resultReview} /> : null}
      contextUsage={<AgentContextUsage usage={session?.kind === 'agent' ? session.turnUsage : undefined} />}
      onActivateSemanticReference={(reference) => {
        const path = reference.reference.startsWith('@') ? reference.reference.slice(1) : reference.reference
        if (workspace) {
          const store = useAppStore.getState()
          void store.selectWorkspace(workspace.id).catch(reportError)
          void store.openFile(path, undefined, undefined, workspace.id).catch(reportError)
        }
      }}
      commands={commandCandidates}
      promptKeywords={keywordCandidates}
      references={activeFile ? [{ text: `@${activeFile.split('/').at(-1)}`, description: activeFile }] : []}
      onSelectSuggestion={(item, kind) => {
        if (kind === 'reference' && activeFile) return appendFileReferences('', [activeFile]).trim()
        // 我自己的 prompt 选中后就地展开成一个 subcommand token（点它再展开成正文）；Provider 原生
        // 命令原样填进草稿交给 Provider。查表用 keyword 去掉 `/` 之后的裸词，与裸词识别同一个键——
        // 两处识别共用一个 keyword 字段，不建第二份注册表。
        // `kind === 'keyword'` 是裸词那条路（`item` 就是 keyword 本身），`'command'` 那条要先剥掉 `/`。
        // 两条都查同一张表：keyword 一个字段两处识别，没有第二份注册表。
        const mine = kind === 'keyword' || kind === 'command'
          ? composerShortcutForBareWord(shortcutsHere, item.replace(/^\//, ''))
          : undefined
        if (mine) return encodeSemanticReference({ token: item, label: mine.label, kind: 'subcommand', reference: mine.body })
        return item
      }}
      tools={<><AgentComposerTools disabled={!submitMode.canType} commands={commandCandidates}
        viewMode={viewMode} onViewModeChange={(mode) => setViewMode(sessionId, mode)}
        loadSkills={() => api.ui.listAgentSkills(sessionId)} onChooseSkill={insertSemanticReference}
        onCommand={(command) => {
          const current = useAppStore.getState().agentComposerDrafts[sessionId] ?? ''
          setAgentComposerDraft(sessionId, `${command}${current ? ` ${current}` : ' '}`)
        }} {...(session?.hostId === 'local' ? { onCapture: capture } : {})} runAction={feedback.run} /></>}
      value={text}
      disabled={!submitMode.canType}
      placeholder={submitMode.placeholder}
      primaryAction={submitMode.primaryAction}
      onHistoryRecall={historyRecall}
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
      // Draft-building helpers follow `canType`, which is what their own bodies already check
      // (attachFiles/pasteImage/addFileReference each return early on `!canType`). Gating them on
      // canSubmit contradicted those guards: while a card is pending the placeholder invites "Draft a
      // steer…" yet attach/paste/@-file were withheld from the draft the user is allowed to type.
      // These three only edit the local draft — nothing leaves the renderer — so a pending card is
      // irrelevant to them.
      {...(submitMode.canType ? {
        onAttach: () => { void feedback.run(attachFiles) },
        onPasteImage: (file: File, insert: ComposerInsert) => { void feedback.run(() => pasteImage(file, insert)) },
        ...(activeFile ? { onReferenceActiveFile: addFileReference } : {})
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
    )}
    </SessionMailbox>
  )
}
