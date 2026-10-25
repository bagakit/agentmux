import { ConversationRetainedDetails } from './ConversationRetainedDetails.js'
import { NATIVE_CONVERSATION_SOURCE } from '../lib/conversation-sources.js'
import type { AgentSessionHistoryItem, AgentSessionHistorySource } from '@agentmux/core'
import { conversationPresentationKey, conversationProcessPeer } from '../lib/conversation-record-sequence.js'
import type { ConversationProcessProps } from './ConversationRecordSequence.js'
import { describeActivityRecordTime } from '../lib/activity-record-time.js'
import { stepTitle } from '../lib/activity-step-summary.js'
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { SemanticIcon } from '../theme/icons.js'
import { RecordedStepsCard as WorkflowCard, RecordedToolRow as WorkflowToolRow, RecordedAgentRow as WorkflowAgentRow, type WorkflowObservationStatus, type WorkflowRecordedTime } from './WorkflowObservation.js'
import { ConversationMetricsDetails, ConversationMetricsInline, conversationMetricsLabel } from './ConversationMetrics.js'

function recordedStatus(item: Pick<AgentSessionHistoryItem, 'collaboration' | 'turnOutcome'>): WorkflowObservationStatus | undefined {
  const collaboration = item.collaboration
  if (collaboration?.kind === 'operation') return collaboration.status === 'completed' ? 'complete' : collaboration.status
  return item.turnOutcome?.status === 'completed' ? 'complete' : item.turnOutcome?.status
}

function nativeReference(source: AgentSessionHistorySource): string {
  return `${source.providerId} · ${source.nativeSessionId}`
}

function participantKey(source: AgentSessionHistorySource, occurrences: Map<string, number>): string {
  const reference = JSON.stringify([source.providerId, source.nativeSessionId])
  const occurrence = occurrences.get(reference) ?? 0
  occurrences.set(reference, occurrence + 1)
  return JSON.stringify([reference, occurrence])
}

function recordTime(item: AgentSessionHistoryItem, origin?: number): WorkflowRecordedTime | undefined {
  if (item.startedAt === undefined) return undefined
  return recordSpan(item.startedAt, item.completedAt ?? item.startedAt, origin)
}

function recordSpan(from: number, to: number, origin?: number): WorkflowRecordedTime {
  const time = describeActivityRecordTime(from, to, origin ?? Number.NaN)
  return { ...time, offset: `Observed record span, not execution duration · ${origin === undefined
    ? 'Offset not recorded' : time.offset.replace('from start', 'from this recorded group')}` }
}

function groupRecordTime(records: ConversationProcessProps['records']): WorkflowRecordedTime | undefined {
  let first: number | undefined, last = -Infinity
  for (const record of records) {
    const original = record.original.kind === 'deferred' ? record.original.item : record.original
    const from = original.kind === 'native' ? original.item.startedAt : original.item.createdAt
    if (from === undefined) return undefined
    const to = original.kind === 'native' ? original.item.completedAt ?? from : original.item.updatedAt
    first ??= from
    last = Math.max(last, to)
  }
  return first === undefined ? undefined : recordSpan(first, last)
}

/** Read-only observations over Core records. A native reference is never a Desktop Session. */
export function NativeProcessObservation({ id, records: sourceRecords, entries, renderRecord, metrics, disclosure, compact = false }: ConversationProcessProps & { compact?: boolean }) {
  const [localExpanded, setExpanded] = useState(!compact)
  const expanded = disclosure?.expanded ?? localExpanded
  const [readOnce, setReadOnce] = useState(expanded)
  useEffect(() => { if (expanded) setReadOnce(true) }, [expanded])
  const layout = entries
  const records = sourceRecords.filter(record => !conversationProcessPeer(record))
  const items = records.flatMap(record => record.original.kind === 'native' ? [record.original.item] : record.original.kind === 'deferred' && record.original.item.kind === 'native' ? [{ ...record.original.item.item, ...(record.original.item.collaboration ? { collaboration: record.original.item.collaboration } : {}) }] : [])
  const anchored = layout.some(entry => entry.kind === 'anchor' || conversationProcessPeer(entry.record))
  const nativeOnly = records.every(record => record.source.kind === 'native')
  const states = items.map(recordedStatus)
  const recordedStepStatus = states.includes('failed') ? 'failed' : states.includes('running') ? 'running'
    : states.includes('interrupted') ? 'interrupted'
    : states.every(state => state === 'complete') ? 'complete' : undefined
  const source = records[0]?.source
  const sameTurn = metrics?.turnId && items.length === records.length && items.every(item => item.turnId === metrics.turnId)
    && source?.kind === 'native' && typeof records[0]?.sourceHostId === 'string' && records.every(record => record.sourceHostId === records[0]?.sourceHostId && record.source.kind === 'native'
      && record.source.providerId === source.providerId && record.source.nativeSessionId === source.nativeSessionId)
  const turnOutcome = sameTurn ? items.find(item => item.turnOutcome)?.turnOutcome : undefined
  const status = nativeOnly ? recordedStepStatus ?? (turnOutcome?.status === 'completed' ? 'complete' : turnOutcome?.status) : undefined
  const first = items[0]
  const recordedTime = groupRecordTime(records)
  return <div className={compact ? 'native-process-observation native-process-observation--compact' : 'native-process-observation'}><WorkflowCard compact={compact} observation={{ id, label: metrics ? conversationMetricsLabel(metrics) : compact ? '执行过程' : 'Process', stepCount: records.length, countUnit: 'records',
    ...(metrics ? { metrics: <ConversationMetricsInline observation={metrics} /> } : {}),
    ...(status ? { status } : {}), ...(recordedTime ? { recordedTime } : {}) }}
    keepContentVisible={anchored} expanded={expanded} onExpandedChange={open => { if (open) setReadOnce(true); setExpanded(open); disclosure?.onExpandedChange(open) }}>
    {metrics ? <div className="native-process-observation__metrics" hidden={!expanded}><ConversationMetricsDetails observation={metrics} /></div> : null}
    {layout.map(entry => {
      if (entry.kind === 'anchor') return <div key={JSON.stringify(['anchor', entry.key])}>{entry.content}</div>
      const record = entry.record, key = conversationPresentationKey(record)
      if (conversationProcessPeer(record)) return <div key={key}>{renderRecord(record)}</div>
      const item = record.original.kind === 'native' ? record.original.item : undefined
      return <div key={key} className="native-process-observation__step" hidden={!expanded} inert={!expanded}>{expanded || readOnce ? item ? renderRecord(record, body =>
        <NativeProcessStep item={item} {...(first?.startedAt === undefined ? {} : { origin: first.startedAt })}
          {...(disclosure?.steps.get(key) === undefined ? {} : { expanded: disclosure.steps.get(key)! })}
          {...(disclosure ? { onExpandedChange: (open: boolean) => disclosure.onStepExpandedChange(key, open) } : {})}>{body}</NativeProcessStep>)
        : renderRecord(record, undefined, disclosure) : null}</div>
    })}
  </WorkflowCard>{items.flatMap(item => [item.metricsDiagnostic, item.turnOutcomeDiagnostic].flatMap((diagnostic, index) => diagnostic
    ? [<p key={JSON.stringify([item.id, index])} className="conversation-metrics__notice" role="status">{diagnostic.message}</p>] : []))}</div>
}

export function NativeProcessStep({ item, origin, children, bodyOnly = false, expanded: controlledExpanded, onExpandedChange }: {
  item: AgentSessionHistoryItem
  bodyOnly?: boolean
  origin?: number
  children: ReactNode
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}) {
  const [localExpanded, setExpanded] = useState(false)
  const expanded = bodyOnly || (controlledExpanded ?? localExpanded)
  const [readOnce, setReadOnce] = useState(expanded)
  useEffect(() => { if (expanded) setReadOnce(true) }, [expanded])
  const bodyId = useId()
  const collaboration = item.collaboration
  const receiverOccurrences = new Map<string, number>()
  const stateOccurrences = new Map<string, number>()
  const time = recordTime(item, origin)
  const status = recordedStatus(item)
  const call = item.contentParts.find(part => part.kind === 'tool-call')
  const title = useMemo(() => collaboration?.kind === 'operation'
    ? operationTitle(collaboration.operation)
    : collaboration?.kind === 'agent-activity'
      ? `Agent ${collaboration.event}`
      : call?.kind === 'tool-call' ? stepTitle(call.name, call.name, call.input, '')
        : item.title ?? (item.contentParts.some(part => part.kind === 'reasoning') ? 'Reasoning' : 'Recorded activity'), [item])
  function toggle(): void {
    if (!expanded) setReadOnce(true)
    setExpanded(!expanded)
    onExpandedChange?.(!expanded)
  }
  return <div className="wf-native-process" data-native-step-id={item.id} data-body-only={bodyOnly ? '' : undefined}>
    {!bodyOnly ? <WorkflowToolRow observation={{ id: item.id, title, source: NATIVE_CONVERSATION_SOURCE, persistentSource: true,
      ...(status ? { status } : {}), ...(time ? { recordedTime: time } : {}) }}
      className="log-row" icon={collaboration ? <SemanticIcon name="object.collaboration" size={12} /> : <SemanticIcon name={call ? 'conversation.tool-call' : item.contentParts.some(part => part.kind === 'tool-result') ? 'conversation.tool-result' : 'object.activity'} size={12} />}
      expanded={expanded} controls={bodyId} onToggle={toggle} /> : null}
    <div id={bodyId} className="wf-native-process__body" hidden={!expanded} inert={!expanded}>
      {expanded || readOnce ? <>
        {collaboration?.kind === 'operation' ? <>
          <dl className="wf-native-process__references">
            {collaboration.sender ? <div><dt>Sender</dt><dd><code>{nativeReference(collaboration.sender)}</code></dd></div> : null}
            {collaboration.receivers.length ? <div><dt>Receivers</dt><dd>{collaboration.receivers.map(receiver =>
              <code key={participantKey(receiver, receiverOccurrences)}>{nativeReference(receiver)}</code>)}</dd></div> : null}
            {collaboration.status ? <div><dt>Recorded operation</dt><dd>{collaboration.status}</dd></div> : null}
          </dl>
          {collaboration.prompt === undefined ? null : <div className="wf-native-process__prompt">
            <span className="wf-observation__recorded">Prompt</span><pre className="wf-native-process__text">{collaboration.prompt}</pre>
          </div>}
          {collaboration.agentStates.length ? <section aria-label="Last recorded target states">
            <span className="wf-observation__recorded">Last recorded target states</span>
            <ul className="wf-agents">{collaboration.agentStates.map(agent => {
              const key = participantKey(agent.source, stateOccurrences)
              return <WorkflowAgentRow key={key} observation={{
                id: JSON.stringify([item.id, key]),
                label: agent.source.nativeSessionId,
                source: nativeReference(agent.source),
                ...(agent.state ? { state: agent.state } : {}),
                ...(agent.message === undefined ? {} : { message: agent.message })
              }} />})}</ul>
          </section> : null}
        </> : collaboration?.kind === 'agent-activity' ? <dl className="wf-native-process__references">
          <div><dt>Native agent</dt><dd><code>{nativeReference(collaboration.agent)}</code></dd></div>
          <div><dt>Recorded event</dt><dd>{collaboration.event}</dd></div>
          {collaboration.path === undefined ? null : <div><dt>Native agent path</dt><dd><code>{collaboration.path}</code></dd></div>}
        </dl> : null}
        {collaboration ? <ConversationRetainedDetails className="wf-native-process__raw" summary="Original record">{() => children}</ConversationRetainedDetails> : children}
      </> : null}
    </div>
  </div>
}

function operationTitle(operation: Extract<NonNullable<AgentSessionHistoryItem['collaboration']>, { kind: 'operation' }>['operation']): string {
  switch (operation) {
    case 'spawn': return 'Start agent'
    case 'send-input': return 'Send input'
    case 'send-message': return 'Send message'
    case 'followup': return 'Follow up'
    case 'wait': return 'Wait for agents'
    case 'resume': return 'Resume agent'
    case 'interrupt': return 'Interrupt agent'
    case 'close': return 'Close agent'
    case 'list': return 'List agents'
    default: return 'Recorded collaboration'
  }
}
