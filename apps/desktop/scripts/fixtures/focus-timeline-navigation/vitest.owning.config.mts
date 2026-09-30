import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
export default defineConfig({
  ...original,
  plugins: [...(original.plugins ?? []), {
    name: 'focus-timeline-navigation-loaded-source', enforce: 'pre',
    transform(code, id) {
      const root = resolve(import.meta.dirname, '../../../../..'), file = id.split('?')[0]!
      if (!file.startsWith(`${root}/apps/desktop/src/renderer/src/`) || !/\.[cm]?[jt]sx?$/u.test(file)) return
      const originalCode = code, mutation = process.env.AGENTMUX_FOCUS_NAVIGATION_MUTATION
      const changes: Record<string, [string, string]> = {
        'wheel-disconnected': ["viewport.addEventListener('wheel', wheel, { passive: false })", 'void wheel'],
        'blank-wheel-disconnected': ['if (!namedTimeTarget && !blankTimeTarget) return', 'if (!namedTimeTarget) return'],
        'zoom-disconnected': ['onClick={() => setHours(FOCUS_WINDOW_HOURS[zoomIndex - 1]!)}', 'onClick={() => {}}'],
        'viewport-reread': ["historical ? 'snapshot' : 'latest', readonlyReading]", "historical ? 'snapshot' : 'latest', readonlyReading, anchor, hours]"]
      }
      if (mutation === 'old-four-levels' && file.endsWith('/lib/focus-time-window.ts')) {
        const needle = 'export const FOCUS_WINDOW_HOURS = [0.5, 1, 2, 4, 6, 8, 12, 18, 24, 36, 48] as const'
        if (code.split(needle).length !== 2) throw new Error('Missing unique eleven-level navigation mutation')
        code = code.replace(needle, 'export const FOCUS_WINDOW_HOURS = [1, 4, 12, 24] as const')
      } else if (mutation && mutation !== 'old-four-levels' && file.endsWith('/components/RecentFocusTimeline.tsx')) {
        const change = changes[mutation]; if (!change) throw new Error(`Unknown navigation mutation ${mutation}`)
        if (code.split(change[0]).length !== 2) throw new Error(`Missing unique navigation mutation ${mutation}`)
        code = code.replace(change[0], change[1])
      }
      const destination = process.env.AGENTMUX_FOCUS_NAVIGATION_LOADED_SOURCE
      if (destination) appendFileSync(destination, `${JSON.stringify({ path: relative(root, file), originalSHA256: createHash('sha256').update(originalCode).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), ...(code !== originalCode ? { mutation } : {}) })}\n`)
      if (code !== originalCode) return { code, map: null }
    }
  }],
  cacheDir: resolve(import.meta.dirname, '../../../../../.tmp/focus-timeline-navigation-cache'),
  test: { ...original.test, include: ['apps/desktop/test/focus-timeline-navigation.test.tsx'], passWithNoTests: false, fileParallelism: false, testTimeout: 15_000 }
})
