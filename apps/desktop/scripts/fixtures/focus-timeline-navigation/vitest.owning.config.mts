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
        'zoom-disconnected': ['onClick={() => setHours(FOCUS_WINDOW_HOURS[zoomIndex - 1]!)}', 'onClick={() => {}}'],
        'viewport-reread': ["historical ? 'snapshot' : 'latest', readonlyReading]", "historical ? 'snapshot' : 'latest', readonlyReading, anchor, hours]"]
      }
      if (mutation && file.endsWith('/components/RecentFocusTimeline.tsx')) {
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
