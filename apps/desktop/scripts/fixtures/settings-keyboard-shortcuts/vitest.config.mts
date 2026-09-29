import { defineConfig } from 'vitest/config'
import overviewConfig from '../settings-overview/vitest.config.mts'

export default defineConfig({ ...overviewConfig, test: { ...overviewConfig.test, include: [
  'apps/desktop/test/settings-keyboard-shortcuts.test.tsx',
  'apps/desktop/test/shortcut-help-affordance.test.tsx',
  'apps/desktop/test/settings-overview.test.tsx',
  'apps/desktop/test/settings-structure.test.tsx',
  'apps/desktop/test/settings-search.test.ts',
  'apps/desktop/test/shortcut-registry.test.ts',
  'apps/desktop/test/shortcut-cheat-sheet.test.ts',
  'apps/desktop/test/shortcut-scope-wiring.test.tsx',
  'apps/desktop/test/workbench-shortcut-wiring.test.tsx',
  'apps/desktop/test/workbench-shortcuts.test.ts',
  'apps/desktop/test/terminal-shortcuts.test.ts',
  'apps/desktop/test/terminal-ime.test.ts',
  'apps/desktop/test/editor-save-shortcut.test.ts',
  'apps/desktop/test/next-attention-shortcut.test.ts',
  'apps/desktop/test/overlay-native-adoption.test.tsx',
  'packages/core/test/control-desktop-focus.test.ts'
] } })
