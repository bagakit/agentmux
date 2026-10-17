import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import shared from './vitest.performance-reading.config.mts'

export const focusHistoryMutations = [
  { name: 'ordinary-tick-rescan', before: 'if (isActive && known.current.get(key)?.active) return', after: '', assertion: 'invalidates new exact Host identities and reopened sources without rescanning ordinary Session ticks' },
  { name: 'exact-lifecycle-host', before: 'JSON.stringify([event.hostId, id])', after: "JSON.stringify(['local', id])", assertion: 'invalidates new exact Host identities and reopened sources without rescanning ordinary Session ticks' },
  { name: 'pending-lifecycle-revision', before: '      readCatalogue()', after: '', assertion: 'drains a lifecycle invalidation received during the original catalogue read without overlapping reads' },
  { name: 'inactive-catalogue-demand', before: 'active.current = enabled && documentVisible', after: 'active.current = documentVisible', assertion: 'tracks lifecycle invalidation while disabled and ignores removal without an exact Session identity' },
  { name: 'late-catalogue-generation', before: 'const current = () => active.current && generation.current === episode', after: 'const current = () => true', assertion: 'coalesces hidden lifecycle changes and fences a hidden late catalogue before resuming its original owner' }
] as const
const selected = process.env.AGENTMUX_FOCUS_HISTORY_MUTATION
const mutation = focusHistoryMutations.find(item => item.name === selected)
if (selected && !mutation) throw Error('Unknown history mutation')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...shared, plugins: [...shared.plugins ?? [], { name: 'original-history-lifecycle-source', enforce: 'pre', transform(source, id) {
  const path = relative(process.cwd(), id.split('?')[0]!)
  if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/')) return
  let code = source
  if (mutation && path === 'apps/desktop/src/renderer/src/lib/focus-history-sources.ts') {
    if (code.split(mutation.before).length !== 2) throw Error('One exact lifecycle mutation anchor required')
    code = code.replace(mutation.before, mutation.after)
  }
  if (process.env.AGENTMUX_FOCUS_HISTORY_LOADED) appendFileSync(process.env.AGENTMUX_FOCUS_HISTORY_LOADED,
    JSON.stringify({ path, originalSHA256: hash(source), effectiveSHA256: hash(code) }) + '\n')
  if (code !== source) return { code, map: null }
} }], test: { ...shared.test, environment: 'happy-dom', maxWorkers: 1,
  include: ['apps/desktop/test/focus-history-catalog.test.tsx', 'apps/desktop/test/focus-history-lifecycle.test.tsx'], passWithNoTests: false } })
