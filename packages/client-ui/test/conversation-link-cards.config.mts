import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { aliases, installedDependency } from '../../../apps/desktop/scripts/fixtures/settings-resource-library/environment.mjs'

const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({
  root, cacheDir: resolve(root, '.tmp/conversation-link-cards-vitest'),
  esbuild: { jsx: 'automatic' }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  resolve: { alias: aliases },
  plugins: [{ name: 'installed-conversation-link-dependencies', enforce: 'pre',
    resolveId(source, importer) { return installedDependency(source, importer) }
  }],
  test: { include: ['packages/client-ui/test/conversation-link-cards.test.tsx'],
    environment: 'happy-dom', passWithNoTests: false, maxWorkers: 1,
    fileParallelism: false, testTimeout: 12000 }
})
