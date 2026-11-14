import { presentKnowledgeSurface } from '../../../lib/knowledge-surface-navigation'
import { DEFAULT_NOTEBOOK_ID } from '@agentmux/core/notebook-catalog'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useAppStore } from '../../../store'
import { resolveNotesPreferences, type NotesPreferences } from '../../../../../shared/notes-preferences'
import { NotesSettingsPane } from '../NotesSettingsPane'
import type { SettingsModule } from '../settings-catalog'
import { saveConfigSlice } from '../save-config-slice'

const RecallIcon = semanticIconComponent('navigation.recall')


async function saveNotes(value: Required<NotesPreferences>, expected: Required<NotesPreferences>): Promise<void> {
  await saveConfigSlice((current, notes: Required<NotesPreferences>) => ({ ...current, notes: { ...current.notes, ...notes } }), value, expected)
}

export const notesSettingsModule = {
  id: 'notes', archetype: 'preference', group: 'know', title: 'Note', icon: RecallIcon,
  selectionAnimation: true,
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
        void presentKnowledgeSurface('recall', state.setMainSurface, { inputPolicy: 'target' })
      }} />
  }
} as const satisfies SettingsModule
