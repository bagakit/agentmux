import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const evidence = join(root, '.tmp/cli-remote-semantics/proof'), receiptFile = join(evidence, 'receipt.json')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const files = dir => readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => join(e.parentPath, e.name))
const testPaths = ['cli-remote-semantics.test.ts', 'public-rpc-service.test.ts', 'agentmux-cli-help.test.ts', 'agent-context.test.ts',
  'public-rpc-ssh-channel.test.ts', 'public-rpc-transports.test.ts', 'helpers/public-rpc-owner.ts', 'helpers/object-cli-rpc.ts', 'fixtures/native-history-session.ts']
const paths = [...files(join(root, 'packages/core/src')), ...testPaths.map(p => join(root, 'packages/core/test', p)),
  ...['packages/core/bin/agentmux', 'packages/core/package.json', 'packages/core/scripts/build.mjs', 'packages/core/scripts/clean-build.mjs',
    'packages/core/tsconfig.json', 'packages/core/tsconfig.build.json', 'tsconfig.base.json',
    'packages/core/scripts/verify-cli-remote-semantics.mjs', 'docs/design/behavior/public-control.md', 'docs/guides/agentmux-cli-object-control.md'].map(p => join(root, p))]
const inputs = Object.fromEntries(paths.map(p => [relative(root, p), sha(readFileSync(p))]))
function proofPath(path) { assert.ok(typeof path === 'string' && !isAbsolute(path) && !path.split('/').includes('..')); return join(root, path) }
function checkRun(run, red = false, owner) {
  const bytes = readFileSync(proofPath(run.report)), loadedBytes = readFileSync(proofPath(run.loaded))
  assert.equal(sha(bytes), run.reportSha256); assert.equal(sha(loadedBytes), run.loadedSha256)
  const report = JSON.parse(bytes), assertions = report.testResults.flatMap(r => r.assertionResults)
  assert.ok(assertions.length >= 7 && assertions.every(a => ['passed', 'failed'].includes(a.status)))
  assert.equal(assertions.length, report.numTotalTests); assert.equal(assertions.length, run.total)
  assert.equal(report.numFailedTests, run.failed); assert.equal(run.exitCode, red ? 1 : 0)
  assert.equal(report.numFailedTests === 0, !red)
  assert.ok(assertions.some(a => a.fullName.includes('actual compiled CLI consumes')))
  if (red) assert.ok(assertions.some(a => a.status === 'failed' && a.failureMessages.some(m => m.includes('AssertionError'))), 'RED must be a semantic assertion, never collection or preparation failure')
  const loaded = loadedBytes.toString().trim().split('\n').map(line => JSON.parse(line).id)
  assert.ok(loaded.length > 0); if (owner) assert.ok(loaded.some(id => id.endsWith('/' + owner) || id.endsWith('/' + owner.replace('/src/', '/dist/').replace(/\.ts$/, '.js'))), 'Mutated source or its compiled consumer must actually load')
  assert.equal(sha(readFileSync(proofPath(run.log))), run.logSha256)
}
function consume() {
  try {
    const proof = JSON.parse(readFileSync(receiptFile)); assert.equal(proof.passed, true); assert.equal(proof.schema, 'agentmux.cli-remote-semantics-proof.v1')
    assert.deepEqual(proof.inputs, inputs); assert.equal(existsSync(proofPath(proof.privateCopy)), false)
    checkRun(proof.baseline); assert.equal(proof.mutations.length, 6)
    for (const mutation of proof.mutations) {
      assert.equal(mutation.sourceSha256, inputs[mutation.path]); assert.notEqual(mutation.sourceSha256, mutation.transformedSha256)
      assert.equal(sha(readFileSync(proofPath(mutation.transformedSource))), mutation.transformedSha256)
      assert.equal(sha(readFileSync(proofPath(mutation.compiledOwner))), mutation.compiledOwnerSha256)
      checkRun(mutation.red, true, mutation.path); checkRun(mutation.green)
      if (['packages/core/src/agentmux.ts', 'packages/core/src/agentmux-cli-help.ts'].includes(mutation.path)) {
        const loaded = readFileSync(proofPath(mutation.red.loaded), 'utf8').trim().split('\n').map(line => JSON.parse(line))
        assert.ok(loaded.some(entry => entry.id.endsWith('/' + mutation.path.replace('/src/', '/dist/').replace(/\.ts$/, '.js')) && entry.sha256 === mutation.compiledOwnerSha256))
      }
      assert.equal(mutation.red.total, mutation.green.total)
    }
    assert.ok(proof.callers.length >= 4)
    for (const caller of proof.callers) {
      assert.notEqual(caller.path, caller.excludedDefinition); const source = readFileSync(proofPath(caller.path))
      assert.equal(sha(source), caller.sha256); assert.ok(source.toString().includes(caller.symbol))
    }
    const adjacent = JSON.parse(readFileSync(proofPath(proof.adjacent.report)))
    assert.equal(sha(readFileSync(proofPath(proof.adjacent.report))), proof.adjacent.sha256)
    assert.ok(adjacent.numTotalTests > 0)
    if (adjacent.numFailedTests) {
      const comparison = JSON.parse(readFileSync(proofPath(proof.adjacent.before.report)))
      assert.equal(sha(readFileSync(proofPath(proof.adjacent.before.report))), proof.adjacent.before.sha256)
      const failures = report => report.testResults.flatMap(r => r.assertionResults).filter(a => a.status === 'failed').map(a => ({ name: a.fullName, assertion: a.failureMessages[0].split('\n')[0] }))
      assert.deepEqual(failures(adjacent), failures(comparison)); assert.equal(comparison.testResults.flatMap(r => r.assertionResults).filter(a => ['passed', 'failed'].includes(a.status)).length, adjacent.numFailedTests)
    }
    return true
  } catch { return false }
}
if (consume()) { console.log(JSON.stringify({ passed: true, consumedCurrentProof: true, receipt: relative(root, receiptFile) })); process.exit(0) }
mkdirSync(evidence, { recursive: true })
// A verifier-only correction does not invalidate sealed product runs. Reuse only
// reports whose complete product/test/build inputs still match; preserve provenance.
let previous = null
try {
  const bytes = readFileSync(receiptFile), saved = JSON.parse(bytes)
  const productInputs = value => Object.fromEntries(Object.entries(value).filter(([path]) => path !== 'packages/core/scripts/verify-cli-remote-semantics.mjs'))
  assert.deepEqual(productInputs(saved.inputs), productInputs(inputs))
  const history = join(evidence, 'receipt-before-' + Date.now() + '.json'); writeFileSync(history, bytes)
  previous = { ...saved, provenance: { path: relative(root, history), sha256: sha(bytes) } }
} catch {}
const copy = join(evidence, `private-${Date.now()}`)
for (const path of ['packages/core/src', 'packages/core/test', 'packages/core/bin', 'packages/core/package.json', 'packages/core/scripts',
  'packages/core/tsconfig.json', 'packages/core/tsconfig.build.json', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json']) {
  mkdirSync(dirname(join(copy, path)), { recursive: true }); cpSync(join(root, path), join(copy, path), { recursive: true })
}
for (const path of ['node_modules', 'packages/core/node_modules', 'packages/core/vendor', 'packages/demand', 'packages/layout']) {
  mkdirSync(dirname(join(copy, path)), { recursive: true }); symlinkSync(join(root, path), join(copy, path))
}
const receipt = { schema: 'agentmux.cli-remote-semantics-proof.v1', passed: false, inputs, privateCopy: relative(root, copy), mutations: [], callers: [],
  boundary: 'Real FileStore/Core owner, two actual Unix services, public client and normal compiled CLI, generic controlled SSH executable into the compiled system endpoint --stdio leaf. No user Runtime control or claim of real SSH network/authentication.', cleanup: null, reusedFrom: previous?.provenance ?? null }
function execute(name, args, cwd = copy, extraEnv = {}) {
  console.log(name)
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, pnpm_config_verify_deps_before_run: 'false', ...extraEnv } })
  const output = result.stdout + result.stderr, log = join(evidence, name + '.log'); writeFileSync(log, output)
  return { result, log: relative(root, log), logSha256: sha(output) }
}
function build(name) {
  const { result } = execute(name + '-build', [join(copy, 'packages/core/scripts/build.mjs')], join(copy, 'packages/core'))
  assert.equal(result.status, 0, result.stdout + result.stderr)
}
function tests(name, red = false, owner) {
  const report = join(evidence, name + '.json'), loaded = join(evidence, name + '-loaded.jsonl'), config = join(evidence, name + '.config.mts')
  rmSync(loaded, { force: true })
  writeFileSync(config, `import {defineConfig} from 'vitest/config';import {appendFileSync} from 'node:fs';export default defineConfig({root:${JSON.stringify(copy)},plugins:[{name:'loaded-owner',transform(_code,id){if(id.startsWith(${JSON.stringify(join(copy, 'packages/core/src'))}))appendFileSync(${JSON.stringify(loaded)},JSON.stringify({id})+'\\n')}}],test:{include:['packages/core/test/cli-remote-semantics.test.ts'],passWithNoTests:false,maxWorkers:1}})`)
  const hook = join(evidence, name + '-compiled-loader.mjs')
  writeFileSync(hook, `import {registerHooks} from 'node:module';import {appendFileSync,readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';registerHooks({load(url,context,next){const result=next(url,context);if(url.startsWith(${JSON.stringify(pathToFileURL(join(copy, 'packages/core/dist')).href + '/')})){const id=fileURLToPath(url);appendFileSync(${JSON.stringify(loaded)},JSON.stringify({id,sha256:createHash('sha256').update(readFileSync(id)).digest('hex')})+'\\n')}return result}})`)
  const { result, log, logSha256 } = execute(name, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile', report], copy,
    { NODE_OPTIONS: ((process.env.NODE_OPTIONS ?? '') + ' --import=' + pathToFileURL(hook).href).trim() })
  assert.equal(result.status, red ? 1 : 0, (result.stdout + result.stderr).slice(-5000))
  const json = JSON.parse(readFileSync(report)), run = { name, exitCode: result.status, total: json.numTotalTests, failed: json.numFailedTests,
    report: relative(root, report), reportSha256: sha(readFileSync(report)), loaded: relative(root, loaded), loadedSha256: sha(readFileSync(loaded)), log, logSha256,
    compiledCliSha256: sha(readFileSync(join(copy, 'packages/core/dist/agentmux.js'))) }
  checkRun(run, red, owner); return run
}
function variant(name, path, from, to) {
  const original = readFileSync(join(copy, path), 'utf8'); assert.equal(original.split(from).length - 1, 1, name + ' requires one mutation anchor')
  const transformed = original.replace(from, to), transformedSource = join(evidence, name + '.source.ts')
  const qualified = previous?.mutations?.find(m => m.name === name && m.path === path && m.sourceSha256 === sha(original) && m.transformedSha256 === sha(transformed))
  if (qualified) {
    assert.equal(sha(readFileSync(proofPath(qualified.transformedSource))), qualified.transformedSha256)
    assert.equal(sha(readFileSync(proofPath(qualified.compiledOwner))), qualified.compiledOwnerSha256)
    checkRun(qualified.red, true, path); checkRun(qualified.green)
    if (['packages/core/src/agentmux.ts', 'packages/core/src/agentmux-cli-help.ts'].includes(path)) {
      const loaded = readFileSync(proofPath(qualified.red.loaded), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      assert.ok(loaded.some(entry => entry.id.endsWith('/' + path.replace('/src/', '/dist/').replace(/\.ts$/, '.js')) && entry.sha256 === qualified.compiledOwnerSha256))
    }
    receipt.mutations.push(qualified); console.log(name + '-consume-qualified'); return
  }
  writeFileSync(join(copy, path), transformed); writeFileSync(transformedSource, transformed)
  build(name)
  const compiledOwner = join(evidence, name + '.compiled.js')
  cpSync(join(copy, path.replace('/src/', '/dist/').replace(/\.ts$/, '.js')), compiledOwner)
  const red = tests(name, true, path)
  if (path === 'packages/core/src/agentmux.ts' || path === 'packages/core/src/agentmux-cli-help.ts') {
    const loaded = readFileSync(proofPath(red.loaded), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok(loaded.some(entry => entry.id.endsWith('/' + path.replace('/src/', '/dist/').replace(/\.ts$/, '.js')) && entry.sha256 === sha(readFileSync(compiledOwner))), 'Actual CLI child must load the exact compiled mutant')
  }
  writeFileSync(join(copy, path), original); build(name + '-restore'); const green = tests(name + '-restore')
  receipt.mutations.push({ name, path, sourceSha256: sha(original), transformedSha256: sha(transformed), transformedSource: relative(root, transformedSource),
    compiledOwner: relative(root, compiledOwner), compiledOwnerSha256: sha(readFileSync(compiledOwner)), red, green })
}
try {
  build('baseline')
  if (previous?.baseline) { checkRun(previous.baseline); receipt.baseline = previous.baseline; console.log('baseline-consume-qualified') }
  else receipt.baseline = tests('baseline')
  if (previous?.adjacent?.before) {
    const observed = JSON.parse(readFileSync(proofPath(previous.adjacent.report))), before = JSON.parse(readFileSync(proofPath(previous.adjacent.before.report)))
    assert.equal(sha(readFileSync(proofPath(previous.adjacent.report))), previous.adjacent.sha256)
    assert.equal(sha(readFileSync(proofPath(previous.adjacent.before.report))), previous.adjacent.before.sha256)
    const failed = report => report.testResults.flatMap(r => r.assertionResults).filter(a => a.status === 'failed').map(a => ({ name: a.fullName, assertion: a.failureMessages[0].split('\n')[0] }))
    assert.deepEqual(failed(observed), failed(before)); assert.equal(observed.numFailedTests, 1)
    assert.equal(before.testResults.flatMap(r => r.assertionResults).filter(a => ['passed', 'failed'].includes(a.status)).length, 1)
    receipt.adjacent = previous.adjacent; console.log('adjacent-consume-qualified')
  } else {
  const adjacentReport = join(evidence, 'adjacent.json'), adjacentConfig = join(evidence, 'adjacent.config.mts')
  writeFileSync(adjacentConfig, `import {defineConfig} from 'vitest/config';export default defineConfig({root:${JSON.stringify(copy)},test:{include:${JSON.stringify(testPaths.filter(p => p.endsWith('.test.ts') && !p.startsWith('cli-remote')).map(p => 'packages/core/test/' + p))},passWithNoTests:false,maxWorkers:1}})`)
  const adjacent = execute('adjacent', [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', adjacentConfig, '--reporter=json', '--outputFile', adjacentReport])
  const adjacentResult = JSON.parse(readFileSync(adjacentReport)); assert.ok(adjacentResult.numTotalTests > 0)
  receipt.adjacent = { report: relative(root, adjacentReport), sha256: sha(readFileSync(adjacentReport)), total: adjacentResult.numTotalTests, ...adjacent, result: undefined }
  if (adjacentResult.numFailedTests) {
    // A known unrelated output-reader failure is compared against the exact
    // pre-task production source. It is reported, never claimed as a pass.
    const failures = report => report.testResults.flatMap(r => r.assertionResults).filter(a => a.status === 'failed').map(a => ({ name: a.fullName, assertion: a.failureMessages[0].split('\n')[0] }))
    const failed = failures(adjacentResult)
    assert.deepEqual(failed.map(f => f.name), ['public service uses the original Core and Desktop business owners keeps unrelated output readers out of the SDK ordered-byte metadata dispatch'], 'Any other adjacent failure must be fixed')
    const changedPaths = ['public-rpc.ts', 'public-rpc-service.ts', 'rpc-native-codec.ts', 'agentmux.ts', 'agentmux-cli-help.ts', 'agentmux-cli-commands.ts'].map(p => 'packages/core/src/' + p)
    const originals = Object.fromEntries(changedPaths.map(p => [p, readFileSync(join(copy, p))]))
    const beforeRef = '9262da53701e8c0704bb2a6df0a9eb46d6756665'
    for (const path of changedPaths) {
      const previous = spawnSync('git', ['show', beforeRef + ':' + path], { cwd: root, encoding: 'utf8' }); assert.equal(previous.status, 0)
      writeFileSync(join(copy, path), previous.stdout)
    }
    build('adjacent-before')
    const beforeReport = join(evidence, 'adjacent-before.json')
    const previous = execute('adjacent-before', [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', adjacentConfig, '--testNamePattern', '^' + failed[0].name + '$', '--reporter=json', '--outputFile', beforeReport])
    const before = JSON.parse(readFileSync(beforeReport)); assert.equal(previous.result.status, 1); assert.deepEqual(failures(before), failed)
    const active = before.testResults.flatMap(r => r.assertionResults).filter(a => ['passed', 'failed'].includes(a.status))
    assert.equal(active.length, 1); assert.equal(before.numFailedTests, 1)
    receipt.adjacent.before = { report: relative(root, beforeReport), sha256: sha(readFileSync(beforeReport)), beforeRef, changedPaths, activeTests: active.length }
    for (const [path, bytes] of Object.entries(originals)) writeFileSync(join(copy, path), bytes)
    build('adjacent-restored')
  } else assert.equal(adjacent.result.status, 0)
  }
  variant('list-loses-route', 'packages/core/src/public-rpc-service.ts', 'return { session: { ...observed, routeHostId: scope.hostId } }', "return { session: { ...observed, routeHostId: 'local' } }")
  variant('inspect-loses-route', 'packages/core/src/public-rpc-service.ts', 'result = { routeHostId, session, status, displayName, unavailable: issues }', "result = { routeHostId: 'local', session, status, displayName, unavailable: issues }")
  variant('partial-wrong-host', 'packages/core/src/public-rpc-service.ts', 'agentSessionId: session.agentSessionId as string | null, hostId: scope.hostId', "agentSessionId: session.agentSessionId as string | null, hostId: 'wrong-route'")
  variant('codec-allows-missing-route', 'packages/core/src/rpc-native-codec.ts', "case 'agent.ls': record(p, ['sessions', 'errors']); array(p.sessions, item => { string(record(item).routeHostId); status(item, undefined, true) })", "case 'agent.ls': record(p, ['sessions', 'errors']); array(p.sessions, item => { status(item, undefined, true) })")
  variant('endpoint-fakes-response', 'packages/core/src/agentmux.ts', "endpoint: publicEndpoint, connection: 'not-attempted'", "endpoint: publicEndpoint, connection: 'responded'")
  variant('help-controller-local', 'packages/core/src/agentmux-cli-help.ts', "local means the receiving Core service's own machine", "local means the invoking shell's own machine")
  for (const [path, symbol, definition] of [
    ['packages/core/src/public-rpc-service.ts', 'routeHostId: scope.hostId', 'packages/core/src/public-rpc.ts'],
    ['packages/core/src/public-rpc-client.ts', 'parseRpcNativeResult(method, value, params, credentials)', 'packages/core/src/rpc-native-codec.ts'],
    ['packages/core/src/agentmux.ts', 'client.call(method, invocation.params', 'packages/core/src/agentmux-cli-commands.ts'],
    ['packages/core/src/agentmux-cli-help.ts', '${list(AGENTMUX_CLI_COMMANDS)}', 'packages/core/src/agentmux-cli-commands.ts']
  ]) {
    const source = readFileSync(join(root, path)); assert.notEqual(path, definition); assert.ok(source.toString().includes(symbol))
    receipt.callers.push({ path, symbol, excludedDefinition: definition, sha256: sha(source), actualConsumption: 'baseline owner/socket/public client/compiled CLI discovery-to-context and SSH stdio cases' })
  }
  const farm = files(join(root, 'packages/core/src')).filter(p => /\.[cm]?[jt]sx?$/.test(p)).filter(p => /\bfarm\b/i.test(readFileSync(p, 'utf8')))
  assert.deepEqual(farm, []); receipt.platformScan = { productionRoot: 'packages/core/src', farmMatches: farm }
  for (const [path, hash] of Object.entries(inputs)) assert.equal(sha(readFileSync(join(root, path))), hash)
  receipt.passed = true
} catch (error) { receipt.error = String(error); process.exitCode = 1 }
finally {
  rmSync(copy, { recursive: true, force: true }); receipt.cleanup = { privateSourceRemoved: !existsSync(copy), sharedSourceMutations: 0, evidencePreserved: true }
  writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, receipt: relative(root, receiptFile), error: receipt.error ?? null }))
}
