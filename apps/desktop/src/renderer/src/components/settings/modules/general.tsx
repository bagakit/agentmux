import { Settings2 } from 'lucide-react'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { GeneralSettingsPane } from '../GeneralSettingsPane'
import type { SettingsModule } from '../settings-catalog'

async function saveCopyPathsAsAbsolute(copyPathsAsAbsolute: boolean, expected: boolean): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) return
  await api.config.save({ ...current, copyPathsAsAbsolute }, { ...current, copyPathsAsAbsolute: expected })
}

export const generalSettingsModule = {
  id: 'general',
  group: 'preferences',
  title: 'General',
  description: 'Copied paths, local data, and diagnostics.',
  icon: Settings2,
  keywords: 'copy path clipboard home directory ~ tilde abbreviate absolute full shorten core runtime terminal tmux ssh show crash log session recovery',
  savedSummary: (config) => config.copyPathsAsAbsolute === true ? 'Absolute paths' : 'Home paths (~)',
  Pane({ config }) {
    return <GeneralSettingsPane copyPathsAsAbsolute={config.copyPathsAsAbsolute} onSave={saveCopyPathsAsAbsolute} />
  }
} as const satisfies SettingsModule
