import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import shared from '../workbench-identity/vitest.owning.config.mts'

const root = resolve(import.meta.dirname, '../../../../..')
const mutations = {
  selection: ['apps/desktop/src/renderer/src/store.ts', '  setSelectedDemand(id) {\n    set({ selectedDemandId: id })', `  setSelectedDemand(id) {
    const state = get(), demand = id ? state.demands[id] : undefined
    const candidate = demand && workbenchSelectionCatalog(state).locations.find(location => {
      const surface = state.tabs[location.tabId]?.regions[location.regionId]
      return surface && isSessionSurface(surface) && demand.sessionIds.includes(surface.sessionId)
    })
    if (candidate) get().selectMainRegion(candidate, state.workbenchSpaceSelection)
    set({ selectedDemandId: id })`],
  reentry: ['apps/desktop/src/renderer/src/store.ts', '    set({ mainSurface, workbenchNavigationInputPolicy: null, regionCaretFocus: null,', `    const surface = choice?.tabId && choice.regionId ? state.tabs[choice.tabId]?.regions[choice.regionId] : undefined
    const linked = surface && isSessionSurface(surface) ? Object.values(state.demands).filter(demand => demand.sessionIds.includes(surface.sessionId)) : []
    if (mainSurface === 'board' && linked.length === 1) set({ selectedDemandId: linked[0]!.id })
    set({ mainSurface, workbenchNavigationInputPolicy: null, regionCaretFocus: null,`]
} as const
export default defineConfig({ ...shared, cacheDir: resolve(root, '.tmp/focus-goal-access/vitest-cache'),
  plugins: [...shared.plugins ?? [], { name: 'original-focus-goal-consumer', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/core/src/')) return
    const mutation = process.env.AGENTMUX_GOAL_MUTATION as keyof typeof mutations | undefined
    let served = code
    if (mutation && mutations[mutation]?.[0] === path) {
      const [, needle, replacement] = mutations[mutation]
      if (code.split(needle).length !== 2) throw new Error('Mutation must match the actual original consumer exactly once: ' + mutation)
      served = code.replace(needle, replacement)
    }
    if (process.env.AGENTMUX_GOAL_LOADED) appendFileSync(process.env.AGENTMUX_GOAL_LOADED, JSON.stringify({ path,
      sourceSha256: createHash('sha256').update(code).digest('hex'), servedSha256: createHash('sha256').update(served).digest('hex'), mutated: served !== code }) + '\n')
    return served !== code ? { code: served, map: null } : undefined
  } }],
  test: { ...shared.test, include: ['apps/desktop/test/desktop-focus-navigation.test.tsx'], passWithNoTests: false }
})
