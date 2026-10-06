import { defineConfig } from 'vitest/config'
import overviewConfig from '../settings-overview/vitest.config.mts'

export default defineConfig({ ...overviewConfig, test: { ...overviewConfig.test, include: [
  'apps/desktop/test/settings-message-tool.test.tsx',
  'apps/desktop/test/message-tool-initial-layout.test.tsx',
  'apps/desktop/test/settings-draft-conflict.test.tsx'
] } })
