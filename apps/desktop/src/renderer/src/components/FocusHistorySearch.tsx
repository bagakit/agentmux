import { memo, useCallback, useMemo } from 'react'
import type { AgentSessionHistoryContentPart, AgentSessionHistoryItem, AgentTimelineItem } from '@agentmux/core'
import { sessionHistoryTextForReading, sessionUserMessageText } from '@agentmux/core/session-user-messages'
import { projectConversationRecords } from '@agentmux/client-ui/conversation-records'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { focusHistoryHitKey, type FocusHistoryHit, type useFocusHistorySearch } from '../lib/use-focus-history-search'
import { api } from '../lib/api'

const Hit = memo(function Hit({ hit, query, open, onExpand }: { hit: FocusHistoryHit; query: string; open: boolean; onExpand(key: string, open: boolean): void }) {
 const item = hit.entry.item
 const record = useMemo(() => projectConversationRecords({ agentSessionId: hit.reference.agentSessionId, executionHostId: hit.reference.hostId,
  ...(hit.nativeSource ? { historyPage: { agentSessionId: hit.reference.agentSessionId, source: hit.nativeSource, items: [item as AgentSessionHistoryItem], nextCursor: null } }
   : { timeline: { agentSessionId: hit.reference.agentSessionId, revision: 0, items: [item as AgentTimelineItem] } }) })[0], [hit])
 const parts = useMemo<readonly AgentSessionHistoryContentPart[]>(() => record?.contentParts ?? ('contentParts' in item ? item.contentParts : [item.content, item.toolInput, item.toolOutput].filter((text): text is string => text !== undefined).map(text => ({ kind: 'text', text }))), [record, item])
 const answer = record?.input?.questionAnswers?.length ? sessionUserMessageText(record.input.contentParts, record.input.questionAnswers) : null
 const text = answer ?? parts.map(part => part.kind === 'text' ? sessionHistoryTextForReading(part) : part.kind === 'reasoning' ? part.text : part.kind === 'tool-call' ? `${part.name}\n${part.input}` : part.kind === 'tool-result' ? part.output : '').join('\n')
 const at = query ? text.indexOf(query) : 0, start = Math.max(0, at - 80)
 const snippet = at < 0 ? 'Matches original stored text · expand to read the record' : `${start ? '…' : ''}${text.slice(start, start + 320)}${text.length > start + 320 ? '…' : ''}`
 const readResource = useCallback((input: Parameters<typeof api.sessions.historyResource>[1]) => api.sessions.historyResource({ hostId: hit.reference.hostId, agentSessionId: hit.reference.agentSessionId }, input), [hit.reference.hostId, hit.reference.agentSessionId])
 const nativeRecord = useMemo(() => hit.nativeSource ? { source: hit.nativeSource, recordId: item.id, ...('turnId' in item && item.turnId ? { turnId: item.turnId } : {}) } : undefined, [hit])
 const body = (content: string | readonly AgentSessionHistoryContentPart[]) => <ConversationMessage compact recordedIdentity {...(record?.speaker ? { speaker: record.speaker } : {})} {...(record?.input ? { inputSource: record.input.source } : {})} content={content} recordTitle={item.kind} messageId={item.id} conversationSessionId={hit.reference.agentSessionId} executionHostId={hit.reference.hostId} {...(nativeRecord ? { nativeResourceRecord: nativeRecord } : {})} readHistoryResource={readResource} />
 return <details className="focus-history-hit" open={open} onToggle={event => onExpand(focusHistoryHitKey(hit), event.currentTarget.open)}>
  <summary><span><strong>{hit.reference.agentSessionId}</strong><small>{hit.reference.hostId} · {hit.reference.source}{hit.nativeSource ? ` / ${hit.nativeSource.nativeSessionId}` : ''} · {item.kind} · {item.id}</small></span><span className="focus-history-hit__excerpt">{snippet}</span></summary>
  {open ? <>{body(answer ?? parts)}{answer !== null ? <details><summary>Original record</summary>{body(parts)}</details> : null}</> : null}
 </details>
})
export function FocusHistorySearch({ search }: { search: ReturnType<typeof useFocusHistorySearch> }) {
 const { result } = search
 if (!result) return null
 return <section className="focus-history-search" aria-label="History search results" aria-busy={result.loading}>
  <header><strong>History · {result.label}</strong>{result.loading ? <button type="button" className="small-button" onClick={search.cancel}>Cancel search</button> : result.pending.length ? <button type="button" className="small-button" onClick={search.more}>Continue history search</button> : null}</header>
  <details className="focus-history-coverage"><summary><small role="status">{result.hits.length} matches · {result.examined} records · {result.pending.length ? `${result.pending.length} source streams remaining` : `${result.completed} / ${result.total} source streams checked`}{result.issues.length ? ` · ${result.issues.length} unavailable` : ''}</small></summary>
   {result.trimmed ? <p>{result.hits.length} of {result.matched} matching records read remain in this bounded window; {result.trimmed} earlier results are outside it. The expanded record is kept. Search again to read earlier results.</p> : null}
   <p>{result.completed} / {result.total} source streams checked. Retained captured and native text; independent of execution project and state filters. Literal text is case-sensitive.</p>
   {result.issues.length ? <><strong>Unavailable search coverage</strong>{result.issues.map((issue, index) => <p key={index}>{issue}</p>)}<p>Search again to retry unavailable sources.</p></> : null}
  </details>
  {!result.hits.length && !result.loading ? <p>{result.pending.length || result.issues.length ? 'No matches in the checked records. Search coverage is incomplete.' : 'No matches in the retained text of the checked sources.'}</p> : null}
  {result.hits.map(hit => <Hit key={focusHistoryHitKey(hit)} hit={hit} query={result.query} open={search.expandedKey === focusHistoryHitKey(hit)} onExpand={search.expand} />)}
 </section>
}
