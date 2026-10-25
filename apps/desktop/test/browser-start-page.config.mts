import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import owning from '../scripts/fixtures/note-restore/vitest.owning.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const exports = JSON.parse(readFileSync(resolve(root, 'apps/host/package.json'), 'utf8')).exports as Record<string, { import: string }>
const hostAliases = Object.entries(exports).map(([name, entry]) => ({
  find: `@agentmux/host/${name.slice(2)}`, replacement: resolve(root, 'apps/host/src', entry.import.slice(7).replace(/\.js$/u, '.ts'))
})).sort((a, b) => b.find.length - a.find.length)
export default defineConfig({ ...owning,
  resolve: { ...owning.resolve, alias: [...hostAliases, ...(owning.resolve?.alias as { find: string; replacement: string }[])] },
  test: { ...owning.test, include: ['apps/desktop/test/browser-start-page.test.tsx', 'apps/desktop/test/browser-address-input.test.tsx', 'apps/desktop/test/start-page-atmosphere.test.tsx'] }
})
