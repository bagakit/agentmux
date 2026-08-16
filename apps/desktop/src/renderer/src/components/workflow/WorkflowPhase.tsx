import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { visibleWorkflowAgents, type WorkflowPhase as WorkflowPhaseData } from './types'
import { WorkflowStatusGlyph } from './WorkflowStatusGlyph'
import { WorkflowAgentRow } from './WorkflowAgentRow'

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-')
}

export function WorkflowPhase({ phase, compact = false }: { phase: WorkflowPhaseData; compact?: boolean }) {
  const generatedId = useId()
  const phaseId = `wf-phase-${safeId(phase.id)}-${safeId(generatedId)}`
  const [expanded, setExpanded] = useState(phase.defaultExpanded ?? phase.status === 'running')
  const [showQuietTail, setShowQuietTail] = useState(false)
  const rows = visibleWorkflowAgents(phase.agents)
  const visible = showQuietTail ? phase.agents : rows.visible
  const toggle = (): void => setExpanded((value) => !value)

  return (
    <section className="wf-phase" data-status={phase.status} data-phase-id={phase.id}>
      <button
        type="button"
        className="wf-phase__head"
        aria-expanded={expanded}
        aria-controls={phaseId}
        onClick={toggle}
      >
        <ChevronRight className="wf-chev" size={12} aria-hidden="true" />
        <WorkflowStatusGlyph status={phase.status} size={12} />
        <span className="wf-phase__title">{phase.label}</span>
        <span className="wf-phase__count">{phase.completed}/{phase.total}</span>
        {phase.elapsed ? <span className="wf-phase__meta">{phase.elapsed}</span> : null}
        <span className="wf-sr">{phase.status === 'running' ? '运行中' : ''}</span>
      </button>
      {expanded ? (
        <div id={phaseId} className="wf-phase__body">
          {phase.current ? <p className="wf-live"><b>当前</b><span>{phase.current}</span></p> : null}
          <ul className={`wf-agents ${visible.length > 8 ? 'wf-agents--grid' : ''}`}>
            {visible.map((agent) => (
              <WorkflowAgentRow key={agent.id} agent={agent} phaseLabel={phase.label} compact={compact} />
            ))}
            {!showQuietTail && rows.hiddenCount > 0 ? (
              <li className="wf-more">
                <button type="button" onClick={() => setShowQuietTail(true)}>
                  … 还有 {rows.hiddenCount} 个
                </button>
              </li>
            ) : null}
            {showQuietTail && rows.hiddenCount > 0 ? (
              <li className="wf-more">
                <button type="button" onClick={() => setShowQuietTail(false)}>
                  收起 {rows.hiddenCount} 个安静项
                </button>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
