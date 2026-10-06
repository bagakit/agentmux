import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import settings from '../settings-overview/vitest.config.mts'

export default defineConfig({
  ...settings,
  resolve: { ...settings.resolve, alias: [
    ...(settings.resolve!.alias as []),
    { find: /^@agentmux\/client-ui\/theme$/, replacement: resolve(import.meta.dirname, '../../../../../packages/client-ui/src/theme/index.ts') },
    { find: /^@agentmux\/client-ui\/icons$/, replacement: resolve(import.meta.dirname, '../../../../../packages/client-ui/src/theme/icons.tsx') }
  ] },
  test: { ...settings.test, include: [
    'apps/desktop/test/theme-bootstrap.test.tsx',
    'apps/desktop/test/theme-owner-runtime.test.tsx',
    'apps/desktop/test/theme-editor-runtime.test.tsx'
  ], environment: 'happy-dom' }
})
