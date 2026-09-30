import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../../../..')
const evidence = process.env.AGENTMUX_TOOLKIT_EVIDENCE ?? resolve(root, '.bagakit/design/toolkit-performance-20261004/evidence/direct')
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
const mutant = process.env.AGENTMUX_TOOLKIT_MUTANT ?? 'baseline'
const changes: Record<string, [string,string,string]> = {
  registration: ['apps/desktop/src/main/ipc.ts', '    toolkit,', '    toolkit: undefined,'],
  shared: ['apps/desktop/src/main/toolkit-owner.ts', 'if (this.execution?.ref && !this.execution.ended) return', 'if (false) return'],
  establish: ['apps/desktop/src/main/toolkit-owner.ts', 'if (!this.wanted() || execution.ended) return\n      const attached', 'if (false) return\n      const attached'],
  framing: ['apps/desktop/src/main/toolkit-owner.ts', 'if (execution.buffer.length) throw', 'if (false) throw'],
  release: ['apps/desktop/src/main/toolkit-owner.ts', 'await execution.port!.stop(execution.ref!)', 'void execution.ref'],
  dispatch: ['apps/desktop/src/main/runtime-controller.ts', 'if (toolkit && (event.type', 'if (false && (event.type'],
  remove: ['packages/core/src/ctxmux-run-adapter.ts', 'await this.requireClient().remove(runId)', 'void runId'],
  'terminal-kind': ['packages/core/src/client.ts', 'if (this.registry.findByRun(ref) || this.registry.isRetiredRun(ref)) {', 'if (false) {'],
  'terminal-metadata': ['packages/core/src/client.ts', 'this.endedRuns.delete(ref.runId)\n    this.stopRequestedRuns.delete(ref.runId)', 'void ref.runId'],
  'renderer-owner': ['apps/desktop/src/renderer/src/store.ts', "if (request.operation === 'toolkit.list' || request.operation === 'toolkit.get' ||\n        request.operation === 'toolkit.script' || request.operation === 'toolkit.run' ||\n        request.operation === 'toolkit.stop' || request.operation === 'toolkit.watch') {", 'if (false) {'],
  'packaged-path': ['apps/desktop/src/main/toolkit-asset.ts', "script: join(root, 'resources/toolkit/performance.mjs')", "script: join(root, 'toolkit/performance.mjs')"],
  utf8: ['packages/core/src/toolkit-control.ts', "new TextDecoder('utf-8', { fatal: true }).decode", "new TextDecoder('utf-8', { fatal: false }).decode"]
}
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, esbuild: { jsx: 'automatic' },
  cacheDir: resolve(evidence, 'cache'), resolve: { alias: aliases },
  plugins: [{ name: 'actual-performance-toolkit-source', enforce: 'pre', configResolved(config) {
    // Node SDK artifact URLs must keep Node semantics, not Vite browser asset lookup.
    const plugins = config.plugins as any[]
    const index = plugins.findIndex(value => value.name === 'vite:asset-import-meta-url')
    if (index >= 0) plugins.splice(index, 1)
  }, transform(input, id) {
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
  test: { include: ['apps/desktop/test/toolkit-owner.test.ts','apps/desktop/test/toolkit-renderer-routing.test.ts','apps/desktop/test/performance-toolkit-main.test.ts','packages/core/test/toolkit-control.test.ts','packages/core/test/client-terminal-remove.test.ts'],
    setupFiles: [resolve(root, 'vitest.setup.ts')], passWithNoTests: false, fileParallelism: false, maxWorkers: 1,
    testTimeout: 120_000 }
})
