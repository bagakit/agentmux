import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import shared from './vitest.collaboration-canvas.config.mts'

const selected = process.env.AGENTMUX_COLLABORATION_LABEL_COST_MUTATION
if (selected && !['sort-search-frontier', 'discard-better-cell', 'revisit-tested-cell'].includes(selected)) throw Error('Unknown label search cost mutation')
const hash = (source: string) => createHash('sha256').update(source).digest('hex')
let loaded = false
export default defineConfig({ ...shared, cacheDir: '.cache/collaboration-labels-cost', plugins: [...shared.plugins ?? [], {
  name: 'actual-label-search-cost', enforce: 'pre', transform(source, id) {
    if (!id.split('?')[0]!.endsWith('/src/renderer/src/components/CollaborationRegionLabels.tsx')) return
    let code = source
    const replace = (before: string, after: string) => {
      if (code.split(before).length !== 2) throw Error('Exactly one original label search cost anchor required: ' + before)
      code = code.replace(before, after)
    }
    if (selected === 'sort-search-frontier') replace('for (const point of pending.values()) if (!next || compareLabelSearchPoints(point, next) < 0) next = point',
      'next = [...pending.values()].sort(compareLabelSearchPoints)[0]')
    if (selected === 'discard-better-cell') replace('if (!old || compareLabelSearchPoints(point, old) < 0)', 'if (!old)')
    if (selected === 'revisit-tested-cell') replace('if (seen.has(key)) return', 'if (false) return')
    // Observe actual priority work, queue sizes and tested cells. No scheduling,
    // coordinate, priority or product state is replaced by this instrumentation.
    replace('function compareLabelSearchPoints(a: LabelSearchPoint, b: LabelSearchPoint) { return',
      'function compareLabelSearchPoints(a: LabelSearchPoint, b: LabelSearchPoint) { if (globalThis.__labelSearchCost) globalThis.__labelSearchCost.comparisons++; return')
    replace('const pending = new Map<string, LabelSearchPoint>(), seen = new Set<string>()',
      'const pending = new Map<string, LabelSearchPoint>(), seen = new Set<string>(); const observedSearch = globalThis.__labelSearchCost && { id: candidate.data.area.id, cells: new Set<string>(), attempts: 0, events: [] }; if (observedSearch) globalThis.__labelSearchCost.searches.push(observedSearch)')
    replace('const old = pending.get(key)', 'const old = pending.get(key); if (observedSearch) observedSearch.events.push({ offer: point }); if (old && globalThis.__labelSearchCost) globalThis.__labelSearchCost.mergeBudget++')
    replace('let next: LabelSearchPoint | undefined', 'if (globalThis.__labelSearchCost) globalThis.__labelSearchCost.selectionBudget += pending.size - 1; let next: LabelSearchPoint | undefined')
    replace('pending.delete(key); seen.add(key)', 'pending.delete(key); seen.add(key); if (observedSearch) { observedSearch.attempts++; observedSearch.cells.add(key); observedSearch.events.push({ picked: next }) }')
    loaded = true
    if (process.env.AGENTMUX_COLLABORATION_LABEL_COST_LOADED) appendFileSync(process.env.AGENTMUX_COLLABORATION_LABEL_COST_LOADED,
      JSON.stringify({ path: id.split('?')[0], originalSHA256: hash(source), effectiveSHA256: hash(code), mutation: selected ?? null, instrumentation: 'Priority comparison count, current finite queue comparison budget and actual tested cell census only.' }) + '\n')
    return { code, map: null }
  }, buildEnd() { if (!loaded) throw Error('The original label search consumer must execute') }
}], test: { ...shared.test, include: ['apps/desktop/test/collaboration-labels-cost.test.tsx'], passWithNoTests: false } })
