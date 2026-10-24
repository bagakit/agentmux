import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import source from './vitest.mote-context.config.mts'

const targets = [
  'apps/desktop/src/renderer/src/components/FocusFilters.tsx',
  'apps/desktop/src/renderer/src/lib/focus-filters.ts',
  'apps/desktop/src/renderer/src/lib/focus-lane-origin.ts',
  'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx',
  'apps/desktop/src/renderer/src/lib/focus-context.ts',
  'apps/desktop/src/renderer/src/components/FocusContextCardBody.tsx'
]
const mutations: Record<string, [string, string, string]> = {
  'drop-types': [targets[1]!, 'return selected.length === 0 || selected.some(type => types.includes(type))', 'return true'],
  'drop-state': [targets[1]!, 'return states.length === 0 || states.some(', 'return true || states.some('],
  'drop-project': [targets[1]!, 'return selected.length === 0 || selected.some(project => project.id === key)', 'return true'],
  'remove-survey': [targets[2]!, "types.push('survey')", "types.push('unknown')"],
  'close-multi-select': [targets[0]!, 'onSelect={event => event.preventDefault()}', 'onSelect={() => {}}'],
  'forget-unavailable': [targets[0]!, '...value.projects.filter(option => !known.has(option.id)).map(', '...[].map('],
  'drop-coordination': [targets[3]!, 'const coordinationResults = filtering ? matched.filter(row => !executionIds.has(row.id)) : []', 'const coordinationResults = []'],
  'read-coordination-body': [targets[4]!, 'agentContextWithConversation(session, undefined, name, workspace, topicId, focusConversationFacts(undefined))', 'agentContextForSession(session, timeline, name, workspace, topicId)'],
  'recap-read': [targets[5]!, 'if (!summary || context.recap !== undefined) return', 'if (!summary) return'],
  'wrong-mote-scope': [targets[3]!, "if (!topicId || focusLaneForSession(topicId, scratchTopicsForWorkspace(current.scratchTopicSnapshots, workspace)) !== 'pmo') {", 'if (!topicId) {'],
  'duplicate-state-actions': [targets[0]!, '        <Menu.Item className="tab-context-menu__item" onSelect={() => { onChange(EMPTY_FOCUS_FILTERS); onClear() }}>Clear filters</Menu.Item>', `        <div><Menu.Item onSelect={() => onChange({ ...value, states: ['attention'] })}>Needs you</Menu.Item><Menu.Item onSelect={() => onChange({ ...value, states: ['results'] })}>Results</Menu.Item></div>
        <Menu.Item className="tab-context-menu__item" onSelect={() => { onChange(EMPTY_FOCUS_FILTERS); onClear() }}>Clear filters</Menu.Item>`]
}
export default defineConfig({
  ...source,
  cacheDir: resolve(source.root!, '.tmp/focus-composable-filters-cache-' + (process.env.AGENTMUX_FOCUS_COMPOSABLE_MUTANT ?? 'baseline')),
  plugins: [{ name: 'loaded-focus-composable-implementation', enforce: 'pre', transform(original, id) {
    const path = relative(source.root!, id.split('?')[0]!)
    if (!targets.includes(path) && !path.endsWith('/App.tsx')) return
    let code = original
    const mutant = process.env.AGENTMUX_FOCUS_COMPOSABLE_MUTANT
    if (mutant) {
      assert.ok(mutations[mutant], 'Known mutation')
      const [target, from, to] = mutations[mutant]!
      if (path === target) { assert.equal(code.split(from).length - 1, 1, 'Unique production anchor'); code = code.replace(from, to) }
    }
    if (process.env.AGENTMUX_FOCUS_COMPOSABLE_LOADED) appendFileSync(process.env.AGENTMUX_FOCUS_COMPOSABLE_LOADED, JSON.stringify({path, originalSHA256:createHash('sha256').update(original).digest('hex'), loadedSHA256:createHash('sha256').update(code).digest('hex'), mutant:code!==original?mutant:null})+'\n')
    if (code !== original) return {code,map:null}
  } }],
  test: { ...source.test, include: ['apps/desktop/test/focus-narrow-filters.test.tsx', 'apps/desktop/test/focus-composable-filters.test.tsx', 'apps/desktop/test/focus-source-filter-membership.test.ts', 'apps/desktop/test/focus-lane-origin.test.tsx', 'apps/desktop/test/focus-history-search.test.tsx', 'apps/desktop/test/focus-coordination-projection.test.tsx', 'apps/desktop/test/focus-context-cost.test.ts'],
    setupFiles: [], globalSetup: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
})
