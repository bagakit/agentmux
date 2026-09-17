import { ChevronRight, GitBranch, Hash, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import type { FocusProjectLane } from '../lib/focus-project-lanes'

export function FocusProjectLanes({ lanes, selectedWorkspaceId, onSelect, renderLane }: {
  lanes: readonly FocusProjectLane[]; selectedWorkspaceId: string
  onSelect(workspaceId: string): void; renderLane(lane: FocusProjectLane): ReactNode
}) {
  return <section className="focus-project-lanes" aria-label="Project contexts">
    <div className="focus-project-lanes__rows">
      {lanes.map(lane => <article className={`focus-project-lanes__row${selectedWorkspaceId === lane.projectId ? ' is-selected' : ''}`} data-project-id={lane.projectId} data-lane-id={lane.id} data-recovery={lane.recovery ?? undefined} key={lane.id}>
        <header className="focus-project-lanes__heading">
          <button type="button" className="focus-project-lanes__axis" aria-pressed={selectedWorkspaceId === lane.projectId} title={`${lane.name} · ${lane.path}`} onClick={() => onSelect(lane.projectId)}>
            {lane.labels.map((label, index) => <span className="focus-project-lanes__label" key={index}>{index ? <ChevronRight size={10} /> : null}{index && lane.topicId && index === lane.labels.length - 1 ? <Hash size={11} /> : index ? <GitBranch size={11} /> : null}<strong>{label}</strong></span>)}
          </button>
          {lane.activeAgentIds.length ? <span className="focus-project-lanes__count"><Users size={10} />{lane.activeAgentIds.length} live</span> : null}
          {lane.recovery ? <span className="focus-project-lanes__recovery">{lane.recovery === 'removed' ? 'Worktree removed' : 'Workspace unregistered'}</span> : null}
        </header>
        <div className="focus-project-lanes__track">{renderLane(lane)}</div>
      </article>)}
    </div>
    {lanes.length === 0 ? <p className="focus-project-lanes__empty">No matching contexts</p> : null}
  </section>
}
