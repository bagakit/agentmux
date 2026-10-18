import { ConversationProgressiveBody, needsProgressiveText } from './ConversationProgressiveBody.js'
import { ConversationSourceLabels } from './ConversationSourceLabels.js'
import { useEffect, useId, useMemo, useState } from 'react'
import { capturedToolEdit } from '@agentmux/core/conversation'
import type { ConversationRecord } from '../lib/conversation-records.js'
import { conversationMessageSourceKey } from '../lib/conversation-message-location.js'
import { describeActivityRecordTime } from '../lib/activity-record-time.js'
import { RecordedToolRow } from './WorkflowObservation.js'
import { ConversationToolPayload } from './ConversationToolPayload.js'
import { SemanticIcon } from '../theme/icons.js'
import type { ConversationProcessProps } from './ConversationRecordSequence.js'
import { stepTitle } from '../lib/activity-step-summary.js'
import { parseUnifiedDiff, toolEditDiff } from '../lib/conversation-tool-diff.js'
import { ConversationToolDiff } from './ConversationToolDiff.js'

/** Rendering of an already classified Core process/interaction; no input or permission authority. */
export function CapturedProcessRecord({ record, disclosure, located = false, workspaceRoot = '', origin = Number.NaN }: {
  record: ConversationRecord; disclosure?: ConversationProcessProps['disclosure']; located?: boolean; workspaceRoot?: string; origin?: number
}) {
  const [localOpen, setOpen] = useState(false), [presented, setPresented] = useState(false)
  const bodyId = useId()
  const item = record.original.kind === 'captured' ? record.original.item : null
  const title = useMemo(() => item ? stepTitle(item.title, item.toolName, item.toolInput, workspaceRoot) : '', [item, workspaceRoot])
  const expanded = located || ((item ? disclosure?.steps.get(item.id) : undefined) ?? localOpen)
  const shown = expanded || presented
  useEffect(() => { if (located) { setOpen(true); setPresented(true) } }, [located])
  useEffect(() => { if (expanded) setPresented(true) }, [expanded])
  if (!item) return null
  const fields = [item.content, item.toolInput, item.toolOutput]
  const prose = item.kind !== 'tool_call' ? item.content : undefined
  return <div className="wf-native-process" data-message-source-key={conversationMessageSourceKey(record.agentSessionId, record.source)} data-captured-process-id={item.id} data-conversation-role={record.role}>
    <RecordedToolRow className={`log-row log-row--${item.kind}`} observation={{ id: item.id, title, source: <ConversationSourceLabels sources={record.sources?.fields[item.toolInput !== undefined ? 'toolInput' : 'content'] ?? record.sources?.main} />, persistentSource: true, status: item.status,
      recordedTime: describeActivityRecordTime(item.createdAt, item.createdAt, origin) }} icon={<SemanticIcon name={item.kind === 'tool_call' ? 'conversation.tool-call' : item.kind === 'permission' ? 'status.permission' : 'object.activity'} size={12} />}
      expanded={expanded} controls={bodyId} onToggle={() => { if (!expanded) setPresented(true); setOpen(!expanded); disclosure?.onStepExpandedChange(item.id, !expanded) }} />
    {prose ? <p className="log-row__prose">{prose}</p> : null}
    <div id={bodyId} className="wf-native-process__body" hidden={!expanded} inert={!expanded}>{shown ? <>
      <ConversationProgressiveBody heavy={fields.some(text => text !== undefined && needsProgressiveText(text))} reveal={located}>
        <CapturedProcessBody record={record} item={item} />
      </ConversationProgressiveBody>
    </> : null}</div>
  </div>
}

function CapturedProcessBody({ record, item }: { record: ConversationRecord; item: Extract<ConversationRecord['original'], { kind: 'captured' }>['item'] }) {
  const diff = useMemo(() => {
    const input = item.toolInput ?? (item.kind === 'tool_call' ? item.content : undefined)
    return toolEditDiff(capturedToolEdit(item)) ?? (input === undefined ? null : parseUnifiedDiff(input))
  }, [item])
  const fields = [item.content, item.toolInput, item.toolOutput]
  return <>
      {diff ? <ConversationToolDiff diff={diff} /> : null}
      {fields.some(value => value !== undefined) ? fields.map((text, index) => {
        if (text === undefined) return null
        const payload = <><ConversationSourceLabels sources={record.sources?.fields[index === 1 ? 'toolInput' : index === 2 ? 'toolOutput' : 'content']} /><ConversationToolPayload text={text} identity={item} sourceIdentity={item} copyLabel={index === 1 ? 'Copy tool input' : index === 2 ? 'Copy tool output' : 'Copy recorded content'} /></>
        return diff && (index === 1 || index === 0 && item.toolInput === undefined)
          ? <details key={index}><summary>{index === 1 ? 'Original tool input' : 'Original recorded content'}</summary>{payload}</details>
          : <div key={index} className="conversation-tool-trace__payload">{payload}</div>
      }) : <ConversationToolPayload text={JSON.stringify(item, null, 2)} identity={item} sourceIdentity={item} copyLabel="Copy original record" />}
  </>
}
