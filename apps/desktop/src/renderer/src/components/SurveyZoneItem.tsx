import * as ContextMenu from '@radix-ui/react-context-menu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { TextInput } from '@agentmux/client-ui/input'
import type { AgentMuxZoneFact } from '@agentmux/core/control'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { currentDisplayNameRevision } from '../store'

const ThemeActionCancelIcon = semanticIconComponent('action.cancel')
const ThemeActionConfirmIcon = semanticIconComponent('action.confirm')
const ThemeActionCloseIcon = semanticIconComponent('action.close')


export type SurveyItemNameDraft = { value: string; focusOnMount: boolean; revision: { revision: number }; selection: { start: number; end: number; direction: 'forward' | 'backward' | 'none' } | null }

/** Both navigation and shortcuts address this row’s original Zone. */
export function SurveyZoneItem({ zone, title, glyph, selected, activity, activityDescription, editing = false, showTitle = true, tabColumns, options, dragHandle, nameDraft, onRename, onEdit, onSelect, onCloseSingleTab, onContextMenu }: {
  zone: AgentMuxZoneFact
  title: string
  glyph: ReactNode
  selected: boolean
  activity: ReactNode
  activityDescription?: string | undefined
  editing?: boolean
  showTitle?: boolean
  tabColumns?: ReactNode
  options?: ReactNode
  dragHandle?: ReactNode
  nameDraft?: SurveyItemNameDraft | undefined
  onRename?: (name: string, expectedNameRevision: number) => Promise<boolean>
  onEdit?: (editing: boolean) => void
  onCloseSingleTab?: (() => void) | undefined
  onContextMenu?(button: HTMLElement): void
  onSelect(zoneId: string): void
}) {
  const localDraft = useRef({ value: title, revision: { revision: 0 } })
  const draft = nameDraft ?? localDraft.current
  const [, redraw] = useState(0)
  const setDraft = (value: string) => { draft.value = value; redraw(version => version + 1) }
  const saving = useRef(false), editGeneration = useRef(0)
  useEffect(() => { ++editGeneration.current; if (editing && !nameDraft) { setDraft(title); draft.revision = { revision: currentDisplayNameRevision('zone', zone.zoneId) } } return () => { ++editGeneration.current; if (!nameDraft) draft.revision = { revision: 0 } } }, [editing, zone.zoneId, nameDraft])
  const beginEdit = () => { ++editGeneration.current; setDraft(title); onEdit?.(true) }
  const item = <button type="button" className="survey-item" aria-label={`Show survey item: ${title}`}
      aria-current={selected ? 'true' : undefined} aria-description={activityDescription} title={activityDescription ? `${title}\n${activityDescription}` : title} onClick={() => onSelect(zone.zoneId)} onDoubleClick={beginEdit} onKeyDown={event => {
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
  const compact = !showTitle && Boolean(tabColumns) && !editing
  const row = <div className="survey-item-row" data-survey-zone-id={zone.zoneId} data-selected={selected} data-headerless={compact} data-multi-tab={Boolean(tabColumns)}
    role={compact ? 'group' : undefined} aria-label={compact ? title : undefined}
    onClick={event => { if (compact && event.target === event.currentTarget) onSelect(zone.zoneId) }} onKeyDown={event => {
      if (!compact) return
      if (event.key === 'F2' && onRename) { event.preventDefault(); beginEdit() }
      if (onContextMenu && (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) {
        event.preventDefault()
        const target = event.target as HTMLElement, rect = target.getBoundingClientRect()
        target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.left, clientY: rect.bottom }))
      }
    }}>
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
    </form> : compact ? null : item}
    {!editing ? tabColumns : null}
    {compact ? <span className="survey-item-compact-activity survey-item-activity" aria-label={`Activity in ${title}`}>{activity}</span> : null}
    {!editing ? <div className="survey-item-shortcuts" aria-label={`Actions for ${title}`}>
      {onCloseSingleTab ? <button type="button" className="survey-item-tab-close" aria-label={`Close survey tab: ${title}`} title={`Close ${title}`} onClick={onCloseSingleTab}><ThemeActionCloseIcon size={12} /></button> : null}
      {options}
    </div> : null}
  </div>
  return onContextMenu && !editing ? <ContextMenu.Trigger asChild onContextMenu={event => {
    const origin = (event.target as Element).closest<HTMLElement>('button') ?? event.currentTarget.querySelector<HTMLElement>('.survey-item, .survey-tab-column')!
    origin.focus(); onContextMenu(origin)
  }}>{row}</ContextMenu.Trigger> : row
}
