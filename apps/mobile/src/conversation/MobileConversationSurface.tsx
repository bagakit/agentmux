import { useMobileCommands } from './use-mobile-commands'
import { useMobileAgentReferences } from './use-mobile-agent-references'
import { consumeProgrammaticReadingScroll, markProgrammaticReadingScroll } from '@agentmux/client-ui/reading-scroll'
import { MessageDeliveryFailure } from '@agentmux/client-ui/components/MessageDeliveryFailure'
import { presentMessageDeliveryFailure } from '@agentmux/client-ui/message-delivery-presentation'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { mobileQuestionReplyState, reconcileMobileQuestionReplies, submitMobileQuestionReply } from './question-replies'
import { questionReplyKey } from '@agentmux/client-ui/conversation-question-reply'
import { DeliveryLogDetails } from '@agentmux/client-ui/components/DeliveryLogDetails'
import { initFollowState, onContentChange, onScroll, shouldShowJumpToLatest } from '@agentmux/client-ui/activity-autoscroll'
import { currentAgentSemanticStatus, nativeTargetSourceUnconfirmed } from '@agentmux/core/agent-status'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createMobileMoteInputReader } from './mote-input-reader'
import { createPortal } from 'react-dom'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { mintObjectId } from '@agentmux/core/object-id'
import type { AgentInputMoteSource, AgentSessionUserMessage } from '@agentmux/core'
import type { InputHistoryRead } from '@agentmux/client-ui/use-agent-input-history'
import { inputHistoryText } from '@agentmux/client-ui/input-history-text'
import {
  AgentInteractionCard, ClientUiProvider, NativeProcessObservation, ConversationView,
  createSpeakerResolver,
  type ClientUiPlatform, type ConversationMessageProps
} from '@agentmux/client-ui'
import { errorMessage } from './delivery'
import type { PromptAttempt, ResponseAttempt } from './local-drafts'
import { useMobileLocalDrafts } from './local-drafts-owner'
import type { MobileConnection } from './use-hosted-conversation'
import { useMobileConversationReading } from './use-mobile-conversation-reading'
import { MobileMessageTools, MobilePosturePicker } from './MobileMessageTools'
import { MobileSkillsPicker } from './MobileSkillsPicker'
import { MobileMailbox } from './MobileMailbox'
import { MobileAttachments, type MobileAttachmentControls } from './MobileAttachments'
import { fileUploadScopeMatches } from './attachments'
import type { ComposerInsertionHandle } from '@agentmux/client-ui/composer-insertion'
import type { ComposerSuggestion } from '@agentmux/client-ui/components/AgentComposer'
import { appendNamedFileReference } from '@agentmux/client-ui/composer-file-reference'
import { useMobilePromptController } from './use-mobile-prompt-controller'
import { useMobileInteractionController } from './use-mobile-interaction-controller'
import { MobileMoteSourceNotice } from './MobileMoteSourceNotice'
import { MobileMoteConversation, type MobileMoteWork, type MobileMoteDialogue } from './MobileMoteConversation'
import type { MoteDefaultConversation, MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { mobileMoteMainInputIssue, retainMobileMoteMain, type MobileMoteMainInput, type MobileMoteRolloverQuery } from './mote-main-input'
import { MobileMoteSpeakerAvatar } from './MobileMoteSpeakerAvatar'
import { agentProviderLabel } from '@agentmux/client-ui/components/AgentProviderIcon'
import type { AgentMuxSpaceAppearance } from '@agentmux/core/control'
import type { DescribeSpeaker } from '@agentmux/client-ui/conversation-speaker'
import './conversation.css'
import { DELIVERY_DISMISSAL_STORAGE, MobileNotice, MobileNoticeScope, useMobileNotices } from '../notices/MobileNotice'
import { useMobileWebAttachmentOwner, useMobileWebUpdateSafetyOwner } from '../mobile-web/update-safety'
import type { AttachmentPageOwner } from './attachment-page-owner'
import { mobileInteractionLabels } from '../presentation/interaction'
import { readMobileConversationSession } from './mobile-conversation-session'
import type { MobileConversationStatus } from './MobileConversationStatus'
import { MobileComposerSource, mobileSessionComposerSource, useMobileMoteComposer } from './mote-composer'

const inShellSlot = (target: HTMLElement | null | undefined, node: ReactNode) =>
  target === undefined ? node : target && node ? createPortal(node, target) : null

/** Touch has no hover. A completed click settles the active message's copy and details. */
function revealMessageActions(reading: HTMLElement, target: EventTarget) {
  if (!(target instanceof Element) || !reading.contains(target)) return
  if (reading.ownerDocument.getSelection()?.isCollapsed === false) return
  const message = target.closest('.log-turn')
  const wasRevealed = message?.hasAttribute('data-actions-revealed')
  // The clicked action has its target now. Do not collapse another message during focus,
  // which can move this target between pointerdown and click.
  for (const current of reading.querySelectorAll('.log-turn[data-actions-revealed]')) if (current !== message) current.removeAttribute('data-actions-revealed')
  if (target.closest('a, button, summary, input, textarea, select, label, [contenteditable="true"]') || !message || !reading.contains(message)) return
  if (wasRevealed) message.removeAttribute('data-actions-revealed')
  else message.setAttribute('data-actions-revealed', '')
}

/** A focused header has already been revealed. Keep that choice when focus moves to its body,
 * so a visible body action cannot move between pointerdown and click. */
function retainFocusedMessageActions(reading: HTMLElement, target: EventTarget) {
  if (!(target instanceof Element)) return
  const message = target.closest('.log-turn')
  if (!message || !reading.contains(message) || !message.querySelector(':scope > .log-turn__head')?.contains(target)) return
  if (!message.hasAttribute('data-actions-revealed')) message.setAttribute('data-actions-revealed', '')
}

const mobileConversationToolLabels: NonNullable<ClientUiPlatform['conversationToolLabels']> = {
  copy: '复制', copying: '正在复制…', copied: '已复制', retryCopy: '重新复制',
  formatJson: '格式化 JSON', formatJsonHint: '格式化便于阅读；复制时保留原文', input: '输入', output: '输出', self: '我'
}

export type { MobileConnection } from './use-hosted-conversation'
export type MobileConversationSurfaceProps = Pick<ConversationMessageProps,
  'openWorkspaceFile' | 'readPastedImage' | 'openHttpLink'> & {
  client: AgentMuxHostedClient | null
  agentSessionId: string | null
  moteSource?: AgentInputMoteSource | undefined
  connection: MobileConnection
  platform: ClientUiPlatform
  onStatusChange?(status: MobileConversationStatus): void
  onAttach?: () => void
  onShowTerminal?: () => void
  onShowGoals?: (trigger: HTMLButtonElement) => void
  toolbarTarget?: HTMLElement | null
  /** Header slots owned by the shell. Omitted renders inline; null renders nothing until the slot mounts. */
  statusTarget?: HTMLElement | null
  noticeTarget?: HTMLElement | null
  visible?: boolean
  displayName?: string
  moteMemberName?: ClientUiPlatform['moteMemberName'] | undefined
  moteTarget?: MotePreferencesTarget | undefined
  moteDialogue?: MobileMoteDialogue | undefined
  /** Explicit Main/member intent; absent is an ordinary Session surface. */
  moteDirectAgent?: boolean | undefined
  moteAppearance?: AgentMuxSpaceAppearance | undefined
  moteName?: string | undefined
  moteWorkMemberName?(source: MobileMoteWork): string
  onOpenMoteWork?(source: MobileMoteWork): void
  moteConfigurationIssue?: string | null | undefined
  onRefreshMoteConfiguration?: (() => void) | undefined
  onShowMoteThreads?(): void
  onMoteRolloverRequired?: ((query: MobileMoteRolloverQuery) => void) | undefined
  onReturnMoteMain?(reference?: MoteDefaultConversation): void
  attachmentOwner?: AttachmentPageOwner | undefined
}
/** A first-party SDK reader and input client. Core owns ordering, authorship and admission. */
export function MobileConversationSurface({ client, agentSessionId, moteSource, connection, platform, onStatusChange, onAttach, onShowTerminal, onShowGoals, toolbarTarget, statusTarget, noticeTarget, visible = true, displayName, moteMemberName, moteTarget, moteDialogue, moteDirectAgent, moteName, moteAppearance, moteWorkMemberName, onOpenMoteWork, onShowMoteThreads, moteConfigurationIssue, onRefreshMoteConfiguration, onMoteRolloverRequired, onReturnMoteMain, attachmentOwner: providedAttachmentOwner,
  openWorkspaceFile, readPastedImage, openHttpLink }: MobileConversationSurfaceProps) {
  const conversationIoPlatform = useMemo(() => ({ ...platform,
    readA2AMessage: async (reference: { hostId: string; agentSessionId: string }, messageId: string, notificationId?: string) => {
      // The selected hosted client owns the local namespace; it cannot route another Host or participant.
      if (!client) throw new Error('The selected Host is unavailable. The original message reference is retained.')
      if (reference.hostId !== 'local' || reference.agentSessionId !== agentSessionId) throw new Error('The original message belongs to another Host or Session. Its reference is retained.')
      return client.readMessage({ messageId, ...(notificationId === undefined ? {} : { notificationId }) })
    }
  }), [platform, client, agentSessionId])
  const feed = useRef<HTMLDivElement>(null)
  const { reading, readers, follow, presentation, presentationIntent, readingKey } = useMobileConversationReading(
    client, agentSessionId, moteTarget, visible && connection.state === 'connected', feed)
  const [jump, setJump] = useState(false)
  useLayoutEffect(() => { setJump(shouldShowJumpToLatest(follow.current)) }, [follow])
  useLayoutEffect(() => {
    const node = feed.current
    if (!visible || !node) return
    const tail = reading.page?.items.at(-1) ?? reading.timeline?.items.at(-1)
    const change = onContentChange(follow.current, { itemCount: reading.page?.items.length ?? reading.timeline?.items.length ?? 0, lastItemId: tail?.id ?? null, lastItemLength: tail ? JSON.stringify(tail).length : 0 })
    follow.current = change.state
    if (change.scrollToBottom && !reading.olderWindow) node.scrollTop = node.scrollHeight
  }, [reading.page, reading.timeline, reading.olderWindow, visible])
  const local = useMobileLocalDrafts(), composer = useMobileMoteComposer(), composerSource = mobileSessionComposerSource(agentSessionId)
  const drafts = useMemo(() => ({ current: composer?.text.local.drafts ?? local.drafts }), [local, composer?.text])
  const currentComposer = useRef(composer); currentComposer.current = composer
  const [, redraw] = useState(0)
  const [copyNotice, setCopyNotice] = useState<string | null>(null)
  const notices = useMobileNotices()
  const [localDismissed, setDismissed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(DELIVERY_DISMISSAL_STORAGE)
      const parsed: unknown = raw ? JSON.parse(raw) : null
      return Array.isArray(parsed) ? new Set(parsed.filter((item): item is string => typeof item === 'string').slice(-64)) : new Set()
    } catch { return new Set() }
  })
  const dismissed = notices?.deliveryDismissed ?? localDismissed
  const updateDismissed = (mutate: (next: Set<string>) => void) => notices ? notices.updateDelivery(mutate) : setDismissed(previous => {
    const next = new Set(previous)
    mutate(next)
    try { localStorage.setItem(DELIVERY_DISMISSAL_STORAGE, JSON.stringify([...next].slice(-64))) } catch { /* Presentation preference only. */ }
    return next
  })
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const current = useRef({ client, agentSessionId })
  current.current = { client, agentSessionId }
  const refreshConversation = useCallback(async () => {
    if (current.current.client !== client || current.current.agentSessionId !== agentSessionId) return
    await reading.refresh()
  }, [client, agentSessionId, reading.refresh])
  const conversationStatus = useMemo<MobileConversationStatus>(() => ({ client, agentSessionId,
    session: reading.id === agentSessionId && reading.metadataClient === client ? reading.session : null,
    metadata: reading.id === agentSessionId && reading.metadataClient === client ? reading.metadata : { state: 'loading', issue: null },
    readingIssue: reading.id === agentSessionId && reading.metadataClient === client ? reading.notice : null,
    agentIssue: reading.id === agentSessionId && reading.metadataClient === client ? reading.agentIssue : null, connection, refresh: refreshConversation
  }), [client, agentSessionId, reading.id, reading.metadataClient, reading.session, reading.metadata, reading.notice, reading.agentIssue, connection, refreshConversation])
  useLayoutEffect(() => { onStatusChange?.(conversationStatus) }, [onStatusChange, conversationStatus])
  const mainObservation = useRef<MobileMoteMainInput | undefined>(undefined)
  const moteMain = moteDirectAgent ? undefined : retainMobileMoteMain(mainObservation.current,
    moteDialogue?.page?.main, moteTarget, agentSessionId)
  mainObservation.current = moteMain
  const moteMainIssue = moteDirectAgent ? undefined : mobileMoteMainInputIssue(moteDialogue?.page?.main, moteTarget, agentSessionId, Boolean(moteDialogue?.unavailable))
    ?? ((moteTarget || moteDirectAgent === false) && !moteMain ? '主对话角色还没核对。可以重新核对，或从 Threads 打开之前的 Agent。' : undefined)
  const { draftKey, textDraftKey, draft, attempt, available, diagnostics, setDraft, submit, sendBodyOnly, confirmedAttachmentPrompt, retryOriginalPrompt, stopManualInput, preparing, preparationIssue, preparationDetail,
    historyLocalEntries, retainedAttempts, sessionAttempts, promptWasRefused, hasAnyPreparation, isDispatchedPrompt, hasPendingAction, cancelPendingAction, cancelPreparation } = useMobilePromptController({ local, textDraft: composer?.text,
      isTextTargetCurrent: composer ? () => composer.sourceCurrent(composerSource) : undefined,
      client, agentSessionId, moteSource, moteMain, moteMainIssue, moteDirectAgent, onRolloverRequired: onMoteRolloverRequired,
      session: conversationStatus.session, sessionState: conversationStatus.metadata.state, timeline: reading.timeline, connection, disconnected: reading.disconnected, visible, refresh: reading.refresh })
  useMobileWebUpdateSafetyOwner(() => {
    if (local.saveIssue || local.recordChanged || local.hasUnconfirmedSave) return '草稿或操作尚未确认保存在设备上。请先恢复设备存储并保存，再更新网页。'
    if (hasAnyPreparation() || [...local.attempts.entries()].some(([key, item]) => item.phase === 'sending' && !isDispatchedPrompt(key, item)) ||
      [...local.responses.values(), ...local.questions.values()].some(item => item.phase === 'sending')) {
      return hasAnyPreparation() ? '附件消息还在准备。可以回到那个对话选择“取消发送准备”。' : '消息或答复仍在发送。请等确认后再更新网页。'
    }
    return null
  })
  const attachmentControls = useRef<MobileAttachmentControls>(null)
  const attachmentOwner = useMobileWebAttachmentOwner(providedAttachmentOwner)
  const [hasPendingAttachments, setHasPendingAttachments] = useState(false)
  const insertion = useRef<ComposerInsertionHandle>(null)
  const originalEditorTarget = () => mounted.current && (composer ? currentComposer.current?.text.token === composer.text.token &&
    currentComposer.current.sourceCurrent(composerSource) : currentComposer.current === null)
  const currentActivity = connection.state === 'connected' && reading.activity?.semantic === 'active'
  const retainedActivity = currentAgentSemanticStatus(reading.session?.semanticStatus)
  const workingObservedAt = currentActivity ? reading.activity?.observedAt
    : reading.activity?.lastKnownActivity?.state === 'working' ? reading.activity.lastKnownActivity.observedAt
      : retainedActivity?.state === 'working' ? retainedActivity.observedAt : undefined
  useEffect(() => {
    if (agentSessionId) void reconcileMobileQuestionReplies(local, agentSessionId, reading.session, client?.runtimeOwnerIdentity?.()?.runtimeId).then(changed => { if (changed && mounted.current) redraw(value => value + 1) })
  }, [reading.session, agentSessionId, client, local])

  const session = reading.session
  const isWorking = Boolean(session && (currentActivity || retainedActivity?.state === 'working'))
  const providerCapabilities = (() => {
    try {
      const provider = session?.providerId ? client?.catalog?.().find(entry => entry.id === session.providerId) : undefined
      return { route: provider?.capabilities.asyncQuestionReply, postureControl: provider?.postureControl, commands: provider?.composer?.commands }
    } catch (error) { return { route: undefined, postureControl: undefined, commands: undefined, issue: errorMessage(error) } }
  })()
  const questionCapability = { route: providerCapabilities.route, issue: providerCapabilities.issue }
  const postureControl = providerCapabilities.postureControl
  const [commandMenuOpen, setCommandMenuOpen] = useState(false)
  const [composerFocused, setComposerFocused] = useState(false)
  const mobileCommands = useMobileCommands({ client, agentSessionId, providerId: session?.providerId,
    commands: providerCapabilities.commands, visible, connected: connection.state === 'connected' && !reading.disconnected,
    demand: commandMenuOpen || composerFocused })
  const commandSuggestions = mobileCommands.commands
  const [referenceRequested, requestReferences] = useState(false)
  const onCompletionQuery = useCallback((query: { kind: string } | null) => requestReferences(query?.kind === 'reference'), [])
  const agentReferences = useMobileAgentReferences(client, agentSessionId, displayName, visible && referenceRequested)
  async function insertSuggestion(item: ComposerSuggestion) {
    if (!insertion.current) {
      setCopyNotice('编辑器还没准备好。')
      return
    }
    try {
      const original = { client, agentSessionId, editor: insertion.current }
      await original.editor.insert(() => mounted.current && current.current.client === original.client &&
        current.current.agentSessionId === original.agentSessionId && insertion.current === original.editor && originalEditorTarget()
        ? item.insertText ?? item.text : null, { separate: true })
    } catch (error) {
      setCopyNotice(errorMessage(error))
    }
  }
  async function interruptCurrentTurn() {
    if (!client?.signalAgent || !session || !agentSessionId) return
    try {
      const originalSession = client.agentSession(agentSessionId)
      if (originalSession.agentSessionId !== session.agentSessionId || originalSession.run.runId !== session.run.runId) {
        setCopyNotice('对话已变化，没有发送中断。')
        return
      }
      await client.signalAgent(originalSession.agentSessionId, { ...originalSession.run }, 'SIGINT')
      setCopyNotice(null)
    } catch (error) {
      setCopyNotice(`中断当前回复未确认：${errorMessage(error)}`)
    }
  }
  const postureAttempts = useRef(new Map<string, { operationId: string; pending: boolean }>())
  async function changePosture(modeId: string) {
    if (!client?.setAgentPosture || !session || !agentSessionId) return
    try {
      const originalSession = client.agentSession(agentSessionId)
      if (originalSession.agentSessionId !== session.agentSessionId || originalSession.run.runId !== session.run.runId) {
        setCopyNotice('对话已变化，没有切换模式。')
        return
      }
      const key = JSON.stringify([agentSessionId, originalSession.run.runId, modeId])
      const attempt = postureAttempts.current.get(key) ?? { operationId: mintObjectId(), pending: false }
      if (attempt.pending) return
      postureAttempts.current.set(key, attempt); attempt.pending = true
      try {
        const original = await client.inspectAgentPosture({ hostId: 'local', agentSessionId, operationId: attempt.operationId })
        let receipt = original.kind === 'operation' ? original.operation : null
        if (!receipt) {
          const declaration = await client.inspectAgentPosture({ hostId: 'local', agentSessionId, expectedRun: { ...originalSession.run } })
          if (declaration.kind !== 'declaration' || !declaration.control || !declaration.controlDigest) throw new Error('The original Provider declares no addressable posture control.')
          receipt = await client.setAgentPosture({ target: declaration.target, operationId: attempt.operationId, controlId: declaration.control.id, modeId, expectedControlDigest: declaration.controlDigest })
        }
        if (receipt.modeId !== modeId || receipt.target.expectedRun.runId !== originalSession.run.runId || receipt.outcome !== 'applied' || receipt.diskDurability !== 'confirmed')
          throw new Error(`Original posture intent ${attempt.operationId}: ${receipt.outcome}; durable ${receipt.diskDurability}. Inspect the same operation.`)
        postureAttempts.current.delete(key)
      } finally { attempt.pending = false }
      setCopyNotice(null)
    } catch (error) {
      setCopyNotice(`模式切换未完成：${errorMessage(error)}`)
    }
  }
  // A reader is scoped to its exact Host connection and persistent Agent, not to a replaceable Run.
  const historyConnection = useRef({ client, generation: 0 })
  if (historyConnection.current.client !== client) historyConnection.current = { client, generation: historyConnection.current.generation + 1 }
  const historyScope = JSON.stringify([historyConnection.current.generation, session?.hostId ?? null, agentSessionId])
  const currentHistory = useRef({ scope: historyScope, client, agentSessionId, visible })
  currentHistory.current = { scope: historyScope, client, agentSessionId, visible }
  const readInputHistory = useCallback<InputHistoryRead>(async (input, signal) => {
    if (!client || !agentSessionId) throw new Error('Mac 还没连接。')
    const page = await client.readAgentSessionHistory({ ...input, hostId: 'local', agentSessionId }, { signal })
    if (page.agentSessionId !== agentSessionId || page.hostId !== 'local') throw new Error('历史返回了另一个 Agent 的记录，没有采用。')
    return page
  }, [client, agentSessionId])
  async function readHistoryMessage(message: AgentSessionUserMessage, signal: AbortSignal) {
    const original = { scope: historyScope, client, agentSessionId, visible }
    const unchanged = () => mounted.current && currentHistory.current.scope === original.scope &&
      currentHistory.current.client === original.client && currentHistory.current.agentSessionId === original.agentSessionId &&
      currentHistory.current.visible === original.visible
    signal.throwIfAborted()
    if (!unchanged() || message.agentSessionId !== original.agentSessionId) throw new Error('已切换 Agent，当前草稿没有改变。')
    const content = await inputHistoryText(message, original.client && original.agentSessionId ? input =>
      original.client!.sessionHistoryResource(original.agentSessionId!, { ...input, signal }) : undefined, signal)
    signal.throwIfAborted()
    if (!unchanged()) throw new Error('已切换 Agent，当前草稿没有改变。')
    return content
  }
  function currentHistoryTarget(scope: string) {
    return mounted.current && currentHistory.current.scope === scope && currentHistory.current.client === client &&
      currentHistory.current.agentSessionId === agentSessionId && currentHistory.current.visible
  }
  async function fillHistoryMessage(message: AgentSessionUserMessage, signal: AbortSignal) {
    const originalScope = historyScope, originalEditor = insertion.current
    const before = drafts.current.get(textDraftKey) ?? ''
    const content = await readHistoryMessage(message, signal)
    signal.throwIfAborted()
    if (!currentHistoryTarget(originalScope) || insertion.current !== originalEditor || !originalEditorTarget()) throw new Error('编辑器或 Agent 已切换，当前草稿没有改变。')
    if ((drafts.current.get(textDraftKey) ?? '') !== before) throw new Error('读取期间草稿已更新，保留新稿；可重新选择这条记录。')
    if (!originalEditor) throw new Error('编辑器已关闭。')
    originalEditor.replace(content.text)
    return content.attachments ? '已填入正文，还没发送。附件仍在那条记录里。' : undefined
  }
  async function copyHistoryMessage(message: AgentSessionUserMessage, signal: AbortSignal) {
    const originalScope = historyScope
    const content = await readHistoryMessage(message, signal)
    signal.throwIfAborted()
    if (!currentHistoryTarget(originalScope)) throw new Error('已切换 Agent，这次没有复制。')
    let cause: unknown
    const copied = await platform.copyText(content.originalText, error => { cause = error })
    signal.throwIfAborted()
    if (!copied && cause) throw cause
    return copied
  }
  const { request, requestKey, responseUnavailableReason, responseEntry, responseAttempt, responseDisabled,
    respond, inspectResponse, retainedResponses, unidentifiedResponses } = useMobileInteractionController({ local, client,
      agentSessionId, session, available })
  function responseStatus(key: string, attempt: ResponseAttempt) {
    return <aside key={key} className="mobile-send-status" data-phase={attempt.phase} data-original-response={attempt.original!.input.operationId}>
      <MobileNotice identity={[attempt.original?.input.operationId,attempt.phase,attempt.message]} role="status">
        <span className="mobile-send-status__line" title={attempt.message}>{attempt.message}</span>
        <button type="button" onClick={() => { void inspectResponse(key, attempt).catch(() => {}) }}>查询答复结果</button>
      </MobileNotice>
    </aside>
  }
  const mainAvatar = useCallback((size?: number) => <MobileMoteSpeakerAvatar spaceId={moteTarget?.spaceId ?? ''} name={moteName ?? 'Mote'} appearance={moteAppearance} {...(size === undefined ? {} : { size })} />,
    [moteTarget?.spaceId, moteName, moteAppearance])
  const describeSpeaker = useMemo<DescribeSpeaker>(() => {
    const original = createSpeakerResolver({
    lookupAgent: id => {
      try {
        const author = session?.agentSessionId === id ? session : client?.agentSession(id)
        return author?.agentSessionId === id ? { label: author.agentSessionId === agentSessionId && displayName ? displayName : agentProviderLabel(author.providerId), providerId: author.providerId } : undefined
      } catch { return undefined }
    },
    ...(session ? { currentSession: { id: session.agentSessionId, label: displayName ?? agentProviderLabel(session.providerId), providerId: session.providerId } } : {})
    })
    const main = moteDialogue?.page?.main.current, owner = reading.pageOwner
    return (speaker, size) => {
      const prior = original(speaker, size)
      return moteTarget && main && owner?.client === client && owner.agentSessionId === agentSessionId && main.hostId === owner.hostId && main.sessionId === agentSessionId && speaker.role === 'agent' && speaker.id === agentSessionId
        ? { ...prior, name: moteName ?? prior.name, avatar: mainAvatar(size) } : prior
    }
  }, [client, session, agentSessionId, displayName, moteDialogue?.page?.main.current, reading.pageOwner, moteTarget, moteName, mainAvatar])
  // Source-history search is keyed by original records, independently of message entities.
  const mailboxMessages = useMemo(() => reading.projection?.originalRecords.flatMap(record => record.input ? [record.input] : []) ?? [], [reading.projection])
  const appendQuote = (quote: string) => setDraft(`${drafts.current.get(textDraftKey) ?? ''}${drafts.current.get(textDraftKey) ? '\n\n' : ''}${quote}`)
  const readHistoryResource = useCallback<NonNullable<ConversationMessageProps['readHistoryResource']>>(input => {
    if (!client || !agentSessionId) throw new Error('Mac 还没连接，暂时打不开这个资源。')
    return client.sessionHistoryResource(agentSessionId, input)
  }, [client, agentSessionId])
  const pageClient = reading.pageOwner?.client, pageSessionId = reading.pageOwner?.agentSessionId
  const readMoteInput = useMemo(() => createMobileMoteInputReader(pageClient ?? null, pageSessionId ?? null), [pageClient, pageSessionId])
  const conversationPlatform = useMemo(() => ({ ...conversationIoPlatform,
    conversationToolLabels: mobileConversationToolLabels,
    messageLayout: 'stacked' as const,
    readMoteInput,
    moteMemberName: (...args: Parameters<NonNullable<ClientUiPlatform['moteMemberName']>>) =>
      pageClient === client && pageSessionId === agentSessionId ? moteMemberName?.(...args) : undefined
  }), [conversationIoPlatform, readMoteInput, moteMemberName, pageClient, pageSessionId, client, agentSessionId])
  const readNativeResource = useCallback<NonNullable<ConversationMessageProps['readHistoryResource']>>(input => {
    if (!pageClient || !pageSessionId) throw new Error('还没确认对话的来源，暂时打不开这个资源。')
    return pageClient.sessionHistoryResource(pageSessionId, input)
  }, [pageClient, pageSessionId])
  const readingProps = {
    active: visible,
    ...(session ? { workspaceRoot: session.workspacePath, executionHostId: session.hostId } : {}),
    ...(client && agentSessionId ? { readHistoryResource } : {}),
    ...(openWorkspaceFile ? { openWorkspaceFile } : {}), ...(readPastedImage ? { readPastedImage } : {}),
    ...(openHttpLink ? { openHttpLink } : {}),
    onSelectAnnotation: ({ messageId, quote }: Parameters<NonNullable<ConversationMessageProps['onSelectAnnotation']>>[0]) =>
      appendQuote(`引用会话 ${JSON.stringify(agentSessionId)}，消息 ${JSON.stringify(messageId)}：\n${quote.split('\n').map(line => `> ${line}`).join('\n')}`)
  }
  const { executionHostId: _currentHost, workspaceRoot: _currentWorkspace, ...sharedReadingProps } = readingProps
  const nativeReadingProps = { ...sharedReadingProps,
    ...(reading.pageOwner?.hostId ? { executionHostId: reading.pageOwner.hostId } : {}),
    workspaceRoot: reading.pageOwner?.workspacePath ?? '', readHistoryResource: readNativeResource }
  const renderPromptAttempt = ([key, original]: [string, PromptAttempt]) => {
    const waiting = original.inputReceipt?.control.waiting
    const failure = waiting?.phase === 'native-environment' ? waiting.observation?.failure : waiting?.failure
    const signature = JSON.stringify([key, original.operationId, original.phase, original.phase === 'confirmed' ? original.logId ?? null : null,
      original.inputReceipt?.status ?? null, original.inputReceipt?.ref.waitGeneration ?? null, original.manualInput?.stopReceipt?.cancelOperationId ?? null])
    const clearDismissedForOperation = () => updateDismissed(set => {
      for (const item of [...set]) if (item.includes(JSON.stringify(original.operationId))) set.delete(item)
    })
    const controlledManual = Boolean(original.manualInput && (original.inputReceipt || original.phase === 'sending'))
    if (original.phase !== 'sending' && dismissed.has(signature) && !hasPendingAction(key, 'retry') && !hasPendingAction(key, 'stop')) {
      const summary = controlledManual
        ? presentMessageDeliveryFailure({ error: failure ?? diagnostics.get(original.logId ?? '')?.record.error ?? original.message,
            logId: original.logId, log: original.logId ? diagnostics.get(original.logId) : undefined,
            inputReceipt: original.inputReceipt, inputStopReceipt: original.manualInput?.stopReceipt }).title
        : original.phase === 'unknown' ? '发送结果未确认 · 草稿已保留' : '尚未发送 · 草稿已保留'
      return <aside className="mobile-send-status mobile-send-status--collapsed" key={key} data-phase={original.phase}
        data-collapsed="true" data-manual={Boolean(original.manualInput) || undefined} data-retained={key !== draftKey || undefined}
        data-original-operation={original.operationId} aria-live="polite">
        <span className="mobile-send-status__collapsed-title">{summary}</span>
        <div className="mobile-send-status__actions">
          <button type="button" aria-label="查看发送结果" onClick={() => updateDismissed(set => set.delete(signature))}>查看结果</button>
        </div>
      </aside>
    }
    return <aside
          className="mobile-send-status" key={key} data-phase={original.phase} data-manual={Boolean(original.manualInput) || undefined} data-retained={key !== draftKey || undefined}
          data-original-operation={original.operationId} aria-live="polite">
          {(hasPendingAction(key, 'retry') || hasPendingAction(key, 'stop')) && <div className="mobile-send-status__actions">
            {hasPendingAction(key, 'retry') && <button type="button" onClick={() => cancelPendingAction(key, 'retry')}>取消未发起的重试</button>}
            {hasPendingAction(key, 'stop') && <button type="button" onClick={() => cancelPendingAction(key, 'stop')}>取消未发起的停止</button>}
          </div>}
          {controlledManual ? <>
            {original.phase === 'sending' && !original.inputReceipt ? <p role="status">正在保存这条消息…</p>
              : original.phase === 'confirmed' && !original.inputReceipt ? <p role="status">之前的输入已送达，最新状态还没读到。这不代表任务已完成。</p>
              : <MessageDeliveryFailure compact error={failure ?? diagnostics.get(original.logId ?? '')?.record.error ?? original.message}
              logId={original.logId} log={original.logId ? diagnostics.get(original.logId) : undefined}
              inputReceipt={original.inputReceipt} inputStopReceipt={original.manualInput!.stopReceipt}
              onRetry={original.phase === 'confirmed' ? undefined : () => { clearDismissedForOperation(); void retryOriginalPrompt(key) }}
              onDismiss={() => updateDismissed(set => set.add(signature))}
              copyText={text => platform.copyText(text, error => setCopyNotice(errorMessage(error)))} />}
            {(original.inputReceipt?.status === 'waiting' || original.inputReceipt?.status === 'not-applied' || key !== draftKey || onShowTerminal) ? <div className="mobile-send-status__actions">
              {original.inputReceipt?.status === 'waiting' ? <button type="button" onClick={() => { void stopManualInput(key, original) }}>
                {original.manualInput!.stopIntent && !original.manualInput!.stopReceipt ? '重试停止等待' : '停止等待'}</button> : null}
              {original.inputReceipt?.status === 'not-applied' ? <button type="button" onClick={() => { clearDismissedForOperation(); void submit(true, original, key) }}>重新发送</button> : null}
              {key !== draftKey ? <button type="button" onClick={() => { void platform.copyText(original.draft, error => setCopyNotice(errorMessage(error))) }}>复制正文</button> : null}
              {onShowTerminal ? <button type="button" onClick={onShowTerminal}>终端</button> : null}
            </div> : null}
          </> : <>
          <div className="mobile-send-status__summary">
            <span>{original.phase === 'sending' ? '正在发送…' : key !== draftKey
              ? original.phase === 'unknown' ? '之前的消息还没确认送达' : '之前的消息没有发送'
              : original.phase === 'unknown' ? '发送结果未确认 · 草稿已保留' : '尚未发送 · 草稿已保留'}</span>
            {original.phase !== 'sending' ? <div className="mobile-send-status__actions">
              <button type="button" onClick={() => { clearDismissedForOperation(); void retryOriginalPrompt(key) }}>{original.moteMain ? '核对主对话消息' : promptWasRefused(original) ? '重新发送' : key === draftKey ? '重试发送' : '重试这条消息'}</button>
              <button type="button" onClick={() => { void reading.refresh() }}>刷新</button>
              <button type="button" className="mobile-send-status__dismiss" aria-label="关闭操作说明" title="关闭操作说明" onClick={() => updateDismissed(set => set.add(signature))}>收起</button>
            </div> : null}
          </div>
          {original.phase !== 'sending' ? <details className="mobile-send-status__diagnosis"><summary>发送详情</summary>
            <p>{original.moteMain ? '核对只查询这次发送的结果，不会改发给新的主 Agent。' : original.phase === 'unknown' ? 'Mac 尚未确认这次发送；正文已保留。核对后可重试同一次请求。' : '这条消息尚未发送；正文已保留，可核对原因后重试。'}</p>
            <details><summary>消息正文</summary><pre>{original.draft}</pre>
              <button type="button" onClick={() => { void platform.copyText(original.draft, error => setCopyNotice(`正文没有复制：${errorMessage(error)}`))
                .then(copied => { if (copied) setCopyNotice('已复制正文。') }) }}>复制正文</button>
            </details>
            <details><summary>技术信息</summary><p role="alert">{original.message}</p>
              <dl><dt>操作</dt><dd>{original.operationId}</dd><dt>运行</dt><dd>{original.runId ?? '尚未确认'}</dd></dl>
              {original.logId ? <DeliveryLogDetails log={diagnostics.get(original.logId)} logId={original.logId} copyText={text => platform.copyText(text, error => setCopyNotice(errorMessage(error)))} /> : null}
            </details>
            {onShowTerminal ? <button type="button" onClick={onShowTerminal}>终端</button> : null}
          </details> : null}</>}
        </aside>
  }
  const conversationTools = (
    <div className="mobile-conversation__floating-tools" role="group" aria-label="对话工具">
      {onShowGoals && <button type="button" className="mobile-conversation__goal" aria-label="目标与结果" title="目标与结果" onClick={event => onShowGoals(event.currentTarget)}><SemanticIcon name="object.goal" size={18} /></button>}
      <MobileMailbox key={historyConnection.current.generation} client={client} session={session} connected={connection.state === 'connected'} messages={mailboxMessages} platform={platform} describeSpeaker={describeSpeaker}
      {...(reading.projection ? { inputs: reading.projection.inputs } : {})}
      {...(reading.projection?.timeline.reference?.hostId ? { sourceHostId: reading.projection.timeline.reference.hostId } : {})}
      refresh={() => { void reading.refresh() }} historyScope={historyScope} readHistory={readInputHistory} visible={visible}
      onHistoryFill={fillHistoryMessage} onHistoryCopy={copyHistoryMessage} localEntries={historyLocalEntries}
      promptAttempts={sessionAttempts} diagnostics={diagnostics}
      onHistoryFillLocal={entry => {
        if (currentHistory.current.scope !== historyScope || current.current.client !== client || current.current.agentSessionId !== agentSessionId)
          throw new Error('已切换 Agent，当前草稿没有改变。')
        if (!insertion.current) throw new Error('编辑器已关闭。')
        insertion.current.replace(entry.text)
      }}
      reading={readingProps}
      {...(onShowTerminal ? { terminal: onShowTerminal } : {})} />
    </div>
  )

  return <ClientUiProvider platform={conversationPlatform}><MobileNoticeScope owner={client} identity={[ agentSessionId, session?.run.runId]}>
    <section className="mobile-conversation" aria-label="会话" data-agent-surface-mode="activity" data-agent-session-id={agentSessionId ?? ''}>
      {readers}
      {questionCapability.issue ? <MobileNotice identity={[questionCapability.issue]} className="mobile-conversation__notice" role="status">
        异步问题能力观察未确认，普通输入照常可用。{questionCapability.issue}
        <button type="button" onClick={() => redraw(value => value + 1)}>重新核对问题能力</button>
      </MobileNotice> : null}
      {local.notice ? <MobileNotice identity={[local.notice]} className="mobile-conversation__notice" role="status">{local.notice}
        {local.canSave ? <button type="button" onClick={() => { void local.save().then(() => { if (mounted.current) redraw(value => value + 1) }); redraw(value => value + 1) }}>重试保存</button> : null}
        <button type="button" disabled={!draft} onClick={() => {
          void platform.copyText(draft, error => setCopyNotice(`草稿未复制：${errorMessage(error)}`))
            .then(copied => { if (copied) setCopyNotice('已复制当前草稿。') })
        }}>复制当前草稿</button>
        {local.recordChanged ? <button type="button" onClick={() => {
          void platform.copyText(local.exportBackup(), error => setCopyNotice(`本页备份未复制：${errorMessage(error)}`))
            .then(copied => { if (copied) setCopyNotice('已复制本页备份，包含正文和操作记录。') })
        }}>复制本页保全备份</button> : null}
      </MobileNotice> : null}
      {local.conflicts.filter(item => item.key === draftKey || item.key === textDraftKey).length > 0 && <details className="mobile-conversation__notice"><summary>保全的冲突内容</summary>
        {local.conflicts.filter(item => item.key === draftKey || item.key === textDraftKey).map((item, index) => {
          const body = typeof item.value === 'string' ? item.value : Array.isArray(item.value) ? item.value.map(answer => answer.answer).join('\n') : 'draft' in item.value ? item.value.draft : 'input' in item.value ? item.value.input.answers.map(answer => answer.answer).join('\n') : '这条答复还没确认送达。'
          return <div key={index}>{typeof item.value !== 'string' && <p>请求记录已保留，可以核对结果。</p>}<pre>{body}</pre><button type="button" onClick={() => { void platform.copyText(body, error => setCopyNotice(errorMessage(error))) }}>复制这份保全内容</button></div>
        })}
      </details>}
      <div className="mobile-conversation__reader">
      <div ref={feed} className="mobile-conversation__reading" onClick={event => revealMessageActions(event.currentTarget, event.target)} onFocusCapture={event => retainFocusedMessageActions(event.currentTarget, event.target)} onScroll={event => {
        const node = event.currentTarget
        const programmatic = consumeProgrammaticReadingScroll(node)
        follow.current = programmatic === 'restore' ? { ...follow.current, lastScrollTop: node.scrollTop } : onScroll(follow.current, { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight })
        setJump(shouldShowJumpToLatest(follow.current))
      }}>
        {(reading.page?.nextCursor || reading.capturedHasMore) && <button className="mobile-reading-action" disabled={reading.reading} onClick={() => { follow.current.following = false; void reading.older() }}>更早消息</button>}
        {reading.hasNewer && <button className="mobile-reading-action" disabled={reading.reading} onClick={() => { void reading.newer() }}>较新消息</button>}
        {inShellSlot(statusTarget, conversationStatus.metadata.state === 'retired' ? <span className="mobile-conversation-history-state">历史对话</span> : workingObservedAt !== undefined ? <span className="mobile-active-state" role="status" data-activity-current={currentActivity}
          title={`最后观察：${new Date(workingObservedAt).toLocaleString()}`}><SemanticIcon name="status.presence-working" size={5} />{currentActivity ? '正在执行' : '最近观察：执行中'}</span> : null)}
        {inShellSlot(noticeTarget, !moteDirectAgent && moteTarget ? <MobileMoteSourceNotice roleIssue={moteMainIssue} readingIssue={moteDialogue?.issue} configurationIssue={moteConfigurationIssue}
          refresh={() => { moteDialogue?.refresh(); onRefreshMoteConfiguration?.() }} onMain={onReturnMoteMain} /> : null)}
        {agentSessionId ? <MobileMoteConversation client={pageClient ?? null} agentSessionId={pageSessionId ?? agentSessionId} hostId={reading.pageOwner?.hostId}
          issuePresented={!moteDirectAgent && Boolean(moteTarget)} target={!moteDirectAgent && pageClient === client && pageSessionId === agentSessionId ? moteTarget : undefined} dialogue={moteDialogue} name={moteName ?? 'Mote'}
          visible={visible} describeSpeaker={describeSpeaker}
          mainAvatar={mainAvatar}
          {...(moteWorkMemberName ? { memberName: moteWorkMemberName } : {})} {...(onOpenMoteWork ? { onOpenWork: onOpenMoteWork } : {})}
          {...(onShowMoteThreads ? { onShowThreads: onShowMoteThreads } : {})}
          readingGeometry={{ viewport: () => feed.current, following: () => follow.current.following && !reading.olderWindow,
            pinToBottom: () => { if (feed.current) { feed.current.scrollTop = feed.current.scrollHeight; markProgrammaticReadingScroll(feed.current) } } }}
          renderCurrent={insertions => <ConversationView key={readingKey} insertions={insertions}
            readProcessDetail={reading.readProcessDetail} sourceLabelsInDetails detailsOnlyMetadata coverageSummary="阅读范围与来源" readingGeometry={{ viewport: () => feed.current,
            following: () => follow.current.following && !reading.olderWindow,
            pinToBottom: () => { if (feed.current) { feed.current.scrollTop = feed.current.scrollHeight; markProgrammaticReadingScroll(feed.current) } } }} presentation={{ controller: presentation, pending: reading.held, onRelease: reading.acceptHeld, intent: presentationIntent.current }} page={reading.page} readActivity={reading.readActivity} timeline={reading.timeline ?? undefined} questionAnswerContext={reading.answerContext} records={reading.projection?.records ?? []} originalRecords={reading.projection?.originalRecords ?? []} coverage={reading.projection?.timeline.coverage ?? []} showInputSource={false} sessionId={agentSessionId} describeSpeaker={describeSpeaker}
            renderProcess={props => <NativeProcessObservation {...props} compact />}
            questionReplyState={target => {
              const state = mobileQuestionReplyState(local, agentSessionId, target), original = state?.original
              return original && (original.hostId !== reading.pageOwner?.hostId || original.runtimeId &&
                original.runtimeId !== pageClient?.runtimeOwnerIdentity()?.runtimeId) ? undefined : state
            }}
            questionReplyDraft={target => local.questionDrafts.get(questionReplyKey(agentSessionId, target))}
            onQuestionDraftChange={(target, answers) => {
              local.questionDrafts.set(questionReplyKey(agentSessionId, target), structuredClone(answers))
              void local.save().then(() => { if (mounted.current) redraw(value => value + 1) })
            }}
            onQuestionReply={input => submitMobileQuestionReply(local, agentSessionId, pageClient ?? null, input,
              () => { if (mounted.current) redraw(value => value + 1) }, pageClient === client ? moteSource : undefined)}
            questionDraftNotice={local.notice ?? undefined}
            questionReplyRoute={questionCapability.route}
            questionReplyTarget={pageClient === client && session && !nativeTargetSourceUnconfirmed(session) && session.nativeHandle?.kind === 'provider' ? {
              source: { providerId: session.nativeHandle.providerId, nativeSessionId: session.nativeHandle.sessionId }, run: session.run
            } : undefined}
            questionReplyContext={JSON.stringify([session?.hostId, agentSessionId, session?.run.runId, client?.runtimeOwnerIdentity?.()?.runtimeId])}
            {...(onShowTerminal && pageClient === client ? { onOpenQuestionTerminal: onShowTerminal } : {})}
            {...(reading.page ? nativeReadingProps : readingProps)} />} />
          : !reading.reading ? <p className="mobile-conversation__empty">暂无已确认的对话内容，可发送消息或查看 Terminal。</p> : null}
      </div>
        {toolbarTarget ? createPortal(conversationTools, toolbarTarget) : null}
      </div>
      {(jump || reading.newerAvailable || reading.olderWindow) && <button className="mobile-reading-action mobile-reading-latest" onClick={() => {
        follow.current = initFollowState(); presentationIntent.current++; setJump(false)
        if (reading.olderWindow || reading.newerAvailable) void reading.refresh()
        else if (feed.current) feed.current.scrollTop = feed.current.scrollHeight
      }}>{reading.newerAvailable ? '有新回复 · 回到最新' : '回到最新'}</button>}
      {request && requestKey ? <div className="mobile-conversation__interaction">
        <AgentInteractionCard key={requestKey} request={request} labels={mobileInteractionLabels} disabled={responseDisabled}
          getMoteSource={() => moteSource}
          {...(responseAttempt?.phase === 'unknown' ? { responseUnavailableReason: responseAttempt.message } : responseUnavailableReason ? { responseUnavailableReason } : {})}
          responseStatus={responseAttempt?.original ? responseStatus(responseEntry![0], responseAttempt) : undefined}
          {...(onShowTerminal ? { onOpenTerminal: onShowTerminal } : {})}
          onRespond={respond} />
      </div> : null}
      {retainedResponses.map(([key, attempt]) => responseStatus(key, attempt))}
      {unidentifiedResponses.map(([key, attempt]) => <MobileNotice identity={[key,attempt.original?.input.operationId,attempt.phase,attempt.message]} key={key} role="status">{attempt.message}</MobileNotice>)}
      <div className="mobile-conversation__composer">
        <MobileComposerSource sourceKey={composerSource} insertionRef={insertion}
          onFocusCapture={event => { if ((event.target as HTMLElement).isContentEditable) setComposerFocused(true) }}
          onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setComposerFocused(false) }}
          aboveInput={<MobileAttachments owner={attachmentOwner} client={client} session={session ?? null} agentSessionId={agentSessionId}
          connected={connection.state === 'connected' && !reading.disconnected} controls={attachmentControls}
          onPendingContentChange={setHasPendingAttachments}
          promptOperationId={attempt?.operationId ?? null} confirmedPrompt={confirmedAttachmentPrompt}
          onSendBodyOnly={sendBodyOnly}
          onCancelPreparation={() => cancelPreparation()} preparing={preparing}
          bodyOnlyDisabled={!draft.trim() || attempt?.phase === 'sending'}
          insert={async (resolve, original) => {
            const originalClient = current.current.client, selectedId = current.current.agentSessionId
            const selected = originalClient && selectedId ? (await readMobileConversationSession(originalClient, selectedId)).session : null
            if (!originalEditorTarget() || current.current.client !== originalClient || current.current.agentSessionId !== selectedId ||
              !fileUploadScopeMatches(original, { runtimeId: originalClient?.runtimeOwnerIdentity?.()?.runtimeId ?? null,
              hostId: selected?.hostId ?? null, sessionId: selectedId, runId: selected?.run.runId ?? null }) || !insertion.current) {
              throw new Error('当前编辑器属于另一个对话或另一台 Mac，草稿没有改变。')
            }
            await insertion.current.insert(async () => {
              const path = await resolve()
              if (path === null) return null
              const selectedId = current.current.agentSessionId, client = current.current.client
              const selected = client && selectedId ? (await readMobileConversationSession(client, selectedId)).session : null
              if (!originalEditorTarget() || current.current.client !== originalClient || client !== originalClient || current.current.agentSessionId !== selectedId ||
                !fileUploadScopeMatches(original, { runtimeId: client?.runtimeOwnerIdentity?.()?.runtimeId ?? null,
                hostId: selected?.hostId ?? null, sessionId: selectedId, runId: selected?.run.runId ?? null })) {
                throw new Error('附件已上传，但编辑器已切换，草稿没有改变。')
              }
              return appendNamedFileReference('', path, original.identity.name)
            }, { separate: true })
          }} />}
          active={visible} onCompletionQuery={onCompletionQuery}
          commands={commandSuggestions} promptKeywords={mobileCommands.promptKeywords} references={agentReferences.references}
          {...(agentReferences.issue ? { completionFeedback: agentReferences.issue } : {})}
          tools={referenceTools => <MobileMessageTools referenceTools={referenceTools} refresh={() => { void reading.refresh() }}
            key={JSON.stringify([historyScope, session?.providerId])}
            commands={commandSuggestions} onCommand={item => { void insertSuggestion(item) }}
            onCommandsOpenChange={setCommandMenuOpen} commandsLoading={mobileCommands.loading}
            commandsIssue={mobileCommands.issue} retryCommands={mobileCommands.retry}
            skills={<MobileSkillsPicker client={client} session={session} scope={JSON.stringify([historyScope, session?.providerId, session?.workspacePath, session?.run.runId])}
              connected={connection.state === 'connected' && !reading.disconnected} visible={visible} onSelect={item => { void insertSuggestion(item) }} />}
            {...(isWorking && available && Boolean(draft.trim()) ? { onInterrupt: () => { void interruptCurrentTurn() } } : {})} />}
          {...(postureControl && available && reading.activity?.process !== 'exited' && reading.activity?.process !== 'interrupted' ? { postureTool:
            <MobilePosturePicker control={postureControl} disabled={!available} onSet={modeId => { void changePosture(modeId) }} />
          } : {})}
          {...(postureControl && available && !reading.activity ? { feedback: <MobileNotice identity={[session?.run.runId]} className="composer-feedback" role="status">运行状态未确认，模式切换以 Mac 的结果为准。</MobileNotice> } : {})}
          primaryAction={isWorking && !draft.trim() && !hasPendingAttachments ? 'stop' : 'send'}
          {...(isWorking && available ? { onInterrupt: () => { void interruptCurrentTurn() } } : {})}
          value={draft} disabled={false} placeholder={connection.state !== 'connected' || reading.disconnected ? '离线草稿' : conversationStatus.metadata.state === 'retired' || conversationStatus.metadata.state === 'deleted' ? '保留一份草稿' : '发消息'}
          hasPendingContent={hasPendingAttachments}
          onChange={setDraft} {...(conversationStatus.metadata.state !== 'retired' && conversationStatus.metadata.state !== 'deleted' && attempt?.phase !== 'sending' && !preparing ? {
            onSubmit: () => void submit(true, undefined, draftKey, attachmentControls.current?.captureForSend()),
            onQueue: () => void submit(false, undefined, draftKey, attachmentControls.current?.captureForSend())
          } : {})}
          onAttach={onAttach ?? (() => { void attachmentControls.current?.choose() })}
          onPasteImage={file => { void attachmentControls.current?.stageFile(file) }}
          onDropFiles={files => { void attachmentControls.current?.stageFiles(files) }}
          {...(readPastedImage ? { readPastedImage } : {})}
          />
        <div className="mobile-composer-feedback">
        {preparationIssue ? <MobileNotice identity={[agentSessionId,preparationIssue]} role="status" className="mobile-compact-notice">{preparationDetail
          ? <details><summary>{preparationIssue}</summary><p className="mobile-compact-notice__detail">{preparationDetail}</p></details>
          : <p>{preparationIssue}</p>}</MobileNotice> : null}
        {attempt && (attempt.phase !== 'confirmed' || Boolean(attempt.logId)) ? renderPromptAttempt([draftKey, attempt]) : null}
        {retainedAttempts.length ? <details className="mobile-retained-prompts"><summary>保留的消息 ({retainedAttempts.length})</summary>
          {retainedAttempts.map(renderPromptAttempt)}
        </details> : null}
        {copyNotice ? <MobileNotice kind="feedback" identity={[copyNotice]} role="status">{copyNotice}</MobileNotice> : null}
        </div>
      </div>
    </section>
  </MobileNoticeScope></ClientUiProvider>
}
