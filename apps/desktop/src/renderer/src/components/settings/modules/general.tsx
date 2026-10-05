import { Settings2 } from 'lucide-react'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { GeneralSettingsPane, type GeneralSettingsValues } from '../GeneralSettingsPane'
import { MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT } from '../../../../../shared/contracts'
import type { SettingsModule } from '../settings-catalog'

async function saveGeneralSettings(value: GeneralSettingsValues, expected: GeneralSettingsValues): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) return
  const pathChange = value.copyPathsAsAbsolute !== expected.copyPathsAsAbsolute
  const layoutChange = value.messageToolInitialLayout !== expected.messageToolInitialLayout
  await api.config.save({ ...current, ...(pathChange ? { copyPathsAsAbsolute: value.copyPathsAsAbsolute } : {}),
    ...(layoutChange ? { messageToolInitialLayout: value.messageToolInitialLayout } : {}) },
  { ...current, ...(pathChange ? { copyPathsAsAbsolute: expected.copyPathsAsAbsolute } : {}),
    ...(layoutChange ? { messageToolInitialLayout: expected.messageToolInitialLayout } : {}) })
}

export const generalSettingsModule = {
  id: 'general',
  group: 'preferences',
  title: 'General',
  description: 'Message Tool layout, project paths, local data, and diagnostics.',
  icon: Settings2,
  keywords: 'message tool initial layout one line two lines composer input tools 一行 两行 初始 copy path clipboard home directory ~ tilde abbreviate absolute full shorten core runtime terminal tmux ssh show crash log session recovery',
  savedSummary: (config) => `${config.copyPathsAsAbsolute === true ? 'Absolute paths' : 'Home paths (~)'} · ${(config.messageToolInitialLayout ?? MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT) === 'one-line' ? 'One-line Message Tool' : 'Two-line Message Tool'}`,
  Pane({ config }) {
    return <GeneralSettingsPane copyPathsAsAbsolute={config.copyPathsAsAbsolute} messageToolInitialLayout={config.messageToolInitialLayout ?? MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT} onSave={saveGeneralSettings} />
  }
} as const satisfies SettingsModule
