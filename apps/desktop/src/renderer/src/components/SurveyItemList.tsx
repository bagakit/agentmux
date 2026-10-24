import * as Menu from '@radix-ui/react-dropdown-menu'
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, pointerWithin, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent, type KeyboardCoordinateGetter } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { TextInput } from '@agentmux/client-ui/input'
import type { AgentMuxSurveyOrganization } from '@agentmux/core/control'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { moveSurveyListItem, type SurveyListOrganizationModel } from '../hooks/useSurveyListOrganization'

const DragIcon = semanticIconComponent('action.drag')
const DisclosureIcon = semanticIconComponent('navigation.disclosure')
const MoreIcon = semanticIconComponent('action.more')
const EditIcon = semanticIconComponent('action.edit')
const RemoveIcon = semanticIconComponent('action.remove')
const ConfirmIcon = semanticIconComponent('action.confirm')
const CancelIcon = semanticIconComponent('action.cancel')
const itemKey = (id: string) => `survey-item:${id}`
const groupKey = (id: string) => `survey-group:${id}`
const ungroupedKey = 'survey-ungrouped'

type Target = { kind: 'item'; zoneId: string; groupId: string | null } | { kind: 'group'; groupId: string } | { kind: 'ungrouped' }

/** List organization alone owns drag behavior; each original row retains its existing content/actions. */
export function SurveyItemList({ model, titles, renderItem, visible, selectedZoneId }: {
  model: SurveyListOrganizationModel
  titles: ReadonlyMap<string, string>
  renderItem(zoneId: string, dragHandle: ReactNode): ReactNode
  visible: boolean
  selectedZoneId?: string | undefined
}) {
  const keyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
    const groupDrag = args.context.active?.data.current?.kind === 'group'
    const rects = new Map([...args.context.droppableRects].filter(([id]) => {
      const data = args.context.droppableContainers.get(id)?.data.current as Target | undefined
      if (!data) return false
      if (groupDrag) return data.kind === 'group'
      if (data.kind === 'item') return true
      if (data.kind === 'ungrouped') return model.effective.ungrouped.length === 0
      const group = model.effective.groups.find(group => group.groupId === data.groupId)
      return group?.collapsed || !group?.zoneIds.length
    }))
    return sortableKeyboardCoordinates(event, { ...args, context: { ...args.context, droppableRects: rects } })
  }
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates }))
  const held = useRef<{ expected: AgentMuxSurveyOrganization; editable: AgentMuxSurveyOrganization } | null>(null)
  const [dragging, setDragging] = useState(false)
  useEffect(() => { if (!visible) { held.current = null; setDragging(false) } }, [visible])
  const ids = (values: string[]) => values.filter(id => titles.has(id))
  function start(_event: DragStartEvent) { held.current = { expected: model.stored, editable: model.editable }; setDragging(true) }
  function end({ active, over }: DragEndEvent) {
    const baseline = held.current; held.current = null; setDragging(false)
    if (!baseline || !over || active.id === over.id) return
    const from = active.data.current as Target, to = over.data.current as Target
    if (from.kind === 'group') {
      if (to.kind !== 'group') return
      const groups = baseline.editable.groups
      void model.commit({ ...baseline.editable, groups: arrayMove(groups, groups.findIndex(group => group.groupId === from.groupId), groups.findIndex(group => group.groupId === to.groupId)) }, baseline.expected)
    } else if (from.kind === 'item') {
      const target = to.kind === 'ungrouped' ? null : to.groupId
      const members = target === null ? baseline.editable.ungrouped : baseline.editable.groups.find(group => group.groupId === target)?.zoneIds
      if (!members) return
      if (to.kind === 'item' && from.groupId === target) {
        const reordered = arrayMove(members, members.indexOf(from.zoneId), members.indexOf(to.zoneId))
        const next = target === null ? { ...baseline.editable, ungrouped: reordered }
          : { ...baseline.editable, groups: baseline.editable.groups.map(group => group.groupId === target ? { ...group, zoneIds: reordered } : group) }
        void model.commit(next, baseline.expected)
        return
      }
      const without = members.filter(id => id !== from.zoneId)
      const overIndex = to.kind === 'item' ? without.indexOf(to.zoneId) : -1
      const after = to.kind === 'item' && active.rect.current.translated && active.rect.current.translated.top > over.rect.top + over.rect.height / 2
      const index = overIndex < 0 ? without.length : overIndex + (after ? 1 : 0)
      void model.commit(moveSurveyListItem(baseline.editable, from.zoneId, target, index), baseline.expected)
    }
  }
  const rows = (values: string[], groupId: string | null, enabled = visible) => <SortableContext items={ids(values).map(itemKey)} strategy={verticalListSortingStrategy}>
    {ids(values).map(zoneId => <SortableItem key={zoneId} zoneId={zoneId} groupId={groupId} title={titles.get(zoneId)!} visible={enabled} render={renderItem} />)}
  </SortableContext>
  return <div className="survey-page-list" data-dragging={dragging || undefined}>
    <DndContext sensors={sensors} onDragStart={start} onDragEnd={end} onDragCancel={() => { held.current = null; setDragging(false) }}
      accessibility={{ screenReaderInstructions: { draggable: 'Press Space to pick up. Use arrow keys to move. Press Space to drop, or Escape to cancel.' } }}
      collisionDetection={args => {
        const groupsOnly = args.active.data.current?.kind === 'group'
        const droppableContainers = args.droppableContainers.filter(container => groupsOnly ? container.data.current?.kind === 'group' : !args.pointerCoordinates || container.id !== args.active.id)
        const candidates = { ...args, droppableContainers }
        const pointer = pointerWithin(candidates)
        const items = pointer.filter(hit => droppableContainers.find(container => container.id === hit.id)?.data.current?.kind === 'item')
        return items.length ? items : pointer.length ? pointer : args.pointerCoordinates ? [] : closestCenter(candidates)
      }}>
      <Ungrouped hasGroups={model.effective.groups.length > 0}>{rows(model.effective.ungrouped, null)}</Ungrouped>
      <SortableContext items={model.effective.groups.map(group => groupKey(group.groupId))} strategy={verticalListSortingStrategy}>
        {model.effective.groups.map(group => <SurveyListGroup key={group.groupId} group={group} model={model} visible={visible} selected={group.zoneIds.includes(selectedZoneId ?? '')}>
          {rows(group.zoneIds, group.groupId, visible && !group.collapsed)}
        </SurveyListGroup>)}
      </SortableContext>
    </DndContext>
    {model.error ? <p className="survey-relation-notice" role="alert">{model.error}</p> : null}
  </div>
}

function Ungrouped({ children, hasGroups }: { children: ReactNode; hasGroups: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: ungroupedKey, data: { kind: 'ungrouped' } satisfies Target })
  return <div ref={setNodeRef} className="survey-list-ungrouped" data-survey-list-group="ungrouped" data-drop-over={isOver || undefined}>
    {hasGroups ? <span className="survey-list-label">Ungrouped</span> : null}{children}
  </div>
}

function SortableItem({ zoneId, groupId, title, visible, render }: { zoneId: string; groupId: string | null; title: string; visible: boolean; render(id: string, handle: ReactNode): ReactNode }) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: itemKey(zoneId), data: { kind: 'item', zoneId, groupId } satisfies Target, disabled: !visible })
  return <div ref={setNodeRef} className="survey-list-item" data-dragging={isDragging || undefined} style={{ transform: CSS.Transform.toString(transform), transition }}>
    {render(zoneId, <button type="button" className="survey-drag-handle" {...attributes} {...listeners} aria-label={`Move survey item: ${title}`} title="Drag to move"><DragIcon size={12} /></button>)}
  </div>
}

function SurveyListGroup({ group, model, children, visible, selected }: { group: AgentMuxSurveyOrganization['groups'][number]; model: SurveyListOrganizationModel; children: ReactNode; visible: boolean; selected: boolean }) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging, isOver } = useSortable({ id: groupKey(group.groupId), data: { kind: 'group', groupId: group.groupId } satisfies Target, disabled: !visible })
  const [menuOpen, setMenuOpen] = useState(false)
  const menuBaseline = useRef({ expected: model.stored, editable: model.editable })
  const [edit, setEdit] = useState<{ draft: string; expected: AgentMuxSurveyOrganization; editable: AgentMuxSurveyOrganization } | null>(null)
  const [saving, setSaving] = useState(false)
  const generation = useRef(0)
  useEffect(() => () => { ++generation.current }, [])
  useEffect(() => {
    if (model.renamingGroupId !== group.groupId && edit) { ++generation.current; setEdit(null) }
    if (model.renamingGroupId === group.groupId && !edit) setEdit({ draft: group.name, expected: model.stored, editable: model.editable })
  }, [model.renamingGroupId, group.groupId, group.name, model.stored, model.editable, edit])
  useEffect(() => { if (!visible) setMenuOpen(false) }, [visible])
  const cancel = () => { ++generation.current; setEdit(null); model.setRenamingGroupId(null) }
  return <section ref={setNodeRef} className="survey-list-group" data-survey-list-group={group.groupId} data-collapsed={group.collapsed} data-selected={selected || undefined} data-dragging={isDragging || undefined} data-drop-over={isOver || undefined} style={{ transform: CSS.Transform.toString(transform), transition }}>
    <div className="survey-list-group-heading" data-survey-group-header={group.groupId}>
      <button type="button" className="survey-drag-handle" {...attributes} {...listeners} aria-label={`Move survey group: ${group.name}`} title="Drag group"><DragIcon size={12} /></button>
      {edit ? <form className="survey-group-name" onSubmit={async event => {
        event.preventDefault(); if (saving) return
        setSaving(true)
        const started = generation.current
        try {
          const report = await model.commit({ ...edit.editable, groups: edit.editable.groups.map(original => original.groupId === group.groupId ? { ...original, name: edit.draft } : original) }, edit.expected)
          if (report && report.outcome !== 'refused') {
            if (generation.current === started) cancel()
            else setEdit(current => current?.expected === edit.expected && current.editable === edit.editable
              ? { ...current, expected: report.storedOrganization, editable: report.storedOrganization } : current)
          }
        } finally { setSaving(false) }
      }}>
        <TextInput autoFocus aria-label="Survey group name" value={edit.draft} onFocus={event => event.target.select()} onChange={event => { ++generation.current; setEdit({ ...edit, draft: event.target.value }) }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); cancel() } }} />
        <button type="submit" aria-label="Save group name" disabled={saving}><ConfirmIcon size={12} /></button>
        <button type="button" aria-label="Cancel group rename" onClick={cancel}><CancelIcon size={12} /></button>
      </form> : <>
        <button type="button" className="survey-list-group-toggle" aria-expanded={!group.collapsed} aria-label={`${group.collapsed ? 'Expand' : 'Collapse'} survey group: ${group.name}`} onClick={() => {
          void model.commit({ ...model.editable, groups: model.editable.groups.map(original => original.groupId === group.groupId ? { ...original, collapsed: !original.collapsed } : original) }, model.stored)
        }}><DisclosureIcon size={12} /><strong>{group.name || 'Unnamed group'}</strong><span>{group.zoneIds.length}</span></button>
        <Menu.Root modal={false} open={visible && menuOpen} onOpenChange={open => { if (open) menuBaseline.current = { expected: model.stored, editable: model.editable }; setMenuOpen(open) }}>
          <Menu.Trigger asChild><button type="button" className="survey-group-options" aria-label={`Options for survey group: ${group.name}`}><MoreIcon size={14} /></button></Menu.Trigger>
          <DocumentOverlayPortal component={Menu.Portal}><Menu.Content className="tab-context-menu survey-item-menu" align="start" sideOffset={4} collisionPadding={8}>
            <Menu.Label className="survey-topic-menu__label">{group.name}</Menu.Label>
            <Menu.Item className="tab-context-menu__item" onSelect={() => { ++generation.current; setEdit({ draft: group.name, ...menuBaseline.current }); model.setRenamingGroupId(group.groupId) }}><EditIcon size={14} /><span>Rename group</span></Menu.Item>
            <Menu.Item className="tab-context-menu__item" onSelect={() => {
              const { editable, expected } = menuBaseline.current
              const members = editable.groups.find(original => original.groupId === group.groupId)?.zoneIds ?? []
              void model.commit({ ungrouped: [...editable.ungrouped, ...members], groups: editable.groups.filter(original => original.groupId !== group.groupId) }, expected)
            }}><RemoveIcon size={14} /><span>Ungroup all items</span></Menu.Item>
          </Menu.Content></DocumentOverlayPortal>
        </Menu.Root>
      </>}
    </div>
    <div className="survey-list-group-items" hidden={group.collapsed} inert={group.collapsed}>{children}{group.zoneIds.length === 0 ? <span className="survey-list-empty">Drop items here</span> : null}</div>
  </section>
}
