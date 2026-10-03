import type { CSSProperties } from 'react'
import { resolveNotesPreferences, type NotesPreferences } from '../../../shared/notes-preferences'

export function noteReadingStyle(preferences: NotesPreferences | undefined): CSSProperties {
  const saved = resolveNotesPreferences(preferences)
  return { '--note-font-size': `${saved.fontSize}px`, '--note-content-width': saved.contentWidth === 'wide' ? '100%' : '760px' } as CSSProperties
}
