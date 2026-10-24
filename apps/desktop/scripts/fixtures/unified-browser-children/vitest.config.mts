import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../../../..')
const core = resolve(root, 'packages/core')
const manifest = JSON.parse(readFileSync(resolve(core, 'package.json'), 'utf8'))
// Follow the package's real export targets: e.g. ./files owns public-rpc-files.ts.
// This bounded source suite does not substitute for package-consumer delivery checks.
const alias = Object.entries(manifest.exports).flatMap(([key, exported]) => {
  const target = typeof exported === 'string' ? exported : (exported as { import?: string }).import
  if (!target || key.includes('*')) return []
  const replacement = resolve(core, target.replace(/^\.\/dist\//u, './src/').replace(/\.js$/u, '.ts'))
  return existsSync(replacement) ? [{ find: '@agentmux/core' + (key === '.' ? '' : key.slice(1)), replacement }] : []
}).sort((a, b) => b.find.length - a.find.length)

export default defineConfig({
  root,
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  resolve: { alias },
  test: {
    include: ['apps/desktop/test/browser-object-link.test.ts', 'apps/desktop/test/browser-child-owner.test.ts', 'apps/desktop/test/browser-view-manager.test.ts'],
    exclude: [], setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1
  }
})
