import { Users } from 'lucide-react'
import type { ReactNode } from 'react'
import type { FocusProjectLane } from '../lib/focus-project-lanes'

export function FocusProjectLanes({
  lanes,
  selectedWorkspaceId,
  onSelect,
  renderLane
}: {
  lanes: readonly FocusProjectLane[]
  selectedWorkspaceId: string
  onSelect(workspaceId: string): void
  renderLane(lane: FocusProjectLane): ReactNode
}) {
  return <section className="focus-project-lanes" aria-label="Project contexts">
    <div className="focus-project-lanes__rows">
      {lanes.map((lane) => <article
        className={`focus-project-lanes__row${selectedWorkspaceId === lane.workspaceId ? ' is-selected' : ''}`}
        data-project-id={lane.workspaceId}
        key={lane.workspaceId}
      >
        <button
          type="button"
          className="focus-project-lanes__axis"
          aria-pressed={selectedWorkspaceId === lane.workspaceId}
          title={`${lane.name} · ${lane.path}`}
          onClick={() => onSelect(lane.workspaceId)}
        >
          <strong>{lane.name}</strong>
          
          <span><Users size={11} />{lane.activeAgentIds.length} live</span>
        </button>
        <div className="focus-project-lanes__track">{renderLane(lane)}</div>
      </article>)}
    </div>
    {lanes.length === 0 ? <p className="focus-project-lanes__empty">No matching contexts</p> : null}
  </section>
}
