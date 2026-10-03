import { Search } from 'lucide-react'
import { useAppStore } from '../../../store'
import { SettingsManagementPane } from '../SettingsManagementPane'
import type { SettingsModule } from '../settings-catalog'

export const surveySettingsModule = {
  id: 'survey', group: 'work', title: 'Survey', icon: Search,
  description: 'Research, browsing and collected explorations.',
  keywords: 'work survey research browser browsing exploration collected sources',
  savedSummary: () => 'Research workspace',
  Pane({ onClose }) {
    return <SettingsManagementPane title="Your research workspace"
      description="Continue browsing and researching in Survey. Manage collected explorations and their sources there."
      actionLabel="Open Survey" onOpen={() => { onClose(); useAppStore.getState().setMainSurface('survey') }} />
  }
} as const satisfies SettingsModule
