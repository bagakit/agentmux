import { DEFAULT_THEME_ID, getThemeCatalog } from '@agentmux/client-ui/theme'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { APP_APPEARANCE_DEFAULT, TERMINAL_FONT_SIZE_DEFAULT } from '../../../../../shared/contracts'
import type { AppearanceConfig } from '../../../../../shared/contracts'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { AppearanceSettingsPane } from '../AppearanceSettingsPane'
import type { SettingsModule } from '../settings-catalog'

const ThemeAppearanceThemeIcon = semanticIconComponent('appearance.theme')


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
  icon: ThemeAppearanceThemeIcon,
  keywords: 'theme color palette terminal tui composer input background editor source diff font size typography',
  savedSummary(config) {
    const mode = config.appearance.appAppearance ?? APP_APPEARANCE_DEFAULT
    const theme = getThemeCatalog(config.appearance.customThemes).items.find(item => item.id === (config.appearance.themeId ?? DEFAULT_THEME_ID))
    return `${theme?.value.name ?? 'Unavailable theme'} · ${mode[0]!.toUpperCase()}${mode.slice(1)} · Editor ${config.appearance.editorFontSize === undefined ? 'App size' : `${config.appearance.editorFontSize}px`} · Terminal ${config.appearance.terminalFontSize ?? TERMINAL_FONT_SIZE_DEFAULT}px`
  },
  Pane({ config, active }) {
    return <AppearanceSettingsPane appearance={config.appearance} onSave={saveAppearance} active={active} />
  }
} as const satisfies SettingsModule
