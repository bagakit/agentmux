import type { AgentSessionHistoryItem, AgentSessionHistorySource } from '@agentmux/core'
import type { ConversationProcessProps } from '@agentmux/client-ui/components/ConversationRecordSequence'
import { describeActivityRecordTime } from '../lib/activity-ruler'
import { stepTitle } from '@agentmux/client-ui/activity-step-summary'
import { useId, useState, type ReactNode } from 'react'
import { GitBranch, Terminal } from 'lucide-react'
import { WorkflowCard } from './workflow/WorkflowCard'
import { WorkflowToolRow } from './workflow/WorkflowToolRow'
import { WorkflowAgentRow } from './workflow/WorkflowAgentRow'
import type { WorkflowObservationStatus, WorkflowRecordedTime } from './workflow/types'

function recordedStatus(item: AgentSessionHistoryItem): WorkflowObservationStatus | undefined {
  const collaboration = item.collaboration
  if (collaboration?.kind !== 'operation') return undefined
  return collaboration.status === 'completed' ? 'complete' : collaboration.status
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
  const time = describeActivityRecordTime(item.startedAt, item.completedAt ?? item.startedAt, origin ?? Number.NaN)
  return { ...time, offset: `Observed record span, not execution duration · ${origin === undefined
    ? 'Offset not recorded' : time.offset.replace('from start', 'from this recorded group')}` }
}

/** Read-only observations over Core records. A native reference is never a Desktop Session. */
export function NativeProcessObservation({ id, items, renderRecord }: ConversationProcessProps) {
  const [expanded, setExpanded] = useState(true)
  const states = items.map(recordedStatus)
  const status = states.includes('failed') ? 'failed' : states.includes('running') ? 'running'
    : states.includes('interrupted') ? 'interrupted'
    : states.every(state => state === 'complete') ? 'complete' : undefined
  const first = items[0]!
  const last = items.at(-1)!
  const recordedTime = items.every(item => item.startedAt !== undefined) ? recordTime({
    ...first, completedAt: last.completedAt ?? last.startedAt!
  }) : undefined
  return <WorkflowCard observation={{ id, label: 'Process', stepCount: items.length,
    ...(status ? { status } : {}), ...(recordedTime ? { recordedTime } : {}) }}
    expanded={expanded} onExpandedChange={setExpanded}>
    {items.map(item => renderRecord(item, body =>
      <NativeProcessStep item={item} {...(first.startedAt === undefined ? {} : { origin: first.startedAt })}>{body}</NativeProcessStep>))}
  </WorkflowCard>
}

function NativeProcessStep({ item, origin, children }: {
  item: AgentSessionHistoryItem
  origin?: number
  children: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const [readOnce, setReadOnce] = useState(false)
  const bodyId = useId()
  const collaboration = item.collaboration
  const receiverOccurrences = new Map<string, number>()
  const stateOccurrences = new Map<string, number>()
  const time = recordTime(item, origin)
  const status = recordedStatus(item)
  const call = item.contentParts.find(part => part.kind === 'tool-call')
  const title = collaboration?.kind === 'operation'
    ? operationTitle(collaboration.operation)
    : collaboration?.kind === 'agent-activity'
      ? `Agent ${collaboration.event}`
      : call?.kind === 'tool-call' ? stepTitle(call.name, call.name, call.input, '')
        : item.title ?? (item.contentParts.some(part => part.kind === 'reasoning') ? 'Reasoning' : 'Recorded activity')
  function toggle(): void {
    if (!expanded) setReadOnce(true)
    setExpanded(value => !value)
  }
  return <div className="wf-native-process">
    <WorkflowToolRow observation={{ id: item.id, title, source: 'Native', persistentSource: true,
      ...(status ? { status } : {}), ...(time ? { recordedTime: time } : {}) }}
      className="log-row" icon={collaboration ? <GitBranch size={12} /> : <Terminal size={12} />}
      expanded={expanded} controls={bodyId} onToggle={toggle} />
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
        {collaboration ? <details className="wf-native-process__raw"><summary>Original record</summary>{children}</details> : children}
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
