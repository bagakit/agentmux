import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { resolveComposerShortcuts } from '../../../../../shared/composer-shortcut-library'
import { ShortcutSettingsPane } from '../ShortcutSettingsPane'
import type { SettingsModule } from '../settings-catalog'

const ThemeObjectPromptIcon = semanticIconComponent('object.prompt')


export const promptsSettingsModule = {
  id: 'prompts', archetype: 'library',
  group: 'message-tool',
  title: 'Prompts',
  overviewShortcut: 3,
  description: 'Keep your everyday instructions close at hand.',
  icon: ThemeObjectPromptIcon,
  keywords: 'message tool composer prompt preset shortcut keyword slash command snippet template library review changes summarize progress eli5 custom',
  savedSummary(config) {
    const count = resolveComposerShortcuts(config).length
    return `${count} ${count === 1 ? 'prompt' : 'prompts'}`
  },
  Pane({ config, active, onNavigate }) {
    return <ShortcutSettingsPane config={config} active={active} onOpenGoals={() => onNavigate('goals')} />
  }
} as const satisfies SettingsModule
