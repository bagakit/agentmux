import { FolderGit2, Users } from 'lucide-react'
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
  return <section className="focus-project-lanes" aria-label="Active project swimlanes">
    <header className="focus-project-lanes__header">
      <span className="focus-project-lanes__axis-title"><FolderGit2 size={13} /><strong>Projects</strong><small>vertical axis</small></span>
      <button
        type="button"
        className={`focus-project-lanes__all${selectedWorkspaceId === 'all' ? ' is-selected' : ''}`}
        aria-pressed={selectedWorkspaceId === 'all'}
        onClick={() => onSelect('all')}
      >
        All active <span><Users size={11} />{lanes.reduce((total, lane) => total + lane.activeAgentIds.length, 0)}</span>
      </button>
    </header>
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
          <small>{lane.path}</small>
          <span><Users size={11} />{lane.activeAgentIds.length} active</span>
        </button>
        <div className="focus-project-lanes__track">{renderLane(lane)}</div>
      </article>)}
    </div>
    {lanes.length === 0 ? <p className="focus-project-lanes__empty">No active projects</p> : null}
  </section>
}
