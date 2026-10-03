import type { AgentMuxZoneFact } from '@agentmux/core/control'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { currentDisplayNameRevision } from '../store'

/** A navigation row references the original Zone; actions belong to the selected Item menu. */
export function SurveyZoneItem({ zone, title, glyph, selected, activity, editing = false, onRename, onEdit, onSelect }: {
  zone: AgentMuxZoneFact
  title: string
  glyph: ReactNode
  selected: boolean
  activity: ReactNode
  editing?: boolean
  onRename?: (name: string, expectedNameRevision: number) => Promise<boolean>
  onEdit?: (editing: boolean) => void
  onSelect(zoneId: string): void
}) {
  const [draft, setDraft] = useState(title)
  const revision = useRef(0), saving = useRef(false), editGeneration = useRef(0)
  useEffect(() => { ++editGeneration.current; if (editing) { setDraft(title); revision.current = currentDisplayNameRevision('zone', zone.zoneId) } return () => { ++editGeneration.current } }, [editing, zone.zoneId])
  const beginEdit = () => { ++editGeneration.current; setDraft(title); onEdit?.(true) }
  return <div className="survey-item-row" data-survey-zone-id={zone.zoneId} data-selected={selected}>
    {editing ? <form className="survey-item-name" onSubmit={async event => { event.preventDefault(); if (saving.current) return; saving.current = true; const generation = editGeneration.current; try { if (await onRename?.(draft, revision.current) && generation === editGeneration.current) { ++editGeneration.current; onEdit?.(false) } } finally { saving.current = false } }}>
      <input autoFocus aria-label="Exploration name" value={draft} placeholder="Name this exploration" onChange={event => { ++editGeneration.current; setDraft(event.target.value) }} onFocus={event => event.target.select()}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); ++editGeneration.current; onEdit?.(false) } }} />
      <button type="submit" aria-label="Save exploration name">✓</button>
      <button type="button" aria-label="Cancel rename" onClick={() => { ++editGeneration.current; onEdit?.(false) }}>×</button>
    </form> : <button type="button" className="survey-item" aria-label={`Show survey item: ${title}`}
      aria-current={selected ? 'true' : undefined} title={title} onClick={() => onSelect(zone.zoneId)} onDoubleClick={beginEdit} onKeyDown={event => { if (event.key === 'F2' && onRename) { event.preventDefault(); beginEdit() } }}>
      <span className="survey-item-glyph" aria-hidden="true">{glyph}</span>
      <strong>{title}</strong>
      <span className="survey-item-meta"><span className="survey-item-activity" aria-label={`Activity in ${title}`}>{activity}</span></span>
    </button>}
  </div>
}
