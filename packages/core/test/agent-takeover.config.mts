import { defineConfig } from 'vitest/config'
import { readFileSync, appendFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { takeoverSource } from './fixtures/agent-takeover-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
const aliases = ['core', 'demand'].flatMap(name => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'packages', name, 'package.json'), 'utf8'))
  return Object.entries(manifest.exports).filter(([key]) => !key.includes('*')).map(([key, value]: [string, any]) => ({
    find: key === '.' ? '@agentmux/' + name : '@agentmux/' + name + '/' + key.slice(2),
    replacement: resolve(root, 'packages', name, value.import.replace('./dist/', name === 'demand' ? './' : './src/').replace(/\.js$/, '.ts'))
  })).sort((a, b) => b.find.length - a.find.length)
})
export default defineConfig({ root, resolve: { alias: aliases }, plugins: [{ name: 'original-takeover-owner', enforce: 'pre', transform(source, id) {
  const path = relative(root, id.split('?')[0]!)
  if (!path.startsWith('packages/core/src/') && !path.startsWith('apps/host/src/')) return
  const result = takeoverSource(path, source, process.env.AGENTMUX_TEST_TAKEOVER_MUTATION === 'restore-drops-provenance' ? undefined : process.env.AGENTMUX_TEST_TAKEOVER_MUTATION)
  if (process.env.AGENTMUX_TEST_TAKEOVER_TRACE) appendFileSync(process.env.AGENTMUX_TEST_TAKEOVER_TRACE, JSON.stringify({ loader: 'vite', ...result.receipt }) + '\n')
  return result.loaded === source ? undefined : { code: result.loaded, map: null }
} }], test: { include: ['packages/core/test/agent-derived-actions.test.ts', 'packages/core/test/agent-open-derive.test.ts', 'packages/core/test/agent-takeover.test.ts', 'packages/core/test/agent-takeover-continuation.test.ts'], passWithNoTests: false,
  setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, fileParallelism: false, testTimeout: 30000, hookTimeout: 30000 } })
