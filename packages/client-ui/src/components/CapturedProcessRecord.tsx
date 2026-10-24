import { ConversationRetainedDetails } from './ConversationRetainedDetails.js'
import { ConversationBodyWorkContext, ConversationProgressiveBody, needsProgressiveText } from './ConversationProgressiveBody.js'
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
export function CapturedProcessRecord({ record, disclosure, bodyOnly = false, located = false, workspaceRoot = '', origin = Number.NaN }: {
  record: ConversationRecord; bodyOnly?: boolean; disclosure?: ConversationProcessProps['disclosure']; located?: boolean; workspaceRoot?: string; origin?: number
}) {
  const [localOpen, setOpen] = useState(false), [presented, setPresented] = useState(false)
  const bodyId = useId()
  const item = record.original.kind === 'captured' ? record.original.item : null
  const title = useMemo(() => item ? stepTitle(item.title, item.toolName, item.toolInput, workspaceRoot) : '', [item, workspaceRoot])
  const expanded = bodyOnly || located || ((item ? disclosure?.steps.get(item.id) : undefined) ?? localOpen)
  const shown = expanded || presented
  useEffect(() => { if (located) { setOpen(true); setPresented(true) } }, [located])
  useEffect(() => { if (expanded) setPresented(true) }, [expanded])
  const project = useMemo(() => {
    let value: ReturnType<typeof projectCapturedBody> | undefined
    return () => value ??= item ? projectCapturedBody(item) : { diff: null, fields: [] }
  }, [item])
  const reading = useMemo(() => () => {
    const { diff, fields } = project()
    return [...(diff ? [diff.lines.map(line => line.text).join('')] : []), ...fields.flatMap((text, index) =>
      text === undefined || text.length === 0 || diff && (index === 1 || index === 0 && item?.toolInput === undefined) ? [] : [text])]
  }, [project, item?.toolInput])
  if (!item) return null
  const heavy = [item.content, item.toolInput, item.toolOutput].some(text => text !== undefined && needsProgressiveText(text))
  const body = shown ? <ConversationProgressiveBody heavy={heavy} reveal={located} reading={reading}>
    <ConversationBodyWorkContext.Provider value={null}><CapturedProcessBody record={record} item={item} project={project} /></ConversationBodyWorkContext.Provider>
  </ConversationProgressiveBody> : null
  if (bodyOnly) return body
  return <div className="wf-native-process" data-message-source-key={conversationMessageSourceKey(record.agentSessionId, record.source)} data-captured-process-id={item.id} data-conversation-role={record.role}>
    <RecordedToolRow className={`log-row log-row--${item.kind}`} observation={{ id: item.id, title, source: <ConversationSourceLabels sources={record.sources?.fields[item.toolInput !== undefined ? 'toolInput' : 'content'] ?? record.sources?.main} />, persistentSource: true, status: item.status,
      recordedTime: describeActivityRecordTime(item.createdAt, item.createdAt, origin) }} icon={<SemanticIcon name={item.kind === 'tool_call' ? 'conversation.tool-call' : item.kind === 'permission' ? 'status.permission' : 'object.activity'} size={12} />}
      expanded={expanded} controls={bodyId} onToggle={() => { if (!expanded) setPresented(true); setOpen(!expanded); disclosure?.onStepExpandedChange(item.id, !expanded) }} />
    <div id={bodyId} className="wf-native-process__body" hidden={!expanded} inert={!expanded}>{body}</div>
  </div>
}

function CapturedProcessBody({ record, item, project }: { record: ConversationRecord; item: Extract<ConversationRecord['original'], { kind: 'captured' }>['item']; project: () => ReturnType<typeof projectCapturedBody> }) {
  const sourceKey = conversationMessageSourceKey(record.agentSessionId, record.source)
  // Snapshot objects change on status updates. Actions belong to the original source;
  // ConversationToolPayload separately resets when the field's exact text changes.
  const sourceIdentity = useMemo(() => ({}), [record.sourceHostId, sourceKey])
  const { diff, fields } = project()
  return <>
      {diff ? <ConversationToolDiff diff={diff} /> : null}
      {fields.some(value => value !== undefined && value.length > 0) ? fields.map((text, index) => {
        if (text === undefined || text.length === 0) return null
        const payload = <><ConversationSourceLabels sources={record.sources?.fields[index === 1 ? 'toolInput' : index === 2 ? 'toolOutput' : 'content']} /><ConversationToolPayload text={text} identity={sourceIdentity} sourceIdentity={sourceIdentity} copyLabel={index === 1 ? 'Copy tool input' : index === 2 ? 'Copy tool output' : 'Copy recorded content'} /></>
        return diff && (index === 1 || index === 0 && item.toolInput === undefined)
          ? <ConversationRetainedDetails key={index} summary={index === 1 ? 'Original tool input' : 'Original recorded content'}>{() => payload}</ConversationRetainedDetails>
          : <div key={index} className="conversation-tool-trace__payload conversation-tool-trace__payload--direct">{payload}</div>
      }) : <ConversationRetainedDetails summary="Original record details">{() => <ConversationToolPayload text={JSON.stringify(item, null, 2)} identity={sourceIdentity} sourceIdentity={sourceIdentity} copyLabel="Copy original record" />}</ConversationRetainedDetails>}
  </>
}

/** The query and original disclosure share this lazy interpretation of the accepted fields. */
function projectCapturedBody(item: Extract<ConversationRecord['original'], { kind: 'captured' }>['item']) {
  const input = item.toolInput ?? (item.kind === 'tool_call' ? item.content : undefined)
  return { diff: toolEditDiff(capturedToolEdit(item)) ?? (input === undefined ? null : parseUnifiedDiff(input)),
    fields: [item.content, item.toolInput, item.toolOutput] }
}
