import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import ts from 'typescript'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const file = 'apps/desktop/scripts/verify-browser-recovery-restart.mjs'
const source = await readFile(resolve(import.meta.dirname, '../../..', file), 'utf8')
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
assert.equal(ast.parseDiagnostics.length, 0)
const owners = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'consumeNativeProof')
assert.equal(owners.length, 1, 'Mutate the unique actual canonical consumer')
const blocks = owners[0].body.statements.filter(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(node => ts.isIdentifier(node.name) && node.name.text === 'validated'
    && node.initializer && ts.isAwaitExpression(node.initializer) && ts.isCallExpression(node.initializer.expression)
    && ts.isIdentifier(node.initializer.expression.expression) && node.initializer.expression.expression.text === 'validateNativeReceipt'))
assert.equal(blocks.length, 1, 'Mutate the entire actual complete validator invocation')
await verifyRendererSourceMutations({
  name: `browser-native-proof-canonical-consumer-${Date.now()}`,
  tests: ['apps/desktop/test/browser-native-proof-canonical-consumer.test.ts'],
  sources: [file, 'apps/desktop/scripts/lib/browser-capability-proof-join.mjs'],
  mutations: [{ label: 'whole-complete-native-validator-call-removed', file,
    before: blocks[0].getText(ast), after: 'const validated={name}' }]
})
