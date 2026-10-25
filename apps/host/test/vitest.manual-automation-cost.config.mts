import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.continuous-progress-manual-check.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.MANUAL_AUTOMATION_MUTATION
const mutations: Record<string, [string, string, string]> = {
  lookup: ['packages/core/src/continuous-progress-scheduler.ts',
    '? [...(indexed ?? [])].sort((a, b) => a[1] - b[1]).map(([id]) => this.loops.get(id)!)', '? [...this.loops.values()]'],
  batch: ['apps/host/src/continuous-progress-loop-manager.ts',
    'if (pending.length) [persistence] = await Promise.allSettled([this.saveLoops()])',
    'if (pending.length) [persistence] = await Promise.allSettled([Promise.all(pending.map(() => this.saveLoops())).then(() => undefined)])'],
  cancel: ['apps/host/src/continuous-progress-loop-manager.ts',
    'for (const loop of this.list(target)) this.cancelDelivery(loop.loopId)', 'void target']
}
if (mutation && !mutations[mutation]) throw Error('Unknown manual automation mutation')
const qualified = new Set(['packages/core/src/continuous-progress-scheduler.ts', 'apps/host/src/continuous-progress-loop-manager.ts',
  'apps/host/src/goal-automation-pause.ts', 'apps/host/src/continuous-progress-loop-store.ts', 'apps/host/test/manual-automation-cost.test.ts'])
export default defineConfig({ ...source, cacheDir: resolve(root, '.cache/manual-automation-input', mutation ?? 'baseline'),
  plugins: [...(source.plugins ?? []), { name: 'manual-automation-loaded-source', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!qualified.has(path)) return
    let code = original
    const change = mutation && mutations[mutation]
    if (change && change[0] === path) {
      if (code.split(change[1]).length !== 2) throw Error('Manual automation mutation must match the original owner exactly once')
      code = code.replace(change[1], change[2])
    }
    const report = process.env.MANUAL_AUTOMATION_LOADED
    if (!report) return code === original ? undefined : { code, map: null }
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    const row = { path, originalSHA256: sha(original), loadedSHA256: sha(code), ...(code === original ? {} : { mutation }) }
    return { code: "import { appendFileSync as __manualLoaded } from 'node:fs'; __manualLoaded(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + code, map: null }
  } }], test: { ...source.test, include: ['apps/host/test/manual-automation-cost.test.ts', 'apps/host/test/agent-automation-boundaries.test.ts'], maxWorkers: 1, passWithNoTests: false }
})
