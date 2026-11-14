import { ConversationRetainedDetails } from './ConversationRetainedDetails.js'
import { NATIVE_CONVERSATION_SOURCE } from '../lib/conversation-sources.js'
import type { AgentSessionHistoryItem, AgentSessionHistorySource } from '@agentmux/core'
import { conversationPresentationKey, conversationProcessPeer } from '../lib/conversation-record-sequence.js'
import type { ConversationProcessProps } from './ConversationRecordSequence.js'
import { describeActivityRecordTime } from '../lib/activity-record-time.js'
import { stepTitle } from '../lib/activity-step-summary.js'
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { SemanticIcon } from '../theme/icons.js'
import { RecordedStepsCard as WorkflowCard, RecordedToolRow as WorkflowToolRow, RecordedAgentRow as WorkflowAgentRow, type WorkflowObservationStatus, type WorkflowRecordedTime, type RecordedProcessObservation } from './WorkflowObservation.js'
import { ConversationMetricsDetails, ConversationMetricsInline, conversationMetricsLabel } from './ConversationMetrics.js'
import type { ConversationRecord } from '../lib/conversation-records.js'

/** The recorded failure flag is enough to expose an issue, never to invent its cause. */
function recordedFailure(record: Pick<ConversationRecord, 'original'>): boolean {
  const original = record.original.kind === 'deferred' ? record.original.item : record.original
  if (original.kind === 'captured') return original.item.status === 'failed'
  const parts = 'parts' in original ? original.parts : original.item.contentParts
  const collaboration = 'parts' in original ? original.collaboration : original.item.collaboration
  return original.item.turnOutcome?.status === 'failed'
    || collaboration?.kind === 'operation' && collaboration.status === 'failed'
    || parts.some(part => part.kind === 'tool-result' && part.failed === true)
}

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

/** The one recorded-span reading for a process step, shared by eager and deferred rows. */
export function recordTime(item: Pick<AgentSessionHistoryItem, 'startedAt' | 'completedAt'>, origin?: number): WorkflowRecordedTime | undefined {
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
export function NativeProcessObservation({ id, records: sourceRecords, entries, renderRecord, metrics, disclosure, initiallyExpanded, compact = false, actions, renderSummary }: ConversationProcessProps & { compact?: boolean; actions?: ReactNode; renderSummary?: (observation: RecordedProcessObservation) => ReactNode }) {
  const processId = useId()
  const [localExpanded, setExpanded] = useState(initiallyExpanded ?? !compact)
  const expanded = disclosure?.expanded ?? localExpanded
  const [readOnce, setReadOnce] = useState(expanded)
  useEffect(() => { if (expanded) setReadOnce(true) }, [expanded])
  const layout = entries
  // Only adjacent originals share a disclosure. Interleaved calls, anchors and
  // unknown memberships retain their original order and independent controls.
  const grouped = new Map<string, readonly string[]>()
  let adjacent: { invocation: string; keys: string[] } | undefined
  const flush = () => {
    if (adjacent && adjacent.keys.length > 1) for (const key of adjacent.keys) grouped.set(key, adjacent.keys)
    adjacent = undefined
  }
  for (const entry of layout) {
    if (entry.kind !== 'record' || conversationProcessPeer(entry.record)) { flush(); continue }
    const invocation = entry.record.invocationKey
    if (!invocation) { flush(); continue }
    if (adjacent?.invocation !== invocation) { flush(); adjacent = { invocation, keys: [] } }
    adjacent!.keys.push(conversationPresentationKey(entry.record))
  }
  flush()
  const shared = new Map<readonly string[], { disclosure: NonNullable<ConversationProcessProps['disclosure']>; controls: string }>()
  if (disclosure) for (const keys of new Set(grouped.values())) {
    const open = keys.some(key => disclosure.steps.get(key) === true)
    shared.set(keys, { controls: keys.map(key => `${processId}-${encodeURIComponent(key)}`).join(' '),
      disclosure: { ...disclosure, steps: new Map(keys.map(key => [key, open])),
        onStepExpandedChange: (_key, expanded) => { for (const key of keys) disclosure.onStepExpandedChange(key, expanded) } } })
  }
  const records = sourceRecords.filter(record => !conversationProcessPeer(record))
  const failureCount = records.filter(record => (record.deferred?.records ?? record.records ?? [record]).some(recordedFailure)).length
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
  const observation: RecordedProcessObservation = { id, label: metrics ? conversationMetricsLabel(metrics) : compact ? '执行过程' : 'Process', stepCount: records.length, countUnit: 'records',
    ...(metrics ? { metrics: <ConversationMetricsInline observation={metrics} /> } : {}),
    ...(status ? { status } : {}), ...(recordedTime ? { recordedTime } : {}) }
  return <div className={compact ? 'native-process-observation native-process-observation--compact' : 'native-process-observation'}><WorkflowCard compact={compact} observation={observation} actions={actions}
    keepContentVisible={anchored} expanded={expanded} onExpandedChange={open => { if (open) setReadOnce(true); setExpanded(open); disclosure?.onExpandedChange(open) }}
    notice={failureCount > 0 ? <p className="native-process-observation__issue" role="status">
      <SemanticIcon name="status.failed" size={12} />
      <span>{compact ? `${failureCount} 条已加载记录标记为失败；展开查看原结果。` : `${failureCount} loaded records marked failed. Expand for original details.`}</span>
    </p> : null}>
    {metrics ? <div className="native-process-observation__metrics" hidden={!expanded}><ConversationMetricsDetails observation={metrics} /></div> : null}
    {layout.map(entry => {
      if (entry.kind === 'anchor') return <div key={JSON.stringify(['anchor', entry.key])}>{entry.content}</div>
      const record = entry.record, key = conversationPresentationKey(record)
      if (conversationProcessPeer(record)) return <div key={key}>{renderRecord(record)}</div>
      const item = record.original.kind === 'native' ? record.original.item : undefined
      const members = grouped.get(key), common = members && shared.get(members)
      const bodyId = `${processId}-${encodeURIComponent(key)}`
      const stepDisclosure = common && members ? { ...common.disclosure, stepGroup: {
        headerHidden: members[0] !== key && !recordedFailure(record), bodyId,
        controls: common.controls
      } } : disclosure
      return <div key={key} className="native-process-observation__step" hidden={!expanded} inert={!expanded}>{expanded || readOnce ? item ? renderRecord(record, body =>
        <NativeProcessStep item={item} source={record.source.kind === 'native' ? record.source : undefined} {...(first?.startedAt === undefined ? {} : { origin: first.startedAt })}
          {...(stepDisclosure?.steps.get(key) === undefined ? {} : { expanded: stepDisclosure.steps.get(key)! })}
          {...(stepDisclosure ? { onExpandedChange: (open: boolean) => stepDisclosure.onStepExpandedChange(key, open) } : {})}
          {...(stepDisclosure?.stepGroup ? { stepGroup: stepDisclosure.stepGroup } : {})}>{body}</NativeProcessStep>)
        : renderRecord(record, undefined, stepDisclosure) : null}</div>
    })}
  </WorkflowCard>{items.flatMap(item => [item.metricsDiagnostic, item.turnOutcomeDiagnostic].flatMap((diagnostic, index) => diagnostic
    ? [<p key={JSON.stringify([item.id, index])} className="conversation-metrics__notice" role="status">{diagnostic.message}</p>] : []))}{renderSummary?.(observation)}</div>
}

export function NativeProcessStep({ item, source, origin, children, bodyOnly = false, expanded: controlledExpanded, onExpandedChange, stepGroup }: {
  item: AgentSessionHistoryItem
  source?: AgentSessionHistorySource | undefined
  bodyOnly?: boolean
  origin?: number
  children: ReactNode
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  stepGroup?: NonNullable<ConversationProcessProps['disclosure']>['stepGroup']
}) {
  const [localExpanded, setExpanded] = useState(false)
  const expanded = bodyOnly || (controlledExpanded ?? localExpanded)
  const [readOnce, setReadOnce] = useState(expanded)
  useEffect(() => { if (expanded) setReadOnce(true) }, [expanded])
  const localBodyId = useId(), bodyId = stepGroup?.bodyId ?? localBodyId
  const collaboration = item.collaboration
  const receiverOccurrences = new Map<string, number>()
  const stateOccurrences = new Map<string, number>()
  const time = recordTime(item, origin)
  const status = recordedStatus(item)
  const call = item.contentParts.find(part => part.kind === 'tool-call')
  const result = item.contentParts.find(part => part.kind === 'tool-result')
  const hasFailedResult = item.contentParts.some(part => part.kind === 'tool-result' && part.failed === true)
  const title = useMemo(() => collaboration?.kind === 'operation'
    ? operationTitle(collaboration.operation)
    : collaboration?.kind === 'agent-activity'
      ? `Agent ${collaboration.event}`
      : call?.kind === 'tool-call' ? stepTitle(call.name, call.name, call.input, '')
        : item.title ?? (result?.name ? `${result.name} result` : result ? 'Tool result' : item.contentParts.some(part => part.kind === 'reasoning') ? 'Reasoning' : 'Recorded activity'), [item])
  function toggle(): void {
    if (!expanded) setReadOnce(true)
    setExpanded(!expanded)
    onExpandedChange?.(!expanded)
  }
  return <div className="wf-native-process" data-native-step-id={item.id} data-body-only={bodyOnly ? '' : undefined}>
    {!bodyOnly ? <WorkflowToolRow observation={{ id: item.id, title, source: NATIVE_CONVERSATION_SOURCE, persistentSource: true,
      ...(status ? { status } : {}), ...(hasFailedResult ? { hasFailedResult } : {}), ...(time ? { recordedTime: time } : {}) }}
      className="log-row" icon={collaboration ? <SemanticIcon name="object.collaboration" size={12} /> : <SemanticIcon name={call ? 'conversation.tool-call' : item.contentParts.some(part => part.kind === 'tool-result') ? 'conversation.tool-result' : 'object.activity'} size={12} />}
      hidden={Boolean(stepGroup?.headerHidden && !hasFailedResult)} missingStatusInDetails expanded={expanded} controls={stepGroup?.controls ?? bodyId} onToggle={toggle} /> : null}
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
        <ConversationRetainedDetails summary="Recorded source">{() => <dl className="wf-native-process__references" aria-label="Recorded step source">
          <div><dt>Source</dt><dd>{NATIVE_CONVERSATION_SOURCE}</dd></div>
          {source ? <><div><dt>Provider</dt><dd>{source.providerId}</dd></div><div><dt>Native session</dt><dd><code>{source.nativeSessionId}</code></dd></div></> : null}
          <div><dt>Record</dt><dd><code>{item.id}</code></dd></div>
          <div><dt>Recorded status</dt><dd>{status ?? 'Status not recorded'}</dd></div>
        </dl>}</ConversationRetainedDetails>
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
