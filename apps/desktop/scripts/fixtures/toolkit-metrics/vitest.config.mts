import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../../../..')
const evidence = process.env.AGENTMUX_METRICS_EVIDENCE ?? resolve(root, '.bagakit/design/settings-followups-20261004/toolkit-metrics-evidence/direct')
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
const mutant = process.env.AGENTMUX_METRICS_MUTANT ?? 'baseline'
const changes: Record<string, [string, string, string]> = {
  registration: ['apps/desktop/src/main/ipc.ts', '    metrics,', '    metrics: undefined,'],
  shared: ['apps/desktop/src/main/resource-usage-control.ts', 'args.sampler.subscribe(sample', 'globalThis.__metricsMutantSampler.subscribe(sample'],
  'get-finally': ['packages/core/src/control-host.ts', '} finally { dispose() }', '} finally { /* injected missing get release */ }'],
  establish: ['packages/core/src/control-host.ts', 'if (closed || controller.signal.aborted) { try { value.dispose() }', 'if (closed || controller.signal.aborted) { try { void value }'],
  identity: ['packages/core/src/control-host.ts', 'raw.requestId !== request.requestId', 'false'],
  'callback-cancel': ['packages/core/src/control-host.ts', 'handlers.onFrame(frame)\n          if (closed) return', 'handlers.onFrame(frame)'],
  age: ['apps/desktop/src/main/process-resource-sampler.ts', 'processObservedAt: unavailable ? this.latest?.processObservedAt ?? null : observedAt', 'processObservedAt: observedAt'],
  nullable: ['apps/desktop/src/renderer/src/lib/resource-owner-counts.ts', 'if (!getter) return null', 'if (!getter) return 0'],
  panel: ['apps/desktop/src/renderer/src/components/ResourceUsagePanel.tsx', "rendererOwners.monacoEditors ?? '—'", 'rendererOwners.monacoEditors']
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
  test: { include: ['packages/core/test/metrics-control-host.test.ts','packages/core/test/metrics-cli.test.ts',
    'apps/desktop/test/metrics-main-control.test.ts','apps/desktop/test/resource-owner-counts.test.ts',
    'apps/desktop/test/resource-usage-observability.test.tsx'],
    setupFiles: [resolve(root, 'vitest.setup.ts')], passWithNoTests: false, fileParallelism: false, maxWorkers: 1,
    testTimeout: 12_000 }
})
