import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
export default defineConfig({ ...original,
  plugins: [...(original.plugins ?? []), { name: 'focus-timeline-order-loaded-source', enforce: 'pre', transform(code, id) {
    const root = resolve(import.meta.dirname, '../../../../..'), file = id.split('?')[0]!
    if (!file.startsWith(`${root}/apps/desktop/src/renderer/src/`) || !/\.[cm]?[jt]sx?$/u.test(file)) return
    const originalCode = code, mutation = process.env.AGENTMUX_FOCUS_ORDER_MUTATION
    if (mutation && file.endsWith('/lib/focus-history-timeline.ts')) {
      const changes: Record<string, [string, string]> = {
        'window-order': ['return [...projects].sort((a, b) => compareRank(order.projects, a, b)).map(project => ({ ...project,', 'return [...projects].map(project => ({ ...project,'],
        'name-order': ['[...project.tracks].sort(compareName)', '[...project.tracks]'],
        'activity-reorder': ['const fresh = createFocusTimelineOrder(candidates)', 'return createFocusTimelineOrder(candidates)\n  const fresh = createFocusTimelineOrder(candidates)']
      }
      const change = changes[mutation]; if (!change) throw new Error(`Unknown order mutation ${mutation}`)
      if (code.split(change[0]).length !== 2) throw new Error(`Missing unique actual Source mutation ${mutation}`)
      code = code.replace(change[0], change[1])
    }
    const output = process.env.AGENTMUX_FOCUS_ORDER_LOADED_SOURCE
    if (output) appendFileSync(output, `${JSON.stringify({ path: relative(root, file), originalSHA256: createHash('sha256').update(originalCode).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), ...(code !== originalCode ? { mutation } : {}) })}\n`)
    if (code !== originalCode) return { code, map: null }
  } }],
  cacheDir: resolve(import.meta.dirname, '../../../../../.tmp/focus-timeline-order-cache'),
  test: { ...original.test, include: ['apps/desktop/test/focus-timeline-order-stability.test.tsx'], passWithNoTests: false, fileParallelism: false, testTimeout: 15_000 }
})
