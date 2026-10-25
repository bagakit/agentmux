import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.TERMINAL_MOUSE_MUTATION
const changes: Record<string, [string, string, string]> = {
  pause: ['apps/desktop/src/main/ipc.ts', ' && !isTerminalMouseReportPayload(data)', ''],
  mixed: ['packages/core/src/terminal-input-protocol.ts', 'while (offset < data.length) {', 'while (offset < data.length) { if (offset > 0) return true;']
}
if (mutation && !changes[mutation]) throw Error('Unknown terminal mouse mutation')
const qualified = new Set(['apps/desktop/src/main/ipc.ts', 'packages/core/src/terminal-input-protocol.ts',
  'packages/core/src/client.ts', 'packages/core/src/index.ts', 'apps/desktop/src/preload/index.ts',
  'apps/desktop/test/terminal-mouse-pause.test.ts'])
export default defineConfig({ ...source, cacheDir: resolve(root, '.cache/terminal-mouse-pause', mutation ?? 'baseline'),
  plugins: [...(source.plugins ?? []), { name: 'terminal-mouse-loaded-source', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!qualified.has(path)) return
    let code = original
    const change = mutation && changes[mutation]
    if (change && change[0] === path) {
      if (code.split(change[1]).length !== 2) throw Error('Mutation must match the original mouse consumer exactly once')
      code = code.replace(change[1], change[2])
    }
    const report = process.env.TERMINAL_MOUSE_LOADED
    if (!report) return code === original ? undefined : { code, map: null }
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    const row = { path, originalSHA256: sha(original), loadedSHA256: sha(code), ...(code === original ? {} : { mutation }) }
    return { code: "import { appendFileSync as __mouseLoaded } from 'node:fs'; __mouseLoaded(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + code, map: null }
  } }], test: { ...source.test, include: ['apps/desktop/test/terminal-mouse-pause.test.ts',
    'packages/core/test/client-input-cancellation-cause.test.ts', 'packages/core/test/agent-semantic-state-entry.test.ts'],
    setupFiles: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
})
