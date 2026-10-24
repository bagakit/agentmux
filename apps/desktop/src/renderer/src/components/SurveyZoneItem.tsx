import * as ContextMenu from '@radix-ui/react-context-menu'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { TextInput } from '@agentmux/client-ui/input'
import type { AgentMuxZoneFact } from '@agentmux/core/control'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { currentDisplayNameRevision } from '../store'
import { DocumentOverlayPortal } from './WindowOverlayHost'

const ThemeActionCancelIcon = semanticIconComponent('action.cancel')
const ThemeActionConfirmIcon = semanticIconComponent('action.confirm')
const ThemeActionCreateNoteIcon = semanticIconComponent('action.create-note')
const ThemeObjectAgentIcon = semanticIconComponent('object.agent')
const ThemeActionAddIcon = semanticIconComponent('action.create')
const ThemeObjectBrowserIcon = semanticIconComponent('object.browser')
const ThemeObjectLauncherIcon = semanticIconComponent('object.launcher')


export type SurveyItemNameDraft = { value: string; focusOnMount: boolean; revision: { revision: number }; selection: { start: number; end: number; direction: 'forward' | 'backward' | 'none' } | null }

/** Both navigation and shortcuts address this row’s original Zone. */
export function SurveyZoneItem({ zone, title, glyph, selected, activity, editing = false, visible = true, tabColumns, options, dragHandle, nameDraft, onRename, onEdit, onSelect, onNewNote, onNewAgent, onNewBrowser, onNewTab, onContextMenu }: {
  zone: AgentMuxZoneFact
  title: string
  glyph: ReactNode
  selected: boolean
  activity: ReactNode
  editing?: boolean
  visible?: boolean
  tabColumns?: ReactNode
  options?: ReactNode
  dragHandle?: ReactNode
  nameDraft?: SurveyItemNameDraft | undefined
  onRename?: (name: string, expectedNameRevision: number) => Promise<boolean>
  onEdit?: (editing: boolean) => void
  onNewNote?(zoneId: string): void
  onNewAgent?(zoneId: string): void
  onNewBrowser?(zoneId: string): void
  onNewTab?(zoneId: string): void
  onContextMenu?(button: HTMLElement): void
  onSelect(zoneId: string): void
}) {
  const localDraft = useRef({ value: title, revision: { revision: 0 } })
  const draft = nameDraft ?? localDraft.current
  const [, redraw] = useState(0)
  const setDraft = (value: string) => { draft.value = value; redraw(version => version + 1) }
  const [createOpen, setCreateOpen] = useState(false)
  useEffect(() => { if (!visible || editing) setCreateOpen(false) }, [visible, editing])
  const saving = useRef(false), editGeneration = useRef(0)
  useEffect(() => { ++editGeneration.current; if (editing && !nameDraft) { setDraft(title); draft.revision = { revision: currentDisplayNameRevision('zone', zone.zoneId) } } return () => { ++editGeneration.current; if (!nameDraft) draft.revision = { revision: 0 } } }, [editing, zone.zoneId, nameDraft])
  const beginEdit = () => { ++editGeneration.current; setDraft(title); onEdit?.(true) }
  const item = <button type="button" className="survey-item" aria-label={`Show survey item: ${title}`}
      aria-current={selected ? 'true' : undefined} title={title} onClick={() => onSelect(zone.zoneId)} onDoubleClick={beginEdit} onKeyDown={event => {
        if (onContextMenu && (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) {
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.left, clientY: rect.bottom }))
          return
        }
        if (event.key === 'F2' && onRename) { event.preventDefault(); beginEdit() }
      }}>
      <span className="survey-item-glyph" aria-hidden="true">{glyph}</span>
      <strong>{title}</strong>
      <span className="survey-item-meta"><span className="survey-item-activity" aria-label={`Activity in ${title}`}>{activity}</span></span>
    </button>
  const row = <div className="survey-item-row" data-survey-zone-id={zone.zoneId} data-selected={selected}>
    {!editing ? dragHandle : null}
    {editing ? <form className="survey-item-name" onSubmit={async event => { event.preventDefault(); if (saving.current) return; saving.current = true; const generation = editGeneration.current, baseline = draft.revision; try { if (await onRename?.(draft.value, baseline.revision) && draft.revision === baseline) { ++baseline.revision; if (generation === editGeneration.current) { ++editGeneration.current; onEdit?.(false) } } } finally { saving.current = false } }}>
      <TextInput autoFocus={nameDraft?.focusOnMount ?? true} aria-label="Exploration name" value={draft.value} placeholder="Name this exploration" onChange={event => { ++editGeneration.current; setDraft(event.target.value) }} onFocus={event => {
          if (nameDraft) nameDraft.focusOnMount = true
          const range = nameDraft?.selection
          if (range) event.target.setSelectionRange(range.start, range.end, range.direction)
          else event.target.select()
        }} onSelect={event => {
          const input = event.currentTarget
          if (nameDraft && input.selectionStart !== null && input.selectionEnd !== null) nameDraft.selection = { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection ?? 'none' }
        }} onBlur={() => { if (nameDraft) nameDraft.focusOnMount = false }}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); ++editGeneration.current; onEdit?.(false) } }} />
      <button type="submit" aria-label="Save exploration name"><ThemeActionConfirmIcon size={12} /></button>
      <button type="button" aria-label="Cancel rename" onClick={() => { ++editGeneration.current; onEdit?.(false) }}><ThemeActionCancelIcon size={12} /></button>
    </form> : item}
    {!editing ? tabColumns : null}
    {!editing ? <div className="survey-item-shortcuts" aria-label={`Create from ${title}`}>
      <Menu.Root modal={false} open={visible && createOpen} onOpenChange={setCreateOpen}>
        <Menu.Trigger asChild><button type="button" aria-label={`Add to ${title}`} title="Add to exploration"><ThemeActionAddIcon size={14} /></button></Menu.Trigger>
        <DocumentOverlayPortal component={Menu.Portal}><Menu.Content className="tab-context-menu survey-item-create-menu" align="start" sideOffset={4} collisionPadding={8} onCloseAutoFocus={event => { if (!visible) event.preventDefault() }}>
          {onNewBrowser ? <Menu.Item className="tab-context-menu__item" onSelect={() => onNewBrowser(zone.zoneId)}><ThemeObjectBrowserIcon size={14} /><span>New Browser</span></Menu.Item> : null}
          {onNewNote ? <Menu.Item className="tab-context-menu__item" onSelect={() => onNewNote(zone.zoneId)}><ThemeActionCreateNoteIcon size={14} /><span>New Note in Recall</span></Menu.Item> : null}
          {onNewAgent ? <Menu.Item className="tab-context-menu__item" onSelect={() => onNewAgent(zone.zoneId)}><ThemeObjectAgentIcon size={14} /><span>New Agent</span></Menu.Item> : null}
          {onNewTab ? <><Menu.Separator className="tab-context-menu__separator" /><Menu.Item className="tab-context-menu__item" onSelect={() => onNewTab(zone.zoneId)}><ThemeObjectLauncherIcon size={14} /><span>New tab…</span></Menu.Item></> : null}
        </Menu.Content></DocumentOverlayPortal>
      </Menu.Root>
      {options}
    </div> : null}
  </div>
  return onContextMenu && !editing ? <ContextMenu.Trigger asChild onContextMenu={event => {
    const origin = (event.target as Element).closest<HTMLElement>('button') ?? event.currentTarget.querySelector<HTMLElement>('.survey-item')!
    origin.focus(); onContextMenu(origin)
  }}>{row}</ContextMenu.Trigger> : row
}
