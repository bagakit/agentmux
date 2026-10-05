import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../../../..')
const require = createRequire(resolve(root, 'apps/desktop/package.json'))
const aliases: { find: RegExp; replacement: string }[] = []
for (const name of ['core', 'demand', 'layout', 'identity', 'relay', 'client-ui']) {
  const directory = resolve(root, 'packages', name)
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
  for (const [key, target] of Object.entries(pkg.exports).sort(([a], [b]) => b.replace('*', '').length - a.replace('*', '').length)) {
    const value = typeof target === 'string' ? target : ((target as { browser?: string; import: string }).browser ?? (target as { import: string }).import)
    const source = value.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/u, '.ts')
    aliases.push({ find: new RegExp(`^@agentmux/${name}${key === '.' ? '' : key.slice(1).replace('*', '(.*)')}$`), replacement: resolve(directory, source.replace('*', '$1')) })
  }
}
for (const name of ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client']) aliases.unshift({ find: new RegExp(`^${name}$`), replacement: require.resolve(name) })

export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, esbuild: { jsx: 'automatic' }, resolve: { alias: aliases },
  test: { include: ['apps/desktop/test/toolkit-agent-cards.test.tsx'], setupFiles: [resolve(root, 'vitest.setup.ts')],
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 12000 } })
