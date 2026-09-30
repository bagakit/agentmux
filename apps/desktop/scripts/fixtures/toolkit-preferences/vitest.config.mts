import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../../../..')
const evidence = process.env.AGENTMUX_TOOLKIT_PREFERENCES_EVIDENCE ?? resolve(root, '.bagakit/design/toolkit-performance-20261004/preferences/direct')
const require = createRequire(resolve(root, 'apps/desktop/package.json'))
const aliases: { find: RegExp; replacement: string }[] = []
for (const name of ['core','demand','layout']) {
  const dir = resolve(root, 'packages', name)
  const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
  for (const [key, value] of Object.entries(pkg.exports)) {
    const target = typeof value === 'string' ? value : (value as { import: string }).import
    const path = resolve(dir, target.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/u, '.ts'))
    assert.ok(readFileSync(path).length > 0, `Alias must own a nonempty current WT Source: ${path}`)
    aliases.push({ find: new RegExp(`^@agentmux/${name}${key === '.' ? '' : key.slice(1)}$`), replacement: path })
  }
}
for (const name of ['react','react/jsx-runtime','react/jsx-dev-runtime','react-dom/client']) aliases.push({ find: new RegExp(`^${name}$`), replacement: require.resolve(name) })
mkdirSync(evidence, { recursive: true })
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const mutant = process.env.AGENTMUX_TOOLKIT_PREFERENCES_MUTANT ?? 'baseline'
const changes: Record<string, [string, string, string]> = {
  composition: ['apps/desktop/src/main/settings/setting-catalog.ts', '  ...toolkitSettings', '  ...[]'],
  expectation: ['apps/desktop/src/renderer/src/components/settings/modules/toolkit.tsx', 'performance: expected', 'performance'],
  defaults: ['apps/desktop/src/shared/config-edit.ts', "  if (path === 'toolkit') return value ?? { performance: DEFAULT_PERFORMANCE_PREFERENCES }", "  if (path === 'toolkit') return value"]
}
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, esbuild: { jsx: 'automatic' },
  cacheDir: resolve(evidence, 'cache'), resolve: { alias: aliases },
  plugins: [{ name: 'actual-toolkit-metrics-source', enforce: 'pre', transform(input, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/') && !path.startsWith('apps/desktop/src/')) return
    let code = input
    const change = changes[mutant]
    if (change?.[0] === path) {
      assert.equal(code.split(change[1]).length - 1, 1, `Mutation anchor must exist exactly once in actual Source: ${path}`)
      code = code.replace(change[1], change[2])
    }
    appendFileSync(resolve(evidence, 'loaded-source.jsonl'), JSON.stringify({ path, originalSHA256: sha(input), consumedSHA256: sha(code), mutant, bytes: Buffer.byteLength(code) }) + '\n')
    if (code !== input) return { code, map: null }
  } }],
  test: { include: ['apps/desktop/test/toolkit-preferences-control.test.ts','apps/desktop/test/toolkit-preferences-draft.test.tsx'],
    setupFiles: [resolve(root, 'vitest.setup.ts')], passWithNoTests: false, fileParallelism: false, maxWorkers: 1,
    testTimeout: 12_000 }
})
