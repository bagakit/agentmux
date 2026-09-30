import type { AgentMuxZoneFact } from '@agentmux/core/control'
import type { ReactNode } from 'react'

/** A navigation row references the original Zone; actions belong to the selected Item menu. */
export function SurveyZoneItem({ zone, title, glyph, selected, activity, onSelect }: {
  zone: AgentMuxZoneFact
  title: string
  glyph: ReactNode
  selected: boolean
  activity: ReactNode
  onSelect(zoneId: string): void
}) {
  return <div className="survey-item-row" data-survey-zone-id={zone.zoneId} data-selected={selected}>
    <button type="button" className="survey-item" aria-label={`Show survey item: ${title}`}
      aria-current={selected ? 'true' : undefined} title={title} onClick={() => onSelect(zone.zoneId)}>
      <span className="survey-item-glyph" aria-hidden="true">{glyph}</span>
      <strong>{title}</strong>
      <span className="survey-item-meta"><span className="survey-item-activity" aria-label={`Activity in ${title}`}>{activity}</span></span>
    </button>
  </div>
}
