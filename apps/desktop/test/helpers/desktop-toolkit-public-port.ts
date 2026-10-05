import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import type { AgentMuxToolkitPort } from '@agentmux/core/control'

// Consume the actual Desktop port installed on its public server. Replacing it
// with the Owner directly hides optional arguments dropped by this adapter.
const source = readFileSync(new URL('../../src/main/ipc.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('ipc.ts', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
const ports: ts.ObjectLiteralExpression[] = []
function visit(node: ts.Node): void {
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'AgentMuxControlServer') {
    const options = node.arguments?.[0]
    assert(options && ts.isObjectLiteralExpression(options), 'Actual Desktop public server options required')
    const toolkit = options.properties.filter(ts.isPropertyAssignment).find(property => property.name.getText(ast) === 'toolkit')
    assert(toolkit && ts.isObjectLiteralExpression(toolkit.initializer), 'Actual Desktop Toolkit port required')
    ports.push(toolkit.initializer)
  }
  ts.forEachChild(node, visit)
}
visit(ast)
assert.equal(ports.length, 1, 'Exactly one production Desktop Toolkit public port must be consumed')
const compiled = ts.transpileModule(`const port = ${ports[0]!.getText(ast)};`, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext }
}).outputText

export function desktopToolkitPublicPort(toolkit: AgentMuxToolkitPort): AgentMuxToolkitPort {
  return new Function('toolkit', 'nameChangeRequests', 'unknownNameContext', `${compiled}\nreturn port;`)(
    toolkit, { run: (_context: unknown, operation: () => unknown) => operation() }, () => ({ kind: 'unknown' })
  ) as AgentMuxToolkitPort
}
