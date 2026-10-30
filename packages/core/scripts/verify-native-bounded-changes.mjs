import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = await realpath(resolve(import.meta.dirname, '../../..'))
const directory = resolve(root, process.argv[2] ?? '.bagakit/mote-conversation-start/native-bounded-changes')
await mkdir(directory, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const config = 'packages/core/test/vitest.native-bounded-changes.config.mts'
const test = 'packages/core/test/native-bounded-changes.test.ts'
const mutations = ['native-upper-ignored', 'core-native-upper-dropped', 'captured-upper-ignored',
  'continuation-upper-unchecked', 'upper-source-scope-unchecked', 'sdk-upper-identity-unchecked']
const receipt = { schema: 'agentmux.native-bounded-changes-proof.v1', passed: false, source: {}, runs: [], sourceDrift: [],
  boundary: 'Original Core Client and public ControlServer/RPC consume actual Pi and Claude JSONL readers in private temporary Sessions. Runtime I/O is never started or called. Vite transforms only loaded production source; no on-disk mutation, live Provider/model/Run, compiled CLI, Host Main transition or installation claim.' }
for (const file of [config, test, 'packages/core/test/fixtures/native-history-session.ts',
  'apps/desktop/scripts/candidate-package-resolve.mjs', 'packages/core/scripts/verify-native-bounded-changes.mjs',
  'packages/core/src/control-endpoint-listener-worker.ts', 'packages/core/dist/control-endpoint-listener-worker.js']) receipt.source[file] = hash(await readFile(resolve(root, file)))
const pinned = new Map()
let expectedTests = 0

async function run(label, mutation) {
  const output = resolve(directory, label + '.json'), log = resolve(directory, label + '.log'), loaded = resolve(directory, label + '.loaded.ndjson')
  await writeFile(loaded, '')
  const args = ['node_modules/vitest/vitest.mjs', 'run', '--config', config, '--reporter=json', '--outputFile', output]
  const result = await new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env,
      AGENTMUX_BOUNDED_MUTATION: mutation ?? '', AGENTMUX_BOUNDED_LOADED: loaded }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes })
    child.stderr.on('data', bytes => { stderr += bytes })
    const timer = setTimeout(() => child.kill('SIGTERM'), 120_000)
    child.once('error', reject)
    child.once('close', (code, signal) => { clearTimeout(timer); done({ code, signal, stdout, stderr }) })
  })
  await writeFile(log, result.stdout + result.stderr)
  let report
  try { report = JSON.parse(await readFile(output, 'utf8')) } catch { throw Error(label + ': no original Vitest JSON result; inspect ' + log) }
  const modules = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(modules.length > 0, label + ': empty loaded production source is not evidence')
  const evaluated = modules.filter(item => item.stage === 'evaluated')
  assert.ok(evaluated.length > 0, label + ': transformed-only source was never evaluated')
  for (const item of modules) {
    assert.equal(item.fileSHA256, item.originalSHA256, label + ': expected direct original source, not a dist/map substitute')
    const current = hash(await readFile(resolve(root, item.path)))
    if (current !== item.fileSHA256) receipt.sourceDrift.push({ stage: label, path: item.path, loaded: item.fileSHA256, current })
    if (!pinned.has(item.path)) pinned.set(item.path, item.fileSHA256)
    else if (pinned.get(item.path) !== item.fileSHA256) receipt.sourceDrift.push({ stage: label, path: item.path, baseline: pinned.get(item.path), current: item.fileSHA256 })
  }
  const assertions = report.testResults.flatMap(file => file.assertionResults)
  const failed = assertions.filter(item => item.status === 'failed')
  if (!mutation) {
    assert.equal(result.code, 0, label + ': baseline/restored must pass; inspect ' + log)
    assert.equal(report.success, true)
    assert.ok(report.numTotalTests >= 8 && assertions.length >= 8, label + ': empty or incomplete scenario selection')
    assert.equal(failed.length, 0)
    expectedTests ||= report.numTotalTests
  } else {
    assert.notEqual(result.code, 0, mutation + ': behavior mutant survived')
    assert.equal(result.signal, null, mutation + ': process termination is not an assertion kill')
    assert.equal(report.numTotalTests, expectedTests, mutation + ': import/collection failure is not a kill')
    assert.ok(failed.length > 0, mutation + ': no actual failed consumer assertion')
    for (const failure of failed) {
      const messages = failure.failureMessages.join('\n')
      assert.match(messages, /\bAssertionError\b/u, mutation + ': require behavioral assertion RED, not an import/runtime failure')
      assert.doesNotMatch(messages, /timed out|SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|Failed to load|Transform failed/u)
    }
    const changed = modules.filter(item => item.mutation === mutation)
    assert.ok(changed.some(item => item.stage === 'loaded' && item.originalSHA256 !== item.loadedSHA256), mutation + ': mutation did not alter loaded source')
    assert.ok(changed.some(item => item.stage === 'evaluated' && item.originalSHA256 !== item.loadedSHA256), mutation + ': mutation was not evaluated')
  }
  const run = { label, mutation: mutation ?? null, code: result.code, totalTests: report.numTotalTests,
    passedTests: report.numPassedTests, failedTests: report.numFailedTests,
    failedAssertions: failed.map(item => ({ name: item.fullName, messages: item.failureMessages })),
    result: output, log, loaded, mutated: evaluated.filter(item => item.mutation === mutation),
    source: Object.fromEntries(evaluated.map(item => [item.path, item.fileSHA256])) }
  receipt.runs.push(run)
  await writeFile(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  process.stdout.write(label + ': ' + (mutation ? 'assertion RED' : 'GREEN') + ' (' + report.numTotalTests + ' actual tests)\n')
}

try {
  await run('baseline')
  for (const mutation of mutations) await run(mutation, mutation)
  await run('restored')
  assert.deepEqual(receipt.sourceDrift, [], 'Production candidate changed during proof; the old receipt cannot sign the new source')
  receipt.source = { ...receipt.source, ...Object.fromEntries(pinned) }
  receipt.passed = true
} catch (error) {
  receipt.failure = { name: error.name, message: error.message }
  process.exitCode = 1
} finally {
  await writeFile(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  process.stdout.write(resolve(directory, 'receipt.json') + '\n')
}
