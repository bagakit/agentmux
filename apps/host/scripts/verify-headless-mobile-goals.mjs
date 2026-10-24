import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { goalMutations } from '../test/mobile-goals-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..'), directory = resolve(root, '.local/state/mobile-independent-host/goals')
await mkdir(directory, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const harnessPaths = ['apps/host/scripts/verify-headless-mobile-goals.mjs', 'apps/host/test/mobile-desktop-goals.test.ts', 'apps/host/test/mobile-goals-mutations.mjs',
  'apps/host/test/vitest.mobile-goals.config.mts', 'apps/host/test/helpers/mobile-web-fixture.ts', 'apps/host/test/fixtures/mobile-web-host.mjs',
  'apps/host/test/fixtures/mobile-web-main.mjs', 'apps/host/test/mobile-web-node-loader.mjs', 'packages/core/test/helpers/headless-runtime-fixture.ts', 'packages/core/test/fixtures/fake-codex-cli.mjs',
  'packages/demand/src/demand-store.ts', 'packages/demand/src/discussion.ts', 'packages/demand/dist/src/demand-store.js', 'packages/demand/dist/src/discussion.js', 'pnpm-lock.yaml']
const harness = async () => Object.fromEntries(await Promise.all(harnessPaths.map(async path => [path, hash(await readFile(resolve(root, path)))])))
const conditions = { node: process.version, platform: process.platform, architecture: process.arch,
  input: 'Private original ctxmux/Node Main/Host, encrypted Relay, deterministic fake native Provider, actual compiled CLI; primary Mote and Goals created by original private owners.' }
const expectedHarness = await harness(), sourceHashes = new Map(), runs = []
for (const label of ['baseline', ...Object.keys(goalMutations), 'restored']) {
  assert.deepEqual(await harness(), expectedHarness, 'Each run must use the same exact harness and inputs')
  const mutant = Object.hasOwn(goalMutations, label), loaded = resolve(directory, label + '-loaded.jsonl'), result = resolve(directory, label + '-result.json')
  await writeFile(loaded, '')
  const run = await new Promise((accept, reject) => {
    const child = spawn('pnpm', ['exec', 'vitest', 'run', '--config', 'apps/host/test/vitest.mobile-goals.config.mts', '--reporter=json', '--outputFile=' + result], {
      cwd: root, env: { ...process.env, MOBILE_GOALS_TEST_MUTANT: mutant ? label : '', MOBILE_GOALS_TEST_LOADED: loaded }, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''; child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
    child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, output }))
  })
  await writeFile(resolve(directory, label + '.log'), run.output)
  assert.equal(run.signal, null)
  const report = JSON.parse(await readFile(result, 'utf8'))
  assert.equal(report.numTotalTests, 1, 'The actual Relay/Desktop-exit/Host-restart goals consumer must execute')
  const evaluations = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.deepEqual(await harness(), expectedHarness, 'The harness changed while this run executed')
  for (const row of evaluations) {
    assert.ok(['node-loader', 'vitest-transform'].includes(row.surface), 'Each actual evaluation must name its input transform surface')
    const key = row.surface + ':' + row.path, previous = sourceHashes.get(key)
    if (previous) assert.equal(row.originalSHA256, previous, 'Every evaluated owner must stay on its original candidate for every run on that transform surface: ' + key)
    else sourceHashes.set(key, row.originalSHA256)
  }
  const failures = report.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed')
  if (mutant) {
    assert.notEqual(run.code, 0, 'The implementation mutation must be detected')
    assert.ok(failures.some(test => test.failureMessages.some(message => message.includes('AssertionError') || message.includes('__VITEST_REJECTS__') || message.includes('__VITEST_RESOLVES__'))), 'The actual consumer must detect the changed owner, not a build or loader error')
    assert.ok(evaluations.some(row => row.mutant === label && row.originalSHA256 !== row.loadedSHA256), 'The exact changed source must actually execute')
  } else {
    assert.equal(run.code, 0, run.output); assert.equal(report.numPassedTests, 1)
    for (const path of ['apps/host/src/goals.ts', 'apps/host/src/goal-runtime.ts', 'apps/host/src/continuous-progress-loop-manager.ts', 'apps/host/src/goal-automation-pause.ts', 'apps/desktop/src/main/desktop-goals.ts', 'apps/host/src/goal-discussions.ts', 'apps/host/src/goal-participation-owner.ts', 'packages/core/src/client.ts', 'packages/demand/dist/src/demand-store.js', 'packages/demand/dist/src/discussion.js']) assert.ok(evaluations.some(row => row.path === path), 'Original owner must execute: ' + path)
  }
  runs.push({ label, conditions, harness: expectedHarness, code: run.code, passed: report.numPassedTests, failed: report.numFailedTests, evaluations })
  process.stdout.write(JSON.stringify({ label, code: run.code, passed: report.numPassedTests, failed: report.numFailedTests }) + '\n')
}
await writeFile(resolve(directory, 'receipt.json'), JSON.stringify({ schema: 'agentmux.headless-mobile-goals.v1', scope: 'Private official ctxmux, real Node Host/Main and encrypted Relay; original Goal/Session continuation, cancel-only input intent and CLI consumers with Desktop exit and Host restart. No live App or physical phone.', conditions, harness: expectedHarness, originalSourceHashes: Object.fromEntries(sourceHashes), runs }, null, 2) + '\n')
