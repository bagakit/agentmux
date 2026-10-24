import { DEFAULT_NOTEBOOK_ID } from '@agentmux/core/notebook-catalog'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useAppStore } from '../../../store'
import { api } from '../../../lib/api'
import { resolveNotesPreferences, type NotesPreferences } from '../../../../../shared/notes-preferences'
import { NotesSettingsPane } from '../NotesSettingsPane'
import type { SettingsModule } from '../settings-catalog'

const RecallIcon = semanticIconComponent('navigation.recall')


async function saveNotes(value: Required<NotesPreferences>, expected: Required<NotesPreferences>): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) throw new Error('Configuration is unavailable. Your Notes choices are kept; reload configuration and retry saving.')
  await api.config.save({ ...current, notes: { ...current.notes, ...value } }, { ...current, notes: { ...current.notes, ...expected } })
}

export const notesSettingsModule = {
  id: 'notes', group: 'work', title: 'Recall', icon: RecallIcon,
  description: 'A comfortable reading space for your notebooks and pages.',
  keywords: 'recall directory folder storage path work notes note notebook notebooks pages quick notes 随手记 knowledge reading font size width wide',
  searchTargets: [
    { id: 'notes-storage', title: 'Notes directory', keywords: 'recall storage folder path' },
    { id: 'notes-font-size', title: 'Notes body text size', keywords: 'reading font typography' },
    { id: 'notes-width', title: 'Reading width', keywords: 'recall notes wide standard' },
  ],
  savedSummary: config => { const saved = resolveNotesPreferences(config.notes); return `${saved.fontSize} px · ${saved.contentWidth === 'wide' ? 'Wide' : 'Standard'}` },
  Pane({ config, onClose }) {
    return <NotesSettingsPane preferences={config.notes} onSave={saveNotes} onOpenNotes={() => {
        onClose()
        const state = useAppStore.getState()
        state.setRecallNotebook(DEFAULT_NOTEBOOK_ID)
        state.setRecallZoneSelection(null)
        state.setMainSurface('recall')
      }} />
  }
} as const satisfies SettingsModule
