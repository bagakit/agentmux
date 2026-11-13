import base from './vitest.mote-context.config.mts'
import { defineConfig } from 'vitest/config'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const directFocusSources = ['lib/use-focus-collection-lanes.ts', 'lib/focus-collection-lanes.ts', 'components/FocusLaneHeadingMenu.tsx',
  'lib/use-focus-context-placements.ts', 'components/FocusScanLaneContent.tsx', 'components/FocusLaneGroups.tsx', 'components/FocusContextRow.tsx']
const directFocusHashes = Object.fromEntries(directFocusSources.map(path => [path,
  createHash('sha256').update(readFileSync(new URL(`../src/renderer/src/${path}`, import.meta.url))).digest('hex')]))

// Observe the original matching loop, including when extracted to its one owner.
// Neither the algorithm, its arguments nor its returned values are replaced.
export default defineConfig({ ...base, cacheDir: '.tmp/spatial-navigation-cost-vitest',
  define: { ...base.define, __AGENTMUX_SPATIAL_FOCUS_HASHES__: JSON.stringify(directFocusHashes) }, plugins: [...(base.plugins ?? []), {
  name: 'observe-original-spatial-category-seeds', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const normalized = id.replaceAll('\\', '/')
    const direct = directFocusSources.find(path => normalized.endsWith(`/apps/desktop/src/renderer/src/${path}`))
    if (direct) {
      const hash = createHash('sha256').update(source).digest('hex')
      return source + `\n;((globalThis as any).__agentmuxSpatialLoadedSources ??= {})[${JSON.stringify(direct)}] = ${JSON.stringify(hash)};\n`
    }
    if (!normalized.endsWith('/apps/desktop/src/shared/space-addresses.ts')) return
    const ast = ts.createSourceFile(id, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const owners = ast.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === 'spatialCategorySeeds')
    assert.equal(owners.length, 1, 'The original classification seed owner must be observed')
    const body = owners[0]!.body; assert.ok(body)
    const callbacks: ts.ArrowFunction[] = []
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'find' &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'categories' && node.arguments[0] && ts.isArrowFunction(node.arguments[0])) callbacks.push(node.arguments[0])
      ts.forEachChild(node, visit)
    }
    visit(body); assert.equal(callbacks.length, 1, 'The original seed predicate must actually run')
    const predicate = callbacks[0]!.body
    const insert = ";(globalThis as any).__agentmuxSpatialNavigationCost?.('seedComparisons');"
    const edits = [{ start: body.getStart(ast) + 1, end: body.getStart(ast) + 1, value: "\n;(globalThis as any).__agentmuxSpatialNavigationCost?.('seedBuilds');\n" },
      ts.isBlock(predicate) ? { start: predicate.getStart(ast) + 1, end: predicate.getStart(ast) + 1, value: insert }
        : { start: predicate.getStart(ast), end: predicate.end, value: `{ ${insert} return (${predicate.getText(ast)}); }` }]
    for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.value + source.slice(edit.end)
    return source
  }
}], test: { ...base.test, include: ['apps/desktop/test/spatial-navigation-cost.test.tsx'], testTimeout: 30000 } })
