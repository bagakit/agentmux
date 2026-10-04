import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import ts from 'typescript'
const root = resolve(import.meta.dirname, '../../..'), output = join(root, '.tmp/recovery-robustness-actions/provider-catalog-readiness')
const exec = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const controller = 'apps/desktop/src/main/runtime-controller.ts', test = 'apps/desktop/test/runtime-controller.test.ts'
const sourceFiles = [controller, test, 'apps/desktop/scripts/verify-provider-catalog-readiness.mjs', 'docs/design/behavior/session-recovery.md']
const callerFiles = ['apps/desktop/src/main/ipc.ts', 'apps/desktop/src/renderer/src/store.ts']
const pins = async files => Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(root, file)))])))
await mkdir(output, { recursive: true })
const inputsBefore = await pins(sourceFiles), callerPins = await pins(callerFiles)
const original = await readFile(join(root, controller), 'utf8')
const from = 'for (const host of this.hosts.values()) {\n      await host.client.connect()\n      for (const entry of host.client.providers.catalog())',
  to = "for (const host of this.hosts.values()) {\n      if (!('runtimeOwnerIdentity' in host.client)) await host.client.connect()\n      for (const entry of host.client.providers.catalog())"
assert.equal(original.split(from).length, 2, 'The exact production catalog readiness seam is absent or ambiguous.')
const variant = original.replace(from, to), witness = join(output, 'old-hosted-skip-loaded.json'), config = join(output, 'loaded.config.mts')
await writeFile(config, [
  "import { mergeConfig } from 'vitest/config'",
  "import { createHash } from 'node:crypto'",
  "import { writeFileSync } from 'node:fs'",
  'import base from ' + JSON.stringify(join(root, 'vitest.config.ts')),
  "const hash = value => createHash('sha256').update(value).digest('hex')",
  "export default mergeConfig(base, { plugins: [{ name: 'loaded-provider-catalog-readiness-counterexample', enforce: 'pre', transform(code, id) {",
  'if (id.split("?")[0] !== ' + JSON.stringify(join(root, controller)) + ') return',
  'const from = ' + JSON.stringify(from) + ', to = ' + JSON.stringify(to),
  'if (code.split(from).length !== 2) throw new Error("Production catalog seam was not uniquely loaded")',
  'const sourceSha256 = hash(code); code = code.replace(from, to)',
  'writeFileSync(' + JSON.stringify(witness) + ', JSON.stringify({ file: ' + JSON.stringify(controller) + ', sourceSha256, loadedVariantSha256: hash(code) }))',
  'return { code, map: null } } }] })'
].join('\n') + '\n')
async function run(name, configuration = './vitest.config.ts') {
  const report = join(output, name + '.json'); let code = 0, raw = ''
  try { const result = await exec('pnpm', ['exec', 'vitest', 'run', test, '--maxWorkers=1', '--config', configuration, '--root', '.', '-t', 'Provider catalog', '--reporter=default', '--reporter=json', '--outputFile=' + report], { cwd: root, maxBuffer: 8 * 1024 * 1024 }); raw = result.stdout + result.stderr }
  catch (error) { code = Number.isInteger(error.code) ? error.code : -1; raw = (error.stdout ?? '') + (error.stderr ?? '') + '\nChild exit: ' + error.code }
  await writeFile(join(output, name + '.log'), raw)
  const parsed = JSON.parse(await readFile(report, 'utf8')), selected = parsed.testResults.flatMap(file => file.assertionResults).filter(item => !['pending', 'skipped'].includes(item.status))
  assert.equal(selected.length, 2, 'The actual finite catalog tests were not collected.')
  return { code, collected: selected.length, passed: selected.filter(item => item.status === 'passed').length,
    assertionRed: selected.filter(item => item.status === 'failed' && item.failureMessages.some(message => /AssertionError|__VITEST_(?:REJECTS|RESOLVES)__|expected .* to /su.test(message))).map(item => item.fullName) }
}
const current = await run('current-green'); assert.equal(current.code, 0); assert.equal(current.passed, current.collected)
const red = await run('old-hosted-skip-red', config), loaded = JSON.parse(await readFile(witness, 'utf8'))
assert.equal(loaded.sourceSha256, hash(original)); assert.equal(loaded.loadedVariantSha256, hash(variant)); assert.notEqual(red.code, 0); assert.ok(red.assertionRed.length, 'The loaded old skip did not reach an actual failed assertion.')
const restored = await run('restored-green'); assert.equal(restored.code, 0); assert.equal(restored.passed, restored.collected)
assert.equal(hash(await readFile(join(root, controller))), hash(original), 'Production disk Source changed.')
const callers = { providersListIpc: [], storeInitialize: [] }
for (const file of callerFiles) {
  const tree = ts.createSourceFile(file, await readFile(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true)
  const record = (group, node, symbol) => callers[group].push({ file, line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1, symbol })
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'handle' && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'providers:list') {
      const inspect = child => { if (ts.isCallExpression(child) && child.expression.getText(tree) === 'args.runtime.providerCatalog') record('providersListIpc', child, 'RuntimeController.providerCatalog'); ts.forEachChild(child, inspect) }
      ts.forEachChild(node, inspect)
    }
    if (ts.isMethodDeclaration(node) && node.name.getText(tree) === 'initialize') {
      const inspect = child => { if (ts.isCallExpression(child) && child.expression.getText(tree) === 'api.providers.list') record('storeInitialize', child, 'api.providers.list'); ts.forEachChild(child, inspect) }
      ts.forEachChild(node, inspect)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
}
assert.ok(Object.values(callers).every(group => group.length), 'An outside-definition production caller group is empty.')
const inputsAfter = await pins(sourceFiles); assert.deepEqual(inputsAfter, inputsBefore); assert.deepEqual(await pins(callerFiles), callerPins)
await writeFile(join(output, 'production-callers.json'), JSON.stringify({ callerPins, callers }, null, 2) + '\n')
await writeFile(join(output, 'qualification.json'), JSON.stringify({ schema: 'agentmux.provider-catalog-readiness.v1', passed: true, inputsBefore, inputsAfter, current, mutation: { loaded, red, restored }, callerPins, callers, userRuntimeTouched: false,
  limitations: ['Actual production RuntimeController consumes synthetic Hosted-shaped and deferred/failing connection seams; no real Native or user Runtime process qualification.', 'The counterexample changes the loaded Controller module in memory; disk Source and Core dist are unchanged.', 'Only the two catalog cases run; unrelated controller tests are explicitly filtered.'] }, null, 2) + '\n')
console.log('Provider catalog readiness qualified: 2 actual GREEN, loaded old Hosted skip assertion RED, exact restored 2 GREEN, 2 nonempty production caller groups.')
