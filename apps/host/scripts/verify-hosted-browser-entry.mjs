import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import ts from 'typescript'

const repository = resolve(import.meta.dirname, '../../..')
const result = await build({ absWorkingDir: repository, entryPoints: ['packages/core/src/hosted.ts'],
  bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true })
const inputs = Object.keys(result.metafile.inputs)
assert.ok(inputs.length > 0, 'The browser build must contain actual SDK inputs')
assert.ok(inputs.includes('packages/core/src/hosted-client.ts'), 'The real Hosted SDK must be in the browser bundle')
assert.ok(inputs.includes('packages/core/src/hosted-client-contract.ts'), 'The finite public contract must be in the browser bundle')
assert.ok(!inputs.includes('packages/core/src/client.ts'), 'A browser consumer cannot import the local semantic Core owner')
assert.ok(!inputs.includes('packages/core/src/hosted-runtime-service.ts'), 'A browser consumer cannot import the Host service')
assert.equal(result.outputFiles.length, 1)
assert.ok(result.outputFiles[0].contents.length > 0)
assert.deepEqual(Object.values(result.metafile.outputs).flatMap(output => output.imports), [], 'The browser bundle must resolve all runtime imports')

const caller = 'apps/desktop/src/main/desktop-host.ts'
const callerSource = await readFile(join(repository, caller), 'utf8')
const ast = ts.createSourceFile(caller, callerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const names = new Set()
for (const statement of ast.statements) {
  if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === '@agentmux/core/hosted') {
    for (const binding of statement.importClause?.namedBindings?.elements ?? []) {
      if ((binding.propertyName ?? binding.name).text === 'connectHostedAgentMux') names.add(binding.name.text)
    }
  }
}
const calls = []
const visit = node => {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.has(node.expression.text)) {
    calls.push({ file: caller, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 })
  }
  ts.forEachChild(node, visit)
}
visit(ast)
assert.ok(calls.length > 0, 'The pure SDK entry must have an actual product call, beyond an import or definition')
const sources = [...new Set([...inputs, caller, 'packages/core/package.json'])]
const hashes = Object.fromEntries(await Promise.all(sources.map(async file => [file,
  createHash('sha256').update(await readFile(join(repository, file))).digest('hex') ])))
const receipt = { schema: 'agentmux.hosted-browser-entry.v1', passed: true, bytes: result.outputFiles[0].contents.length,
  inputs, calls, hashes, limitation: 'This verifies the pure SDK build and product caller; HTTP transport and device integration are separate behavior acceptance.' }
const output = join(repository, '.tmp/private-mobile-host/browser-entry.json')
await mkdir(join(repository, '.tmp/private-mobile-host'), { recursive: true })
await writeFile(output, JSON.stringify(receipt, null, 2) + '\n')
process.stdout.write(JSON.stringify({ passed: true, bytes: receipt.bytes, inputs, calls, receipt: output }, null, 2) + '\n')
