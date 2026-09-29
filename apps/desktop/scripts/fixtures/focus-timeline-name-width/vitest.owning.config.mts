import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
export default defineConfig({
  ...original,
  plugins: [...(original.plugins ?? []), {
    name: 'focus-name-width-loaded-source', enforce: 'pre',
    transform(code, id) {
      const root = resolve(import.meta.dirname, '../../../../..'), file = id.split('?')[0]!
      if (!file.startsWith(`${root}/apps/desktop/src/renderer/src/`) || !/\.[cm]?[jt]sx?$/u.test(file)) return
      const originalCode = code, mutation = process.env.AGENTMUX_FOCUS_NAME_WIDTH_MUTATION
      const changes: Record<string, { path: string; before: string; after: string }> = {
        'resize-disconnected': { path: '/components/RecentFocusTimeline.tsx', before: 'if (event.button === 0) nameResize.onResizeStart(event)', after: 'if (event.button === 0) void nameResize' },
        'persistence-disconnected': { path: '/store.ts', before: '    focusTimelineNameWidth: state.focusTimelineNameWidth,', after: '' },
        'geometry-saves-preference': { path: '/components/RecentFocusTimeline.tsx', before: 'if (available > 0) setNameMaximum(', after: 'if (available > 0) saveNameWidth(' },
        'draft-rereads': { path: '/components/RecentFocusTimeline.tsx', before: "historical ? 'snapshot' : 'latest', readonlyReading]", after: "historical ? 'snapshot' : 'latest', readonlyReading, savedNameWidth]" }
      }
      if (mutation) {
        const change = changes[mutation]; if (!change) throw new Error(`Unknown width mutation ${mutation}`)
        if (file.endsWith(change.path)) {
          if (code.split(change.before).length !== 2) throw new Error(`Missing unique width mutation ${mutation}`)
          code = code.replace(change.before, change.after)
        }
      }
      const destination = process.env.AGENTMUX_FOCUS_NAME_WIDTH_LOADED_SOURCE
      if (destination) appendFileSync(destination, `${JSON.stringify({ path: relative(root, file), originalSHA256: createHash('sha256').update(originalCode).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), ...(code !== originalCode ? { mutation } : {}) })}\n`)
      if (code !== originalCode) return { code, map: null }
    }
  }],
  cacheDir: resolve(import.meta.dirname, '../../../../../.tmp/focus-timeline-name-width-cache'),
  test: { ...original.test, include: ['apps/desktop/test/focus-timeline-name-width.test.tsx'], passWithNoTests: false, fileParallelism: false, testTimeout: 15_000 }
})
