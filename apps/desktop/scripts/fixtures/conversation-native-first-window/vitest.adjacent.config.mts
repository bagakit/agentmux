import { defineConfig } from 'vitest/config'
import owning from './vitest.owning.config.mts'

export default defineConfig({ ...owning, test: { ...owning.test, globalSetup: [], include: [
  'apps/desktop/test/conversation-native-input-refresh.integration.test.tsx',
  'apps/desktop/test/conversation-native-input-window.integration.test.tsx'
], passWithNoTests: false } })
