import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { sourceAliases } from '../bookmark-local-link/vitest.owning.config.mts'
import { radixOverlayAliases } from '../../radix-overlay-aliases.ts'
const repository = resolve(import.meta.dirname, '../../../../..')
export { sourceAliases }
export default defineConfig({
  root: repository, resolve: { alias: [...Object.entries(radixOverlayAliases).map(([find,replacement]) => ({find,replacement})), ...sourceAliases] }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  test: { include: ['apps/desktop/test/launcher*.test.{ts,tsx}', 'apps/desktop/test/launch-option-controls.test.tsx',
    'apps/desktop/test/mote-avatar-identity.test.tsx', 'apps/desktop/test/space-launcher-interaction.test.tsx',
    'apps/desktop/test/mote-launcher-identity.test.tsx', 'apps/desktop/test/warm-terminal-ownership.test.ts'],
    setupFiles: [resolve(repository, 'vitest.setup.ts')], server: { deps: { inline: ['@agentmux/client-ui', /@radix-ui\//] } }, passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 20000 },
  cacheDir: resolve(repository, '.tmp/launcher-current-closure/cache')
})
