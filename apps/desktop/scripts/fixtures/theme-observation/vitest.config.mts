import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import settings from '../settings-themes/vitest.config.mts'
export default defineConfig({
  ...settings,
  resolve: { ...settings.resolve, alias: [
    ...(settings.resolve!.alias as []),
    { find: /^@agentmux\/relay\/e2ee$/, replacement: resolve(import.meta.dirname, '../../../../../packages/relay/src/e2ee.ts') },
    { find: /^@agentmux\/relay\/offer$/, replacement: resolve(import.meta.dirname, '../../../../../packages/relay/src/connection-offer.ts') },
    { find: /^@agentmux\/relay\/endpoint$/, replacement: resolve(import.meta.dirname, '../../../../../packages/relay/src/daemon-endpoints.ts') }
  ] },
  test: { ...settings.test, include: ['apps/desktop/test/theme-observation.test.ts', 'apps/desktop/test/theme-observation-relay.test.ts', 'packages/core/test/appearance-observation-codec.test.ts'] }
})
