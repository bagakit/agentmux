import base from '../../../packages/core/test/hook-postcommit-observation.vitest.config.mts'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
const root = resolve(import.meta.dirname, '../../..')
const host = resolve(root, 'apps/host')
const clientUi = resolve(root, 'packages/client-ui')
const clientUiAliases = Object.entries(JSON.parse(readFileSync(resolve(clientUi, 'package.json'), 'utf8')).exports)
  .filter(([key]) => key !== '.').sort(([a], [b]) => b.length - a.length).map(([key, value]) => ({
    find: new RegExp('^@agentmux/client-ui/' + key.slice(2).replace('*', '(.+)') + '$'),
    replacement: resolve(clientUi, (typeof value === 'string' ? value : (value as { types: string }).types).replace('*', '$1'))
  }))
const aliases = Object.entries(JSON.parse(readFileSync(resolve(host, 'package.json'), 'utf8')).exports).map(([key, value]) => ({
  find: '@agentmux/host' + (key === '.' ? '' : key.slice(1)),
  replacement: resolve(host, (value as { import: string }).import.replace('./dist/', './src/').replace(/\.js$/u, '.ts'))
})).sort((a, b) => b.find.length - a.find.length)
export default { ...base, resolve: { alias: [{ find: '@agentmux/identity/runtime-source', replacement: resolve(root, 'packages/identity/dist/runtime-source.js') },
  { find: /^@agentmux\/browser\/(.+)$/u, replacement: resolve(root, 'packages/browser/src/$1.ts') },
  ...aliases, ...clientUiAliases, ...base.resolve.alias
  ] }, test: { ...base.test, include: ['apps/host/test/executor-environment-refresh.test.ts', 'apps/desktop/test/executor-environment-refresh.test.tsx'],
  setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 45_000, hookTimeout: 20_000 } }
