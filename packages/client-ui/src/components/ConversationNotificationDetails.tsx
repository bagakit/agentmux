import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ConversationSourceRecord } from '@agentmux/core/conversation'
import { conversationMessageSourceKey } from '../lib/conversation-message-location.js'
import { ConversationToolPayload } from './ConversationToolPayload.js'

/** Evidence stays at the original notification; opening it never renders or reads another message. */
export function ConversationNotificationDetails({ notificationId, protocol, records = [], locatedSourceKey, children }: {
  notificationId: string; protocol?: string | undefined; records?: readonly ConversationSourceRecord[] | undefined
  locatedSourceKey?: string | null | undefined; children?: ReactNode
}) {
  const located = records.some(record => record.reference && conversationMessageSourceKey(record.reference.agentSessionId, record.reference.source) === locatedSourceKey)
  const [open, setOpen] = useState(located)
  const [presented, setPresented] = useState(located)
  const identity = useMemo(() => ({}), [notificationId, protocol])
  useEffect(() => { if (located) { setOpen(true); setPresented(true) } }, [located, locatedSourceKey])
  return <details className="conversation-a2a-notice__details" open={open} onToggle={event => { const next = event.currentTarget.open; setOpen(next); if (next) setPresented(true) }}>
    <summary>通知与来源</summary>
    <dl className="conversation-input-details__facts"><dt>通知来源</dt><dd>AgentMux</dd><dt>通知 ID</dt><dd><code>{notificationId}</code></dd></dl>
    {open || presented ? <>{children}{protocol === undefined ? null : <ConversationToolPayload text={protocol} identity={identity} sourceIdentity={identity} copyLabel="Copy notification protocol" />}</> : null}
    {records.map(record => <Original key={record.id} record={record} locatedSourceKey={locatedSourceKey} active={open} />)}
  </details>
}

function Original({ record, locatedSourceKey, active }: { record: ConversationSourceRecord; locatedSourceKey?: string | null | undefined; active: boolean }) {
  const reference = record.reference
  const sourceKey = reference ? conversationMessageSourceKey(reference.agentSessionId, reference.source) : null
  const located = Boolean(sourceKey && sourceKey === locatedSourceKey)
  const [open, setOpen] = useState(located)
  const [presented, setPresented] = useState(located)
  const show = active && open || presented
  const identity = useMemo(() => ({}), [record.id, record.revision])
  const text = useMemo(() => show ? JSON.stringify(record.original.item, null, 2) : '', [show, record.original.item])
  useEffect(() => { if (located) setOpen(true) }, [located, locatedSourceKey])
  useEffect(() => { if (active && open) setPresented(true) }, [active, open])
  return <details className="conversation-original-record" data-message-source-key={sourceKey} data-original-contribution={record.id}
    tabIndex={-1} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{record.original.kind === 'native' ? '原生记录' : '提交记录'} · {record.original.item.id}</summary>
    {show ? <ConversationToolPayload text={text} identity={identity} sourceIdentity={identity} copyLabel="Copy original record" /> : null}
  </details>
}
