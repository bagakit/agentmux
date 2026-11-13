import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { resolveComposerShortcuts } from '../../../../../shared/composer-shortcut-library'
import type { ComposerShortcut } from '../../../../../shared/contracts'
import { ShortcutSettingsPane } from '../ShortcutSettingsPane'
import type { SettingsModule } from '../settings-catalog'
import { saveConfigSlice } from '../save-config-slice'

const ThemeObjectPromptIcon = semanticIconComponent('object.prompt')


// An empty list is an authored deletion; never restore defaults based on length.
async function saveComposerShortcuts(composerShortcuts: ComposerShortcut[], expected: ComposerShortcut[]): Promise<void> {
  await saveConfigSlice((current, value: ComposerShortcut[]) => ({ ...current, composerShortcuts: value }), composerShortcuts, expected)
}

export const promptsSettingsModule = {
  id: 'prompts',
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
  Pane({ config, active }) {
    return <ShortcutSettingsPane config={config} active={active} onSave={saveComposerShortcuts} />
  }
} as const satisfies SettingsModule
