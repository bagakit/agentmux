import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ConversationRecord } from '../lib/conversation-records.js'
import { conversationMessageSourceKey } from '../lib/conversation-message-location.js'
import { ConversationToolPayload } from './ConversationToolPayload.js'

/** Original contributors stay at their own source identity even after an event coalesces. */
export function ConversationOriginalRecords({ records, sessionId, locatedMessageKey, renderRecord, expandedRecords, onOpenChange }: {
  records: readonly ConversationRecord[]; sessionId: string; locatedMessageKey?: string | null; renderRecord(record: ConversationRecord): ReactNode
  expandedRecords?: ReadonlySet<string>
  onOpenChange?(id: string, open: boolean): void
}) {
  return <>{records.map(record => <Original key={record.id} record={record} expanded={expandedRecords?.has(record.records?.[0]?.id ?? record.id) ?? false} sessionId={sessionId} locatedMessageKey={locatedMessageKey} renderRecord={renderRecord}
    {...(onOpenChange ? { onOpenChange: (open: boolean) => onOpenChange(record.records?.[0]?.id ?? record.id, open) } : {})} />)}</>
}
function Original({ record, sessionId, locatedMessageKey, renderRecord, expanded, onOpenChange }: { record: ConversationRecord; sessionId: string; locatedMessageKey: string | null | undefined; expanded: boolean; renderRecord(record: ConversationRecord): ReactNode; onOpenChange?(open: boolean): void }) {
  const key = conversationMessageSourceKey(sessionId, record.source)
  const [open, setOpen] = useState(expanded), [presented, setPresented] = useState(expanded)
  useEffect(() => { if (expanded || key && key === locatedMessageKey) { setOpen(true); setPresented(true); if (key === locatedMessageKey) onOpenChange?.(true) } }, [key, locatedMessageKey, expanded])
  return <details className="conversation-original-record" data-message-source-key={key} data-original-contribution={record.id} tabIndex={-1}
    open={open} onToggle={event => { const next = event.currentTarget.open; if (next === open) return; setOpen(next); if (next) setPresented(true); onOpenChange?.(next) }}>
    <summary>Original {record.original.kind} record · {record.rawId}</summary>
    {open || presented ? <ConversationOriginalRecordContent record={record} renderRecord={renderRecord} /> : null}
  </details>
}

/** Used only inside an opened original disclosure; full reading and raw facts keep one owner. */
export function ConversationOriginalRecordContent({ record, renderRecord }: { record: ConversationRecord; renderRecord(record: ConversationRecord): ReactNode }) {
  const text = useMemo(() => JSON.stringify(record.original.item, null, 2), [record.original.item])
  return <>{renderRecord(record)}<details><summary>Original record JSON</summary><ConversationToolPayload text={text} identity={record.original.item} sourceIdentity={record.original.item} copyLabel="Copy original record" /></details></>
}
