import * as Menu from '@radix-ui/react-dropdown-menu'
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter, pointerWithin, useDndContext, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent, type KeyboardCoordinateGetter } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { getEventCoordinates, CSS } from '@dnd-kit/utilities'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { TextInput } from '@agentmux/client-ui/input'
import type { AgentMuxSurveyOrganization } from '@agentmux/core/control'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import type { SurveyContentDrag, SurveyPageDrop, SurveyContentReference, SurveyCompositionDropTarget } from '../lib/survey-composition-drag'
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

type Target = { kind: 'item'; zoneId: string; groupId: string | null; index: number } | { kind: 'group'; groupId: string } | { kind: 'ungrouped' }

/** A container is a destination only across containers; ordering uses an exact row. */
function acceptsContainer(from: Target | undefined, groupId: string | null): boolean {
  return from?.kind === 'item' ? from.groupId !== groupId
    : from?.kind === 'group' && groupId !== null && from.groupId !== groupId
}

/** List organization alone owns drag behavior; each original row retains its existing content/actions. */
export function SurveyItemList({ model, titles, renderItem, visible, selectedZoneId, leading, composition }: {
  leading?: ReactNode
  composition?: { start(reference: SurveyContentReference): string | null; canDrop(target: SurveyCompositionDropTarget): boolean; drop(target: SurveyCompositionDropTarget | null): void }
  model: SurveyListOrganizationModel
  titles: ReadonlyMap<string, string>
  renderItem(zoneId: string, dragHandle: ReactNode, compositionEnabled: boolean): ReactNode
  visible: boolean
  selectedZoneId?: string | undefined
}) {
  const keyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
    const contentDrag = args.context.active?.data.current?.kind === 'content'
    const groupDrag = args.context.active?.data.current?.kind === 'group'
    if (contentDrag) {
      const direction = event.code, current = args.context.collisionRect
      if (!current || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(direction)) return
      event.preventDefault()
      const candidates = args.context.droppableContainers.getEnabled().flatMap(container => {
        const data = container.data.current as Target | SurveyPageDrop | undefined
        const target = data?.kind === 'item' ? { kind: 'research' as const, zoneId: data.zoneId } : data?.kind === 'page-target' ? data.reference : null
        const rect = args.context.droppableRects.get(container.id)
        if (!rect || !target || !composition?.canDrop(target)) return []
        const valid = direction === 'ArrowDown' ? rect.top > current.top : direction === 'ArrowUp' ? rect.top < current.top
          : direction === 'ArrowRight' ? rect.left > current.left : rect.left < current.left
        return valid ? [rect] : []
      })
      candidates.sort((a, b) => Math.hypot(a.left - current.left, a.top - current.top) - Math.hypot(b.left - current.left, b.top - current.top))
      const target = candidates[0]
      return target ? { x: target.left + (target.width - current.width) / 2, y: target.top + (target.height - current.height) / 2 } : undefined
    }
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
  const contentLabel = useRef<string | null>(null)
  const contentPresentation = useRef<SurveyContentDrag['presentation']>(undefined)
  const previewBounds = useRef<{ left: number; right: number; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  useEffect(() => { if (!visible) { held.current = null; setDragging(false); composition?.drop(null) } }, [visible])
  const ids = (values: string[]) => values.filter(id => titles.has(id))
  function start(event: DragStartEvent) {
    if (event.active.data.current?.kind === 'content') { held.current = null; contentPresentation.current = (event.active.data.current as SurveyContentDrag).presentation; contentLabel.current = composition?.start((event.active.data.current as SurveyContentDrag).reference) ?? null }
    else { contentLabel.current = null; held.current = { expected: model.stored, editable: model.editable } }
    const origin = event.activatorEvent.target
    const bounds = origin instanceof Element ? origin.closest('.survey-navigation')?.getBoundingClientRect() : null
    previewBounds.current = bounds?.width ? bounds : null
    setDragging(true)
  }
  function end({ active, over }: DragEndEvent) {
    const baseline = held.current; held.current = null; setDragging(false)
    if (active.data.current?.kind === 'content') {
      const target = over?.data.current
      composition?.drop(target?.kind === 'item' ? { kind: 'research', zoneId: target.zoneId } : target?.kind === 'page-target' ? target.reference : null)
      return
    }
    if (!baseline || !over || active.id === over.id) return
    const from = active.data.current as Target, to = over.data.current as Target
    if (from.kind === 'group') {
      if (to.kind !== 'group') return
      const groups = baseline.editable.groups
      void model.commit({ ...baseline.editable, groups: arrayMove(groups, groups.findIndex(group => group.groupId === from.groupId), groups.findIndex(group => group.groupId === to.groupId)) }, baseline.expected)
    } else if (from.kind === 'item') {
      const target = to.kind === 'ungrouped' ? null : to.groupId
      // The surrounding container also covers the picked-up row and its gaps; it is not an end insertion.
      if (to.kind !== 'item' && !acceptsContainer(from, target)) return
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
    {ids(values).map((zoneId, index) => <SortableItem index={index} key={zoneId} zoneId={zoneId} groupId={groupId} title={titles.get(zoneId)!} visible={enabled} render={renderItem} />)}
  </SortableContext>
  return <div className="survey-page-list" data-dragging={dragging || undefined}>
    <DndContext sensors={sensors} onDragStart={start} onDragEnd={end} onDragCancel={() => { held.current = null; setDragging(false); composition?.drop(null) }}
      accessibility={{ screenReaderInstructions: { draggable: 'Press Space to pick up. Use arrow keys to choose a destination. Press Space to drop, or Escape to cancel.' },
        announcements: {
          onDragStart: ({ active }) => active.data.current?.kind === 'content' ? `Picked up ${contentLabel.current ?? 'original content'}. Move over a research, or another page to combine.` : 'Picked up for reordering.',
          onDragOver: ({ active, over }) => active.data.current?.kind === 'content' ? !over ? 'No merge target. Content stays in place.' : over.data.current?.kind === 'page-target' ? 'Combine into a new research.' : 'Move into this research.' : over ? 'Reorder at this position.' : 'No insertion target.',
          onDragEnd: ({ active, over }) => active.data.current?.kind === 'content' ? over ? 'Drop requested. Check the research or choose its exact destination.' : 'Canceled. Content stays in place.' : 'Reordering gesture ended.',
          onDragCancel: () => 'Canceled. Content stays in place.'
        } }}
      collisionDetection={args => {
        const content = args.active.data.current?.kind === 'content'
        const groupsOnly = args.active.data.current?.kind === 'group'
        const droppableContainers = args.droppableContainers.filter(container => {
          const data = container.data.current
          if (content) return Boolean(composition && (data?.kind === 'item' ? composition.canDrop({ kind: 'research', zoneId: data.zoneId })
            : data?.kind === 'page-target' && composition.canDrop(data.reference)))
          if (data?.kind === 'page-target') return false
          return groupsOnly ? data?.kind === 'group' : !args.pointerCoordinates || container.id !== args.active.id
        })
        const candidates = { ...args, droppableContainers }
        const pointer = pointerWithin(candidates)
        if (content) {
          const initial = args.active.rect.current.initial
          if (!args.pointerCoordinates && initial && args.collisionRect.left === initial.left && args.collisionRect.top === initial.top) return []
          return pointer.length ? pointer : args.pointerCoordinates ? [] : closestCenter(candidates)
        }
        const items = pointer.filter(hit => droppableContainers.find(container => container.id === hit.id)?.data.current?.kind === 'item')
        return items.length ? items : pointer.length ? pointer : args.pointerCoordinates ? [] : closestCenter(candidates)
      }}>
      {leading}
      <Ungrouped hasGroups={model.effective.groups.length > 0}>{rows(model.effective.ungrouped, null)}</Ungrouped>
      <SortableContext items={model.effective.groups.map(group => groupKey(group.groupId))} strategy={verticalListSortingStrategy}>
        {model.effective.groups.map(group => <SurveyListGroup key={group.groupId} group={group} model={model} visible={visible} selected={group.zoneIds.includes(selectedZoneId ?? '')}>
          {rows(group.zoneIds, group.groupId, visible && !group.collapsed)}
        </SurveyListGroup>)}
      </SortableContext>
      {contentLabel.current ? <DragOverlay dropAnimation={null} modifiers={[({ transform, activeNodeRect, activatorEvent }) => {
        const point = activatorEvent && getEventCoordinates(activatorEvent)
        if (!activeNodeRect) return transform
        const bounds = previewBounds.current, width = bounds ? Math.min(188, bounds.width - 12) : 188
        const desiredLeft = activeNodeRect.left + transform.x + 8
        const left = bounds ? Math.max(bounds.left + 6, Math.min(desiredLeft, bounds.right - width - 6)) : desiredLeft
        return { ...transform, x: left - activeNodeRect.left, y: transform.y + (point ? point.y - activeNodeRect.top + 14 : activeNodeRect.height + 8) }
      }]}>{dragging && contentLabel.current ? <div className="survey-composition-preview" style={previewBounds.current ? { maxWidth: Math.min(188, previewBounds.current.width - 12) } : undefined}>
        {contentPresentation.current?.icon ? <span className="survey-composition-preview__icon" aria-hidden="true">{contentPresentation.current.icon}</span> : null}
        <span><strong>{contentPresentation.current?.title ?? contentLabel.current}</strong>{contentPresentation.current?.title ? <small>{contentLabel.current}</small> : null}</span>
      </div> : null}</DragOverlay> : null}
    </DndContext>
    {model.error ? <p className="survey-relation-notice" role="alert">{model.error}</p> : null}
  </div>
}

function Ungrouped({ children, hasGroups }: { children: ReactNode; hasGroups: boolean }) {
  const { active } = useDndContext()
  const { setNodeRef, isOver } = useDroppable({ id: ungroupedKey, data: { kind: 'ungrouped' } satisfies Target })
  return <div ref={setNodeRef} className="survey-list-ungrouped" data-survey-list-group="ungrouped" data-drop-over={isOver && acceptsContainer(active?.data.current as Target | undefined, null) || undefined}>
    {hasGroups ? <span className="survey-list-label">Ungrouped</span> : null}{children}
  </div>
}

function SortableItem({ zoneId, groupId, title, visible, render, index }: { index: number; zoneId: string; groupId: string | null; title: string; visible: boolean; render(id: string, handle: ReactNode, compositionEnabled: boolean): ReactNode }) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging, isOver } = useSortable({ id: itemKey(zoneId), data: { kind: 'item', zoneId, groupId, index } satisfies Target, disabled: !visible })
  const { active, over } = useDndContext(), content = active?.data.current?.kind === 'content'
  const from = active?.data.current as Target | undefined
  const sortingOver = from?.kind === 'item' && over?.id === itemKey(zoneId)
  const edge = sortingOver ? from.groupId === groupId ? from.index < index ? 'after' : 'before'
    : active?.rect.current.translated && active.rect.current.translated.top > over.rect.top + over.rect.height / 2 ? 'after' : 'before' : undefined
  return <div ref={setNodeRef} data-sort-edge={edge} data-compose-over={content && isOver || undefined} className="survey-list-item" data-dragging={isDragging || undefined} style={{ transform: CSS.Transform.toString(transform), transition }}>
    {render(zoneId, <button type="button" className="survey-drag-handle" {...attributes} {...listeners} aria-label={`Move survey item: ${title}`} title="Drag to reorder"><DragIcon size={12} /></button>, visible)}
    {content && isOver ? <span className="survey-compose-cue" aria-hidden="true">Move into research</span> : null}
  </div>
}

function SurveyListGroup({ group, model, children, visible, selected }: { group: AgentMuxSurveyOrganization['groups'][number]; model: SurveyListOrganizationModel; children: ReactNode; visible: boolean; selected: boolean }) {
  const { active } = useDndContext()
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
  return <section ref={setNodeRef} className="survey-list-group" data-survey-list-group={group.groupId} data-collapsed={group.collapsed} data-selected={selected || undefined} data-dragging={isDragging || undefined} data-drop-over={isOver && acceptsContainer(active?.data.current as Target | undefined, group.groupId) || undefined} style={{ transform: CSS.Transform.toString(transform), transition }}>
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
