import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2)
const suite = args[args.indexOf('--suite') + 1], mode = args.includes('--mutations') ? 'mutations' : 'positive'
const directory = resolve(root, '.local/state/hook-durable-runtime-proof')
const core = path => 'packages/core/' + path, test = path => core('test/' + path)
const source = path => path.startsWith('packages/') ? path : core('src/' + path)
const worker = core('dist/agentmux-hook.mjs'), self = core('scripts/verify-hook-runtime-durability.mjs'), base = test('vitest.hook-environment.config.mts')
const grokScript = core('scripts/verify-grok-hook-binding.mjs')
const grokInputs = ['packages/providers/src/grok/provider.ts', 'providers/shared.ts', 'client.ts', 'managed-hook-runtime.ts', 'managed-hook-installer.ts'].map(source)
  .concat([test('providers/grok-hook-binding.native.test.ts'), test('vitest.grok-hook-binding.config.mts'), grokScript])
  .concat([test('fixtures/grok-hook-core-host.mjs')])
const regressions = ['managed-hook-installer', 'doctor-hook-installation', 'hook-delivery-recovery', 'provider-event-name-source',
  'unified-identifiers', 'permission-hook-callback'].map(name => test(name + '.test.ts'))
const definitions = {
  environment: { config: 'vitest.hook-environment.config.mts', env: 'AGENTMUX_HOOK_ENVIRONMENT_MUTATION',
    owners: ['providers/execution-environment.ts', 'packages/providers/src/grok/provider.ts', 'client.ts', 'packages/providers/src/gemini/provider.ts', 'packages/providers/src/claude/hook-settings.ts', 'packages/providers/src/claude/workspace-trust.ts', 'packages/providers/src/opencode/provider.ts'],
    inputs: ['agent-provider.ts', 'client.ts', 'providers/execution-environment.ts', 'providers/shared.ts',
      ...['claude', 'claude-native-settings', 'cursor-adapter', 'cursor-history',
        'hermes', 'opencode', 'pi'].map(name => 'providers/' + name + '.ts')].map(source)
      .concat(['packages/providers/src/claude/hook-settings.ts', 'packages/providers/src/claude/workspace-trust.ts'])
      .concat(['antigravity', 'claude', 'copilot', 'gemini', 'droid', 'grok', 'cursor', 'pi', 'opencode', 'hermes'].map(name => 'packages/providers/src/' + name + '/provider.ts')),
    tests: ['provider-hook-environment.test.ts', 'claude-hook-activation.test.ts'],
    mutants: ['ignore-home', 'inherit-unset', 'drop-provider-env', 'core-cwd-relative', 'ignore-gemini-home', 'drop-inspect-unset',
      'ignore-claude-inspection-home', 'ignore-claude-trust-env', 'ignore-grok-home', 'trim-opencode-override'] },
  runtime: { config: 'vitest.managed-hook-runtime.config.mts', env: 'AGENTMUX_HOOK_RUNTIME_MUTATION', owners: ['managed-hook-runtime.ts'],
    inputs: ['managed-hook-runtime.ts', 'runtime-paths.ts', 'client.ts', 'agent-provider.ts', 'providers/shared.ts', 'hook-server.ts',
      'providers/claude.ts', 'providers/claude-plugin.ts', 'packages/providers/src/claude/provider.ts', 'packages/providers/src/claude/native-activity.ts', 'providers/codex.ts', 'providers/codex-hook-services.ts', 'packages/providers/src/codex/launch-hooks.ts'].map(source),
    tests: ['managed-hook-runtime.test.ts', 'launch-scoped-hook-environment.test.ts', 'codex-claude-retained-hook.test.ts',
      'fixtures/codex-claude-retained-hook.py', 'vitest.codex-claude-retained-hook.config.mts', 'vitest.hook-runtime-core.config.mts'],
    extras: [core('scripts/verify-codex-claude-retained-hook.mjs')],
    mutants: ['source-paths', 'unretained-worker', 'framework-omitted', 'interpreter-per-worker'],
    filters: { 'source-paths': 'runs the real bundled worker', 'unretained-worker': 'runs the real bundled worker',
      'framework-omitted': 'retains the actual Electron Framework', 'interpreter-per-worker': 'retains both immutable worker revisions' } },
  bridge: { config: 'vitest.managed-hook-bridge.config.mts', env: 'AGENTMUX_HOOK_BRIDGE_MUTATION', owners: ['providers/shared.ts', 'managed-hook-installer.ts'],
    inputs: ['providers/shared.ts', 'managed-hook-installer.ts', 'hook-config-merge.ts', 'agent-hook-command.ts', 'agent-hook-delivery.ts',
      'hook-passive-response.ts', 'hook-server.ts'].map(source), tests: ['managed-hook-bridge.test.ts'], extras: grokInputs,
    mutants: ['drop-launch-mark', 'borrow-foreign-provider', 'persist-installation-path', 'retire-live-callback', 'forget-owned-callback'] },
  opencode: { config: 'vitest.opencode-hook-binding.config.mts', owners: ['packages/providers/src/opencode/provider.ts'],
    inputs: ['packages/providers/src/opencode/provider.ts', 'providers/execution-environment.ts', 'agent-provider.ts', 'client.ts', 'hook-server.ts',
      'agent-hook-delivery.ts', 'hook-normalizer.ts', 'managed-hook-installer.ts'].map(source),
    tests: ['providers/opencode.test.ts', 'providers/opencode-hook-binding.test.ts', 'providers/opencode-hook-binding.native.test.ts',
      'fixtures/opencode-hook-hosts.py'], extras: [core('scripts/verify-opencode-hook-binding.mjs')],
    mutants: ['last-binding-wins', 'foreign-host-admitted', 'external-host-claimed', 'persist-run-environment'] }
}
assert(definitions[suite] || suite === 'integration', 'Choose --suite environment|runtime|bridge|opencode|integration')
assert(suite !== 'integration' || mode === 'positive', 'Integration joins positive and mutation gates')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const hash = async path => sha(await readFile(isAbsolute(path) ? path : join(root, path)))
const json = async path => JSON.parse(await readFile(isAbsolute(path) ? path : join(root, path), 'utf8'))
const snapshot = async paths => Object.fromEntries(await Promise.all([...new Set(paths)].sort().map(async path => [path, await hash(path)])))
const suitePaths = name => [self, worker, base, 'vitest.setup.ts', core('scripts/build-hook-worker.mjs'), test(definitions[name].config),
  ...definitions[name].inputs, ...definitions[name].tests.map(test), ...(definitions[name].extras ?? []),
  ...(name === 'opencode' && environment.AGENTMUX_OPENCODE_NATIVE_BINARY ? [environment.AGENTMUX_OPENCODE_NATIVE_BINARY] : []),
  ...(name === 'bridge' && environment.AGENTMUX_GROK_NATIVE_BINARY ? [environment.AGENTMUX_GROK_NATIVE_BINARY] : [])]
const gatePath = (name, kind) => join(directory, name, kind, 'gate.json')
async function currentMap(value) { return value && Object.keys(value).length > 0 && JSON.stringify(await snapshot(Object.keys(value))) === JSON.stringify(Object.fromEntries(Object.entries(value).sort())) }
async function validGate(name, kind) {
  try {
    const value = await json(gatePath(name, kind))
    assert.equal(value.schema, 'agentmux.hook-gate.v1'); assert.equal(value.passed, true)
    assert.equal(value.suite, name); assert.equal(value.mode, kind); assert.deepEqual(value.inputs, await snapshot(suitePaths(name)))
    assert(value.checks.length && value.checks.every(check => check.assertions > 0 && check.qualified === true))
    assert(value.artifacts.length > 0)
    for (const item of value.artifacts) assert.equal(await hash(item.path), item.sha256)
    return value
  } catch { return null }
}
const privateRoot = await mkdtemp(join(tmpdir(), 'amx-hook-proof-')), evidence = join(directory, suite, mode)
await mkdir(evidence, { recursive: true }); await mkdir(join(privateRoot, 'home'))
const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))),
  HOME: join(privateRoot, 'home'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state'), AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'),
  AGENTMUX_MESSAGE_QUEUE_PATH: join(privateRoot, 'messages.ndjson'), AGENTMUX_AGENT_SESSION_STORE: join(privateRoot, 'sessions.json') }
for (const name of ['AGENTMUX_OPENCODE_NATIVE_BINARY', 'AGENTMUX_GROK_NATIVE_BINARY']) if (process.env[name]) environment[name] = process.env[name]
for (const [flag, key] of [['--opencode-binary', 'AGENTMUX_OPENCODE_NATIVE_BINARY'], ['--grok-binary', 'AGENTMUX_GROK_NATIVE_BINARY']]) {
  const index = args.indexOf(flag); if (index >= 0) { assert(args[index + 1], flag + ' requires a path'); environment[key] = resolve(args[index + 1]) }
}
const artifacts = [], checks = []
async function artifact(path) { artifacts.push({ path: relative(root, path), sha256: await hash(path) }) }
async function command(label, commandArgs, env = {}) {
  const chunks = [], child = spawn(process.execPath, commandArgs, { cwd: root, env: { ...environment, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const output of [child.stdout, child.stderr]) output.on('data', bytes => { chunks.push(bytes); process.stdout.write(bytes) })
  const code = await new Promise((yes, no) => { child.once('error', no); child.once('close', yes) })
  const log = join(evidence, label + '.log'); await writeFile(log, Buffer.concat(chunks)); await artifact(log)
  return code
}
function qualify(report, red = false, framework = false) {
  assert(report.numTotalTests > 0 && (report.numRuntimeErrorTestSuites ?? 0) === 0 && !(report.unhandledErrors ?? []).length, 'Empty or unhandled-error proof')
  const assertions = report.testResults.flatMap(file => file.assertionResults ?? [])
  if (!red) assert(report.numPassedTests > 0 && report.numFailedTests === 0 && assertions.some(item => item.status === 'passed'), 'No passing semantic assertion')
  else {
    const failed = assertions.filter(item => item.status === 'failed')
    assert(report.numFailedTests > 0 && failed.length > 0, 'Mutation must fail actual assertions')
    assert(failed.every(item => item.failureMessages?.some(message => /AssertionError/.test(message) ||
      framework && /_Assertion\.__VITEST_RESOLVES__/.test(message) && /managed-hook-runtime\.test\.ts:266/.test(message))),
    'Loader, timeout, ENOENT or resource failures are not semantic mutation RED')
  }
  return assertions.filter(item => item.status === (red ? 'failed' : 'passed')).length
}
async function loadedOwner(entries, mutation) {
  assert(entries.length, 'No production owner was loaded')
  for (const entry of entries) {
    const path = isAbsolute(entry.path) ? relative(root, entry.path) : entry.path, original = entry.originalSHA256 ?? entry.sourceSHA256
    assert(path.startsWith('packages/core/src/'), 'Loaded proof must name a production owner')
    assert.equal(original, await hash(path), 'Loaded owner is stale: ' + path)
    if (mutation) assert((entry.mutation ?? entry.mutant) === mutation && entry.loadedSHA256 !== original && entry.applied !== false, 'Actual owner mutant was not loaded')
    else assert.equal(entry.loadedSHA256, original, 'Positive owner was changed')
  }
}
async function runTests(config, label, mutation, filter, include) {
  const loaded = join(evidence, label + '.loaded.jsonl'), reportPath = join(evidence, label + '.json')
  await writeFile(loaded, '')
  const definition = definitions[suite], owners = (definition?.owners ?? ['client.ts']).map(source), wrapper = join(privateRoot, label + '.config.mts')
  await writeFile(wrapper, `import base from ${JSON.stringify(pathToFileURL(join(root, test(config))).href)};\n` +
    `import{appendFileSync,readFileSync}from'node:fs';import{createHash}from'node:crypto';import{relative}from'node:path';\n` +
    `export default {...base,plugins:[...(base.plugins??[]),{name:'gate-loaded-owner',enforce:'pre',transform(code,id){const path=relative(${JSON.stringify(root)},id.split('?')[0]);if(!${JSON.stringify(owners)}.includes(path))return;const hash=x=>createHash('sha256').update(x).digest('hex');appendFileSync(${JSON.stringify(loaded)},JSON.stringify({path,mutation:${JSON.stringify(mutation ?? null)},originalSHA256:hash(readFileSync(id.split('?')[0])),loadedSHA256:hash(code)})+'\\n')}}],test:{...base.test,${include ? `include:${JSON.stringify(include)},` : ''}passWithNoTests:false}};\n`)
  const code = await command(label, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', wrapper,
    '--reporter=default', '--reporter=json', '--outputFile=' + reportPath, ...(filter ? ['-t', filter] : [])], mutation ? { [definition.env]: mutation } : {})
  const report = await json(reportPath), count = qualify(report, !!mutation, mutation === 'framework-omitted')
  assert(mutation ? code !== 0 : code === 0, 'Unexpected semantic proof exit')
  assert(!/Unhandled Errors|Unhandled Rejection|Uncaught Exception/i.test(await readFile(join(evidence, label + '.log'), 'utf8')), 'Unhandled process error is not proof')
  const entries = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  await loadedOwner(mutation ? entries.filter(item => item.loadedSHA256 !== item.originalSHA256) : entries, mutation)
  await artifact(reportPath); await artifact(loaded)
  checks.push({ label, assertions: count, qualified: true, semanticRed: !!mutation, loaded: entries })
}
async function publisherReceipt() {
  try {
    const prefix = join(root, '.local/state/hook-runtime-proof'), path = join(prefix, 'verified-receipt.json'), value = await json(path)
    assert(await currentMap(value.candidateInputs)); assert.equal(value.baseline.passed, 7); assert.equal(value.baseline.failed, 0)
    await loadedOwner(value.baseline.loaded)
    for (const name of definitions.runtime.mutants) {
      const mutant = value.mutants.find(item => item.name === name)
      assert(mutant?.semanticAssertion && mutant.failedAssertions > 0); await loadedOwner(mutant.loaded, name)
      qualify(await json(join(prefix, name + '.json')), true, name === 'framework-omitted'); await artifact(join(prefix, name + '.json'))
    }
    const child = value.mutants.find(item => item.name === 'source-paths-child')
    assert(child.loaded.some(item => item.stage === 'esbuild-owner')); await loadedOwner(child.loaded, 'source-paths')
    qualify(await json(join(prefix, 'baseline2.json'))); await artifact(join(prefix, 'baseline2.json')); await artifact(path)
    return value
  } catch { return null }
}
async function nativeCarriers() {
  const prefix = join(root, '.local/hook-durability/codex-claude-proof'), path = join(prefix, 'positive.json'), receipt = join(prefix, 'native-cases.json')
  let value
  try { value = await json(path); assert(value.passed && await currentMap(value.productionAndTestSHA256)); assert.equal(value.receiptSHA256, await hash(receipt)) }
  catch { assert.equal(await command('native-codex-claude', [join(root, core('scripts/verify-codex-claude-retained-hook.mjs'))]), 0); value = await json(path) }
  assert(value.passed && await currentMap(value.productionAndTestSHA256)); assert.equal(value.receiptSHA256, await hash(receipt))
  const cases = await json(receipt)
  assert.equal(cases.length, 6)
  assert.deepEqual(cases.map(item => item.providerId + '/' + item.mode).sort(),
    ['claude/allow-once', 'claude/no-decision', 'claude/reject-once', 'codex/allow-once', 'codex/no-decision', 'codex/reject-once'])
  assert(cases.every(item => item.childrenReaped && item.privateSourceRemoved && item.originalNativeSessionId))
  await artifact(path); await artifact(receipt); checks.push({ label: 'native-codex-claude-retained-worker', assertions: 6, qualified: true })
}
async function grokProof(kind) {
  assert.equal(await command('grok-' + kind, [join(root, grokScript), ...(kind === 'mutations' ? ['--mutations'] : kind === 'compiled' ? ['--compiled'] : [])]), 0)
  const prefix = join(root, '.local/hook-durability/grok-proof'), path = join(prefix, (kind === 'compiled' ? 'compiled-positive' : kind) + '.json'), value = await json(path)
  assert(value.passed && value.workerSHA256 === await hash(worker) && value.binarySHA256 === await hash(value.binary)); assert.equal(value.results.length, kind === 'mutations' ? 3 : 1)
  for (const result of value.results) {
    assert(await currentMap(result.baseline)); assert(await currentMap(result.fixtureHashes))
    const red = kind === 'mutations'
    if (kind !== 'compiled') await loadedOwner(result.loaded.filter(item => !red || item.applied), red ? result.label : undefined)
    const reportPath = join(prefix, result.label + '.vitest.json'), count = qualify(await json(reportPath), red)
    await artifact(reportPath); checks.push({ label: 'grok-' + result.label, assertions: count, qualified: true, semanticRed: red, loaded: result.loaded })
  }
  await artifact(path); if (kind !== 'mutations') await artifact(join(prefix, kind === 'compiled' ? 'compiled-native-receipt.json' : 'native-receipt.json'))
}
try {
  if (suite === 'integration') {
    for (const name of Object.keys(definitions)) for (const kind of ['positive', 'mutations']) {
      const gate = await validGate(name, kind); assert(gate, `Current ${name}/${kind} gate is missing or stale; run that exact suite first`)
      await artifact(gatePath(name, kind)); checks.push({ label: name + '/' + kind, assertions: gate.checks.reduce((sum, item) => sum + item.assertions, 0), qualified: true })
    }
    const inputs = await snapshot(Object.keys(definitions).flatMap(suitePaths).concat(regressions, grokInputs))
    await grokProof('compiled'); await runTests('vitest.hook-environment.config.mts', 'affected-regressions', undefined, undefined, regressions)
    assert.deepEqual(await snapshot(Object.keys(inputs)), inputs, 'Integration inputs changed during proof')
    await writeFile(gatePath(suite, mode), JSON.stringify({ schema: 'agentmux.hook-gate.v1', suite, mode, passed: true, inputs, checks, artifacts }, null, 2) + '\n')
  } else if (await validGate(suite, mode)) console.log(JSON.stringify({ suite, mode, reused: true }))
  else {
    const definition = definitions[suite], inputs = await snapshot(suitePaths(suite))
    if (suite === 'opencode') {
      assert.equal(await command('opencode-' + mode, [join(root, core('scripts/verify-opencode-hook-binding.mjs')), ...(mode === 'mutations' ? ['--mutations'] : [])]), 0)
      const prefix = join(root, '.local/hook-durability/opencode-proof'), proofPath = join(prefix, mode + '.json'), value = await json(proofPath)
      assert(value.passed && value.ownerSHA256 === await hash(source('packages/providers/src/opencode/provider.ts')))
      for (const label of mode === 'mutations' ? definition.mutants : ['positive']) {
        const entries = (await readFile(join(prefix, label + '.loaded.ndjson'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
        await loadedOwner(entries, mode === 'mutations' ? label : undefined)
        const reportPath = join(prefix, label + '.vitest.json'), count = qualify(await json(reportPath), mode === 'mutations')
        assert(!/Unhandled Errors|Unhandled Rejection|Uncaught Exception/i.test(await readFile(join(prefix, label + '.log'), 'utf8')))
        await artifact(reportPath); await artifact(join(prefix, label + '.loaded.ndjson'))
        checks.push({ label, assertions: count, qualified: true, semanticRed: mode === 'mutations', loaded: entries })
      }
      await artifact(proofPath); if (mode === 'positive') await artifact(join(prefix, 'native-receipt.json'))
    } else if (suite === 'runtime') {
      const reused = await publisherReceipt()
      if (reused) checks.push({ label: 'qualified-publisher-' + mode, assertions: mode === 'positive' ? 7 : 4, qualified: true, semanticRed: mode === 'mutations', reused: true })
      else if (mode === 'positive') await runTests(definition.config, 'publisher')
      else for (const name of definition.mutants) await runTests(definition.config, name, name, definition.filters[name])
      if (mode === 'positive') { await nativeCarriers(); await runTests('vitest.hook-runtime-core.config.mts', 'core-lifecycle') }
    } else {
      if (mode === 'positive') await runTests(definition.config, suite)
      else for (const name of definition.mutants) await runTests(definition.config, name, name)
      if (suite === 'bridge') await grokProof(mode)
    }
    assert.deepEqual(await snapshot(Object.keys(inputs)), inputs, 'Suite inputs changed during proof')
    await writeFile(gatePath(suite, mode), JSON.stringify({ schema: 'agentmux.hook-gate.v1', suite, mode, passed: true, inputs, checks, artifacts }, null, 2) + '\n')
  }
  console.log(JSON.stringify({ suite, mode, passed: true, gate: gatePath(suite, mode) }))
} finally { await rm(privateRoot, { recursive: true, force: true }) }
