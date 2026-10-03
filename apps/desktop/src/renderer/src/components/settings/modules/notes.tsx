import { DEFAULT_NOTEBOOK_ID } from '@agentmux/core/notebook-catalog'
import { NotebookPen } from 'lucide-react'
import { useAppStore } from '../../../store'
import { SettingsManagementPane } from '../SettingsManagementPane'
import type { SettingsModule } from '../settings-catalog'

export const notesSettingsModule = {
  id: 'notes', group: 'work', title: 'Notes', icon: NotebookPen,
  description: 'Notebooks and pages, managed alongside your research.',
  keywords: 'work notes note notebook notebooks pages quick notes 随手记 knowledge',
  savedSummary: () => 'Notebooks and pages',
  Pane({ onClose }) {
    return <SettingsManagementPane title="Your notebooks"
      description="Open 随手记 in Survey, then choose a notebook to organize its pages, sources and history."
      actionLabel="Open Notes" onOpen={() => {
        onClose()
        const state = useAppStore.getState()
        state.setSurveyNotebook(DEFAULT_NOTEBOOK_ID)
        state.setSurveyZoneSelection(null)
        state.setMainSurface('survey')
      }} />
  }
} as const satisfies SettingsModule
