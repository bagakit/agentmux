import { Palette } from 'lucide-react'
import { APP_APPEARANCE_DEFAULT, TERMINAL_FONT_SIZE_DEFAULT } from '../../../../../shared/contracts'
import type { AppearanceConfig } from '../../../../../shared/contracts'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { AppearanceSettingsPane } from '../AppearanceSettingsPane'
import type { SettingsModule } from '../settings-catalog'

async function saveAppearance(appearance: AppearanceConfig, expected: AppearanceConfig): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) return
  await api.config.save({ ...current, appearance }, { ...current, appearance: expected })
}

export const appearanceSettingsModule = {
  id: 'appearance',
  group: 'preferences',
  title: 'Appearance',
  description: 'Theme, typography, and terminal colors.',
  icon: Palette,
  keywords: 'theme color palette terminal tui composer input background font size typography',
  savedSummary(config) {
    const mode = config.appearance.appAppearance ?? APP_APPEARANCE_DEFAULT
    return `${mode[0]!.toUpperCase()}${mode.slice(1)} · ${config.appearance.terminalFontSize ?? TERMINAL_FONT_SIZE_DEFAULT}px`
  },
  Pane({ config }) {
    return <AppearanceSettingsPane appearance={config.appearance} onSave={saveAppearance} />
  }
} as const satisfies SettingsModule
