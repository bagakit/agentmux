import { useEffect, useId, useState, type ReactNode } from 'react'
import type { ConversationWindowSnapshot } from '@agentmux/core/conversation'
import type { ConversationRecord } from '../lib/conversation-records.js'
import type { ConversationProcessDetailReader } from '../lib/read-conversation-process-detail.js'
import type { ConversationProcessProps } from './ConversationRecordSequence.js'
import { RecordedToolRow } from './WorkflowObservation.js'
import { SemanticIcon } from '../theme/icons.js'
import { conversationMessageSourceKey } from '../lib/conversation-message-location.js'

/** A disclosure is the only owner of its exact loaded bodies. Closed steps carry
 * typed reading metadata; they never mount a placeholder as original content. */
export function DeferredConversationProcess({ record, readDetail, renderDetail, active, located, disclosure }: {
  record: ConversationRecord; readDetail?: ConversationProcessDetailReader; renderDetail(snapshot: ConversationWindowSnapshot): ReactNode;
  active: boolean; located: boolean; disclosure?: ConversationProcessProps['disclosure']
}) {
  const [open, setOpen] = useState(false), [attempt, retry] = useState(0)
  const [loaded, setLoaded] = useState<readonly ConversationWindowSnapshot[] | null>(null)
  const [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(false)
  const bodyId = useId(), key = record.presentationKey ?? record.id
  const expanded = located || (disclosure?.steps.get(key) ?? open)
  const [deferred] = useState(() => record.deferred!)
  const header = record.original.kind === 'deferred' ? record.original.item : null
  useEffect(() => {
    if (!expanded || !active || loaded || error) return
    if (!readDetail) { setError('The original process reader is unavailable. Its source and version are retained.'); return }
    const controller = new AbortController()
    setLoading(true)
    void (async () => {
      const bodies: ConversationWindowSnapshot[] = []
      for (const source of deferred.records) bodies.push(await readDetail({ record: source.reference!, revision: source.revision, frontier: deferred.frontier }, controller.signal))
      if (!controller.signal.aborted) setLoaded(bodies)
    })().catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); setLoading(false) }
  }, [expanded, active, loaded, error, readDetail, deferred, attempt])
  if (!header) return null
  const tool = header.kind === 'native' ? header.parts.find(part => part.kind === 'tool-call') : undefined
  const title = header.kind === 'captured' ? header.item.toolName ?? header.item.title
    : tool?.kind === 'tool-call' ? tool.name : header.item.title ?? (header.parts.some(part => part.kind === 'reasoning') ? 'Reasoning' : 'Recorded activity')
  const collaboration = header.kind === 'native' ? header.collaboration : undefined
  const status = header.kind === 'captured' ? header.item.status : collaboration?.kind === 'operation'
    ? collaboration.status === 'completed' ? 'complete' : collaboration.status
    : header.parts.some(part => part.kind === 'tool-result' && part.failed) ? 'failed' : undefined
  return <div className="wf-native-process" data-conversation-layout-key={key} data-message-source-key={conversationMessageSourceKey(record.agentSessionId, record.source)}
    data-deferred-process-id={record.rawId}>
    <RecordedToolRow className="log-row" observation={{ id: record.rawId, title, source: header.kind === 'native' ? 'Native record' : 'Captured record', persistentSource: true, ...(status ? { status } : {}) }}
      icon={<SemanticIcon name="conversation.tool-call" size={12} />} expanded={expanded} controls={bodyId}
      onToggle={() => { setOpen(!expanded); disclosure?.onStepExpandedChange(key, !expanded) }} />
    <div id={bodyId} className="wf-native-process__body" hidden={!expanded} inert={!expanded}>
      {loading ? <p role="status">Reading original process details…</p> : null}
      {error ? <p role="status">{error} <button type="button" onClick={() => { setError(null); retry(value => value + 1) }}>Retry original details</button></p> : null}
      {loaded?.map((snapshot, index) => <div key={deferred.records[index]!.id}>{renderDetail(snapshot)}</div>)}
    </div>
  </div>
}
