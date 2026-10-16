import { memo } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { FocusContext } from '../lib/focus-context'
import type { FocusContextIdentity } from '../lib/focus-context-identity'
import type { FocusGoalLinks as GoalLinks } from '../lib/focus-goal-links'
import { FocusContextRow } from './FocusContextRow'
import { workspaceAgentOrderKey } from '../lib/workspace-agent-order'

const MoveIcon = semanticIconComponent('action.drag')

/** List controls wrap the real Focus card; there is no second Agent face. */
export const WorkspaceAgentRow = memo(function WorkspaceAgentRow({ context, identity, goalLinks, selected, selecting, disabled, onToggle, onOpen }: {
  context: FocusContext; identity?: FocusContextIdentity | undefined; goalLinks?: GoalLinks | undefined
  selected: boolean; selecting: boolean; disabled: boolean; onToggle(key: string): void; onOpen(id: string): void
}) {
  const key = workspaceAgentOrderKey(context)
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: key, disabled })
  return <div ref={setNodeRef} className={`workspace-agent-list-item${selected ? ' is-selected' : ''}${isDragging ? ' is-dragging' : ''}`}
    data-agent-key={key} style={{ transform: CSS.Transform.toString(transform), transition }}>
    <div className="workspace-agent-list-item__controls">
      {selecting ? <input type="checkbox" aria-label={`Select Agent ${context.name}`} checked={selected} disabled={disabled} onChange={() => onToggle(key)} /> : null}
      <button ref={setActivatorNodeRef} type="button" className="workspace-agent-list-item__drag" {...attributes} {...listeners}
        aria-label={`Move Agent ${context.name}`} title="Drag to reorder · Space, arrow keys, Space to move with keyboard" disabled={disabled}><MoveIcon size={13} /></button>
    </div>
    <div className="workspace-agent-row"><FocusContextRow context={context} identity={identity} goalLinks={goalLinks} selected={selected} onSelect={onOpen} /></div>
  </div>
})
