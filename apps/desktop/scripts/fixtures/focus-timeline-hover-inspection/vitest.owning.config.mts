import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({
  ...base, root,
  cacheDir: resolve(root, '.tmp/focus-timeline-hover-inspection-cache'),
  plugins: [...(base.plugins ?? []), {
    name: 'actual-focus-hover-inspection', enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!
      if (!file.startsWith(`${root}/apps/desktop/src/`) || !/\.[cm]?[jt]sx?$/.test(file)) return
      const original = code, mutation = process.env.AGENTMUX_FOCUS_HOVER_MUTATION
      const changes: Record<string, [string, string, string]> = {
        'cancelled-intent-reopens': ['components/RecentFocusTimeline.tsx', 'clearTimeout(previewTimers.current.open); clearTimeout(previewTimers.current.close)', 'clearTimeout(previewTimers.current.close)'],
        'history-uses-current-project': ['components/RecentFocusTimeline.tsx', 'context ? lane?.labels[0] ?? context.workspaceName : identity?.project?.name', "context ? lane?.labels[0] ?? context.workspaceName : identity?.project?.name ?? 'Author project'"],
        'quick-renders-full-body': ['components/FocusMessagePreview.tsx', 'message ? !interactive ? <>', 'message ? false ? <>'],
        'resource-summary-empty': ['components/FocusMessagePreview.tsx', "message.content.trim() || (resources.length ? resources.join(' · ') : 'Input has no recorded text')", "message.content.trim() || 'Input has no recorded text'"]
      }
      if (mutation) {
        const change = changes[mutation]; if (!change) throw new Error(`Unknown hover mutation ${mutation}`)
        if (file === `${root}/apps/desktop/src/renderer/src/${change[0]}`) {
          if (code.split(change[1]).length !== 2) throw new Error(`Missing unique loaded hover mutation ${mutation}`)
          code = code.replace(change[1], change[2])
        }
      }
      const destination = process.env.AGENTMUX_FOCUS_HOVER_LOADED_SOURCE
      if (destination) appendFileSync(destination, JSON.stringify({ path: relative(root, file), originalSHA256: createHash('sha256').update(original).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), ...(code !== original ? { mutation } : {}) }) + '\n')
      if (code !== original) return { code, map: null }
    }
  }],
  test: { ...base.test, include: ['apps/desktop/test/focus-timeline-hover-inspection.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 15_000, hookTimeout: 30_000 }
})
