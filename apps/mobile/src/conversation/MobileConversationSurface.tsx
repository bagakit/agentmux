import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxInteractionResponse } from '@agentmux/core'
import { agentPromptCondition } from '@agentmux/core/prompt-condition'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import {
  AgentComposer, AgentInteractionCard, ClientUiProvider, ConversationMessage, ConversationNativeThread,
  createSpeakerResolver, expandSemanticReferences, speakerOfUserMessage,
  type ClientUiPlatform, type ConversationMessageProps
} from '@agentmux/client-ui'
import { deliveryOutcome, errorMessage } from './delivery'
import { createLocalDrafts, type PromptAttempt, type ResponseAttempt } from './local-drafts'
import { useHostedConversation, type MobileConnection } from './use-hosted-conversation'
import './conversation.css'

export type { MobileConnection } from './use-hosted-conversation'
export type MobileConversationSurfaceProps = Pick<ConversationMessageProps,
  'openWorkspaceFile' | 'readPastedImage' | 'openHttpLink'> & {
  client: AgentMuxHostedClient | null
  agentSessionId: string | null
  connection: MobileConnection
  platform: ClientUiPlatform
  onAttach?: () => void
}
/** A first-party SDK reader and input client. Core owns ordering, authorship and admission. */
export function MobileConversationSurface({ client, agentSessionId, connection, platform, onAttach,
  openWorkspaceFile, readPastedImage, openHttpLink }: MobileConversationSurfaceProps) {
  const reading = useHostedConversation(client, agentSessionId, connection.state === 'connected')
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

  async function submit(): Promise<void> {
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
    const original: PromptAttempt = { operationId: crypto.randomUUID(), runId: condition.expectedRun.runId, draft, phase: 'sending', message: '正在发送输入…' }
    attempts.current.set(originalKey, original)
    local.save()
    redraw(value => value + 1)
    try {
      await originalClient.submitAgentPrompt({ agentSessionId: originalId, operationId: original.operationId,
        prompt: expandSemanticReferences(original.draft), authorHuman: true, ...condition })
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
        return author ? { label: author.agentSessionId, providerId: author.providerId } : undefined
      } catch { return undefined }
    },
    ...(session ? { currentSession: { id: session.agentSessionId, providerId: session.providerId } } : {})
  }), [client, session])
  const captured = useMemo(() => agentSessionId && reading.timeline
    ? projectSessionUserMessages({ agentSessionId, timeline: reading.timeline }) : [], [agentSessionId, reading.timeline])
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
    <section className="mobile-conversation" aria-label="会话" data-agent-session-id={agentSessionId ?? ''}>
      <header className="mobile-conversation__heading">
        <div><strong>{session?.providerId ?? 'Agent'}</strong><span>{agentSessionId ?? '尚未选择会话'}</span></div>
        <button type="button" disabled={!client || connection.state !== 'connected' || reading.reading}
          onClick={() => void reading.refresh()}>刷新</button>
      </header>
      <p className="mobile-conversation__connection" role="status">{connection.message}
        {!available ? ' 当前不能发送；草稿与引用保留。' : ''}</p>
      {reading.notice ? <p className="mobile-conversation__notice" role="status">{reading.notice}</p> : null}
      {local.notice ? <aside className="mobile-conversation__notice" role="status">{local.notice}
        {local.canSave ? <button type="button" onClick={() => { local.save(); redraw(value => value + 1) }}>重试保存</button> : null}
        <button type="button" disabled={!draft} onClick={() => {
          void platform.copyText(draft, error => setCopyNotice(`草稿未复制：${errorMessage(error)}`))
            .then(copied => { if (copied) setCopyNotice('已复制当前草稿。') })
        }}>复制当前草稿</button>
        {copyNotice ? <span>{copyNotice}</span> : null}
      </aside> : null}
      <div className="mobile-conversation__reading">
        {reading.page && agentSessionId ? <>
          <nav className="mobile-conversation__window" aria-label="历史窗口">
            <button type="button" disabled={!available || reading.reading || !reading.page.nextCursor}
              onClick={() => void reading.older()}>更早记录</button>
            {reading.olderWindow ? <button type="button" disabled={!available || reading.reading}
              onClick={() => void reading.refresh()}>最新记录{reading.newerAvailable ? ' · 有更新' : ''}</button> : null}
          </nav>
          <ConversationNativeThread page={reading.page} sessionId={agentSessionId} describeSpeaker={describeSpeaker}
            onContinue={appendQuote} {...readingProps} />
        </> : !reading.reading ? <p className="mobile-conversation__empty">尚无可读取的原生历史。选择原会话并连接 Host 后可刷新。</p> : null}
        {captured.length > 0 ? <section aria-label="Core 记录的输入" className="mobile-conversation__captured">
          <p className="mobile-conversation__source">Core 记录的输入 · 与原生历史分别保留来源</p>
          {captured.map(message => <ConversationMessage key={message.id} messageId={message.id}
            conversationSessionId={agentSessionId!} content={message.contentParts} inputSource={message.source}
            speaker={speakerOfUserMessage(message)} describeSpeaker={describeSpeaker}
            {...(message.deliveryStatus ? { status: message.deliveryStatus } : {})}
            {...(message.recordedAt !== undefined ? { createdAt: message.recordedAt } : {})}
            {...readingProps} />)}
        </section> : null}
      </div>
      {reading.timeline?.items.filter(item => item.sourceDevice && item.kind === 'system_message').map(item => <ConversationMessage
        key={item.id} messageId={item.id} conversationSessionId={agentSessionId!} content={item.content ?? item.title}
        inputSource={{ kind: 'captured', submissionId: item.id, device: item.sourceDevice! }}
        speaker={{ role: 'system', id: 'agentmux' }} createdAt={item.createdAt} {...readingProps} />)}
      {request && requestKey ? <div className="mobile-conversation__interaction">
        <AgentInteractionCard key={requestKey} request={request} disabled={responseDisabled}
          {...(responseAttempt?.phase === 'unknown' ? { responseUnavailableReason: responseAttempt.message } : {})}
          onRespond={respond} />
        {responseAttempt ? <p role="status">{responseAttempt.message}</p> : null}
      </div> : null}
      <div className="mobile-conversation__composer">
        <AgentComposer value={draft} disabled={false} placeholder="写给原会话；未连接时保留草稿"
          onChange={setDraft} {...(available && !blocked ? { onSubmit: () => void submit() } : {})}
          {...(onAttach ? { onAttach } : {})} {...(readPastedImage ? { readPastedImage } : {})}
          feedback={attempt ? <span role="status">{attempt.message}</span> : undefined} />
      </div>
    </section>
  </ClientUiProvider>
}
