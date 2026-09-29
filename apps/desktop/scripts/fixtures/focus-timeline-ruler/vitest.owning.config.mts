import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({
  ...original, root,
  cacheDir: resolve(root, '.tmp/focus-timeline-ruler-cache'),
  plugins: [...(original.plugins ?? []), {
    name: 'actual-focus-ruler-source', enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!
      if (!file.startsWith(`${root}/apps/desktop/src/`) || !/\.[cm]?[jt]sx?$/.test(file)) return
      const before = code, mutation = process.env.AGENTMUX_FOCUS_RULER_MUTATION
      const changes: Record<string, [string, string, string]> = {
        'aligned-publication': ['lib/focus-timeline-ruler.ts', "if (preferences.mode === 'free')", 'if (true)'],
        'zone-fixed-offset': ['lib/focus-timeline-ruler.ts', 'const possible = focusDateCandidates(value, zone)', "const fixed = DateTime.fromISO(value, { zone: `UTC${first.offset < 0 ? '' : '+'}${first.offset / 60}` }); const possible = [{ instant: fixed.toMillis(), offset: fixed.offset }]"],
        'viewport-phase-reset': ['lib/focus-timeline-ruler.ts', 'const civilDay = day.toMillis() / MINUTE_MS', 'const civilDay = (day.toMillis() - DateTime.utc(first.year, first.month, first.day).toMillis()) / MINUTE_MS'],
        'preview-zone-gap': ['components/FocusMessagePreview.tsx', "const time = timeFormatters ?? createFocusTimeFormatters('system')", "const time = createFocusTimeFormatters('UTC')"],
        'date-zone-ignored': ['components/RecentFocusTimeline.tsx', 'const candidates = focusDateCandidates(value, time.zone)', "const candidates = focusDateCandidates(value, 'UTC')"],
        'system-zone-snapshot': ['components/RecentFocusTimeline.tsx', 'const displayedTimeZone = resolvedFocusTimeZone(ruler.timeZone)', 'const displayedTimeZone = useMemo(() => resolvedFocusTimeZone(ruler.timeZone), [ruler.timeZone])'],
        'preference-not-persisted': ['store.ts', 'focusTimelineRuler: state.focusTimelineRuler,', '']
      }
      if (mutation) {
        const change = changes[mutation]; if (!change) throw new Error(`Unknown ruler mutation ${mutation}`)
        if (file === `${root}/apps/desktop/src/renderer/src/${change[0]}`) {
          if (code.split(change[1]).length !== 2) throw new Error(`Missing unique loaded ruler mutation ${mutation}`)
          code = code.replace(change[1], change[2])
        }
      }
      const loaded = process.env.AGENTMUX_FOCUS_RULER_LOADED_SOURCE
      if (loaded) appendFileSync(loaded, JSON.stringify({ path: relative(root, file), originalSHA256: createHash('sha256').update(before).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), ...(code !== before ? { mutation } : {}) }) + '\n')
      if (code !== before) return { code, map: null }
    }
  }],
  test: { ...original.test, include: ['apps/desktop/test/focus-timeline-ruler-modes.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 20_000, hookTimeout: 30_000 }
})
