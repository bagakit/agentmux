import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import ts from 'typescript'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const file = 'apps/desktop/scripts/verify-browser-recovery-restart.mjs'
const source = await readFile(resolve(import.meta.dirname, '../../..', file), 'utf8')
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
assert.equal(ast.parseDiagnostics.length, 0)
const hooks = []
function visit(node) {
  if (ts.isIfStatement(node) && ts.isIdentifier(node.expression) && node.expression.text === 'cost') {
    const calls = []
    function find(child) {
      if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)
        && ts.isIdentifier(child.expression.expression) && child.expression.expression.text === 'cost'
        && child.expression.name.text === 'collectBrowserCapabilityMeasurements') calls.push(child)
      ts.forEachChild(child, find)
    }
    find(node.thenStatement)
    if (calls.length === 1) hooks.push(node)
  }
  ts.forEachChild(node, visit)
}
visit(ast)
assert.equal(hooks.length, 1, 'Mutate the unique actual owning cost baseline and collector block')
await verifyRendererSourceMutations({
  name: `browser-capability-cost-canonical-consumer-${Date.now()}`,
  tests: ['apps/desktop/test/browser-capability-cost-canonical-consumer.test.ts'],
  sources: [file],
  mutations: [{ label: 'whole-owning-cost-baseline-and-collector-hook-removed', file, before: hooks[0].getText(ast), after: '' }]
})
