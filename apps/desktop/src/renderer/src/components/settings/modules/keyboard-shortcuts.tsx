import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { SHORTCUT_BINDINGS } from '../../../lib/shortcut-registry'
import { KeyboardShortcutsPane } from '../KeyboardShortcutsPane'
import type { SettingsModule } from '../settings-catalog'

const ThemeObjectKeyboardIcon = semanticIconComponent('object.keyboard')


export const keyboardShortcutsSettingsModule = {
  id: 'keyboard-shortcuts',
  group: 'preferences',
  title: 'Keyboard shortcuts',
  description: 'Commands, platform keys, and where they work.',
  icon: ThemeObjectKeyboardIcon,
  keywords: 'keyboard shortcuts keys keybindings hotkeys commands bindings chord help',
  savedSummary: () => `${SHORTCUT_BINDINGS.length} read-only bindings`,
  Pane: () => <KeyboardShortcutsPane />
} as const satisfies SettingsModule
