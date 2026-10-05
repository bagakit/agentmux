import { defineConfig } from 'vitest/config'
import overviewConfig from '../settings-overview/vitest.config.mts'
import { resolve } from 'node:path'

// Main source owner plus the real compiled CLI; no UI mock or duplicate theme parser.
export default defineConfig({
  ...overviewConfig,
  resolve: { ...overviewConfig.resolve, alias: [
    ...(overviewConfig.resolve!.alias as []),
    { find: /^@agentmux\/client-ui\/theme$/, replacement: resolve(import.meta.dirname, '../../../../../packages/client-ui/src/theme/index.ts') }
  ] },
  test: { ...overviewConfig.test, include: [
    'apps/desktop/test/settings-themes-control.test.ts',
    'apps/desktop/test/settings-resources-control.test.ts',
    'apps/desktop/test/settings-control.test.ts',
    'packages/core/test/agentmux-cli-settings-resources.test.ts'
  ] }
})
