import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { AppConfig, ComposerShortcut, GoalsCommonActionRef, GoalsCommonActionsConfig } from '../../../../shared/contracts'
import { commonActionKey, DEFAULT_GOALS_COMMON_ACTIONS, resolveGoalsCommonAction, type GoalsCommonAction } from '../../lib/goals-common-actions'
import { resolveComposerShortcuts } from '../../../../shared/composer-shortcut-library'
import './settings-goals-common-actions.css'

const Drag = semanticIconComponent('action.drag'), Up = semanticIconComponent('action.move-up'), Down = semanticIconComponent('action.move-down')
const Remove = semanticIconComponent('action.remove'), Add = semanticIconComponent('action.create-shortcut')
function DirectoryRow({ action, index, count, saving, onEdit, onMove, onRemove }: {
  action: GoalsCommonAction; index: number; count: number; saving: boolean; onEdit(): void; onMove(to: number): void; onRemove(): void
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: action.key, disabled: saving })
  return <div className="settings-goals-actions__row" data-common-ref={action.key} ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}>
    <button type="button" className="icon-button" disabled={saving} aria-label={`Reorder ${action.label}`} {...attributes} {...listeners}><Drag size={13} /></button>
    <button type="button" className="settings-goals-actions__name" data-common-select={action.key} disabled={saving} onClick={onEdit}><strong>{action.label}</strong><small>{action.ref.kind === 'builtin' ? 'Default request' : action.body ? 'Shared prompt' : action.reason || 'Original prompt deleted'}</small></button>
    <span className="settings-goals-actions__tools"><button type="button" className="icon-button" disabled={saving || index === 0} aria-label={`Move up ${action.label}`} onClick={() => onMove(index - 1)}><Up size={12} /></button><button type="button" className="icon-button" disabled={saving || index === count - 1} aria-label={`Move down ${action.label}`} onClick={() => onMove(index + 1)}><Down size={12} /></button><button type="button" className="icon-button" disabled={saving} aria-label={`Remove from Goals ${action.label}`} onClick={onRemove}><Remove size={12} /></button></span>
  </div>
}

/** Only ordered references and visibility; the retained Settings draft owner holds every original body. */
export function GoalsCommonActionsSettings({ config, prompts, directory, saving, disclosureRef: region, onItemsChange, onCollapsedChange, onAdd, onEdit }: {
  config: AppConfig; prompts: ComposerShortcut[]; directory: GoalsCommonActionsConfig; saving: boolean
  disclosureRef: RefObject<HTMLDetailsElement | null>
  onItemsChange(items: GoalsCommonActionRef[]): void; onCollapsedChange(value: boolean): void; onAdd(): void; onEdit(id: string): void
}) {
  const [referencesOpen, setReferencesOpen] = useState(false), [preview, setPreview] = useState<GoalsCommonActionRef | null>(null)
  const focusAfter = useRef<string | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const authored = { ...config, composerShortcuts: prompts }
  const resolve = (ref: GoalsCommonActionRef) => {
    const action = resolveGoalsCommonAction(ref, authored, null)
    const saved = ref.kind === 'prompt' && !prompts.some(prompt => prompt.id === ref.id) ? resolveComposerShortcuts(config).find(prompt => prompt.id === ref.id) : undefined
    return saved ? { ...action, label: saved.label || saved.keyword, reason: 'Deletion pending in Prompts. Goals saves keep the original library prompt.' } : action
  }
  const actions = directory.items.map(resolve)
  const available = [...DEFAULT_GOALS_COMMON_ACTIONS.items, ...prompts.map(prompt => ({ kind: 'prompt' as const, id: prompt.id }))]
    .filter(ref => !directory.items.some(item => commonActionKey(item) === commonActionKey(ref)))
  const shown = preview ? resolve(preview) : null
  useLayoutEffect(() => {
    if (!focusAfter.current) return
    const row = [...region.current?.querySelectorAll<HTMLButtonElement>('[data-common-select]') ?? []].find(node => node.dataset.commonSelect === focusAfter.current)
    ;(row ?? region.current?.querySelector<HTMLButtonElement>('[data-common-create]'))?.focus()
    focusAfter.current = null
  }, [directory.items])
  function move(key: string, to: number) {
    const from = directory.items.findIndex(ref => commonActionKey(ref) === key)
    if (from < 0 || to < 0 || to >= directory.items.length || from === to) return
    const items = [...directory.items], [ref] = items.splice(from, 1); items.splice(to, 0, ref!); focusAfter.current = key; onItemsChange(items)
  }
  function remove(key: string) {
    const at = directory.items.findIndex(ref => commonActionKey(ref) === key), items = directory.items.filter(ref => commonActionKey(ref) !== key)
    const next = items[Math.min(at, items.length - 1)]
    focusAfter.current = next ? commonActionKey(next) : 'add'
    onItemsChange(items)
  }
  return <details ref={region} className="settings-group settings-goals-actions" open data-settings-field="goals-common-actions">
    <summary><strong>Goals common actions</strong><span>{directory.items.length} {directory.items.length === 1 ? 'shortcut' : 'shortcuts'}</span></summary>
    <p>Choose the requests shown in Goals. Edit instructions in Prompts by their original identity. Removing a shortcut here keeps its prompt in the library.</p>
    <label className="settings-goals-actions__visibility"><input type="checkbox" aria-label="Collapse common actions" checked={directory.collapsed} onChange={event => onCollapsedChange(event.target.checked)} /><span>Start with common actions collapsed</span></label>
    <div className="settings-goals-actions__toolbar"><button type="button" className="small-button" data-common-create disabled={saving} onClick={onAdd}><Add size={13} /> Add common action</button><button type="button" className="small-button" disabled={saving} aria-expanded={referencesOpen} onClick={() => setReferencesOpen(!referencesOpen)}>Reference a prompt</button></div>
    <div role="region" aria-label="Goals common action order" className="settings-goals-actions__directory" tabIndex={0}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={event => { if (event.over) move(String(event.active.id), directory.items.findIndex(ref => commonActionKey(ref) === String(event.over!.id))) }}>
        <SortableContext items={actions.map(action => action.key)} strategy={verticalListSortingStrategy}>{actions.map((action, index) => <DirectoryRow key={action.key} action={action} index={index} count={actions.length} saving={saving}
          onEdit={() => { if (action.ref.kind === 'prompt' && prompts.some(prompt => prompt.id === action.ref.id)) onEdit(action.ref.id); else setPreview(action.ref) }}
          onMove={to => move(action.key, to)} onRemove={() => remove(action.key)} />)}</SortableContext>
      </DndContext>
      {!actions.length ? <p>No common actions. Add a request or reference a prompt when you need one.</p> : null}
    </div>
    {referencesOpen ? <div className="settings-goals-actions__available" aria-label="Available common actions">{available.map(ref => { const action = resolveGoalsCommonAction(ref, authored, null); return <button type="button" className="small-button" key={action.key} data-common-add={action.key} disabled={saving} onClick={() => { focusAfter.current = action.key; onItemsChange([...directory.items, ref]) }}>{action.label}</button> })}{!available.length ? <p>All available requests are already referenced.</p> : null}</div> : null}
    {shown ? <div className="settings-goals-actions__preview"><strong>{shown.label}</strong><p>{shown.body || shown.reason}</p>{shown.ref.kind === 'builtin' ? <small>Default wording is read only. The project and receiving Agent are resolved when you use it in Goals.</small> : null}</div> : null}
  </details>
}
