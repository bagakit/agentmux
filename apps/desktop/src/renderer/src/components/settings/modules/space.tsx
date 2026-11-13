import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useAppStore } from '../../../store'
import { SpaceSettingsPane, projectRailDensityLabel, type SpacePreferences } from '../SpaceSettingsPane'
import type { SettingsModule } from '../settings-catalog'
import { saveConfigSlice } from '../save-config-slice'

const SpaceIcon = semanticIconComponent('navigation.space')


async function savePreferences(value: SpacePreferences, expected: SpacePreferences): Promise<void> {
  await saveConfigSlice((current, preferences: SpacePreferences) => ({ ...current, ...preferences }), value, expected)
}

export const spaceSettingsModule = {
  id: 'space', group: 'work', title: 'Space', icon: SpaceIcon,
  selectionAnimation: true,
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
