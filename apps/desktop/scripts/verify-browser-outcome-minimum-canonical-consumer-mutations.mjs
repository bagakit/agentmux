import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import ts from 'typescript'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const file = 'apps/desktop/scripts/verify-browser-recovery-restart.mjs'
const source = await readFile(resolve(import.meta.dirname, '../../..', file), 'utf8')
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const matches = []
function visit(node) {
  if (ts.isIfStatement(node) && ts.isIdentifier(node.expression) && node.expression.text === 'outcome') {
    const body = node.thenStatement
    if (ts.isExpressionStatement(body) && ts.isAwaitExpression(body.expression) && ts.isCallExpression(body.expression.expression)) {
      const called = body.expression.expression.expression
      if (ts.isPropertyAccessExpression(called) && ts.isIdentifier(called.expression)
        && called.expression.text === 'outcome' && called.name.text === 'observeMinimumBrowserOutcome') matches.push(node)
    }
  }
  ts.forEachChild(node, visit)
}
visit(ast)
assert.equal(matches.length, 1, 'Exactly one actual owning canonical if/body is mutated')
const hook = matches[0].getText(ast)
await verifyRendererSourceMutations({
  name: `browser-outcome-minimum-canonical-consumer-${Date.now()}`,
  tests: ['apps/desktop/test/browser-outcome-minimum-canonical-consumer.test.ts'],
  sources: [file],
  mutations: [{ label: 'whole-owning-minimum-outcome-hook-removed', file, before: hook, after: '' }]
})
