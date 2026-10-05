import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const evidence = join(root, '.tmp/session-takeover/core-context')
const copy = join(evidence, `source-${Date.now()}`)
const receiptPath = join(root, '.tmp/session-takeover/core-context-receipt.json')
const sha = value => createHash('sha256').update(value).digest('hex')
const inputs = {}
const files = directory => readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
for (const file of [...files(join(root, 'packages/core/src')), ...[
  'packages/core/test/agent-context.test.ts', 'packages/core/test/fixtures/native-history-session.ts',
  'packages/core/test/helpers/object-cli-rpc.ts', 'packages/core/scripts/verify-agent-context.mjs',
  'packages/core/bin/amux', 'packages/core/package.json', 'packages/core/scripts/build.mjs',
  'packages/core/scripts/clean-build.mjs', 'packages/core/tsconfig.json', 'packages/core/tsconfig.build.json',
  'tsconfig.base.json', 'vitest.config.ts', 'vitest.dist-freshness.ts', 'vitest.setup.ts'
].map(path => join(root, path))]) inputs[relative(root, file)] = sha(readFileSync(file))

function proofFile(path) {
  assert.ok(typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.split('/').includes('..'), 'Evidence paths must remain inside this workspace')
  return join(root, path)
}
function consumeCurrentProof() {
  try {
    const saved = JSON.parse(readFileSync(receiptPath, 'utf8'))
    assert.equal(saved.schema, 'agentmux.agent-context-proof.v1'); assert.equal(saved.passed, true)
    assert.deepEqual(saved.inputs, inputs, 'Current relevant inputs, including this verifier, must match exactly')
    assert.ok(saved.mutations.length > 0 && saved.callers.length > 0 && saved.runs.length > 0)
    assert.deepEqual(saved.cleanup, { privateSourceRemoved: true, privateSourcePath: saved.cleanup.privateSourcePath, sharedSourceMutations: 0, evidencePreserved: true })
    assert.equal(existsSync(proofFile(saved.cleanup.privateSourcePath)), false, 'The qualified private source copy must actually be gone')
    const runs = new Map(saved.runs.map(run => [run.name, run]))
    assert.equal(runs.size, saved.runs.length, 'Run names must be unique')
    const qualifiedFailures = new Set(saved.mutations.map(mutation => mutation.red.name))
    const inspectReport = (proof, red = false, changed = null) => {
      assert.equal(proof.passed, !red)
      const bytes = readFileSync(proofFile(proof.report)), loadedBytes = readFileSync(proofFile(proof.loaded))
      assert.equal(sha(bytes), proof.reportSha256); assert.equal(sha(loadedBytes), proof.loadedSha256)
      const report = JSON.parse(bytes), assertions = report.testResults.flatMap(result => result.assertionResults)
      const failed = assertions.filter(test => test.status === 'failed')
      assert.ok(assertions.length >= 7 && assertions.every(test => typeof test.fullName === 'string' && test.fullName.length > 0 && ['passed', 'failed'].includes(test.status)))
      assert.equal(assertions.length, report.numTotalTests); assert.equal(assertions.length, proof.total)
      assert.equal(failed.length, report.numFailedTests); assert.equal(failed.length, proof.failed)
      assert.equal(assertions.length - failed.length, report.numPassedTests)
      assert.ok(assertions.some(test => test.fullName.includes('actual compiled CLI')), 'The real CLI case must be part of this qualified report')
      const loaded = loadedBytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line).id)
      assert.ok(loaded.length > 0 && loaded.every(id => typeof id === 'string'))
      if (changed) assert.ok(loaded.some(id => id.endsWith('/' + changed)), 'The mutated owner must have been loaded')
      if (red) assert.ok(failed.length > 0 && failed.some(test => test.failureMessages.some(message => message.includes('AssertionError'))), 'A qualified RED must be a semantic assertion failure')
      else assert.equal(failed.length, 0)
      const run = runs.get(proof.name); assert.ok(run)
      assert.equal(run.exitCode, red ? 1 : 0); assert.equal(run.sha256, proof.outputSha256)
    }
    inspectReport(saved.baseline)
    if (saved.baselineRestored) inspectReport(saved.baselineRestored)
    for (const mutation of saved.mutations) {
      assert.equal(mutation.sourceSha256, inputs[mutation.path]); assert.notEqual(mutation.sourceSha256, mutation.transformedSha256)
      assert.equal(sha(readFileSync(proofFile(mutation.transformedSource))), mutation.transformedSha256)
      inspectReport(mutation.red, true, mutation.path); inspectReport(mutation.green)
      assert.equal(mutation.red.total, mutation.green.total)
    }
    const inspectAdjacent = proof => {
      const bytes = readFileSync(proofFile(proof.report)); assert.equal(sha(bytes), proof.reportSha256)
      const report = JSON.parse(bytes), assertions = report.testResults.flatMap(result => result.assertionResults)
      const failures = assertions.filter(test => test.status === 'failed').map(test => ({ name: test.fullName, assertion: test.failureMessages[0].split('\n')[0] }))
      assert.equal(assertions.length, proof.total); assert.equal(report.numTotalTests, proof.total)
      assert.equal(report.numPassedTests, proof.passed); assert.equal(report.numFailedTests, failures.length); assert.deepEqual(failures, proof.failures)
      const run = runs.get(proof.name); assert.ok(run); assert.equal(run.exitCode, proof.exitCode)
      if (failures.length) qualifiedFailures.add(proof.name)
    }
    inspectAdjacent(saved.adjacent)
    if (saved.adjacent.failures.length) {
      inspectAdjacent(saved.adjacentBeforeContext)
      assert.deepEqual(saved.adjacent.failures, saved.adjacentBeforeContext.failures)
    }
    for (const run of saved.runs) {
      assert.equal(sha(readFileSync(proofFile(run.log))), run.sha256, `Qualified log changed: ${run.name}`)
      assert.equal(run.exitCode, qualifiedFailures.has(run.name) ? 1 : 0)
    }
    for (const caller of saved.callers) {
      assert.notEqual(caller.path, caller.excludedDefinition)
      const source = readFileSync(proofFile(caller.path), 'utf8')
      assert.equal(sha(source), caller.sha256); assert.equal(caller.sha256, inputs[caller.path])
      assert.ok(typeof caller.symbol === 'string' && caller.symbol.length > 0 && source.includes(caller.symbol))
      assert.ok(typeof caller.actualConsumption === 'string' && caller.actualConsumption.length > 0)
    }
    return true
  } catch { return false }
}
if (consumeCurrentProof()) {
  console.log(JSON.stringify({ passed: true, consumedCurrentProof: true, receipt: relative(root, receiptPath), inputs: Object.keys(inputs).length }))
  process.exit(0)
}
mkdirSync(copy, { recursive: true })
for (const path of ['packages/core/src', 'packages/core/test', 'packages/core/bin', 'packages/core/package.json',
  'packages/core/tsconfig.json', 'packages/core/tsconfig.build.json', 'packages/core/scripts/build.mjs', 'packages/core/scripts/clean-build.mjs',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'vitest.config.ts', 'vitest.dist-freshness.ts', 'vitest.setup.ts']) {
  mkdirSync(dirname(join(copy, path)), { recursive: true }); cpSync(join(root, path), join(copy, path), { recursive: true })
}
for (const path of ['node_modules', 'packages/core/node_modules', 'packages/core/vendor', 'packages/demand']) {
  mkdirSync(dirname(join(copy, path)), { recursive: true }); symlinkSync(join(root, path), join(copy, path))
}
const receipt = { schema: 'agentmux.agent-context-proof.v1', passed: false, inputs, runs: [], mutations: [], callers: [],
  boundary: 'Private current source, normal Core build, real FileStore and two built-in Provider protocols, public Unix service/client, actual compiled CLI. No vendor CLI writer, user Runtime, installation, or real SSH-machine claim. Remote route is an actual service forwarding test.', cleanup: null }
function execute(name, args, expected = 0, cwd = copy) {
  const run = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' } })
  const output = run.stdout + run.stderr, log = join(evidence, `${name}.log`)
  writeFileSync(log, output); receipt.runs.push({ name, exitCode: run.status, log: relative(root, log), sha256: sha(output) })
  assert.equal(run.status, expected, `${name}: ${output.slice(-5000)}`)
  return run
}
function build(name) { execute(`${name}-build`, [join(copy, 'packages/core/scripts/build.mjs')], 0, join(copy, 'packages/core')) }
function tests(name, red = false, changed = null) {
  const report = join(evidence, `${name}.json`), loaded = join(evidence, `${name}-loaded.jsonl`), config = join(evidence, `${name}.config.mts`)
  const include = ['packages/core/test/agent-context.test.ts']
  writeFileSync(config, `import {defineConfig} from 'vitest/config';import base from ${JSON.stringify(join(copy, 'vitest.config.ts'))};import {appendFileSync} from 'node:fs';export default defineConfig({...base,root:${JSON.stringify(copy)},plugins:[{name:'loaded-owner',transform(_code,id){if(id.startsWith(${JSON.stringify(join(copy, 'packages/core/src'))}))appendFileSync(${JSON.stringify(loaded)},JSON.stringify({id})+'\\n')}}],test:{...base.test,include:${JSON.stringify(include)},passWithNoTests:false,maxWorkers:1}})`)
  const run = execute(name, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile', report], red ? 1 : 0)
  const result = JSON.parse(readFileSync(report, 'utf8')), modules = readFileSync(loaded, 'utf8').trim().split('\n').map(line => JSON.parse(line).id)
  assert.ok(result.numTotalTests >= 7 && modules.length > 0, 'Tests and owning loaded modules must be nonempty')
  if (changed) assert.ok(modules.includes(join(copy, changed)), `${changed} was not loaded`)
  if (red) assert.ok(result.testResults.flatMap(test => test.assertionResults).some(test => test.status === 'failed' && test.failureMessages.some(message => message.includes('AssertionError'))), 'Only a semantic assertion RED qualifies; a guard/compile/preparation error does not')
  return { name, passed: !red, total: result.numTotalTests, failed: result.numFailedTests, report: relative(root, report), reportSha256: sha(readFileSync(report)), loaded: relative(root, loaded), loadedSha256: sha(readFileSync(loaded)), outputSha256: sha(run.stdout + run.stderr) }
}
function adjacent(name) {
  const report = join(evidence, `${name}.json`)
  const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'packages/core/test/public-rpc-service.test.ts', '--maxWorkers=1', '--reporter=json', '--outputFile', report], { cwd: copy, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024 })
  const log = join(evidence, `${name}.log`), output = result.stdout + result.stderr
  writeFileSync(log, output); receipt.runs.push({ name, exitCode: result.status, log: relative(root, log), sha256: sha(output) })
  const tests = JSON.parse(readFileSync(report, 'utf8'))
  assert.equal(tests.numTotalTests, 16)
  const failures = tests.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed').map(test => ({ name: test.fullName, assertion: test.failureMessages[0].split('\n')[0] }))
  return { name, exitCode: result.status, total: tests.numTotalTests, passed: tests.numPassedTests, failures, report: relative(root, report), reportSha256: sha(readFileSync(report)) }
}
function variant(name, path, from, to) {
  const original = readFileSync(join(copy, path), 'utf8')
  assert.equal(original.split(from).length - 1, 1, `Mutation anchor must be unique: ${name}`)
  const changed = original.replace(from, to); assert.notEqual(sha(changed), sha(original))
  writeFileSync(join(copy, path), changed); writeFileSync(join(evidence, `${name}.source.ts`), changed)
  build(name); const red = tests(name, true, path)
  writeFileSync(join(copy, path), original); assert.equal(sha(readFileSync(join(copy, path))), sha(original))
  build(`${name}-restore`); const green = tests(`${name}-restore`)
  receipt.mutations.push({ name, path, sourceSha256: sha(original), transformedSha256: sha(changed), transformedSource: relative(root, join(evidence, `${name}.source.ts`)), red, green })
}
try {
  build('baseline'); receipt.baseline = tests('baseline')
  receipt.adjacent = adjacent('adjacent-current')
  if (receipt.adjacent.failures.length) {
    // Compare only this task's five production edits with the preserved shared index. Other
    // ongoing changes stay identical, so old failures do not masquerade as new.
    const paths = ['public-rpc.ts', 'public-rpc-service.ts', 'rpc-native-codec.ts', 'agentmux-cli-commands.ts', 'index.ts'].map(path => 'packages/core/src/' + path)
    const originals = Object.fromEntries(paths.map(path => [path, readFileSync(join(copy, path))]))
    for (const path of paths) {
      const previous = spawnSync('git', ['show', ':' + path], { cwd: root, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024 })
      assert.equal(previous.status, 0); writeFileSync(join(copy, path), previous.stdout)
    }
    build('adjacent-before-context'); receipt.adjacentBeforeContext = adjacent('adjacent-before-context')
    assert.deepEqual(receipt.adjacent.failures, receipt.adjacentBeforeContext.failures, 'A new adjacent failure must be fixed')
    for (const [path, source] of Object.entries(originals)) writeFileSync(join(copy, path), source)
    build('baseline-restore'); receipt.baselineRestored = tests('baseline-restored')
  }
  variant('service-omits-native', 'packages/core/src/public-rpc-service.ts',
    'result = await readAgentContext(scope.client, input, descriptor)', 'result = { ...await readAgentContext(scope.client, input, descriptor), native: null }')
  variant('captured-truncated', 'packages/core/src/agent-context.ts',
    'window.slice(start, end)', "window.slice(start, end).map(item => ({...item,...(item.content === undefined ? {} : {content:item.content.slice(0,700)})}))")
  variant('captured-window-reorder-ignored', 'packages/core/src/agent-context.ts',
    'if (itemIdsHash(window) !== cursor.capturedIdsHash) invalidCursor()', 'if (false) invalidCursor()')
  variant('cursor-ignores-session', 'packages/core/src/agent-context.ts',
    'cursor.agentSessionId !== input.agentSessionId ||', 'false ||')
  variant('codec-ignores-host', 'packages/core/src/rpc-native-codec.ts',
    'p.hostId !== expected.hostId || p.agentSessionId !== expected.agentSessionId', 'p.agentSessionId !== expected.agentSessionId')
  for (const [symbol, path, definition] of [
    ['readAgentContext(scope.client', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/agent-context.ts'],
    ['parseAgentContextParams(input)', 'packages/core/src/rpc-native-codec.ts', 'packages/core/src/agent-context.ts'],
    ["command('agent.context'", 'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/public-rpc.ts'],
    ['client.call(method, invocation.params', 'packages/core/src/agentmux.ts', 'packages/core/src/agentmux-cli-commands.ts'],
    ['${list(AGENTMUX_CLI_COMMANDS)}', 'packages/core/src/agentmux-cli-help.ts', 'packages/core/src/agentmux-cli-commands.ts']
  ]) {
    const source = readFileSync(join(root, path), 'utf8'); assert.notEqual(path, definition); assert.ok(source.includes(symbol), `Production caller missing: ${symbol}`)
    receipt.callers.push({ symbol, path, excludedDefinition: definition, sha256: sha(source), actualConsumption: 'baseline real service/client and actual compiled CLI success, pagination and meaningful failures' })
  }
  assert.ok(receipt.callers.length > 0 && receipt.mutations.length > 0)
  for (const [path, hash] of Object.entries(inputs)) assert.equal(sha(readFileSync(join(root, path))), hash, `Relevant shared source changed: ${path}`)
  receipt.passed = true
} catch (error) { receipt.error = String(error); process.exitCode = 1 }
finally {
  rmSync(copy, { recursive: true, force: true })
  receipt.cleanup = { privateSourceRemoved: !existsSync(copy), privateSourcePath: relative(root, copy), sharedSourceMutations: 0, evidencePreserved: true }
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, receipt: relative(root, receiptPath), error: receipt.error ?? null }))
}
