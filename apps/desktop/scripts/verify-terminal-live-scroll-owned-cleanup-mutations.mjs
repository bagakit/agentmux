import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import ts from 'typescript'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const file = 'apps/desktop/scripts/verify-terminal-live-scroll.mjs'
const source = await readFile(resolve(import.meta.dirname, '../../..', file), 'utf8')
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
assert.equal(ast.parseDiagnostics.length, 0)
const owners = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'cleanupOwnedProbes')
assert.equal(owners.length, 1)
const loops = []
function visit(node) {
  if (ts.isForOfStatement(node) && ts.isAwaitExpression(node.expression) && ts.isCallExpression(node.expression.expression)
    && ts.isIdentifier(node.expression.expression.expression) && node.expression.expression.expression.text === 'listProbeProcesses') loops.push(node)
  ts.forEachChild(node, visit)
}
visit(owners[0])
assert.equal(loops.length, 1, 'Delete the actual entire per-PID verification and signal block')
assert.ok(ts.isBlock(loops[0].statement) && loops[0].statement.statements.length > 0)
const archiveOwners = ast.statements.filter(node => ts.isTryStatement(node) && node.finallyBlock)
assert.equal(archiveOwners.length, 1)
const preservation = archiveOwners[0].finallyBlock.statements.filter(node => ts.isTryStatement(node)
  && node.tryBlock.statements.some(statement => ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
    && ts.isAwaitExpression(statement.expression.right) && ts.isCallExpression(statement.expression.right.expression)
    && ts.isIdentifier(statement.expression.right.expression.expression) && statement.expression.right.expression.expression.text === 'preserveGeneratedArtifacts'))
assert.equal(preservation.length, 1, 'Delete the actual entire owning generated artifact preservation call')
await verifyRendererSourceMutations({
  name: `terminal-live-scroll-owned-cleanup-${Date.now()}`,
  tests: ['apps/desktop/test/terminal-live-scroll-owned-cleanup.test.ts', 'apps/desktop/test/terminal-live-scroll-evidence-preservation.test.ts'],
  sources: [file, 'apps/desktop/scripts/probe-process.mjs'],
  mutations: [
    { label: 'whole-per-positive-pid-recheck-and-signal-block-removed', file, before: loops[0].statement.getText(ast), after: '{}' },
    { label: 'whole-owning-generated-artifact-preservation-block-removed', file, before: preservation[0].getText(ast), after: '' }
  ]
})
