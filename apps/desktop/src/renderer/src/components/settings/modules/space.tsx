import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { SpaceSettingsPane, projectRailDensityLabel, type SpacePreferences } from '../SpaceSettingsPane'
import type { SettingsModule } from '../settings-catalog'

const SpaceIcon = semanticIconComponent('navigation.space')


async function savePreferences(value: SpacePreferences, expected: SpacePreferences): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) throw new Error('Configuration is unavailable. Your Space choices are kept; reload configuration and retry saving.')
  const committed = await api.config.save({ ...current, ...value }, { ...current, ...expected })
  if (useAppStore.getState().config === current) useAppStore.getState().setConfig(committed)
}

export const spaceSettingsModule = {
  id: 'space', group: 'work', title: 'Space', icon: SpaceIcon,
  description: 'Project rail density, Git History, topics and projects.',
  keywords: 'work topic topics project projects density rail compact dense git history commit time date',
  searchTargets: [
    { id: 'project-rail', title: 'Project rail density', keywords: 'comfortable compact dense sidebar' },
    { id: 'git-history-time', title: 'Show commit time', description: 'Show recorded author time in the Git History tree.', keywords: 'git history date timestamp' },
  ],
  savedSummary: config => `${projectRailDensityLabel(config.projectRailDensity)} project rail · Commit time ${config.gitHistoryShowTime !== false ? 'shown' : 'hidden'}`,
  Pane({ config, onClose, onNavigate }) {
    return <SpaceSettingsPane density={config.projectRailDensity} showHistoryTime={config.gitHistoryShowTime} onSave={savePreferences}
      onTopics={() => { onClose(); useAppStore.getState().setMainSurface('workbench') }}
      onProjects={() => onNavigate('hosts')} />
  }
} as const satisfies SettingsModule
