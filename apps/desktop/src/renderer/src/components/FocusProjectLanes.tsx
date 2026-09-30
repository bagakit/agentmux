import { ChevronRight, GitBranch, Hash } from 'lucide-react'
import type { ReactNode } from 'react'
import type { FocusProjectLane } from '../lib/focus-project-lanes'
import { ProjectIcon } from './ProjectIcon'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { useAppStore } from '../store'

export function FocusProjectLanes({ lanes, selectedWorkspaceId, onSelect, renderLane }: {
  lanes: readonly FocusProjectLane[]; selectedWorkspaceId: string
  onSelect(workspaceId: string): void; renderLane(lane: FocusProjectLane, heading: ReactNode): ReactNode
}) {
  const icons = useAppStore(state => state.spaceObjectIcons)
  return <section className="focus-project-lanes" aria-label="Project contexts">
    <div className="focus-project-lanes__rows">
      {lanes.map(lane => <article className={`focus-project-lanes__row${selectedWorkspaceId === lane.projectId ? ' is-selected' : ''}`} data-project-id={lane.projectId} data-lane-id={lane.id} data-recovery={lane.recovery ?? undefined} key={lane.id}>
        <div className="focus-project-lanes__track">{renderLane(lane,
        <span className="focus-project-lanes__heading">
          <button type="button" className="focus-project-lanes__axis" aria-pressed={selectedWorkspaceId === lane.projectId} title={`${lane.name} · ${lane.activeAgentIds.length} live · ${lane.path}`} onClick={() => onSelect(lane.projectId)}>
            {lane.objectKind === 'topic' || lane.objectKind === 'mote'
              ? <><SpaceObjectIcon kind={lane.objectKind} name={lane.labels.at(-1)!} topicGlyph manualIcon={lane.objectIconKey ? icons[lane.objectIconKey] ?? null : null} avatarWorkspaceId={lane.workspaceId} avatarTopicId={lane.topicId ?? undefined} avatarObjectKey={lane.objectIconKey} /><span className="focus-project-lanes__label"><strong>{lane.labels.at(-1)}</strong></span></>
              : <>{lane.projectWorkspaceId ? <ProjectIcon workspaceId={lane.projectWorkspaceId} name={lane.labels[0]!} /> : null}
                {lane.labels.map((label, index) => <span className="focus-project-lanes__label" key={index}>{index ? <ChevronRight size={10} /> : null}{index && lane.topicId && index === lane.labels.length - 1 ? <Hash size={11} /> : index ? <GitBranch size={11} /> : null}<strong>{label}</strong></span>)}</>}
          </button>
          {lane.summary ? <span className="focus-project-lanes__summary" title={lane.summary}>{lane.summary}</span> : null}
          {lane.recovery ? <span className="focus-project-lanes__recovery">{lane.recovery === 'removed' ? 'Worktree removed' : 'Workspace unregistered'}</span> : null}
        </span>
        )}</div>
      </article>)}
    </div>
    {lanes.length === 0 ? <p className="focus-project-lanes__empty">No matching contexts</p> : null}
  </section>
}
