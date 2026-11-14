import { memo, type ReactNode } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { FocusContext } from '../lib/focus-context'
import type { FocusContextIdentity } from '../lib/focus-context-identity'
import type { FocusGoalLinks as GoalLinks } from '../lib/focus-goal-links'
import { FocusContextRow } from './FocusContextRow'
import { workspaceAgentOrderKey } from '../lib/workspace-agent-order'

const MoveIcon = semanticIconComponent('action.drag')
type MoveHandle = Pick<ReturnType<typeof useSortable>, 'attributes' | 'listeners' | 'setActivatorNodeRef'>

export function WorkspaceAgentGroup({ groupKey, disabled, children }: { groupKey: string; disabled: boolean; children(handle: MoveHandle): ReactNode }) {
  const sortable = useSortable({ id: groupKey, disabled })
  return <div ref={sortable.setNodeRef} className={`workspace-agent-group${sortable.isDragging ? ' is-dragging' : ''}`}
    data-agent-group-key={groupKey} style={{ transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition }}>
    {children(sortable)}
  </div>
}

/** List controls wrap the real Focus card; there is no second Agent face. */
export const WorkspaceAgentRow = memo(function WorkspaceAgentRow({ context, identity, goalLinks, selected, selecting, disabled, onToggle, onOpen, depth = 0, move, onResume, resuming }: {
  context: FocusContext; identity?: FocusContextIdentity | undefined; goalLinks?: GoalLinks | undefined
  selected: boolean; selecting: boolean; disabled: boolean; onToggle(key: string): void; onOpen(id: string): void
  depth?: number; move?: MoveHandle | undefined; onResume?: (() => void) | undefined; resuming?: boolean | undefined
}) {
  const key = workspaceAgentOrderKey(context)
  return <div className={`workspace-agent-list-item${selected ? ' is-selected' : ''}`}
    data-agent-key={key} data-agent-depth={depth} style={{ marginInlineStart: Math.min(depth, 3) * 10 }}>
    <div className="workspace-agent-list-item__controls">
      {selecting ? <input type="checkbox" aria-label={`Select Agent ${context.name}`} checked={selected} disabled={disabled} onChange={() => onToggle(key)} /> : null}
      {move ? <button ref={move.setActivatorNodeRef} type="button" className="workspace-agent-list-item__drag" {...move.attributes} {...move.listeners}
        aria-label={`Move Agent ${context.name}`} title="Move the entire derivation group · Space, arrow keys, Space to move with keyboard" disabled={disabled}><MoveIcon size={13} /></button> : null}
    </div>
    <div className="workspace-agent-row"><FocusContextRow context={context} identity={identity} goalLinks={goalLinks} selected={selected} onSelect={onOpen} /></div>
    {onResume ? <button type="button" className="workspace-agent-list-item__resume" aria-label={`Resume Agent ${context.name}`} disabled={resuming}
      title="Resume original Session" onClick={onResume}>{resuming ? 'Checking…' : 'Resume'}</button> : null}
  </div>
})
