import { initFollowState, onContentChange, onScroll, shouldShowJumpToLatest } from '@agentmux/client-ui/activity-autoscroll'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxInteractionResponse } from '@agentmux/core'
import { agentPromptCondition } from '@agentmux/core/prompt-condition'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import {
  AgentComposer, AgentInteractionCard, ClientUiProvider, NativeProcessObservation, ConversationMessage, ConversationView,
  createSpeakerResolver, expandSemanticReferences, speakerOfUserMessage,
  type ClientUiPlatform, type ConversationMessageProps
} from '@agentmux/client-ui'
import { deliveryOutcome, errorMessage } from './delivery'
import { createLocalDrafts, type PromptAttempt, type ResponseAttempt } from './local-drafts'
import { useHostedConversation, type MobileConnection } from './use-hosted-conversation'
import { MobileMessageTools } from './MobileMessageTools'
import { CapturedConversationMessage } from '@agentmux/client-ui/components/CapturedConversationMessage'
import { MobileMailbox } from './MobileMailbox'
import './conversation.css'

export type { MobileConnection } from './use-hosted-conversation'
export type MobileConversationSurfaceProps = Pick<ConversationMessageProps,
  'openWorkspaceFile' | 'readPastedImage' | 'openHttpLink'> & {
  client: AgentMuxHostedClient | null
  agentSessionId: string | null
  connection: MobileConnection
  platform: ClientUiPlatform
  onAttach?: () => void
  onShowTerminal?: () => void
  visible?: boolean
  displayName?: string
}
/** A first-party SDK reader and input client. Core owns ordering, authorship and admission. */
export function MobileConversationSurface({ client, agentSessionId, connection, platform, onAttach, onShowTerminal, visible = true, displayName,
  openWorkspaceFile, readPastedImage, openHttpLink }: MobileConversationSurfaceProps) {
  const reading = useHostedConversation(client, agentSessionId, visible && connection.state === 'connected')
  const feed = useRef<HTMLDivElement>(null), follow = useRef(initFollowState())
  const [jump, setJump] = useState(false)
  useEffect(() => { follow.current = initFollowState(); setJump(false) }, [agentSessionId])
  useLayoutEffect(() => {
    const node = feed.current
    if (!visible || !node) return
    const tail = reading.page?.items.at(-1) ?? reading.timeline?.items.at(-1)
    const geometry = { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }
    const change = onContentChange(follow.current, { itemCount: reading.page?.items.length ?? reading.timeline?.items.length ?? 0, lastItemId: tail?.id ?? null, lastItemLength: tail ? JSON.stringify(tail).length : 0 }, geometry)
    follow.current = change.state
    if (change.scrollToBottom && !reading.olderWindow) node.scrollTop = node.scrollHeight
    const resize = new ResizeObserver(() => { if (follow.current.following && !reading.olderWindow) node.scrollTop = node.scrollHeight })
    for (const child of node.children) resize.observe(child)
    return () => resize.disconnect()
  }, [reading.page, reading.timeline, reading.olderWindow, visible])
  const draftKey = JSON.stringify(['draft', agentSessionId])
  const [local] = useState(createLocalDrafts)
  const drafts = useRef(local.drafts)
  const attempts = useRef(local.attempts)
  const responses = useRef(local.responses)
  const [revision, redraw] = useState(0)
  const [copyNotice, setCopyNotice] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const current = useRef({ client, agentSessionId })
  current.current = { client, agentSessionId }
  const draft = drafts.current.get(draftKey) ?? ''
  const attempt = attempts.current.get(draftKey)
  const available = Boolean(client && agentSessionId && reading.session && connection.state === 'connected' && !reading.disconnected)
  const setDraft = (value: string, key = draftKey) => { drafts.current.set(key, value); local.save(); redraw(value => value + 1) }
  const confirmPrompt = (key: string, original: PromptAttempt) => {
    if (attempts.current.get(key) !== original) return
    original.phase = 'confirmed'
    original.message = 'Core 已确认输入。'
    // A receipt belongs to its captured operation, including after navigating elsewhere.
    if (drafts.current.get(key) === original.draft) drafts.current.set(key, '')
    local.save()
    redraw(value => value + 1)
  }
  useEffect(() => {
    const pending = attempts.current.get(draftKey)
    if (!pending || pending.phase !== 'unknown') return
    const admission = reading.session?.promptCompletionAdmission
    if (admission?.submissionId === pending.operationId && admission.notApplied === true
      && admission.intent?.run.runId === pending.runId && reading.session?.run.runId === pending.runId) {
      pending.phase = 'rejected'
      pending.message = 'Core 已确认原输入未应用；草稿保留，可由你重新发送。'
      local.save()
      redraw(value => value + 1)
      return
    }
    const receipt = reading.timeline?.items.find(item => item.agentSessionId === agentSessionId
      && item.id === `prompt:${pending.operationId}` && item.kind === 'user_message' && item.status === 'complete')
    if (receipt) confirmPrompt(draftKey, pending)
  }, [reading.timeline, reading.session, agentSessionId, draftKey, revision])

  async function submit(explicit = true): Promise<void> {
    const existing = attempts.current.get(draftKey)
    if (!available || !client || !agentSessionId || !reading.session || !draft.trim()
      || existing?.phase === 'sending' || existing?.phase === 'unknown') return
    const originalClient = client, originalId = agentSessionId, originalKey = draftKey
    // No write has been dispatched if Core's authoritative condition cannot be obtained.
    let condition: ReturnType<typeof agentPromptCondition>
    try { condition = agentPromptCondition(originalClient.agentSession(originalId)) }
    catch (error) {
      attempts.current.set(originalKey, { operationId: '', runId: null, draft, phase: 'rejected', message: `尚未发送：${errorMessage(error)}` })
      local.save()
      redraw(value => value + 1); return
    }
    const original: PromptAttempt = { operationId: randomClientRequestId(), runId: condition.expectedRun.runId, draft, phase: 'sending', message: '正在发送输入…' }
    attempts.current.set(originalKey, original)
    local.save()
    redraw(value => value + 1)
    try {
      await originalClient.submitAgentPrompt({ agentSessionId: originalId, operationId: original.operationId,
        prompt: expandSemanticReferences(original.draft), authorHuman: true, ...condition,
        // Explicit Send/Cmd+Enter authorizes this input only; plain Enter keeps its original semantics.
        ...(explicit ? { allowUncertainTurn: true, execution: 'immediate' as const } : {}) })
      if (!mounted.current) return
      confirmPrompt(originalKey, original)
      if (current.current.client === originalClient && current.current.agentSessionId === originalId) void reading.refresh()
    } catch (error) {
      if (!mounted.current) return
      if (attempts.current.get(originalKey) !== original) return
      original.phase = deliveryOutcome(error, 'prompt')
      original.message = original.phase === 'unknown'
        ? `回执未知；草稿已保留，不会再次投递这条输入。请刷新核对原会话。${errorMessage(error)}`
        : `Core 已拒绝这条输入，草稿已保留。${errorMessage(error)}`
      local.save()
      redraw(value => value + 1)
    }
  }

  const session = reading.session
  const pending = session?.pendingInteraction
  const request = pending?.request
  const requestRun = request?.evidence?.run ?? session?.run
  const requestKey = session && request && requestRun
    ? JSON.stringify([session.agentSessionId, requestRun.runId, request.id]) : null
  const responseAttempt = requestKey ? responses.current.get(requestKey) : undefined
  const responseDisabled = !available || request?.agentSessionId !== session?.agentSessionId
    || requestRun?.runId !== session?.run.runId || Boolean(pending?.response || pending?.nativeInput || pending?.nativeCompleted)
    || responseAttempt?.phase === 'unknown' || responseAttempt?.phase === 'sending' || responseAttempt?.phase === 'confirmed'
  async function respond(response: AgentMuxInteractionResponse): Promise<void> {
    if (!client || !session || !request || !requestRun || !requestKey || responseDisabled) return
    const previous = responses.current.get(requestKey)
    if (previous?.phase === 'sending' || previous?.phase === 'unknown' || previous?.phase === 'confirmed') return
    const originalKey = requestKey
    const original: ResponseAttempt = { phase: 'sending', message: '正在发送原请求的答复…' }
    responses.current.set(originalKey, original)
    local.save()
    redraw(value => value + 1)
    try {
      await client.respondAgentInteraction({ agentSessionId: session.agentSessionId, expectedRun: requestRun, response })
      if (!mounted.current) return
      original.phase = 'confirmed'; original.message = 'Core 已确认答复，等待原请求更新。'
    } catch (error) {
      if (!mounted.current) throw error
      original.phase = deliveryOutcome(error, 'interaction')
      original.message = original.phase === 'unknown'
        ? `答复回执未知；不会重复回答这个请求。请在原会话核对。${errorMessage(error)}`
        : `Core 已拒绝答复。${errorMessage(error)}`
      throw error
    } finally { if (mounted.current) { local.save(); redraw(value => value + 1) } }
  }
  const describeSpeaker = useMemo(() => createSpeakerResolver({
    lookupAgent: id => {
      try {
        const author = client?.agentSessions().find(value => value.agentSessionId === id)
        return author ? { label: author.agentSessionId === agentSessionId && displayName ? displayName : `${author.providerId} Agent`, providerId: author.providerId } : undefined
      } catch { return undefined }
    },
    ...(session ? { currentSession: { id: session.agentSessionId, label: displayName ?? `${session.providerId} Agent`, providerId: session.providerId } } : {})
  }), [client, session, agentSessionId, displayName])
  const captured = useMemo(() => agentSessionId && reading.timeline
    ? projectSessionUserMessages({ agentSessionId, timeline: reading.timeline }) : [], [agentSessionId, reading.timeline])
  const capturedById = useMemo(() => new Map(captured.map(message => [message.id, message])), [captured])
  const appendQuote = (quote: string) => setDraft(`${drafts.current.get(draftKey) ?? ''}${drafts.current.get(draftKey) ? '\n\n' : ''}${quote}`)
  const readingProps = {
    ...(session ? { workspaceRoot: session.workspacePath } : {}),
    ...(openWorkspaceFile ? { openWorkspaceFile } : {}), ...(readPastedImage ? { readPastedImage } : {}),
    ...(openHttpLink ? { openHttpLink } : {}),
    onSelectAnnotation: ({ messageId, quote }: Parameters<NonNullable<ConversationMessageProps['onSelectAnnotation']>>[0]) =>
      appendQuote(`引用会话 ${JSON.stringify(agentSessionId)}，消息 ${JSON.stringify(messageId)}：\n${quote.split('\n').map(line => `> ${line}`).join('\n')}`)
  }
  const blocked = attempt?.phase === 'sending' || attempt?.phase === 'unknown'
  return <ClientUiProvider platform={platform}>
    <section className="mobile-conversation" aria-label="会话" data-agent-surface-mode="activity" data-agent-session-id={agentSessionId ?? ''}>
      {!available || connection.issue ? <p className="mobile-conversation__connection" role="status">{connection.issue ?? connection.message}{!available ? ' 当前不能发送；草稿与阅读保留。' : ''}</p> : null}
      {reading.notice ? <details className="mobile-conversation__notice"><summary>对话读取暂未确认 · 原 Agent 与输入保留</summary><p>{reading.notice}</p><button onClick={() => { void reading.refresh() }}>刷新原记录</button></details> : null}
      {local.notice ? <aside className="mobile-conversation__notice" role="status">{local.notice}
        {local.canSave ? <button type="button" onClick={() => { local.save(); redraw(value => value + 1) }}>重试保存</button> : null}
        <button type="button" disabled={!draft} onClick={() => {
          void platform.copyText(draft, error => setCopyNotice(`草稿未复制：${errorMessage(error)}`))
            .then(copied => { if (copied) setCopyNotice('已复制当前草稿。') })
        }}>复制当前草稿</button>
        {copyNotice ? <span>{copyNotice}</span> : null}
      </aside> : null}
      <div ref={feed} className="mobile-conversation__reading" onScroll={event => {
        const node = event.currentTarget
        follow.current = onScroll(follow.current, { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight })
        setJump(shouldShowJumpToLatest(follow.current))
      }}>
        {reading.page?.nextCursor && <button className="mobile-reading-action" disabled={reading.reading} onClick={() => { follow.current.following = false; void reading.older() }}>更早消息</button>}
        {(jump || reading.newerAvailable || reading.olderWindow) && <button className="mobile-reading-action mobile-reading-latest" onClick={() => {
          follow.current = initFollowState(); setJump(false)
          if (reading.olderWindow || reading.newerAvailable) void reading.refresh()
          else if (feed.current) feed.current.scrollTop = feed.current.scrollHeight
        }}>{reading.newerAvailable ? '有新回复 · 回到最新' : '回到最新'}</button>}
        {session?.semanticStatus?.state === 'working' ? <p className="mobile-active-state" role="status"><span />正在执行</p> : null}
        {reading.page && agentSessionId ? <>
          <ConversationView page={reading.page} showInputSource={false} sessionId={agentSessionId} describeSpeaker={describeSpeaker}
            renderProcess={props => <NativeProcessObservation {...props} compact />}
            {...(available && client?.forwardRpc ? { onReplyQuestion: async input => {
              const condition = agentPromptCondition(client.agentSession(agentSessionId))
              if (condition.expectedRun.runId !== session?.run.runId) throw new Error('原问题的 Run 已改变；对话与终端仍保留。')
              return client.forwardRpc!('agent.question.reply', { ...input, ...condition, agentSessionId, sourceChannel: 'api' })
            } } : {})}
            {...readingProps} />
        </> : !reading.reading ? <p className="mobile-conversation__empty">暂无已确认的对话内容，可发送消息或查看 Terminal。</p> : null}
        {captured.length > 0 || reading.timeline?.items.some(item => item.kind === 'assistant_message') ? <details className="mobile-conversation__captured" open={!reading.page?.items.length}><summary>发送与实时观察{attempt && attempt.phase !== 'confirmed' ? ' · 交付待确认' : ''}</summary><section aria-label="已发送消息">
          {reading.page && <p className="mobile-captured-source">独立记录来源，保留发送设备与交付事实</p>}
          {reading.timeline?.items.filter(item => item.agentSessionId === agentSessionId && (item.kind === 'user_message' || item.kind === 'assistant_message')).map(item => {
            if (item.kind === 'assistant_message') return <CapturedConversationMessage key={item.id} item={item}
              conversationSessionId={agentSessionId!} speaker={{ role: 'agent', id: agentSessionId! }} describeSpeaker={describeSpeaker} {...readingProps} />
            const message = capturedById.get(`captured:${item.id}`)
            return message ? <ConversationMessage key={message.id} messageId={message.id}
              conversationSessionId={agentSessionId!} content={message.contentParts} inputSource={message.source}
              speaker={speakerOfUserMessage(message)} describeSpeaker={describeSpeaker}
              {...(message.deliveryStatus ? { status: message.deliveryStatus } : {})}
              {...(message.recordedAt !== undefined ? { createdAt: message.recordedAt } : {})} {...readingProps} /> : null
          })}
        </section></details> : null}
      </div>
      {reading.timeline?.items.filter(item => item.sourceDevice && item.kind === 'system_message').map(item => <details key={item.id} className="mobile-conversation__notice"><summary>设备操作记录</summary><ConversationMessage
        messageId={item.id} conversationSessionId={agentSessionId!} content={item.content ?? item.title}
        inputSource={{ kind: 'captured', submissionId: item.id, device: item.sourceDevice! }}
        speaker={{ role: 'system', id: 'agentmux' }} createdAt={item.createdAt} {...readingProps} /></details>)}
      {request && requestKey ? <div className="mobile-conversation__interaction">
        <AgentInteractionCard key={requestKey} request={request} disabled={responseDisabled}
          {...(responseAttempt?.phase === 'unknown' ? { responseUnavailableReason: responseAttempt.message } : {})}
          onRespond={respond} />
        {responseAttempt ? <p role="status">{responseAttempt.message}</p> : null}
      </div> : null}
      <div className="mobile-conversation__composer">
        <AgentComposer tools={<MobileMessageTools refresh={() => { void reading.refresh() }} terminal={onShowTerminal} />} mailbox={<MobileMailbox session={session} connected={connection.state === 'connected'} messages={captured} platform={platform} describeSpeaker={describeSpeaker}
          refresh={() => { void reading.refresh() }} {...(onShowTerminal ? { terminal: onShowTerminal } : {})} />} value={draft} disabled={false} placeholder={available ? '发消息' : '离线草稿'}
          onChange={setDraft} {...(available && !blocked ? { onSubmit: () => void submit(), onQueue: () => void submit(false) } : {})}
          {...(onAttach ? { onAttach } : {})} {...(readPastedImage ? { readPastedImage } : {})}
          />
        {attempt && attempt.phase !== 'confirmed' ? <aside className="mobile-send-status" data-phase={attempt.phase} aria-live="polite">
          <div className="mobile-send-status__summary">
            <span>{attempt.phase === 'sending' ? '正在发送…' : attempt.phase === 'unknown' ? '发送结果未确认 · 草稿已保留' : '尚未发送 · 草稿已保留'}</span>
            {attempt.phase !== 'sending' ? <button type="button" onClick={() => { void reading.refresh() }}>刷新</button> : null}
            {attempt.phase !== 'sending' && onShowTerminal ? <button type="button" onClick={onShowTerminal}>终端</button> : null}
            {attempt.phase !== 'sending' ? <details><summary>详情</summary><p>{attempt.message}</p></details> : null}
          </div>
        </aside> : null}
      </div>
    </section>
  </ClientUiProvider>
}
