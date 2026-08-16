import { useId, useState } from 'react'
import { ChevronRight, GitBranch } from 'lucide-react'
import { WorkflowPhase } from './WorkflowPhase'
import { WorkflowProgressRail } from './WorkflowProgressRail'
import { WorkflowStatusGlyph } from './WorkflowStatusGlyph'
import { workflowStatusLabel, type WorkflowSnapshot, type WorkflowVariant } from './types'
import { WorkflowToolRow } from './WorkflowToolRow'
import { workflowPresentation } from './presentation'

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-')
}

export function WorkflowCard({
  workflow,
  variant = 'inline',
  defaultExpanded,
  expanded: expandedProp,
  onExpandedChange
}: {
  workflow: WorkflowSnapshot
  variant?: WorkflowVariant
  defaultExpanded?: boolean
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}) {
  const generatedId = useId()
  const contentId = `wf-card-${safeId(workflow.id)}-${safeId(generatedId)}`
  const presentation = workflowPresentation(workflow)
  const [expanded, setExpanded] = useState(defaultExpanded ?? (presentation.kind === 'card' && presentation.defaultExpanded))
  const [phasesExpanded, setPhasesExpanded] = useState(true)
  const expandedValue = expandedProp ?? expanded
  const open = expandedValue && !workflow.legacyNotice
  const setExpandedValue = (next: boolean): void => {
    if (expandedProp === undefined) setExpanded(next)
    onExpandedChange?.(next)
  }

  if (presentation.kind === 'tool') {
    return (
      <WorkflowToolRow
        title={`Workflow ${workflow.name}`}
        workflowName={workflow.name}
        status={workflow.status}
        duration={workflow.duration}
        notice={presentation.notice}
      />
    )
  }

  return (
    <article
      className={`wf-card wf-card--${variant}`}
      data-status={workflow.status}
      data-workflow-id={workflow.id}
    >
      <button
        type="button"
        className="wf-head"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setExpandedValue(!expandedValue)}
      >
        <ChevronRight className="wf-chev" size={14} aria-hidden="true" />
        <GitBranch className="wf-ico" size={12} aria-hidden="true" />
        <span className="wf-head__name">Workflow <em>{workflow.name}</em></span>
        <span className="wf-chip">
          <WorkflowStatusGlyph status={workflow.status} size={12} />
          <span>{workflowStatusLabel(workflow.status)}</span>
        </span>
        <span className="wf-head__meta">
          <WorkflowProgressRail completed={workflow.completedAgents} total={workflow.totalAgents} status={workflow.status} />
          <i>{workflow.completedAgents}/{workflow.totalAgents} agents</i>
          <i>{workflow.duration}</i>
          <i>{workflow.tokens} tokens</i>
          <i>{workflow.toolCalls} 次调用</i>
        </span>
      </button>
      {open ? (
        <div id={contentId} className="wf-body">
          {workflow.current ? <p className="wf-live"><b>当前</b><span>{workflow.current}</span></p> : null}
          {workflow.result ? <p className="wf-result">{workflow.result}</p> : null}
          <button
            type="button"
            className="wf-phase-toggle"
            aria-expanded={phasesExpanded}
            onClick={() => setPhasesExpanded((value) => !value)}
          >
            <ChevronRight className="wf-chev" size={12} aria-hidden="true" />
            <span>阶段</span>
            <span className="wf-sr">{phasesExpanded ? '已展开' : '已折叠'}</span>
          </button>
          {phasesExpanded ? workflow.phases.map((phase) => <WorkflowPhase key={phase.id} phase={phase} compact={variant === 'dock'} />) : null}
        </div>
      ) : null}
    </article>
  )
}
