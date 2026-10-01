import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const root = resolve(import.meta.dirname, '../../..'), mode = process.argv[2]
assert.ok(['--unit', '--mutations', '--qualification'].includes(mode))
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
try {
  for (const path of ['apps/desktop/scripts/verify-toolkit-stop.mjs', 'apps/desktop/scripts/fixtures/toolkit-custom/vitest.config.mts',
    'apps/desktop/test/toolkit-custom-owner.test.ts', 'apps/desktop/test/toolkit-owner.test.ts', 'apps/desktop/test/toolkit-receipt-store.test.ts', 'vitest.setup.ts']) await bind(path)
  if (mode === '--unit') await run('owning')
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
    const cliSource = (await bind('packages/core/src/toolkit-cli.ts')).toString()
    const cliTree = ts.createSourceFile('toolkit-cli.ts', cliSource, ts.ScriptTarget.Latest, true), cliCalls = []
    function visitCli(node) { if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression) &&
        node.expression.properties.some(property => ts.isPropertyAssignment(property) && property.name.getText(cliTree) === 'operation' &&
          ts.isStringLiteral(property.initializer) && property.initializer.text === 'toolkit.stop')) cliCalls.push(node); ts.forEachChild(node, visitCli) }
    visitCli(cliTree); assert.ok(cliCalls.length > 0, 'Actual CLI Stop command dispatch is nonempty')
    const commandPath = 'packages/core/src/agentmux.ts'
    await bind(commandPath); await bind('packages/core/src/control.ts'); await bind('packages/core/src/control-host.ts')
    const configPath = resolve(root, 'apps/desktop/scripts/fixtures/toolkit-custom/tsconfig.owning.json')
    await bind(relative(root, configPath))
    const config = ts.readConfigFile(configPath, ts.sys.readFile); assert.equal(config.error, undefined)
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath))
    const program = ts.createProgram([resolve(root, commandPath)], parsed.options), checker = program.getTypeChecker()
    const commandTree = program.getSourceFile(resolve(root, commandPath)); assert.ok(commandTree?.text.length > 0)
    const functions = new Map()
    function collect(node) { if (ts.isFunctionDeclaration(node) && node.name && node.body) functions.set(node.name.text, node); ts.forEachChild(node, collect) }
    collect(commandTree)
    const entry = functions.get('toolkitCommand'); assert.ok(entry?.body)
    const calls = []
    function collectCalls(node) { if (ts.isCallExpression(node)) calls.push(node); ts.forEachChild(node, collectCalls) }
    collectCalls(entry.body); assert.ok(calls.length > 0, 'Actual CLI command calls are nonempty')
    function callsExternal(name, definition, argument) {
      return calls.some(node => node.expression.getText(commandTree) === name &&
        relative(root, checker.getResolvedSignature(node)?.declaration?.getSourceFile().fileName ?? '') === definition &&
        (argument === undefined || node.arguments[0]?.getText(commandTree) === argument))
    }
    assert.ok(callsExternal('parseToolkitCommand', 'packages/core/src/toolkit-cli.ts'), 'CLI calls the external parser, excluding its definition/import')
    assert.ok(callsExternal('requestAgentMuxControl', 'packages/core/src/control-host.ts', 'request'), 'CLI sends the parsed exact captured command to public Control')
    const dispatchCalls = []
    function dispatch(node) { if (ts.isCallExpression(node) && node.expression.getText(commandTree) === 'toolkitCommand') dispatchCalls.push(node); ts.forEachChild(node, dispatch) }
    dispatch(commandTree); assert.ok(dispatchCalls.length > 0, 'Ordinary CLI dispatch consumes the Toolkit command')
    results.push({ native: packet.native, raw: packet.raw, callers, cli: { count: cliCalls.length, publicCalls: calls.length, dispatchCalls: dispatchCalls.length } })
  }
  for (const [path, digest] of Object.entries(inputs)) assert.equal(sha(await readFile(resolve(root, path))), digest, 'Proof input drift: ' + path)
  receipt.completed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; throw error }
finally {
  receipt.identity = sha(JSON.stringify(inputs)); await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ mode, completed: receipt.completed, evidence, identity: receipt.identity }))
}
