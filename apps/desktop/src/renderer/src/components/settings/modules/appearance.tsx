import { DEFAULT_THEME_ID, getThemeCatalog } from '@agentmux/client-ui/theme'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { APP_APPEARANCE_DEFAULT, TERMINAL_FONT_SIZE_DEFAULT } from '../../../../../shared/contracts'
import type { AppearanceConfig } from '../../../../../shared/contracts'
import { AppearanceSettingsPane } from '../AppearanceSettingsPane'
import type { SettingsModule } from '../settings-catalog'
import { saveConfigSlice } from '../save-config-slice'

const ThemeAppearanceThemeIcon = semanticIconComponent('appearance.theme')


async function saveAppearance(appearance: AppearanceConfig, expected: AppearanceConfig): Promise<void> {
  await saveConfigSlice((current, value: AppearanceConfig) => ({ ...current, appearance: value }), appearance, expected)
}

export const appearanceSettingsModule = {
  id: 'appearance', archetype: 'preference',
  group: 'preferences',
  title: 'Appearance',
  overviewShortcut: 1,
  description: 'Theme, typography, and terminal colors.',
  icon: ThemeAppearanceThemeIcon,
  keywords: 'theme color palette terminal tui composer input background editor source diff font size typography icon icons semantic icons 图标',
  searchTargets: [
    { id: 'app-icon', title: 'App icon', keywords: 'brand logo dragon 青篆 回环 折玉 灵伴 classic 图标' },
    { id: 'workspace-theme', title: 'Workspace theme', keywords: 'theme color palette custom icon icons semantic icons 图标' },
    { id: 'app-appearance', title: 'Application appearance', keywords: 'dark light system window' },
    { id: 'editor-font-size', title: 'Editor font size', keywords: 'source diff typography inherit app' },
    { id: 'terminal-font-size', title: 'Terminal font size', keywords: 'terminal typography pixels' },
    { id: 'terminal-palette', title: 'Terminal palette', keywords: 'terminal colors' },
  ],
  savedSummary(config) {
    const mode = config.appearance.appAppearance ?? APP_APPEARANCE_DEFAULT
    const theme = getThemeCatalog(config.appearance.customThemes).items.find(item => item.id === (config.appearance.themeId ?? DEFAULT_THEME_ID))
    return `${theme?.value.name ?? 'Unavailable theme'} · ${mode[0]!.toUpperCase()}${mode.slice(1)} · Editor ${config.appearance.editorFontSize === undefined ? 'App size' : `${config.appearance.editorFontSize}px`} · Terminal ${config.appearance.terminalFontSize ?? TERMINAL_FONT_SIZE_DEFAULT}px`
  },
  Pane({ config, active }) {
    return <AppearanceSettingsPane appearance={config.appearance} onSave={saveAppearance} active={active} />
  }
} as const satisfies SettingsModule
