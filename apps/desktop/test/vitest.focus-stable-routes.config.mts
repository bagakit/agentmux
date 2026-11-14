import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'
import { relative } from 'node:path'
import { appendFileSync } from 'node:fs'
const mutants = {
  'live-reorder': ['apps/desktop/src/renderer/src/lib/use-focus-project-order.ts', 'route.current.revision !== arrangeRevision', 'true'],
  'ignore-pins': ['apps/desktop/src/renderer/src/lib/use-focus-project-order.ts', 'preferences.filter(item => item.pinned)', 'preferences.filter(() => false)'],
  'drop-notes': ['apps/desktop/src/renderer/src/components/FocusProjectPreferences.tsx', 'item.key === projectKey ? draft : item', "item.key === projectKey ? { ...draft, note: '' } : item"],
  'stale-save': ['apps/desktop/src/renderer/src/components/FocusProjectPreferences.tsx', 'if (generation.current !== token) return', 'if (false) return'],
  'never-compact': ['apps/desktop/src/renderer/src/components/FocusProjectLanes.tsx', 'const automaticallyCompact = Boolean(initialQuiet.current.get(lane.id))', 'const automaticallyCompact = false'],
  'quiet-refold': ['apps/desktop/src/renderer/src/components/FocusProjectLanes.tsx', '|| quietLanes && !quietLanes.has(lane.id))) initialQuiet.current.set(lane.id, false)', '|| quietLanes && !quietLanes.has(lane.id))) {}'],
  'future-visits': ['apps/desktop/src/renderer/src/lib/focus-attention.ts', 'entry.identity?.hostId && recorded(entry.focusedAt, now)', 'entry.identity?.hostId && Number.isFinite(entry.focusedAt) && entry.focusedAt > 0'],
  'hidden-summary-read': ['apps/desktop/src/renderer/src/components/FocusContextCardBody.tsx', 'active && context.access?.readConversation', 'context.access?.readConversation'],
  'hidden-first-body': ['apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx', 'visible={!compact && visible && documentActive}', 'visible={visible && documentActive}'],
  'drop-order': ['apps/desktop/src/renderer/src/components/FocusProjectLanes.tsx', 'projects: next', 'projects: original']
} as const
const selected = process.env.AGENTMUX_FOCUS_ROUTE_MUTANT as keyof typeof mutants | undefined
if (selected && !mutants[selected]) throw Error('Unknown Focus route mutation')
let applied = false
export default defineConfig({ ...source, cacheDir: '.tmp/focus-stable-routes-cache',
  plugins: [{ name: 'actual-focus-route-source', enforce: 'pre', transform(source, id) {
    const path = relative(process.cwd(), id.split('?')[0]!)
    if (process.env.AGENTMUX_FOCUS_ROUTE_LOADED && path.startsWith('apps/desktop/src/')) appendFileSync(process.env.AGENTMUX_FOCUS_ROUTE_LOADED, path + '\n')
    if (!selected || mutants[selected][0] !== path) return
    const [, before, after] = mutants[selected]
    if (source.split(before).length !== 2) throw Error('Unique actual route mutation anchor required')
    applied = true; process.stderr.write(`MUTATION_APPLIED=${selected}\n`)
    return { code: source.replace(before, after), map: null }
  }, buildEnd() { if (selected && !applied) throw Error('The actual route mutation was not loaded') } }],
  test: { ...source.test, environment: 'happy-dom', include: ['apps/desktop/test/focus-settings.test.tsx', 'apps/desktop/test/focus-stable-routes.test.tsx', 'apps/desktop/test/focus-project-preferences-races.test.tsx'], setupFiles: [], globalSetup: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 20000 }
})
