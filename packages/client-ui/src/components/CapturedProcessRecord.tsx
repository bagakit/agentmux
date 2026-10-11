import { useEffect, useId, useState } from 'react'
import type { ConversationRecord } from '../lib/conversation-records.js'
import { conversationMessageSourceKey } from '../lib/conversation-message-location.js'
import { describeActivityRecordTime } from '../lib/activity-record-time.js'
import { RecordedToolRow } from './WorkflowObservation.js'
import { ConversationToolPayload } from './ConversationToolPayload.js'
import { SemanticIcon } from '../theme/icons.js'
import type { ConversationProcessProps } from './ConversationRecordSequence.js'

/** Rendering of an already classified Core process/interaction; no input or permission authority. */
export function CapturedProcessRecord({ record, disclosure, located = false }: {
  record: ConversationRecord; disclosure?: ConversationProcessProps['disclosure']; located?: boolean
}) {
  const [localOpen, setOpen] = useState(false), [presented, setPresented] = useState(false)
  const bodyId = useId()
  useEffect(() => { if (located) { setOpen(true); setPresented(true) } }, [located])
  if (record.original.kind !== 'captured') return null
  const item = record.original.item, expanded = located || (disclosure?.steps.get(item.id) ?? localOpen)
  const fields = [item.content, item.toolInput, item.toolOutput]
  return <div className="wf-native-process" data-message-source-key={conversationMessageSourceKey(record.agentSessionId, record.source)} data-captured-process-id={item.id} data-conversation-role={record.role}>
    <RecordedToolRow className="log-row" observation={{ id: item.id, title: item.title, source: item.source, persistentSource: true, status: item.status,
      recordedTime: describeActivityRecordTime(item.createdAt, item.createdAt, Number.NaN) }} icon={<SemanticIcon name="conversation.tool-call" size={12} />}
      expanded={expanded} controls={bodyId} onToggle={() => { if (!expanded) setPresented(true); setOpen(!expanded); disclosure?.onStepExpandedChange(item.id, !expanded) }} />
    <div id={bodyId} className="wf-native-process__body" hidden={!expanded} inert={!expanded}>{expanded || presented ? fields.some(value => value !== undefined)
      ? fields.map((text, index) => text === undefined ? null : <ConversationToolPayload key={index} text={text} identity={item} sourceIdentity={item} copyLabel={index === 1 ? 'Copy tool input' : index === 2 ? 'Copy tool output' : 'Copy recorded content'} />)
      : <ConversationToolPayload text={JSON.stringify(item, null, 2)} identity={item} sourceIdentity={item} copyLabel="Copy original record" /> : null}</div>
  </div>
}
