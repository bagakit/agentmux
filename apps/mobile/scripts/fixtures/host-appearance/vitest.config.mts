import { defineConfig } from 'vitest/config'
import settings from '../../../../desktop/scripts/fixtures/settings-themes/vitest.config.mts'
import { resolve } from 'node:path'
export default defineConfig({
  ...settings,
  resolve: { ...settings.resolve, conditions: ['browser', 'module', 'import'], alias: [
    ...(settings.resolve!.alias as []),
    { find: /^@agentmux\/client-ui\/icons$/, replacement: resolve(import.meta.dirname, '../../../../../packages/client-ui/src/theme/icons.tsx') }
  ] },
  test: { ...settings.test, environment: 'happy-dom', include: ['apps/mobile/test/host-appearance.test.tsx', 'apps/mobile/test/terminal-viewer-initial-binding.test.tsx'] }
})
