import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(root, '.local/state/codex-native-queue-contract')
await mkdir(evidence, { recursive: true })
const config = 'packages/core/test/vitest.codex-native-queue-contract.config.mts'
const unit = 'packages/core/test/codex-durable-queue.test.ts'
const actor = 'packages/core/test/codex-idle-queue.test.ts'
const native = 'packages/core/test/codex-durable-queue-native.test.ts'
const sources = ['packages/core/src/providers/codex-native-queue.ts',
  'packages/core/src/providers/codex-native-input.ts', 'packages/core/src/providers/codex-native-rpc.ts',
  'packages/core/src/providers/app-server-native-session.ts', 'packages/core/src/agent-native-process.ts',
  'packages/core/test/fixtures/codex-queue-rpc.mjs', config, unit, actor, native]
const sha = value => createHash('sha256').update(value).digest('hex')
const inputs = Object.fromEntries(await Promise.all(sources.map(async file => [file, sha(await readFile(resolve(root, file)))])))
const suites = []
async function suite(name, files, { mutation, pattern, binary, version } = {}) {
  const output = resolve(evidence, name + '.json'), loaded = resolve(evidence, name + '.loaded.jsonl')
  await writeFile(loaded, '')
  const args = [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, ...files,
    '--reporter=json', '--outputFile=' + output, ...(pattern ? ['--testNamePattern', pattern] : [])]
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env,
    AGENTMUX_QUEUE_CONTRACT_LOADED: loaded, AGENTMUX_QUEUE_CONTRACT_MUTATION: mutation ?? '',
    ...(binary ? { AGENTMUX_TEST_CODEX_BINARY: binary, AGENTMUX_TEST_CODEX_VERSION: version } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', value => { log += value }); child.stderr.on('data', value => { log += value })
  const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) })
  await writeFile(resolve(evidence, name + '.log'), log)
  const result = JSON.parse(await readFile(output, 'utf8'))
  assert.ok(result.numTotalTests > 0 && result.testResults.length > 0, name + ': nonempty actual consumers required')
  const loads = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(loads.length > 0, name + ': actual Provider source must load')
  if (mutation) {
    assert.notEqual(code, 0, name + ': mutation survived')
    const failed = result.testResults.flatMap(file => file.assertionResults ?? []).filter(test => test.status === 'failed')
    assert.ok(failed.some(test => test.failureMessages.some(message => /AssertionError|expected |promise resolved[\s\S]*instead of rejecting/u.test(message))), name + ': a product assertion must kill the loaded mutation')
    assert.ok(loads.some(value => value.originalSHA256 !== value.loadedSHA256 && value.mutation === mutation), name + ': mutated Provider source must actually load')
  } else {
    assert.equal(code, 0, name + ': see ' + relative(root, resolve(evidence, name + '.log')))
    assert.equal(result.success, true)
    assert.ok(result.numPassedTests > 0)
  }
  const receipt = { name, mutation: mutation ?? null, passed: result.numPassedTests, failed: result.numFailedTests,
    result: relative(root, output), ...(binary ? { binary, version } : {}) }
  suites.push(receipt)
  process.stdout.write(name + ': ' + (mutation ? 'mutation killed' : 'passed') + '\n')
}

await suite('contract-and-authenticated-actor', [unit, actor])
for (const [mutation, pattern] of [
  ['version-gate', 'independently of the 0.169.0'],
  ['skip-queue-contract', 'changed native queue read contract'],
  ['require-peer-correlation', 'does not require platform correlation on an existing'],
  ['lose-correlation', 'keeps correlation admission unknown'],
  ['lose-wire', 'keeps wire admission unknown'],
  ['lose-frozen-target', 'altered frozen wire target'],
  ['borrow-helper-queue', 'changed helperChanged'],
  ['lose-file-identity', 'refuses replace metadata'],
  ['ignore-birth', 'changed birthChanged']
]) await suite(mutation, [unit], { mutation, pattern })

const oldBinary = process.env.AGENTMUX_TEST_CODEX_0167_BINARY
assert.ok(oldBinary, 'Set AGENTMUX_TEST_CODEX_0167_BINARY to an isolated complete Codex 0.167.0 installation; do not replace the user CLI.')
for (const [version, binary] of [['0.167.0', oldBinary], ['0.169.0', process.env.AGENTMUX_TEST_CODEX_0169_BINARY ?? 'codex']]) {
  await suite('native-' + version, [native], { binary, version,
    pattern: 'public A2A reference reaches the original direct native thread' })
}
for (const [file, digest] of Object.entries(inputs)) assert.equal(sha(await readFile(resolve(root, file))), digest, 'Proof input changed: ' + file)
const receipt = { status: 'passed', inputs, suites,
  boundary: 'Source-loaded Provider/Core/public RPC/CLI consumers, two original native executable versions against isolated offline model endpoints, actual OS-bound thread/store and real queue admission. Authenticated live actor and idle-only queue intents remain separate. No user Session, queue, deployment or installation is operated.' }
await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
process.stdout.write(relative(root, resolve(evidence, 'receipt.json')) + '\n')
