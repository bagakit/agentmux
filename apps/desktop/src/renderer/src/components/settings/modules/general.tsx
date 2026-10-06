import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { GeneralSettingsPane, type GeneralSettingsValues } from '../GeneralSettingsPane'
import type { SettingsModule } from '../settings-catalog'

const ThemeObjectSettingsIcon = semanticIconComponent('object.settings')


async function saveGeneralSettings(value: GeneralSettingsValues, expected: GeneralSettingsValues): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) return
  const pathChange = value.copyPathsAsAbsolute !== expected.copyPathsAsAbsolute
  await api.config.save({ ...current, ...(pathChange ? { copyPathsAsAbsolute: value.copyPathsAsAbsolute } : {}) },
    { ...current, ...(pathChange ? { copyPathsAsAbsolute: expected.copyPathsAsAbsolute } : {}) })
}

export const generalSettingsModule = {
  id: 'general',
  group: 'preferences',
  title: 'General',
  description: 'Project paths, local data, and diagnostics.',
  icon: ThemeObjectSettingsIcon,
  keywords: 'copy path clipboard home directory ~ tilde abbreviate absolute full shorten core runtime terminal tmux ssh show crash log session recovery',
  savedSummary: (config) => `${config.copyPathsAsAbsolute === true ? 'Absolute paths' : 'Home paths (~)'}`,
  Pane({ config }) {
    return <GeneralSettingsPane copyPathsAsAbsolute={config.copyPathsAsAbsolute} onSave={saveGeneralSettings} />
  }
} as const satisfies SettingsModule
