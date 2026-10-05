import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import type { Alias } from 'vite'
import original from '../../../vitest.config'

const root = resolve(import.meta.dirname, '../../..')
const dependencyRepository = resolve(realpathSync(resolve(root, 'node_modules')), '..')
// The isolated worktree has no shipping dist. Exercise these current public sources explicitly.
const aliases: Alias[] = []
for (const name of ['core', 'demand', 'git', 'identity', 'layout', 'client-ui', 'relay', 'diagnostic-evidence']) {
  const directory = resolve(root, 'packages', name)
  const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
  const exports = (Object.entries(manifest.exports ?? {}) as [string, { import?: string; browser?: string }][])
    .sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)
  for (const [entry, value] of exports) {
    const target = value.browser ?? value.import
    if (!target) continue
    const stem = target.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/, '.ts')
    const specifier = `@agentmux/${name}${entry === '.' ? '' : entry.slice(1)}`
    const pattern = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (entry.includes('*')) {
      aliases.push({ find: new RegExp(`^${pattern.replace('\\*', '(.*)')}$`), replacement: resolve(directory, stem.replace('*', '$1')) })
      continue
    }
    const source = [resolve(directory, stem), resolve(directory, stem.replace(/\.ts$/, '.tsx'))].find(existsSync)
    if (!source) throw new Error(`Current public source is missing: ${name}${entry}`)
    aliases.push({ find: new RegExp(`^${pattern}$`), replacement: source })
  }
  // Core's source adapter consumes the installed native SDK, declared as its build dependency.
  const dependencies = { ...manifest.dependencies, ...(name === 'core' ? { '@ctxmux/sdk': manifest.devDependencies['@ctxmux/sdk'] } : {}) }
  for (const [dependency, version] of Object.entries(dependencies) as [string, string][]) {
    if (dependency.startsWith('@agentmux/')) continue
    const installed = resolve(root, 'apps/desktop/node_modules/@agentmux', name, 'node_modules', dependency)
    const mapped = resolve(dependencyRepository, 'packages', name, 'node_modules', dependency)
    const cached = resolve(root, 'node_modules/.pnpm', `${dependency.replace('/', '+')}@${version}`, 'node_modules', dependency)
    const replacement = [installed, mapped, cached].find(existsSync)
    if (replacement && !aliases.some(alias => alias.find === dependency)) {
      aliases.push({ find: dependency, replacement: dependency, customResolver(specifier) {
        return this.resolve(specifier, resolve(replacement, 'package.json'), { skipSelf: true })
      } })
    }
  }
}
aliases.push(...['react', 'react-dom'].map(find => ({ find, replacement: resolve(root, 'apps/desktop/node_modules', find) })))

export default defineConfig({
  ...original, root, cacheDir: resolve(root, '.tmp/mote-context-vitest-cache'),
  esbuild: { jsx: 'automatic' },
  resolve: { alias: aliases, conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui'] },
  test: {
    ...original.test, globalSetup: [], passWithNoTests: false, maxWorkers: 1, fileParallelism: false,
    include: process.env.AGENTMUX_MOTE_CONTEXT_ADJACENT ? ['apps/desktop/test/desktop-focus-navigation.test.tsx']
      : ['apps/desktop/test/mote-context-preparation.test.tsx', 'apps/desktop/test/mote-navigation-context.test.tsx',
      'apps/desktop/test/mote-directory-short-birth.test.tsx', 'apps/desktop/test/mote-context-service-status.test.tsx'], testTimeout: 15000
  }
})
