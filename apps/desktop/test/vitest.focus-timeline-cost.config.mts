import base from './vitest.mote-context.config.mts'
import { defineConfig } from 'vitest/config'
import ts from 'typescript'
import assert from 'node:assert/strict'

const observed = new Map([
  ['GlobalFocusSurface.tsx', ['GlobalFocusSurface']],
  ['RecentFocusTimeline.tsx', ['RecentFocusTimeline', 'FocusTimeTrack']],
  ['FocusContextCardBody.tsx', ['FocusContextCardBody']],
  ['focus-context.ts', ['FocusProjectionSubject', 'FocusCardRankComparison']],
  ['focus-project-lanes.ts', ['deriveFocusProjectLanes']],
  ['focus-history-timeline.ts', ['groupFocusTimeline', 'focusTimelineOrderCandidates']]
])
const mutants = {
  'whole-record-projection': ['if (!subjectsChanged) {', 'if (!subjectsChanged && sameNames && sameTimelines) {'],
  'unchanged-card-reranking': ['if (orderChanged || rows.length !== contexts.length) {', 'if (modelsChanged || orderChanged || rows.length !== contexts.length) {']
} as const
const mutant = process.env.AGENTMUX_FOCUS_TIMELINE_COST_MUTANT as keyof typeof mutants | undefined
if (mutant) assert(Object.hasOwn(mutants, mutant), 'Known Focus cost mutation')

export default defineConfig({ ...base, cacheDir: '.tmp/focus-timeline-cost-vitest', plugins: [...(base.plugins ?? []), {
  name: 'observe-original-focus-timeline-consumers', enforce: 'pre' as const,
  transform(source: string, id: string) {
    if (!id.includes('/apps/desktop/src/renderer/src/')) return
    const file = id.split('/').at(-1)!, names = observed.get(file)
    if (!names) return
    if (mutant && file === 'focus-context.ts') {
      const [from, to] = mutants[mutant]
      assert.equal(source.split(from).length, 2, 'Unique actual Focus mutation anchor')
      source = source.replace(from, to)
      process.stderr.write(`MUTATION_APPLIED=${mutant}\n`)
    }
    const ast = ts.createSourceFile(id, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const entries: { at: number; name: string }[] = []
    const atBlock = (node: ts.Block, name: string) => entries.push({ at: node.getStart(ast) + 1, name })
    const visit = (node: ts.Node, inProjection = false) => {
      if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name && node.body) {
        if (names.includes(node.name.text)) atBlock(node.body, node.name.text)
        inProjection ||= file === 'focus-context.ts' && node.name.text === 'createFocusProjectionCache'
      }
      if (inProjection && ts.isForOfStatement(node) && node.expression.getText(ast) === 'input.sessions' && ts.isBlock(node.statement)) {
        atBlock(node.statement, 'FocusProjectionSubject')
      }
      if (inProjection && ts.isCallExpression(node) && node.expression.getText(ast) === 'rows.sort') {
        const compare = node.arguments[0]
        if (compare && ts.isArrowFunction(compare) && ts.isBlock(compare.body)) atBlock(compare.body, 'FocusCardRankComparison')
      }
      ts.forEachChild(node, child => visit(child, inProjection))
    }; visit(ast)
    assert.equal(entries.length, names.length, 'Observe the actual production component owners')
    for (const entry of entries.sort((a,b) => b.at-a.at)) source = source.slice(0, entry.at) + `\n;(globalThis as any).__agentmuxFocusTimelineCostRender?.(${JSON.stringify(entry.name)}, arguments[0]);\n` + source.slice(entry.at)
    return source
  }
}], test: { ...base.test, include: ['apps/desktop/test/focus-timeline-cost.test.tsx',
  'apps/desktop/test/focus-timeline-current-main.test.tsx',
  'apps/desktop/test/focus-timeline-original-source.test.tsx'], testTimeout: 20000 } })
