import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ConversationRecord } from '../lib/conversation-records.js'
import { conversationMessageSourceKey } from '../lib/conversation-message-location.js'
import { ConversationToolPayload } from './ConversationToolPayload.js'

/** Original contributors stay at their own source identity even after an event coalesces. */
export function ConversationOriginalRecords({ records, sessionId, locatedMessageKey, renderRecord, expandedRecords }: {
  records: readonly ConversationRecord[]; sessionId: string; locatedMessageKey?: string | null; renderRecord(record: ConversationRecord): ReactNode
  expandedRecords?: ReadonlySet<string>
}) {
  return <>{records.map(record => <Original key={record.id} record={record} expanded={expandedRecords?.has(record.records?.[0]?.id ?? record.id) ?? false} sessionId={sessionId} locatedMessageKey={locatedMessageKey} renderRecord={renderRecord} />)}</>
}
function Original({ record, sessionId, locatedMessageKey, renderRecord, expanded }: { record: ConversationRecord; sessionId: string; locatedMessageKey: string | null | undefined; expanded: boolean; renderRecord(record: ConversationRecord): ReactNode }) {
  const key = conversationMessageSourceKey(sessionId, record.source)
  const [open, setOpen] = useState(expanded), [presented, setPresented] = useState(expanded)
  useEffect(() => { if (expanded || key && key === locatedMessageKey) { setOpen(true); setPresented(true) } }, [key, locatedMessageKey, expanded])
  const text = useMemo(() => open || presented ? JSON.stringify(record.original.item, null, 2) : '', [record.original.item, open, presented])
  return <details className="conversation-original-record" data-message-source-key={key} data-original-contribution={record.id} tabIndex={-1}
    open={open} onToggle={event => { setOpen(event.currentTarget.open); if (event.currentTarget.open) setPresented(true) }}>
    <summary>Original {record.original.kind} record · {record.original.item.id}</summary>
    {open || presented ? <>{renderRecord(record)}<details><summary>Original record JSON</summary><ConversationToolPayload text={text} identity={record.original.item} sourceIdentity={record.original.item} copyLabel="Copy original record" /></details></> : null}
  </details>
}
