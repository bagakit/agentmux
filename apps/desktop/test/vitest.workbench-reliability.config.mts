import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './vitest.workbench-user-storage.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_RELIABILITY_MUTATION
const edits: Record<string, [string, string, string]> = {
  'late-admission': ['apps/desktop/src/main/workbench-user-state.ts', 'request.writeRevision < this.rendererRevision', 'false'],
  'retry-disabled': ['apps/desktop/src/renderer/src/lib/persisted-ui-writer.ts', 'schedule(Math.min(120_000, 1000 * 2 ** Math.min(failures - 1, 7)))', 'void 0'],
  'late-ack': ['apps/desktop/src/renderer/src/lib/persisted-ui-writer.ts', 'generation === attempt && pending.get(name) === value', 'true'],
  'fenced-quit': ['apps/desktop/src/renderer/src/store.ts', 'rootAuthoredRevision > rootConfirmedAuthoredRevision || auxiliaryUserDataPending()', 'auxiliaryUserDataPending()'],
  'bootstrap-pending': ['apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts', 'this.startup ??= { baseline: graph, graph };\n    this.markPending();', 'this.startup ??= { baseline: graph, graph };'],
  'checkpoints-serial': ['apps/desktop/src/renderer/src/store/storage-checkpoint.ts', 'steps.map(step => Promise.resolve().then(step))', 'steps.map((step, index) => Promise.all(steps.slice(0, index).map(previous => previous())).then(step))'],
  'window-quit': ['apps/desktop/src/main/workbench-windows.ts', "if (!await this.persistWindows()) throw new Error('The original window arrangement is not yet durable. Current windows are retained; retry saving before Quit.')", 'await this.persistWindows()'],
  'window-directory-ack': ['apps/desktop/src/main/workbench-window-store.ts', ', { requireDirectorySync: true }', '']
}
if (mutation && !edits[mutation]) throw Error('Unknown reliability mutation')
export default defineConfig({ ...base, cacheDir: resolve(root, '.tmp/workbench-reliability'),
  plugins: [...base.plugins ?? [], { name: 'reliability-source-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!), item = mutation && edits[mutation]
    let code = source
    if (item && path === item[0]) {
      if (!source.includes(item[1])) throw Error('Missing reliability mutation owner anchor: ' + mutation)
      code = source.replaceAll(item[1], item[2])
    }
    const output = process.env.AGENTMUX_RELIABILITY_LOADED
    if (output && (path.startsWith('apps/desktop/src/') || path.startsWith('packages/'))) appendFileSync(output,
      JSON.stringify({ path, absolutePath: id.split('?')[0], diskSHA256: createHash('sha256').update(readFileSync(id.split('?')[0]!)).digest('hex'), originalSHA256: createHash('sha256').update(source).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), mutation: code === source ? null : mutation }) + '\n')
    return source === code ? undefined : { code, map: null }
  } }],
  test: { ...base.test, include: process.env.AGENTMUX_RELIABILITY_SLICE === 'spatial-window'
    ? ['apps/desktop/test/workbench-reliability-spatial-window.test.ts', 'apps/desktop/test/workbench-window-store.test.ts', 'apps/desktop/test/workbench-windows.test.ts', 'apps/desktop/test/desktop-spatial-latest-intent.test.ts']
    : ['apps/desktop/test/workbench-reliability-input.test.ts', 'apps/desktop/test/workbench-user-state-consumer.test.ts'],
    testTimeout: 20000, passWithNoTests: false }
})
