import { useState } from 'react'
import { conversationRecordId, type ConversationItemRef, type ConversationTimeline } from '@agentmux/core/conversation'
import type { ConversationRecord } from '../lib/conversation-records.js'

type Locate = (reference: ConversationItemRef) => Promise<{ kind: 'located' } | { kind: 'cancelled' } | { kind: 'unavailable'; message: string }>
/** Original Core coverage, once per reading scope; per-record previews show only exact record gaps. */
export function ConversationCoverage({ coverage, record, summary, onLocate }: {
  coverage: ConversationTimeline['coverage']; record?: ConversationRecord; summary?: string | undefined; onLocate?: Locate
}) {
  const [feedback, setFeedback] = useState<string | null>(null)
  const keys = record ? new Set([record.event?.anchorId, ...(record.records?.map(source => source.id) ?? [])]) : null
  const rows = coverage.map(row => ({ ...row, gaps: keys ? row.gaps.filter(gap => gap.record && keys.has(conversationRecordId(gap.record))) : row.gaps }))
    .filter(row => keys ? row.gaps.length : row.gaps.length || row.origin !== 'beginning' || row.earlier !== 'complete' || row.current !== 'complete-through-cut')
  if (!rows.length) return null
  return <details className="conversation-metrics__notice conversation-coverage" data-conversation-coverage>
    <summary>{summary ?? (record ? 'Original record reading details' : 'Current reading window · source coverage')}</summary>
    {rows.map((row, index) => <div key={index} data-coverage-source={JSON.stringify(row.source)}>
      {!record ? <p>{row.source.kind === 'native' ? `${row.source.providerId} · ${row.source.nativeSessionId}` : 'Captured history'} · Origin: {row.origin} · Earlier: {row.earlier} · Current: {row.current}</p> : null}
      {row.gaps.map((gap, n) => <div key={n} data-conversation-gap={gap.code}>
        <p><code>{gap.code}</code> · {gap.message}</p>
        {gap.record ? <><code data-conversation-gap-reference>{JSON.stringify(gap.record)}</code>{onLocate ? <button type="button" onClick={() => {
          void onLocate(gap.record!).then(result => setFeedback(result.kind === 'located' ? 'Original record located.' : result.kind === 'unavailable' ? result.message : null))
        }}>Locate original record</button> : null}</> : null}
        {gap.continuation ? <code>{gap.continuation}</code> : null}
      </div>)}
    </div>)}
    {feedback ? <p role="status">{feedback}</p> : null}
  </details>
}
