import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import base from './vitest.mote-context.config.mts'
const reader = 'apps/desktop/src/renderer/src/lib/use-space-mount-reader.ts'
const mutations: Record<string, [string, string, string]> = {
  'no-reconnect': [reader, '      generation++\n      if (failed.size) reopen()', '      return'],
  'wrong-host': ['apps/desktop/src/renderer/src/lib/session-events.ts', '? [...semantic, ...(observations.get(event.hostId) ?? [])]\n      : semantic', '? [...semantic, ...[...observations.values()].flatMap(readers => [...readers])]\n      : semantic'],
  'forget-early-recovery': [reader, "if (generation > (kind === 'space' ? spaceGeneration : sessionsGeneration)) reopen()", 'if (false) reopen()'],
  'refresh-healthy': [reader, 'if (failed.size) reopen()', 'reopen()'],
  'clear-error-on-begin': ['apps/desktop/src/renderer/src/lib/space-mount-sessions.ts', 'if (update.begin) return { ...before, members: {}, reading: true }', 'if (update.begin) return { ...before, members: {}, reading: true, error: undefined }']
}
const mutation = process.env.AGENTMUX_SOURCE_CONNECTION_MUTATION
if (mutation) assert.ok(mutations[mutation], 'Known source connection mutation')
export default defineConfig({ ...base, cacheDir: resolve(base.root!, '.tmp/source-connection-vitest-' + (mutation ?? 'baseline')),
  plugins: [{ name: 'source-connection-loaded-proof', enforce: 'pre', transform(original, id) {
    const path = relative(base.root!, id.split('?')[0]!)
    if (![reader, ...Object.values(mutations).map(([path]) => path)].includes(path)) return
    let code = original
    if (mutation && mutations[mutation]![0] === path) {
      const [, from, to] = mutations[mutation]!
      assert.equal(code.split(from).length - 1, 1, 'Unique current production anchor')
      code = code.replace(from, to)
    }
    if (process.env.AGENTMUX_SOURCE_CONNECTION_LOADED) appendFileSync(process.env.AGENTMUX_SOURCE_CONNECTION_LOADED, JSON.stringify({ path, originalSHA256: createHash('sha256').update(original).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex'), mutation: code === original ? null : mutation }) + '\n')
    if (code !== original) return { code, map: null }
  } }],
  test: { ...base.test, include: ['apps/desktop/test/ordinary-space-readers.test.tsx', 'apps/desktop/test/focus-source-recovery.test.tsx'], setupFiles: [], globalSetup: [], passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 20000 }
})
