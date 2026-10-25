import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { sourceAliases } from '../scripts/fixtures/bookmark-local-link/vitest.owning.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const ui = resolve(root, 'packages/client-ui')
const uiExports = JSON.parse(readFileSync(resolve(ui, 'package.json'), 'utf8')).exports
const uiAliases = Object.entries(uiExports).sort(([a], [b]) => b.length - a.length).map(([key, value]) => {
  const name = `@agentmux/client-ui${key === '.' ? '' : key.slice(1)}`
  const target = typeof value === 'string' ? value : (value as { types: string }).types
  return { find: name.includes('*') ? new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\*', '(.+)')}$`) : name,
    replacement: resolve(ui, target.replace('*', '$1')) }
})
export default defineConfig({
  root, resolve: { alias: [...uiAliases, ...sourceAliases] }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  test: {
    include: ['apps/desktop/test/launcher-resume-previews.test.tsx', 'apps/desktop/test/launcher-resume-picker.test.tsx',
      'apps/desktop/test/launcher-resume-actions.test.tsx', 'apps/desktop/test/session-takeover.test.tsx'],
    setupFiles: [resolve(root, 'vitest.setup.ts')], passWithNoTests: false,
    maxWorkers: 1, fileParallelism: false, testTimeout: 20000
  }
})
