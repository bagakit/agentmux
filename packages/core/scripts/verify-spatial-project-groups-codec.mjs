import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import ts from 'typescript'
const root = resolve(import.meta.dirname, '../../..'), output = join(root, '.tmp/spatial-project-groups-codec')
const exec = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const parser = 'packages/core/src/space-control-parser.ts', test = 'packages/core/test/space-project-groups-codec.test.ts'
const sources = [parser, test, 'packages/core/scripts/verify-spatial-project-groups-codec.mjs', 'docs/design/behavior/spaces-and-layout.md']
const callerFiles = ['packages/core/src/rpc-business-codec.ts', 'packages/core/src/public-rpc-client.ts', 'apps/desktop/src/renderer/src/lib/space-agent-control.ts', 'apps/desktop/src/renderer/src/store.ts']
const pins = async files => Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(root, file)))])))
await mkdir(output, { recursive: true })
const before = await pins(sources), callerPins = await pins(callerFiles), original = await readFile(join(root, parser), 'utf8')
const mutations = [
  { id: 'old-catalog-allowlist', from: "fields(value, ['projectGroups', 'spaces', 'zones', 'tabs', 'regions', 'bindings', 'locations'], code)", to: "fields(value, ['spaces', 'zones', 'tabs', 'regions', 'bindings', 'locations'], code)" },
  { id: 'drop-parsed-project-groups', from: '...(projectGroups === undefined ? {} : { projectGroups }), spaces, zones, tabs, regions, bindings, locations', to: 'spaces, zones, tabs, regions, bindings, locations' }
]
async function run(name, configuration = './vitest.config.ts') {
  const report = join(output, name + '.json'); let code = 0, raw = ''
  try { const result = await exec('pnpm', ['exec', 'vitest', 'run', test, '--maxWorkers=1', '--config', configuration, '--root', '.', '--reporter=default', '--reporter=json', '--outputFile=' + report],
    { cwd: root, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, AGENTMUX_PROJECT_GROUPS_COMPILED_RECEIPT: join(output, name + '-compiled-cli.json') } }); raw = result.stdout + result.stderr }
  catch (error) { code = Number.isInteger(error.code) ? error.code : -1; raw = (error.stdout ?? '') + (error.stderr ?? '') + '\nChild exit: ' + error.code }
  await writeFile(join(output, name + '.log'), raw)
  const parsed = JSON.parse(await readFile(report, 'utf8')), cases = parsed.testResults.flatMap(file => file.assertionResults)
  assert.equal(cases.length, 13, 'The finite codec cases were not collected.')
  return { code, collected: cases.length, passed: cases.filter(item => item.status === 'passed').length,
    assertionRed: cases.filter(item => item.status === 'failed' && item.failureMessages.some(message => /AssertionError|__VITEST_(?:REJECTS|RESOLVES)__|expected .* to /su.test(message))).map(item => item.fullName) }
}
const build = await exec('pnpm', ['--filter', '@agentmux/core', 'build'], { cwd: root, maxBuffer: 8 * 1024 * 1024 })
await writeFile(join(output, 'qualified-core-build.log'), build.stdout + build.stderr)
const current = await run('qualified-current-green'); assert.equal(current.code, 0); assert.equal(current.passed, current.collected)
const receipts = []
for (const mutation of mutations) {
  assert.equal(original.split(mutation.from).length, 2, 'Mutation seam missing or ambiguous: ' + mutation.id)
  const variant = original.replace(mutation.from, mutation.to), witness = join(output, mutation.id + '-loaded.json'), config = join(output, mutation.id + '.config.mts')
  await writeFile(config, [
    "import { mergeConfig } from 'vitest/config'", "import { createHash } from 'node:crypto'", "import { writeFileSync } from 'node:fs'",
    'import base from ' + JSON.stringify(join(root, 'vitest.config.ts')), "const hash = value => createHash('sha256').update(value).digest('hex')",
    "export default mergeConfig(base, { plugins: [{ name: 'loaded-original-spatial-codec-counterexample', enforce: 'pre', transform(code, id) {",
    'if (id.split("?")[0] !== ' + JSON.stringify(join(root, parser)) + ') return',
    'const from = ' + JSON.stringify(mutation.from) + ', to = ' + JSON.stringify(mutation.to),
    'if (code.split(from).length !== 2) throw new Error("Actual codec seam was not uniquely loaded")',
    'const sourceSha256 = hash(code); code = code.replace(from, to)',
    'writeFileSync(' + JSON.stringify(witness) + ', JSON.stringify({ sourceSha256, loadedVariantSha256: hash(code) }))',
    'return { code, map: null } } }] })'
  ].join('\n') + '\n')
  const red = await run(mutation.id + '-red', config), loaded = JSON.parse(await readFile(witness, 'utf8'))
  assert.equal(loaded.sourceSha256, hash(original)); assert.equal(loaded.loadedVariantSha256, hash(variant)); assert.notEqual(red.code, 0); assert.ok(red.assertionRed.length, mutation.id + ' lacks actual assertion RED')
  const restored = await run(mutation.id + '-restored-green'); assert.equal(restored.code, 0); assert.equal(restored.passed, restored.collected)
  assert.equal(hash(await readFile(join(root, parser))), hash(original), 'Disk Source changed.')
  receipts.push({ id: mutation.id, loaded, red, restored })
}
const callers = { rpcDecoder: [], rpcClientConsumer: [], desktopCatalog: [], desktopStoreCaller: [] }
for (const file of callerFiles) {
  const tree = ts.createSourceFile(file, await readFile(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true)
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(tree), symbol = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ''
      const group = file === callerFiles[0] && symbol === 'parseAgentMuxControlReceipt' ? 'rpcDecoder' : file === callerFiles[1] && symbol === 'parseRpcControlResult' ? 'rpcClientConsumer' :
        file === callerFiles[2] && symbol === 'spatialCatalog' ? 'desktopCatalog' : file === callerFiles[3] && symbol === 'spatialCatalog' ? 'desktopStoreCaller' : null
      if (group) callers[group].push({ file, line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1, expression })
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
}
assert.ok(Object.values(callers).every(group => group.length), 'A production decoder / Desktop caller group is empty.')
const compiled = JSON.parse(await readFile(join(output, 'qualified-current-green-compiled-cli.json'), 'utf8'))
assert.equal(compiled.actual.length, 2); assert.ok(compiled.groups.length); assert.equal(compiled.coreClientCount, 0); assert.equal(compiled.originalDocumentUnchanged, true)
for (const read of compiled.actual) { assert.equal(read.code, 0); assert.deepEqual(read.result.result.catalog.projectGroups, compiled.groups) }
const after = await pins(sources); assert.deepEqual(after, before); assert.deepEqual(await pins(callerFiles), callerPins)
const compiledPins = await pins(['packages/core/dist/space-control-parser.js', 'packages/core/dist/rpc-business-codec.js', 'packages/core/dist/agentmux.js', 'packages/core/dist/spatial-graph.js', 'packages/core/dist/public-rpc-server.js'])
await writeFile(join(output, 'production-callers.json'), JSON.stringify({ callerPins, callers }, null, 2) + '\n')
await writeFile(join(output, 'qualification.json'), JSON.stringify({ schema: 'agentmux.spatial-project-groups-codec.v1', passed: true, before, after, current, mutations: receipts, callerPins, callers, compiledPins, compiled, userRuntimeTouched: false,
  limitations: ['Actual Desktop catalog and Core spatial document feed the strict source decoder. Mutations transform only the actual loaded parser in memory; Source and compiled dist never contain mutant bytes.', 'Compiled normal Core public CLI/server read a private populated spatial document with zero lifecycle clients; no user GUI/Native, restoration or package claim.', 'Only the finite project-group codec cases run.'] }, null, 2) + '\n')
console.log('Project groups codec qualified: 13 actual GREEN, 2 loaded assertion RED with exact restored GREEN, 4 nonempty production caller groups and 2 actual compiled CLI reads.')
