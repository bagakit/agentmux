import type { ConversationRecord } from '../lib/conversation-records.js'
import { COLLECTED_REPLY_TITLE } from '../lib/conversation-sources.js'
import { ConversationSourceLabels } from './ConversationSourceLabels.js'
import type { AgentTimelineItem } from '@agentmux/core'
import { ConversationMessage, type ConversationMessageProps } from './ConversationMessage.js'
import { conversationItemRef } from '@agentmux/core/conversation'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { formatClock } from '../lib/conversation-time.js'
import { SemanticIcon } from '../theme/icons.js'
import { conversationMessageSourceKey } from '../lib/conversation-message-location.js'
/** Exact captured record metadata. A failed native reader cannot hide a confirmed Hook reply. */
export function CapturedConversationMessage({ item, record, replyObservation, ...props }: Omit<ConversationMessageProps, 'content' | 'messageId' | 'createdAt' | 'status'> & {
  item: AgentTimelineItem
  record?: ConversationRecord
  /** Local reading role only; never asserts native coverage or a record join. */
  replyObservation?: { compact: boolean }
}) {
  const itemRef = record ? conversationItemRef(record) : conversationItemRef({ agentSessionId: item.agentSessionId, ...(props.executionHostId ? { executionHostId: props.executionHostId } : {}), source: { kind: 'captured', recordId: item.id } })
  const message = <ConversationMessage {...props} sources={record?.sources ?? props.sources} {...(record?.role === 'observation' ? { recordedIdentity: true } : {})} {...(record?.event ? { conversationEvent: record.event } : {})} {...(itemRef ? { itemRef } : {})} {...(record?.input ? { inputSource: record.input.source, publicContent: record.input.publicContent } : {})} messageId={record?.input?.id ?? item.id} content={record?.contentParts ?? item.content ?? ''} status={record?.input?.deliveryStatus ?? item.status} createdAt={item.createdAt}
    messageDetails={<><dl className="conversation-input-details__facts">
      <dt>Record source</dt><dd>{item.source}</dd>
      <dt>Captured record</dt><dd><code>{item.id}</code></dd>
      <dt>Session</dt><dd><code>{item.agentSessionId}</code></dd>
      {item.eventName ? <><dt>Recorded event</dt><dd>{item.eventName}</dd></> : null}
    </dl>{props.messageDetails}</>} />
  return <ReplyObservation key={JSON.stringify([item.agentSessionId, item.source, item.id])} item={item} observation={Boolean(replyObservation)} compact={replyObservation?.compact ?? false} reveal={props.located === true} sources={record?.sources}>{message}</ReplyObservation>
}

function ReplyObservation({ item, observation, compact, reveal, children, sources }: { item: AgentTimelineItem; observation: boolean; compact: boolean; reveal: boolean; children: ReactNode; sources?: import('../lib/conversation-sources.js').ConversationSources | undefined }) {
  const [choice, setChoice] = useState<boolean>()
  const [readOnce, setReadOnce] = useState(!compact)
  const [, selectionChanged] = useState(0)
  const body = useRef<HTMLDivElement>(null)
  const bodyId = useId()
  useEffect(() => { if (reveal) { setChoice(true); setReadOnce(true) } }, [reveal])
  const document = body.current?.ownerDocument
  const selection = document?.defaultView?.getSelection()
  let selected = false
  if (selection && !selection.isCollapsed && selection.rangeCount && body.current) {
    try { selected = selection.getRangeAt(0).intersectsNode(body.current) } catch { selected = true }
  }
  const expanded = !observation || (choice ?? (!compact || selected))
  useEffect(() => {
    if (!selected || !document) return
    const update = () => selectionChanged(value => value + 1)
    document.addEventListener('selectionchange', update)
    return () => document.removeEventListener('selectionchange', update)
  }, [selected, document])
  const preview = (item.content ?? '').replace(/\s+/gu, ' ').trim().slice(0, 180)
  return <div className={observation ? 'conversation-reply-observation' : undefined} data-captured-reply-observation={observation ? item.id : undefined} tabIndex={-1}
    data-message-source-key={observation ? conversationMessageSourceKey(item.agentSessionId, { kind: 'captured', recordId: item.id }) : undefined}>
    {observation ? <div className="conversation-reply-observation__controls">
      <button type="button" className="conversation-reply-observation__toggle" aria-expanded={expanded} aria-controls={bodyId}
        aria-label={expanded ? '收起采集内容' : '展开采集内容'} onClick={() => { setChoice(!expanded); if (!expanded) setReadOnce(true) }}>
        <SemanticIcon name="navigation.disclosure" size={12} aria-hidden="true" />
        {expanded ? '收起原文' : <ConversationSourceLabels sources={sources?.main} observation={sources?.collectedReply ?? COLLECTED_REPLY_TITLE} unconfirmed={sources?.unconfirmed ?? false} />}
      </button>
      {!expanded ? <><time>{formatClock(item.createdAt)}</time>{item.status !== 'complete' ? <span role="status" data-status={item.status}>{item.status === 'failed' ? '记录失败' : '记录中'}</span> : null}</> : null}
    </div> : null}
    {!expanded && preview ? <p className="conversation-reply-observation__preview">{preview}</p> : null}
    <div ref={body} id={bodyId} hidden={!expanded} inert={!expanded}>{expanded || readOnce ? children : null}</div>
  </div>
}
