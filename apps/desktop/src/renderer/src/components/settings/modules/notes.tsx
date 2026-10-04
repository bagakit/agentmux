import { DEFAULT_NOTEBOOK_ID } from '@agentmux/core/notebook-catalog'
import { NotebookPen } from 'lucide-react'
import { useAppStore } from '../../../store'
import { api } from '../../../lib/api'
import { resolveNotesPreferences, type NotesPreferences } from '../../../../../shared/notes-preferences'
import { NotesSettingsPane } from '../NotesSettingsPane'
import type { SettingsModule } from '../settings-catalog'

async function saveNotes(value: Required<NotesPreferences>, expected: Required<NotesPreferences>): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) throw new Error('Configuration is unavailable. Your Notes choices are kept; reload configuration and retry saving.')
  await api.config.save({ ...current, notes: { ...current.notes, ...value } }, { ...current, notes: { ...current.notes, ...expected } })
}

export const notesSettingsModule = {
  id: 'notes', group: 'work', title: 'Notes', icon: NotebookPen,
  description: 'A comfortable reading space for your notebooks and pages.',
  keywords: 'work notes note notebook notebooks pages quick notes 随手记 knowledge reading font size width wide',
  savedSummary: config => { const saved = resolveNotesPreferences(config.notes); return `${saved.fontSize} px · ${saved.contentWidth === 'wide' ? 'Wide' : 'Standard'}` },
  Pane({ config, onClose }) {
    return <NotesSettingsPane preferences={config.notes} onSave={saveNotes} onOpenNotes={() => {
        onClose()
        const state = useAppStore.getState()
        state.setSurveyNotebook(DEFAULT_NOTEBOOK_ID)
        state.setSurveyZoneSelection(null)
        state.setMainSurface('survey')
      }} />
  }
} as const satisfies SettingsModule
