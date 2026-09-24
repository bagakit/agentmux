import { MessageSquareText } from 'lucide-react'
import { resolveComposerShortcuts } from '../../../../../shared/composer-shortcut-library'
import type { ComposerShortcut } from '../../../../../shared/contracts'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { ShortcutSettingsPane } from '../ShortcutSettingsPane'
import type { SettingsModule } from '../settings-catalog'

// An empty list is an authored deletion; never restore defaults based on length.
async function saveComposerShortcuts(composerShortcuts: ComposerShortcut[], expected: ComposerShortcut[]): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) return
  await api.config.save({ ...current, composerShortcuts }, { ...current, composerShortcuts: expected })
}

export const promptsSettingsModule = {
  id: 'prompts',
  group: 'resources',
  title: 'Prompts',
  description: 'Keep your everyday instructions close at hand.',
  icon: MessageSquareText,
  keywords: 'prompt preset shortcut keyword slash command snippet template library review changes summarize progress eli5 custom',
  savedSummary(config) {
    const count = resolveComposerShortcuts(config).length
    return `${count} ${count === 1 ? 'prompt' : 'prompts'}`
  },
  Pane({ config }) {
    return <ShortcutSettingsPane config={config} onSave={saveComposerShortcuts} />
  }
} as const satisfies SettingsModule
