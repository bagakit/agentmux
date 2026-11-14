import base from './vitest.mote-context.config.mts'
import { defineConfig } from 'vitest/config'
import ts from 'typescript'
import assert from 'node:assert/strict'

const observed = new Map([
  ['GlobalFocusSurface.tsx', ['GlobalFocusSurface']],
  ['RecentFocusTimeline.tsx', ['RecentFocusTimeline', 'FocusTimeTrack']],
  ['FocusContextCardBody.tsx', ['FocusContextCardBody']]
])
export default defineConfig({ ...base, cacheDir: '.tmp/focus-timeline-cost-vitest', plugins: [...(base.plugins ?? []), {
  name: 'observe-original-focus-timeline-consumers', enforce: 'pre' as const,
  transform(source: string, id: string) {
    if (!id.includes('/apps/desktop/src/renderer/src/components/')) return
    const names = observed.get(id.split('/').at(-1)!); if (!names) return
    const ast = ts.createSourceFile(id, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const entries: { at: number; name: string }[] = []
    const visit = (node: ts.Node) => {
      if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name && names.includes(node.name.text) && node.body) entries.push({ at: node.body.getStart(ast) + 1, name: node.name.text })
      ts.forEachChild(node, visit)
    }; visit(ast)
    assert.equal(entries.length, names.length, 'Observe the actual production component owners')
    for (const entry of entries.sort((a,b) => b.at-a.at)) source = source.slice(0, entry.at) + `\n;(globalThis as any).__agentmuxFocusTimelineCostRender?.(${JSON.stringify(entry.name)}, arguments[0]);\n` + source.slice(entry.at)
    return source
  }
}], test: { ...base.test, include: ['apps/desktop/test/focus-timeline-cost.test.tsx',
  'apps/desktop/test/focus-timeline-current-main.test.tsx',
  'apps/desktop/test/focus-timeline-original-source.test.tsx'], testTimeout: 20000 } })
