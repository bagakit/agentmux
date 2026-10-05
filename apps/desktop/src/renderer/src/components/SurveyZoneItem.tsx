import { Bot, NotebookPen } from 'lucide-react'
import { TextInput } from '@agentmux/client-ui/input'
import type { AgentMuxZoneFact } from '@agentmux/core/control'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { currentDisplayNameRevision } from '../store'

/** Both navigation and shortcuts address this row’s original Zone. */
export function SurveyZoneItem({ zone, title, glyph, selected, activity, editing = false, onRename, onEdit, onSelect, onNewNote, onNewAgent }: {
  zone: AgentMuxZoneFact
  title: string
  glyph: ReactNode
  selected: boolean
  activity: ReactNode
  editing?: boolean
  onRename?: (name: string, expectedNameRevision: number) => Promise<boolean>
  onEdit?: (editing: boolean) => void
  onNewNote?(zoneId: string): void
  onNewAgent?(zoneId: string): void
  onSelect(zoneId: string): void
}) {
  const [draft, setDraft] = useState(title)
  const revision = useRef({ revision: 0 }), saving = useRef(false), editGeneration = useRef(0)
  useEffect(() => { ++editGeneration.current; if (editing) { setDraft(title); revision.current = { revision: currentDisplayNameRevision('zone', zone.zoneId) } } return () => { ++editGeneration.current; revision.current = { revision: 0 } } }, [editing, zone.zoneId])
  const beginEdit = () => { ++editGeneration.current; setDraft(title); onEdit?.(true) }
  return <div className="survey-item-row" data-survey-zone-id={zone.zoneId} data-selected={selected}>
    {editing ? <form className="survey-item-name" onSubmit={async event => { event.preventDefault(); if (saving.current) return; saving.current = true; const generation = editGeneration.current, baseline = revision.current; try { if (await onRename?.(draft, baseline.revision) && revision.current === baseline) { ++baseline.revision; if (generation === editGeneration.current) { ++editGeneration.current; onEdit?.(false) } } } finally { saving.current = false } }}>
      <TextInput autoFocus aria-label="Exploration name" value={draft} placeholder="Name this exploration" onChange={event => { ++editGeneration.current; setDraft(event.target.value) }} onFocus={event => event.target.select()}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); ++editGeneration.current; onEdit?.(false) } }} />
      <button type="submit" aria-label="Save exploration name">✓</button>
      <button type="button" aria-label="Cancel rename" onClick={() => { ++editGeneration.current; onEdit?.(false) }}>×</button>
    </form> : <button type="button" className="survey-item" aria-label={`Show survey item: ${title}`}
      aria-current={selected ? 'true' : undefined} title={title} onClick={() => onSelect(zone.zoneId)} onDoubleClick={beginEdit} onKeyDown={event => { if (event.key === 'F2' && onRename) { event.preventDefault(); beginEdit() } }}>
      <span className="survey-item-glyph" aria-hidden="true">{glyph}</span>
      <strong>{title}</strong>
      <span className="survey-item-meta"><span className="survey-item-activity" aria-label={`Activity in ${title}`}>{activity}</span></span>
    </button>}
    {!editing ? <div className="survey-item-shortcuts" aria-label={`Create from ${title}`}>
      {onNewNote ? <button type="button" aria-label={`New note in Recall from ${title}`} title="New note in Recall" onClick={() => onNewNote(zone.zoneId)}><NotebookPen size={14} /></button> : null}
      {onNewAgent ? <button type="button" aria-label={`New agent in ${title}`} title="New agent" onClick={() => onNewAgent(zone.zoneId)}><Bot size={14} /></button> : null}
    </div> : null}
  </div>
}
