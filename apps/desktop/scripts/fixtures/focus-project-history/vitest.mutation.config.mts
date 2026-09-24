import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import owning from './vitest.owning.config.mts'

// Mutate the actually loaded production module, leaving the concurrent source tree untouched.
const variants = {
  'window-filter': { file: '/components/RecentFocusTimeline.tsx', from: 'focusTimeSegments(entries, range, now)', to: 'focusTimeSegments(entries, { ...range, start: 0 }, now)' },
  'current-members': { file: '/lib/agent-focus.ts', from: 'history: context.execution.history', to: 'history: context.execution.history.filter(entry => byId.has(entry.sessionId))' },
  'historical-owner': { file: '/lib/focus-history-timeline.ts', from: 'const track = ensure(id, visit.identity)', to: 'const track = ensure(id, undefined)' },
  'presence-cost': { file: '/components/RecentFocusTimeline.tsx', from: '    if (visible) present.current.add(key); else present.current.delete(key)', to: '    present.current = new Set(present.current); if (visible) present.current.add(key); else present.current.delete(key)' }
} as const
const name = process.env.AGENTMUX_FOCUS_HISTORY_MUTATION as keyof typeof variants
if (!Object.hasOwn(variants, name)) throw new Error('Select one known Focus history loaded mutation.')
const variant = variants[name]
let transformed = false
export default defineConfig({
  ...owning,
  cacheDir: resolve(import.meta.dirname, `../../../../../.tmp/focus-project-history-cache/${name}`),
  plugins: [{ name: 'focus-history-loaded-counterexample', enforce: 'pre', transform(source, id) {
    if (!id.split('?')[0]!.endsWith(variant.file)) return
    if (!source.includes(variant.from)) throw new Error(`Mutation ${name} did not find its production source anchor.`)
    transformed = true
    return source.replace(variant.from, variant.to)
  }, buildEnd() { if (!transformed) throw new Error(`Mutation ${name} production module was not loaded.`) } }]
})
