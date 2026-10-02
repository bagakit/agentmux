import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const root = resolve(import.meta.dirname, '../../..'), mode = process.argv[2]
assert.ok(['--unit', '--mutations', '--qualification', '--check-callers'].includes(mode))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const base = resolve(root, ".bagakit/design/toolkit-custom-stop-intake-fixture/evidence")
await mkdir(base, { recursive: true })
const evidence = await mkdtemp(resolve(base, 'run-')), inputs = {}, results = []
const receipt = { schema: 'agentmux.toolkit-stop-proof.v1', mode, completed: false, inputs, results }
async function bind(path) {
  const bytes = await readFile(resolve(root, path)); assert.ok(bytes.length > 0, 'Nonempty proof input: ' + path)
  if (Object.hasOwn(inputs, path)) assert.equal(sha(bytes), inputs[path], 'Input drift: ' + path)
  else {
    inputs[path] = sha(bytes)
    const target = resolve(evidence, 'inputs', path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes)
  }
  return bytes
}
async function readReceipt(ref) {
  assert.ok(ref && typeof ref.path === 'string' && /^[a-f0-9]{64}$/u.test(ref.sha256))
  const bytes = await bind(ref.path); assert.equal(sha(bytes), ref.sha256); return JSON.parse(bytes)
}
const exec = promisify(execFile)
async function run(name, mutant = 'baseline', pattern) {
  const directory = resolve(evidence, name); await mkdir(directory)
  const json = resolve(directory, 'results.json')
  const files = ['apps/desktop/test/toolkit-custom-owner.test.ts',
    ...(!pattern ? ['apps/desktop/test/toolkit-owner.test.ts', 'apps/desktop/test/toolkit-receipt-store.test.ts'] : [])]
  let output, code = 0
  try {
    output = await exec(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...files,
      '--config', 'apps/desktop/scripts/fixtures/toolkit-custom/vitest.config.mts', '--reporter=json', '--outputFile=' + json,
      ...(pattern ? ['--testNamePattern', pattern] : [])], {
      cwd: root, env: { ...process.env, AGENTMUX_TOOLKIT_EVIDENCE: directory, AGENTMUX_TOOLKIT_MUTANT: mutant },
      timeout: 150000, maxBuffer: 8 * 1024 * 1024
    })
  } catch (error) { code = error.code; output = error; if (!Number.isInteger(code)) throw error }
  await writeFile(resolve(directory, 'command.log'), String(output.stdout) + String(output.stderr))
  const report = JSON.parse(await readFile(json)), tests = report.testResults.flatMap(suite => suite.assertionResults)
    .filter(test => ['passed', 'failed'].includes(test.status))
  assert.ok(tests.length > 0, 'Actual owning test collection must be nonempty')
  const failures = tests.filter(test => test.status === 'failed')
  if (mutant === 'baseline') { assert.equal(code, 0); assert.deepEqual(failures, []) }
  else {
    assert.notEqual(code, 0); assert.equal(failures.length, 1)
    assert.ok(failures[0].fullName.includes(pattern))
    assert.ok(failures[0].failureMessages.some(text => /AssertionError/u.test(text)), 'Specific assertion RED, never setup')
  }
  const loaded = (await readFile(resolve(directory, 'loaded-source.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
  assert.ok(loaded.length > 0, 'Actually loaded product Source is nonempty')
  for (const item of loaded) { await bind(item.path); assert.equal(inputs[item.path], item.originalSHA256) }
  if (mutant !== 'baseline') assert.ok(loaded.some(item => item.mutant === mutant && item.originalSHA256 !== item.consumedSHA256))
  results.push({ name, mutant, pattern, code, passed: tests.length - failures.length, failed: failures.length })
}
async function checkCallers() {
  const require = createRequire(resolve(root, 'apps/desktop/package.json')), ts = require('typescript'), callers = []
  for (const [path, expression] of [
    ['apps/desktop/src/main/toolkit-owner.ts', 'this.custom.stop'],
    ['apps/desktop/src/renderer/src/components/toolkit/UserToolkitResult.tsx', 'api.toolkit.stop']
  ]) {
    const source = (await bind(path)).toString(), tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const calls = []; function visit(node) { if (ts.isCallExpression(node) && node.expression.getText(tree) === expression) calls.push(node); ts.forEachChild(node, visit) }
    visit(tree); assert.ok(calls.length > 0, 'Definition-excluded actual product Stop caller: ' + path)
    callers.push({ path, expression, count: calls.length })
  }
  const commandPath = 'packages/core/src/agentmux.ts', registryPath = 'packages/core/src/agentmux-cli-commands.ts'
  const clientPath = 'packages/core/src/public-rpc-client.ts', domainPath = 'packages/core/src/toolkit-cli.ts'
  for (const path of [commandPath, registryPath, clientPath, domainPath]) await bind(path)
  const configPath = resolve(root, 'apps/desktop/scripts/fixtures/toolkit-custom/tsconfig.owning.json')
  await bind(relative(root, configPath))
  const config = ts.readConfigFile(configPath, ts.sys.readFile); assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath))
  assert.deepEqual(parsed.errors, [])
  const program = ts.createProgram([resolve(root, commandPath), resolve(root, registryPath)], parsed.options), checker = program.getTypeChecker()
  const commandTree = program.getSourceFile(resolve(root, commandPath)), registryTree = program.getSourceFile(resolve(root, registryPath))
  assert.ok(commandTree?.text.length > 0 && registryTree?.text.length > 0)
  const loadedSource = []
  for (const tree of program.getSourceFiles()) {
    const path = relative(root, tree.fileName)
    if (!path.startsWith('packages/') || path.includes('/node_modules/')) continue
    const bytes = await bind(path); assert.equal(sha(bytes), sha(tree.text), 'Actual loaded caller Source identity: ' + path)
    loadedSource.push({ path, sha256: sha(bytes) })
  }
  assert.ok(loadedSource.length > 0, 'Actual production caller Source graph is nonempty')
  receipt.loadedSource = loadedSource
  function find(tree, predicate) { const matches = []; function visit(node) { if (predicate(node)) matches.push(node); ts.forEachChild(node, visit) } visit(tree); return matches }
  function unwrap(node) { while (node && (ts.isAwaitExpression(node) || ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node))) node = node.expression; return node }
  function from(node, path) { return ts.isCallExpression(node) && relative(root, checker.getResolvedSignature(node)?.declaration?.getSourceFile().fileName ?? '') === path }
  function same(node, symbol) { return Boolean(symbol && node && ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) }
  function member(node, symbol, key) { node = unwrap(node); return Boolean(node && ts.isPropertyAccessExpression(node) && node.name.text === key && same(unwrap(node.expression), symbol)) }
  const entry = find(commandTree, node => ts.isFunctionDeclaration(node) && node.name?.text === 'main' && node.body)[0]
  assert.ok(entry?.body, 'Actual ordinary CLI entry is nonempty')
  const invocation = find(entry.body, node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
    from(unwrap(node.initializer), registryPath) && unwrap(node.initializer).expression.getText(commandTree) === 'parseAgentMuxCliInvocation')
  assert.equal(invocation.length, 1, 'Ordinary CLI calls the sole registry parser, excluding definition/import')
  const invocationSymbol = checker.getSymbolAtLocation(invocation[0].name)
  const methods = find(entry.body, node => ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && member(node.initializer, invocationSymbol, 'command'))
    .flatMap(node => node.name.elements.filter(element => (element.propertyName ?? element.name).getText(commandTree) === 'method'))
  assert.equal(methods.length, 1, 'CLI method comes from the same parsed invocation.command')
  const methodSymbol = checker.getSymbolAtLocation(methods[0].name)
  const connections = find(entry.body, node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
    from(unwrap(node.initializer), clientPath) && unwrap(node.initializer).expression.getText(commandTree) === 'connectAgentMuxRpc')
  assert.equal(connections.length, 1, 'Ordinary CLI connects the sole public RPC client')
  const clientSymbol = checker.getSymbolAtLocation(connections[0].name)
  const sends = find(entry.body, node => ts.isCallExpression(node) && member(node.expression, clientSymbol, 'call') && from(node, clientPath))
  assert.equal(sends.length, 1, 'Actual connected-client request call is nonempty and unique')
  assert.ok(same(unwrap(sends[0].arguments[0]), methodSymbol), 'CLI sends the exact parsed method to the connected public client')
  assert.ok(member(sends[0].arguments[1], invocationSymbol, 'params'), 'CLI sends params from that same parsed invocation')
  const registry = find(registryTree, node => ts.isVariableDeclaration(node) && node.name.getText(registryTree) === 'AGENTMUX_CLI_COMMANDS' && node.initializer && ts.isArrayLiteralExpression(node.initializer))[0]
  assert.ok(registry, 'The original executable registry is nonempty')
  const registered = registry.initializer.elements.filter(node => ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'stop' && from(node, registryPath))
  assert.equal(registered.length, 1, 'Stop has one actual registration in the sole registry')
  const factory = checker.getResolvedSignature(registered[0]).declaration
  assert.ok(ts.isFunctionDeclaration(factory) && factory.body && factory.parameters[0] && ts.isIdentifier(factory.parameters[0].name))
  const actionSymbol = checker.getSymbolAtLocation(factory.parameters[0].name)
  const method = find(factory.body, node => ts.isPropertyAssignment(node) && node.name.getText(registryTree) === 'method')[0]?.initializer
  assert.ok(method && ts.isTemplateExpression(method) && method.head.text === 'toolkit.' && method.templateSpans.length === 1 &&
    same(method.templateSpans[0].expression, actionSymbol) && method.templateSpans[0].literal.text === '', 'Registered Stop method is derived by the original Toolkit factory')
  const domainCalls = find(factory.body, node => from(node, domainPath) && node.expression.getText(registryTree) === 'parseToolkitCommand')
  assert.equal(domainCalls.length, 1, 'The registry consumes the original Toolkit domain parser outside its definition/import')
  assert.ok(ts.isArrayLiteralExpression(domainCalls[0].arguments[0]) && same(domainCalls[0].arguments[0].elements[0], actionSymbol), 'Registered action reaches the original domain parser')
  return { callers, cli: { method: method.head.text + registered[0].arguments[0].text, registryPath,
    registrationCount: registered.length, domainParserCalls: domainCalls.length, parserCalls: invocation.length,
    connectedClientCalls: connections.length, publicRequestCalls: sends.length, loadedSourceCount: loadedSource.length },
    scope: 'Actual production AST/type-resolved caller proof only; no Native qualification, runtime execution or whole-types0 claim.' }
}
try {
  for (const path of ['apps/desktop/scripts/verify-toolkit-stop.mjs', 'apps/desktop/scripts/fixtures/toolkit-custom/vitest.config.mts',
    'apps/desktop/test/toolkit-custom-owner.test.ts', 'apps/desktop/test/toolkit-owner.test.ts', 'apps/desktop/test/toolkit-receipt-store.test.ts', 'vitest.setup.ts']) {
    if (mode !== '--check-callers' || path === 'apps/desktop/scripts/verify-toolkit-stop.mjs') await bind(path)
  }
  if (mode === '--check-callers') results.push(await checkCallers())
  else if (mode === '--unit') await run('owning')
  else if (mode === '--mutations') {
    for (const [mutant, pattern] of [
      ['stop-acceptance', 'confirms natural completion after a rejected Stop repairs a previously failed result save'],
      ['stop-decision', 'waits for a rejected Stop submission before confirming natural exit 0'],
      ['stop-cleanup', 'waits for already confirmed release cleanup without submitting Stop']
    ]) { await run(mutant, mutant, pattern); await run(mutant + '-restored', 'baseline', pattern) }
  } else {
    const packet = JSON.parse(await bind(".bagakit/design/toolkit-custom-ui-intake-fixture/qualification/current.json"))
    assert.equal(packet.schema, 'agentmux.toolkit-custom-ui-qualification.v1')
    const native = await readReceipt(packet.native), raw = await readReceipt(packet.raw)
    assert.equal(native.completed, true); assert.equal(native.sourceCurrentReadbackExact, true)
    assert.deepEqual(native.changedAfterCapture, []); assert.deepEqual(native.remainingPrivateProcesses, [])
    const rawInput = native.rawInputs.find(item => item.phase === 'toolkit')
    assert.ok(rawInput); assert.equal(rawInput.sha256, packet.raw.sha256)
    assert.equal(resolve(root, packet.raw.path), resolve(dirname(resolve(root, packet.native.path)), rawInput.file))
    assert.equal(raw.qualificationScope, 'toolkit-custom-ui'); assert.equal(raw.qualified, true)
    const recovery = raw.stopRecovery, accepted = raw.acceptedStop
    for (const [observed, state, stopAccepted] of [[recovery, 'succeeded', false], [accepted, 'stopped', true]]) {
      assert.ok(observed?.before?.admission?.run?.runId)
      assert.equal(observed.confirmed.state, state); assert.equal(observed.confirmed.admission, null)
      const original = observed.before.admission, confirmed = observed.confirmed.latestConfirmed
      for (const key of ['executionId', 'invocationId', 'definition', 'target', 'run', 'startedAt']) assert.deepEqual(confirmed[key], original[key])
      assert.equal(observed.stop.runId, original.run.runId); assert.equal(observed.stop.accepted, stopAccepted)
      if (!stopAccepted) {
        assert.equal(observed.before.state, 'unknown'); assert.ok(observed.stop.error?.trim())
        assert.equal(confirmed.exitCode, 0); assert.equal(confirmed.text, original.text)
        assert.deepEqual(observed.before.latestConfirmed, raw.unknown.snapshot.latestConfirmed)
      }
    }
    assert.equal(raw.desktop.originalWorkbenchExact, true)
    assert.equal(raw.restart.healthyRunSamePid, true); assert.equal(raw.restart.realInputAckReplay, true)
    const ownerPath = 'apps/desktop/src/main/toolkit-custom-owner.ts'
    await bind(ownerPath); assert.equal(native.inputs[ownerPath].sha256, inputs[ownerPath])
    results.push({ native: packet.native, raw: packet.raw, ...await checkCallers() })
  }
  for (const [path, digest] of Object.entries(inputs)) assert.equal(sha(await readFile(resolve(root, path))), digest, 'Proof input drift: ' + path)
  receipt.completed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; throw error }
finally {
  receipt.identity = sha(JSON.stringify(inputs)); await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ mode, completed: receipt.completed, evidence, identity: receipt.identity }))
}
