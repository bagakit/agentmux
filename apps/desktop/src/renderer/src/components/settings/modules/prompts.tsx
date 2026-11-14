import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { resolveComposerShortcuts } from '../../../../../shared/composer-shortcut-library'
import type { AppConfig, ComposerShortcut } from '../../../../../shared/contracts'
import { ShortcutSettingsPane } from '../ShortcutSettingsPane'
import type { SettingsModule } from '../settings-catalog'
import { saveGoalsCommonActions } from '../../../lib/goals-common-actions-config'

const ThemeObjectPromptIcon = semanticIconComponent('object.prompt')


// An empty list is an authored deletion; never restore defaults based on length.
async function saveComposerShortcuts(composerShortcuts: ComposerShortcut[], expected: ComposerShortcut[], directory: AppConfig['goalsCommonActions'], expectedDirectory: AppConfig['goalsCommonActions']): Promise<void> {
  await saveGoalsCommonActions({ directory, expectedDirectory, prompts: { value: composerShortcuts, expected } })
}

export const promptsSettingsModule = {
  id: 'prompts', archetype: 'library',
  group: 'message-tool',
  title: 'Prompts',
  overviewShortcut: 3,
  description: 'Keep your everyday instructions close at hand.',
  icon: ThemeObjectPromptIcon,
  keywords: 'message tool composer prompt preset shortcut keyword slash command snippet template library review changes summarize progress eli5 custom goals common actions order collapsed',
  searchTargets: [{ id: 'goals-common-actions', title: 'Goals common actions', keywords: 'default custom request order reference collapsed expanded' }],
  savedSummary(config) {
    const count = resolveComposerShortcuts(config).length
    return `${count} ${count === 1 ? 'prompt' : 'prompts'}`
  },
  Pane({ config, active }) {
    return <ShortcutSettingsPane config={config} active={active} onSave={saveComposerShortcuts} />
  }
} as const satisfies SettingsModule
