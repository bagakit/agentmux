import { PanelsTopLeft } from 'lucide-react'
import type { ProjectRailDensity } from '../../../../../shared/contracts'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { SpaceSettingsPane, projectRailDensityLabel } from '../SpaceSettingsPane'
import type { SettingsModule } from '../settings-catalog'

async function saveDensity(projectRailDensity: ProjectRailDensity, expected: ProjectRailDensity): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) throw new Error('Configuration is unavailable. Your density choice is kept; reload configuration and retry saving.')
  await api.config.save({ ...current, projectRailDensity }, { ...current, projectRailDensity: expected })
}

export const spaceSettingsModule = {
  id: 'space', group: 'work', title: 'Space', icon: PanelsTopLeft,
  description: 'Project rail density, topics and projects.',
  keywords: 'work topic topics project projects density rail compact dense',
  savedSummary: config => `${projectRailDensityLabel(config.projectRailDensity)} project rail`,
  Pane({ config, onClose, onNavigate }) {
    return <SpaceSettingsPane density={config.projectRailDensity} onSave={saveDensity}
      onTopics={() => { onClose(); useAppStore.getState().setMainSurface('workbench') }}
      onProjects={() => onNavigate('hosts')} />
  }
} as const satisfies SettingsModule
