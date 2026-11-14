import { readFileSync } from 'node:fs'
import base from '../scripts/fixtures/browser-operation-feedback/vitest.owning.config.mts'
import { fileURLToPath } from 'node:url'

const coreSourceRoot = new URL('../../../packages/core/', import.meta.url)
const coreSourceAliases = Object.entries(JSON.parse(readFileSync(new URL('package.json', coreSourceRoot), 'utf8')).exports as Record<string, { import: string }>)
  .filter(([key]) => key !== '.')
  .map(([key, entry]) => ({
    find: '@agentmux/core/' + key.slice(2),
    replacement: fileURLToPath(new URL(entry.import.replace('./dist/', './src/').replace(/\.js$/u, '.ts'), coreSourceRoot))
  })).sort((a, b) => b.find.length - a.find.length)

export default { ...base, resolve: { alias: [...base.resolve.alias,
  ...coreSourceAliases,
  { find: /^@agentmux\/identity$/, replacement: fileURLToPath(new URL('../../../packages/identity/src/index.ts', import.meta.url)) }
] }, test: { ...base.test, include: [
  'apps/desktop/test/browser-control-feedback.test.ts',
  'apps/desktop/test/browser-operation-feedback.test.ts',
  'apps/desktop/test/browser-page-action-feedback.test.ts'
], passWithNoTests: false, maxWorkers: 1, fileParallelism: false } }
