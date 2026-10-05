import { conversationReplySourceKey, type ConversationReplySource, type PromptReactionDefinition, type PromptReactionIcon } from '@agentmux/core/prompt-reaction'
import { SemanticIcon } from '../theme/icons.js'
import { useRef, useState } from 'react'

const glyphs = { check: 'action.confirm', play: 'action.start', 'message-circle': 'object.context' } as const

/** The same bounded SVG vocabulary in replies and the Prompt editor. */
export function PromptReactionIconView({ icon, size = 15 }: { icon: PromptReactionIcon; size?: number }) {
  const semantic = glyphs[icon]
  return <SemanticIcon name={semantic} size={size} strokeWidth={1.8} aria-hidden="true" />
}

export type ConversationReactionSend = (
  definition: PromptReactionDefinition,
  source: ConversationReplySource,
  onRejected: (error: unknown) => void
) => Promise<boolean>

/** Only feedback is local. The host's original message queue owns input and delivery. */
export function ConversationReactionActions({ definitions, source, onSend, pending = [] }: {
  definitions: readonly PromptReactionDefinition[]
  source: ConversationReplySource
  onSend: ConversationReactionSend
  pending?: readonly { code: string; status: 'queued' | 'restoring' | 'deferred' | 'failed'; error?: string }[]
}) {
  const busy = useRef(false)
  const sourceKey = conversationReplySourceKey(source)
  const activeSource = useRef(sourceKey)
  activeSource.current = sourceKey
  const [feedback, setFeedback] = useState<{ source: string; code: string; state: 'preparing' | 'queued' | 'failed'; error?: string } | null>(null)
  const queuedError = pending.find(entry => entry.status === 'failed' || entry.status === 'deferred')
  const currentFeedback = queuedError ? { source: sourceKey, code: queuedError.code, state: 'failed' as const,
    error: `${queuedError.error ?? 'Delivery is unconfirmed.'} Check the Outbox before retrying.` } : feedback?.source === sourceKey ? feedback : null
  if (!definitions.length) return null

  async function send(definition: PromptReactionDefinition): Promise<void> {
    if (busy.current) return
    busy.current = true
    const originalSource = sourceKey
    const reject = (error: unknown) => {
      if (activeSource.current === originalSource) setFeedback({ source: originalSource, code: definition.keyword,
        state: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
    setFeedback({ source: originalSource, code: definition.keyword, state: 'preparing' })
    try {
      const accepted = await onSend(definition, source, reject)
      if (activeSource.current === originalSource && accepted) setFeedback(current => current?.state === 'failed'
        ? current : { source: originalSource, code: definition.keyword, state: 'queued' })
    } catch (error) { reject(error) }
    finally { busy.current = false }
  }

  return <span className="conversation-reactions" aria-label="Quick replies">
    {definitions.map(definition => <span className="conversation-reactions__choice" key={definition.id}>
      <button type="button" className="log-turn__action conversation-reactions__button"
        aria-label={`回复：${definition.label}`} disabled={currentFeedback?.state === 'preparing' || pending.some(entry => entry.code === definition.keyword)}
        onClick={() => { void send(definition) }}>
        <PromptReactionIconView icon={definition.reactionIcon} />
      </button>
      <span className="conversation-reactions__hint" role="tooltip"><strong>{definition.label}</strong>
        <span>{definition.body}</span><small>{definition.keyword} · 作为新消息发送</small>
      </span>
    </span>)}
    {currentFeedback ? <span className="conversation-reactions__choice conversation-reactions__feedback"
      role={currentFeedback.state === 'failed' ? 'alert' : 'status'} tabIndex={currentFeedback.state === 'failed' ? 0 : undefined}
      data-reaction-status={currentFeedback.state}>
      {currentFeedback.state === 'preparing' ? <SemanticIcon name="status.loading" size={13} aria-hidden="true" />
        : currentFeedback.state === 'queued' ? <SemanticIcon name="action.confirm" size={13} aria-hidden="true" /> : <SemanticIcon name="status.warning" size={13} aria-hidden="true" />}
      <span className="conversation-reactions__sr">{currentFeedback.state === 'preparing' ? '准备回复…'
        : currentFeedback.state === 'queued' ? '已加入发件箱' : currentFeedback.error}</span>
      <span className="conversation-reactions__hint" role="tooltip"><strong>{`${definitions.find(item => item.keyword === currentFeedback.code)?.label ?? currentFeedback.code} · `}{currentFeedback.state === 'failed' ? '回复未确认' : currentFeedback.state === 'preparing' ? '准备回复…' : '已加入发件箱'}</strong>
        <span>{currentFeedback.state === 'failed' ? currentFeedback.error : currentFeedback.state === 'preparing' ? '正在核对当前含义与原对话。' : '原发件箱会保留这条回复的含义与目标。'}</span>
      </span>
    </span> : null}
  </span>
}
