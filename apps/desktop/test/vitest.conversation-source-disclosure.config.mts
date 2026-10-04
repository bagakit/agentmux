import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const root = resolve(import.meta.dirname, '../../..')
const exports = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports
const coreAliases = Object.entries(exports).map(([key, value]) => ({
  find: key === '.' ? '@agentmux/core' : `@agentmux/core/${key.slice(2)}`,
  replacement: resolve(root, 'packages/core', (value as { import: string }).import.replace('/dist/', '/src/').replace(/\.js$/, '.ts'))
})).sort((a, b) => b.find.length - a.find.length)

export default defineConfig({
  root,
  cacheDir: resolve(root, '.tmp/conversation-source-disclosure-cache'),
  esbuild: { jsx: 'automatic' },
  resolve: { alias: [
    ...coreAliases,
    { find: /^@agentmux\/client-ui\/components\/(.*)$/, replacement: resolve(root, 'packages/client-ui/src/components/$1') },
    { find: '@agentmux/client-ui/platform', replacement: resolve(root, 'packages/client-ui/src/platform.tsx') },
    { find: /^@agentmux\/client-ui\/(.*)$/, replacement: resolve(root, 'packages/client-ui/src/lib/$1') }
  ] },
  test: { include: ['apps/desktop/test/conversation-source-disclosure.test.tsx'], passWithNoTests: false, fileParallelism: false }
})
