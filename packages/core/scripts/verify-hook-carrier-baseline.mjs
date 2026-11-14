import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile), root = resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2)
const suite = args[args.indexOf('--suite') + 1], mode = args.includes('--mutations') ? 'mutations' : 'positive'
assert(['shell', 'hermes', 'pi', 'integration'].includes(suite), 'Choose --suite shell|hermes|pi|integration')
assert(suite !== 'integration' || mode === 'positive')
const base = 'packages/core/', src = name => base + 'src/' + name + '.ts', test = name => base + 'test/' + name
const self = base + 'scripts/verify-hook-carrier-baseline.mjs'
const common = [self, src('client'), src('hook-config-merge'), src('managed-hook-installer'), src('managed-hook-runtime'),
  src('agent-provider'), src('hook-normalizer'), src('hook-server'), src('providers/shared'), src('hook-passive-response'),
  base + 'dist/agentmux-hook.mjs', test('vitest.hook-environment.config.mts')]
const owners = {
  shell: common.concat(['gemini', 'antigravity', 'cursor', 'copilot', 'droid'].map(name => src('providers/' + name)),
    [test('hook-carrier-baseline.test.ts'), test('vitest.hook-carrier-baseline.config.mts'),
      test('providers/gemini-hook-binding.native.test.ts'), test('fixtures/gemini-hook-native-host.mjs'), base + 'scripts/verify-gemini-hook-binding.mjs']),
  hermes: common.concat([src('providers/hermes'), test('providers/hermes-hook-binding.native.test.ts'), base + 'scripts/verify-hermes-hook-binding.mjs']),
  pi: common.concat([src('providers/pi'), test('providers/pi-hook-binding.test.ts'), base + 'scripts/verify-pi-hook-binding.mjs'])
}
owners.hermes.push(test('fixtures/hermes-native-hooks.py'), test('vitest.hermes-hook-binding.config.mts'), test('providers/hermes.test.ts'))
owners.pi.push(test('providers/pi-hook-binding.native.test.ts'), test('vitest.pi-hook-binding.config.mts'), test('providers/pi.test.ts'))
const sha = value => createHash('sha256').update(value).digest('hex')
const file = path => isAbsolute(path) ? path : join(root, path)
const json = async path => JSON.parse(await readFile(file(path), 'utf8'))
const snapshot = async paths => Object.fromEntries(await Promise.all([...new Set(paths)].sort().map(async path => [path, sha(await readFile(file(path)))])))
const directory = join(root, '.local/state/hook-carrier-baseline-proof'), evidence = join(directory, suite, mode)
await mkdir(evidence, { recursive: true })
const privateRoot = await mkdtemp(join(tmpdir(), 'amx-carrier-proof-')); await mkdir(join(privateRoot, 'home'))
const env = { PATH: process.env.PATH, HOME: join(privateRoot, 'home'), LANG: 'en_US.UTF-8',
  AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state'), AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'),
  AGENTMUX_AGENT_SESSION_STORE: join(privateRoot, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(privateRoot, 'messages.ndjson') }
const checks = [], artifacts = []
async function artifact(path) { artifacts.push({ path: relative(root, file(path)), sha256: sha(await readFile(file(path))) }) }
async function command(label, argv, overrides = {}) {
  let result
  try { result = { ...(await exec(process.execPath, argv, { cwd: root, env: { ...env, ...overrides }, maxBuffer: 8 * 1024 * 1024 })), code: 0 } }
  catch (error) { result = { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code } }
  const log = join(evidence, label + '.log'); await writeFile(log, result.stdout + result.stderr); await artifact(log)
  return result
}
function qualify(report, red) {
  assert(report.numTotalTests > 0 && !(report.unhandledErrors ?? []).length && !(report.numRuntimeErrorTestSuites ?? 0), 'Empty or failed test loading')
  const selected = report.testResults.flatMap(value => value.assertionResults ?? []).filter(value => value.status === (red ? 'failed' : 'passed'))
  assert(selected.length > 0, 'No actual semantic assertions')
  if (red) assert(selected.every(value => value.failureMessages.some(message => message.includes('AssertionError'))), 'Resource/loader/timeout failures do not kill a mutant')
  else assert.equal(report.numFailedTests, 0)
  return selected.length
}
async function tests(config, label, mutation, filter) {
  const reportPath = join(evidence, label + '.json'), loadedPath = join(evidence, label + '.loaded.jsonl')
  await writeFile(loadedPath, '')
  const result = await command(label, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', file(test(config)),
    '--reporter=json', '--outputFile=' + reportPath, ...(filter ? ['-t', filter] : [])], {
    AGENTMUX_HOOK_CARRIER_LOADED: loadedPath, ...(mutation ? { AGENTMUX_HOOK_CARRIER_MUTATION: mutation } : {}) })
  assert(mutation ? result.code !== 0 : result.code === 0, result.stdout + result.stderr)
  const count = qualify(await json(reportPath), Boolean(mutation))
  if (config === 'vitest.hook-carrier-baseline.config.mts') {
    const loaded = (await readFile(loadedPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    assert(loaded.length > 0)
    for (const entry of loaded) assert.equal(entry.originalSHA256, sha(await readFile(file(entry.path))), 'Stale loaded source')
    if (mutation) assert(loaded.some(value => value.mutation === mutation && value.loadedSHA256 !== value.originalSHA256), 'Selected actual owner was not mutated')
    await artifact(loadedPath)
  }
  await artifact(reportPath); checks.push({ label, assertions: count, qualified: true, semanticRed: Boolean(mutation) })
}
async function native(name, red = false, compiled = false) {
  const result = await command(name + (red ? '-mutations' : ''), [file(base + 'scripts/verify-' + name + '-hook-binding.mjs'),
    ...(red ? ['--mutations'] : []), ...(compiled ? ['--compiled'] : [])])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  if (name === 'grok') {
    const path = '.local/hook-durability/grok-proof/compiled-positive.json', proof = await json(path)
    assert(proof.passed && proof.results.length > 0)
    const receipt = await json('.local/hook-durability/grok-proof/compiled-native-receipt.json')
    assert(receipt.compiledSourceRemovedAfterLaunch && receipt.firstCoreExitedBeforeSourceRemoval && receipt.sameRunReattached && receipt.oldLaunchBindingDeliveredStop)
    assert(receipt.firstCorePid !== receipt.secondCorePid)
    await artifact(path); await artifact('.local/hook-durability/grok-proof/compiled-native-receipt.json')
    checks.push({ label: 'compiled-Core-replacement-and-source-removal', assertions: 1, qualified: true }); return
  }
  const path = '.local/state/' + name + '-hook-binding-proof/' + (red ? 'mutations' : 'positive') + '.json'
  const proof = await json(path)
  const assertions = proof.assertions
  assert(proof.passed && typeof assertions === 'number' && assertions > 0 && Object.keys(proof.inputs).length > 0, 'Native proof must contain actual assertions and input identity')
  assert.deepEqual(await snapshot(Object.keys(proof.inputs)), Object.fromEntries(Object.entries(proof.inputs).sort()))
  await artifact(path); checks.push({ label: name + '/' + (red ? 'mutations' : 'positive'), assertions, qualified: true })
}
async function gate(name, kind) {
  const path = join(directory, name, kind, 'gate.json'), value = await json(path)
  assert(value.passed && value.checks.length > 0 && value.checks.every(check => check.qualified && check.assertions > 0))
  assert.deepEqual(await snapshot(Object.keys(value.inputs)), value.inputs, 'Stale ' + name + '/' + kind + ' gate')
  for (const item of value.artifacts) {
    assert.equal(sha(await readFile(file(item.path))), item.sha256)
    if (item.path.endsWith('.json')) {
      const proof = await json(item.path)
      if (proof.inputs) assert.deepEqual(await snapshot(Object.keys(proof.inputs)), Object.fromEntries(Object.entries(proof.inputs).sort()),
        'Stale referenced proof inputs: ' + item.path)
    }
  }
  await artifact(path); checks.push({ label: name + '/' + kind, assertions: value.checks.reduce((sum, check) => sum + check.assertions, 0), qualified: true })
}
try {
  const regressionConfig = test('vitest.hook-carrier-regression.config.mts')
  const regressionTests = [...(await readFile(file(regressionConfig), 'utf8')).matchAll(/'((?:packages\/core\/test\/)[^']+\.test\.ts)'/gu)].map(match => match[1])
  assert(regressionTests.length > 0, 'Regression suite must select real consumers')
  const inputs = await snapshot(suite === 'integration' ? [...Object.values(owners).flat(), regressionConfig, ...regressionTests,
    src('doctor'), src('public-rpc-service'), test('helpers/public-rpc-owner.ts'),
    base + 'scripts/verify-grok-hook-binding.mjs', test('fixtures/grok-hook-core-host.mjs'), test('providers/grok-hook-binding.native.test.ts')] : owners[suite])
  if (suite === 'shell') {
    if (mode === 'positive') { await tests('vitest.hook-carrier-baseline.config.mts', 'shell'); await native('gemini') }
    else for (const [mutation, filter] of [
      ['volatile-shell-command', 'preserves old and foreign'], ['shell-runtime-unretained', 'gemini public Core'],
      ['native-timeout-unit', 'gemini preserves'],
      ['key-overwrites-callbacks', 'antigravity preserves'], ['forget-native-container', 'antigravity preserves'],
      ['conflate-container-ownership', 'separates two native event containers']]) await tests('vitest.hook-carrier-baseline.config.mts', mutation, mutation, filter)
  } else if (suite === 'integration') {
    for (const name of Object.keys(owners)) for (const kind of ['positive', 'mutations']) await gate(name, kind)
    await tests('vitest.hook-carrier-regression.config.mts', 'affected-regressions')
    await native('grok', false, true)
  } else await native(suite, mode === 'mutations')
  assert.deepEqual(await snapshot(Object.keys(inputs)), inputs, 'Candidate changed during verification')
  await writeFile(join(evidence, 'gate.json'), JSON.stringify({ schema: 'agentmux.hook-carrier-baseline-proof.v1', suite, mode,
    passed: true, inputs, checks, artifacts }, null, 2) + '\n')
  console.log(JSON.stringify({ suite, mode, passed: true, assertions: checks.reduce((sum, value) => sum + value.assertions, 0), evidence }))
} finally { await rm(privateRoot, { recursive: true, force: true }) }
