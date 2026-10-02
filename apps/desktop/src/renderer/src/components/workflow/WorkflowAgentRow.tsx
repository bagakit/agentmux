import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { SemanticIcon } from '../semantic-icons'
import { WorkflowStatusGlyph, WorkflowStatusName } from './WorkflowStatusGlyph'
import { workflowStatusLabel, type WorkflowAgent } from './types'

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-')
}

export function WorkflowAgentRow({
  observation,
  agent,
  phaseLabel,
  compact = false,
  defaultExpanded = false
}: {
  observation?: never
  agent: WorkflowAgent
  phaseLabel: string
  compact?: boolean
  defaultExpanded?: boolean
} | {
  observation: {
    id: string
    label: string
    source: string
    state?: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'stopped' | 'not-found'
    message?: string
  }
  agent?: never
  phaseLabel?: never
  compact?: never
  defaultExpanded?: never
}) {
  return observation ? <RecordedAgentRow observation={observation} />
    : <WorkflowSnapshotAgentRow agent={agent} phaseLabel={phaseLabel!} compact={compact} defaultExpanded={defaultExpanded} />
}

function WorkflowSnapshotAgentRow({ agent, phaseLabel, compact, defaultExpanded }: {
  agent: WorkflowAgent
  phaseLabel: string
  compact: boolean
  defaultExpanded: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const generatedId = useId()
  const detailId = `wf-detail-${safeId(agent.id)}-${safeId(generatedId)}`
  const toggle = (): void => setExpanded((value) => !value)

  return (
    <>
      <li
        className={`wf-agent ${compact ? 'wf-agent--compact' : ''}`}
        data-state={agent.status}
        data-agent-id={agent.id}
      >
        <button
          type="button"
          className="wf-agent__button"
          aria-expanded={expanded}
          aria-controls={detailId}
          onClick={toggle}
        >
          <span className="wf-agent__state">
            <WorkflowStatusGlyph status={agent.status} />
            <WorkflowStatusName status={agent.status} />
          </span>
          <span className="wf-agent__label">
            <span className="wf-agent__name">{agent.label}</span>
            {agent.attempts && agent.attempts > 1 ? <span className="wf-retry">×{agent.attempts}</span> : null}
          </span>
          <span className="wf-agent__meta">
            {agent.model ? <span className="wf-m-model">{agent.model}</span> : null}
            {agent.lastTool ? <span className="wf-m-tool">{agent.lastTool}</span> : null}
            {agent.duration ? <b>{agent.duration}</b> : null}
            {agent.tokens ? <b>{agent.tokens}</b> : null}
            <ChevronRight className="wf-chev" size={12} aria-hidden="true" />
            <span className="wf-sr">{workflowStatusLabel(agent.status)}</span>
          </span>
        </button>
      </li>
      {expanded ? (
        <li id={detailId} className="wf-detail" data-for-agent={agent.id}>
          <dl>
            <div><dt>阶段</dt><dd>{phaseLabel}</dd></div>
            <div><dt>模型</dt><dd>{agent.model ?? '—'}</dd></div>
            <div><dt>尝试</dt><dd>第 {agent.attempts ?? 1} 次</dd></div>
            <div><dt>状态</dt><dd>{workflowStatusLabel(agent.status)}</dd></div>
            <div><dt>排队于</dt><dd>{agent.queuedAt ?? '—'}</dd></div>
            <div><dt>开始于</dt><dd>{agent.startedAt ?? '—'}</dd></div>
            <div><dt>最近活动</dt><dd>{agent.lastActivityAt ?? '—'}</dd></div>
            <div><dt>耗时</dt><dd>{agent.duration ?? '—'}</dd></div>
            <div><dt>token</dt><dd>{agent.tokens ?? '—'}</dd></div>
            <div><dt>工具调用</dt><dd>{agent.toolCalls ?? '—'}</dd></div>
            <div><dt>最近工具</dt><dd>{agent.lastTool ?? '—'}</dd></div>
          </dl>
        </li>
      ) : null}
    </>
  )
}

function RecordedAgentRow({ observation }: {
  observation: {
    id: string
    label: string
    source: string
    state?: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'stopped' | 'not-found'
    message?: string
  }
}) {
  const [expanded, setExpanded] = useState(false)
  const detailId = useId()
  const state = observation.state
  const glyph = state === 'running' ? 'running' : state === 'completed' ? 'completed'
    : state === 'failed' ? 'failed' : state === 'interrupted' || state === 'stopped' ? 'killed'
    : state === 'pending' ? 'queued' : 'paused'
  return <>
    <li className="wf-agent wf-agent--observation" data-recorded-agent-id={observation.id}>
      <button type="button" className="wf-agent__button" aria-expanded={expanded}
        aria-controls={detailId} onClick={() => setExpanded(value => !value)}>
        <span className="wf-agent__state">{state === undefined || state === 'not-found' ? <SemanticIcon name="neutral" size={12} /> : <WorkflowStatusGlyph status={glyph} recorded />}</span>
        <span className="wf-agent__label"><span className="wf-agent__name" title={observation.label}>{observation.label}</span></span>
        <span className="wf-agent__meta" title="Last recorded target state">
          <span>{state ?? 'State not recorded'}</span><ChevronRight className="wf-chev" size={12} aria-hidden="true" />
        </span>
      </button>
    </li>
    <li id={detailId} className="wf-detail" data-for-recorded-agent={observation.id} hidden={!expanded} inert={!expanded}>
      <dl><div><dt>Native reference</dt><dd>{observation.source}</dd></div>
        {state ? <div><dt>Last recorded state</dt><dd>{state}</dd></div> : null}</dl>
      {observation.message === undefined ? null : <pre className="wf-native-process__text">{observation.message}</pre>}
    </li>
  </>
}
