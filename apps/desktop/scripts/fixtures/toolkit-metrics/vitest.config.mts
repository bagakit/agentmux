import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../../../..')
const evidence = process.env.AGENTMUX_METRICS_EVIDENCE ?? resolve(root, ".bagakit/design/settings-followups-fixture/toolkit-metrics-evidence/direct")
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
  'get-finally': ['packages/core/src/public-rpc-service.ts', 'controller.abort(); sub.dispose() }', 'controller.abort(); /* injected missing get release */ }'],
  establish: ['packages/core/src/public-rpc-service.ts', 'cleanup = () => sub.dispose(); initial = { observation: await first }', 'cleanup = () => {}; initial = { observation: await first }'],
  identity: ['packages/core/src/public-rpc-client.ts', "if (response.id !== request.id) throw new AgentMuxError('RPC response ID does not match the request.', 'CONTROL_PROTOCOL_ERROR')", 'if (response.id !== request.id) response.id = request.id!'],
  age: ['apps/desktop/src/main/process-resource-sampler.ts', 'processObservedAt: unavailable ? this.latest?.processObservedAt ?? null : observedAt', 'processObservedAt: observedAt'],
  nullable: ['apps/desktop/src/renderer/src/lib/resource-owner-counts.ts', 'if (!getter) return null', 'if (!getter) return 0'],
  panel: ['apps/desktop/src/renderer/src/components/performance/PerformanceOverview.tsx', "observation.renderer.data.counts.monacoEditors ?? '—'", 'observation.renderer.data.counts.monacoEditors']
}
// A same-chunk cancellation is protected at every read of the current receive block.
// Withdraw that complete block; deleting one fence can be masked by another guard.
const clientPath = 'packages/core/src/public-rpc-client.ts'
const clientSource = readFileSync(resolve(root, clientPath), 'utf8')
const receiveStart = clientSource.indexOf('    const receive = (value: unknown) => {')
const receiveEnd = clientSource.indexOf('    const rpc = new JSONRPCClient(', receiveStart)
assert.ok(receiveStart >= 0 && receiveEnd > receiveStart, 'Actual public receive block must be nonempty')
const receiveBlock = clientSource.slice(receiveStart, receiveEnd)
assert.equal(receiveBlock.split('if (finished) return').length - 1, 4, 'All actual callback/receive cancellation fences must be present')
changes['callback-cancel'] = [clientPath, receiveBlock, receiveBlock.replaceAll('if (finished) return', '')]
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
