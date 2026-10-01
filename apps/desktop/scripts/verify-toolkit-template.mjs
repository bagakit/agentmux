import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const modes = process.argv.slice(2)
assert.ok(modes.length && modes.every(mode => ['--owner', '--native', '--capture-native', '--mutations', '--callers'].includes(mode)), 'Choose a bounded template verification mode')
assert.ok(!(modes.includes('--native') && modes.includes('--capture-native')), 'Capture and sealed qualification are separate explicit modes')
const base = resolve(root, ".bagakit/design/toolkit-template-fixture/formal"); await mkdir(base, { recursive: true })
const evidence = await mkdtemp(resolve(base, 'run-')), inputs = {}, results = [], exec = promisify(execFile)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function bind(path, { copy = true } = {}) {
  const bytes = await readFile(resolve(root, path)); assert.ok(bytes.length, 'Nonempty template proof input: ' + path)
  if (Object.hasOwn(inputs, path)) assert.equal(inputs[path], sha(bytes), 'Actual input stays on this candidate: ' + path)
  else { inputs[path] = sha(bytes); if (copy) { const target = resolve(evidence, 'inputs', path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes) } }
  return bytes
}
async function run(name, mutant = 'baseline', pattern) {
  const directory = resolve(evidence, name); await mkdir(directory)
  const json = resolve(directory, 'results.json'), args = ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/scripts/fixtures/toolkit-template/vitest.config.mts', '--reporter=json', '--outputFile=' + json,
    ...(pattern ? ['--testNamePattern', pattern] : [])]
  let output, exitCode = 0
  try { output = await exec(process.execPath, args, { cwd: root, env: { ...process.env, AGENTMUX_TOOLKIT_TEMPLATE_EVIDENCE: directory, AGENTMUX_TOOLKIT_TEMPLATE_MUTANT: mutant }, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 }) }
  catch (error) { exitCode = error.code; output = error; if (!Number.isInteger(exitCode)) throw error }
  await writeFile(resolve(directory, 'command.log'), String(output.stdout) + String(output.stderr))
  const report = JSON.parse(await readFile(json)), tests = report.testResults.flatMap(suite => suite.assertionResults).filter(test => ['passed', 'failed'].includes(test.status))
  assert.ok(tests.length > 0, 'Actually executed template cases are nonempty')
  const failures = tests.filter(test => test.status === 'failed')
  if (mutant === 'baseline') { assert.equal(exitCode, 0); assert.deepEqual(failures, []) }
  else {
    assert.notEqual(exitCode, 0); assert.equal(failures.length, 1)
    assert.ok(failures[0].fullName.includes(pattern), 'The selected actual owning case fails')
    assert.ok(failures[0].failureMessages.some(message => /AssertionError/u.test(message)), 'SpecificAssertionRED, never setup failure')
  }
  const loaded = (await readFile(resolve(directory, 'loaded-source.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
  assert.ok(loaded.length > 0, 'Actually compiled product input collection is nonempty')
  if (mutant !== 'baseline') assert.ok(loaded.some(input => input.applied && input.mutant === mutant && input.originalSHA256 !== input.consumedSHA256), 'The mutation changes actual loaded product bytes')
  for (const input of loaded) { await bind(input.path); assert.equal(inputs[input.path], input.originalSHA256, 'Loaded product Source matches this candidate') }
  results.push({ name, mutant, pattern: pattern ?? null, exitCode, passed: tests.length - failures.length, failed: failures.length, jsonSHA256: sha(await readFile(json)) })
  console.log(`${name}: ${tests.length - failures.length} passed, ${failures.length} assertion failures`)
}
async function callers() {
  const require = createRequire(resolve(root, 'apps/desktop/package.json')), ts = require('typescript')
  const file = resolve(root, 'apps/desktop/scripts/fixtures/toolkit-custom-ui/tsconfig.owning.json')
  const config = ts.readConfigFile(file, ts.sys.readFile); assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(file)); assert.deepEqual(parsed.errors, [])
  const program = ts.createProgram(parsed.fileNames, parsed.options), checker = program.getTypeChecker(), edges = []
  for (const tree of program.getSourceFiles()) {
    const caller = relative(root, tree.fileName)
    if (!caller.startsWith('apps/desktop/src/renderer/src/') || !/\.tsx?$/u.test(caller)) continue
    const record = (node, symbol, name) => {
      if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
      for (const declaration of symbol?.getDeclarations() ?? []) {
        const definition = relative(root, declaration.getSourceFile().fileName)
        if (definition !== caller && !/test|fixture/u.test(caller)) edges.push({ symbol: name ?? symbol.name, caller, definition, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 })
      }
    }
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'createAccountUsageTool') record(node, checker.getSymbolAtLocation(node.expression))
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(tree) === 'ToolkitSettingsPane') record(node, checker.getSymbolAtLocation(node.tagName), 'JSX ToolkitSettingsPane')
      if (caller.endsWith('/toolkit/UserToolkitResult.tsx') && ts.isCallExpression(node) && node.expression.getText(tree) === 'api.toolkit.run') record(node, checker.getSymbolAtLocation(node.expression.name), 'ToolkitDesktopApi.run')
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  assert.ok(edges.length > 0)
  for (const target of ['createAccountUsageTool', 'JSX ToolkitSettingsPane', 'ToolkitDesktopApi.run']) assert.ok(edges.some(edge => edge.symbol === target), 'Definition/import/test-excluded product caller is nonempty: ' + target)
  for (const edge of edges) { await bind(edge.caller); await bind(edge.definition) }
  await writeFile(resolve(evidence, 'callers.json'), JSON.stringify(edges, null, 2) + '\n')
  results.push({ callers: edges })
}
try {
  for (const path of ['apps/desktop/resources/toolkit/account-usage.mjs', 'apps/desktop/src/renderer/src/components/settings/account-usage-template.ts',
    'apps/desktop/src/renderer/src/components/settings/ToolkitSettingsPane.tsx', 'apps/desktop/src/renderer/src/styles/settings-toolkit.css',
    'apps/desktop/scripts/fixtures/toolkit-template/query.mjs', 'apps/desktop/scripts/fixtures/toolkit-template/vitest.config.mts',
    'apps/desktop/test/toolkit-template-script.test.ts', 'apps/desktop/test/toolkit-template-ui.test.tsx', 'apps/desktop/scripts/verify-toolkit-template.mjs']) await bind(path)
  if (modes.includes('--owner')) await run('owner')
  if (modes.includes('--mutations')) for (const [mutant, pattern] of [
    ['create', 'previews and creates one disabled ordinary draft'],
    ['unknown', 'keeps visible null and absent card details unknown'],
    ['edit', 'keeps an independently edited saved tool']
  ]) { await run(mutant, mutant, pattern); await run(mutant + '-restored', 'baseline', pattern) }
  if (modes.includes('--callers')) await callers()
  if (modes.includes('--native') || modes.includes('--capture-native')) {
    const { verifyToolkitTemplateNative } = await import('./fixtures/toolkit-template/capture.mjs')
    results.push(await verifyToolkitTemplateNative({ root, evidence, bind, captureOnly: modes.includes('--capture-native') }))
  }
  for (const [path, digest] of Object.entries(inputs)) assert.equal(sha(await readFile(resolve(root, path))), digest, 'Final Source input stays unchanged: ' + path)
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify({ schema: 'agentmux.toolkit-template-proof.v1', completed: true, modes, inputs, results }, null, 2) + '\n')
  console.log(relative(root, evidence))
} catch (error) {
  await writeFile(resolve(evidence, 'failure.json'), JSON.stringify({ modes, inputs, results, error: String(error), stack: error.stack }, null, 2) + '\n')
  console.error(relative(root, evidence)); throw error
}
