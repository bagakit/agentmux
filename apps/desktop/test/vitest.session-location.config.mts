import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vitest/config'
import source from '../scripts/fixtures/settings-overview/vitest.config.mts'

const mutation = process.env.AGENTMUX_SESSION_LOCATION_MUTATION
const changes: Record<string, { suffix: string; before: string; after: string }> = {
  'stale-location-creates-view': { suffix: '/store.ts',
    before: "if (options?.reference) return fail('This location no longer contains the original Session. Its existing work is kept; no new view was created.')",
    after: '/* mutation: stale exact target falls through to ordinary creation */' },
  'old-request-can-choose': { suffix: '/store.ts',
    before: 'if (request?.requestId !== requestId) return false', after: 'if (!request) return false' },
  'wrong-session-location': { suffix: '/lib/desktop-focus-navigation.ts',
    before: 'surface.sessionId !== sessionId || groupId', after: 'false || groupId' },
  'silent-highlight-retarget': { suffix: '/components/QuickSwitcher.tsx',
    before: 'results.findIndex(item => item.id === activeLocationId) : activeIndex',
    after: 'Math.max(0, results.findIndex(item => item.id === activeLocationId)) : activeIndex' }
}
if (mutation && !changes[mutation]) throw Error('Unknown Session location mutation')
export default defineConfig({ ...source, plugins: mutation ? [{ name: 'loaded-session-location-mutation', enforce: 'pre', transform(code, id) {
  const change = changes[mutation]!
  if (!id.endsWith(change.suffix)) return
  if (code.split(change.before).length !== 2) throw Error('Exact mutation boundary absent: ' + mutation)
  const updated = code.replace(change.before, change.after)
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  if (process.env.AGENTMUX_SESSION_LOCATION_LOADED) appendFileSync(process.env.AGENTMUX_SESSION_LOCATION_LOADED, JSON.stringify({ id, mutation, original: hash(code), changed: hash(updated) }) + '\n')
  return updated
} }] : [], test: { ...source.test, passWithNoTests: false, include: [
  'apps/desktop/test/session-projection-navigation.test.tsx',
  'apps/desktop/test/quick-switch-demand.test.tsx',
  'apps/desktop/test/quick-switch.test.ts'
] } })
