import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { launchSmokeMutations, launchSmokeOwners } from '../test/launch-smoke-connection-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..'), directory = join(root, '.local/state/mobile-independent-host/launch-smoke-connection')
await mkdir(directory, { recursive: true })
const attempt = await mkdtemp(join(directory, 'attempt-')), sha = value => createHash('sha256').update(value).digest('hex')
const harnessPaths = ['apps/desktop/src/main/index.ts', 'apps/desktop/scripts/verify-launch-smoke-connection.mjs', 'apps/desktop/test/launch-smoke-connection.test.ts',
  'apps/desktop/test/launch-smoke-connection.config.mts', 'apps/desktop/test/launch-smoke-connection-mutations.mjs', 'apps/desktop/test/launch-smoke-connection-node-loader.mjs',
  'packages/core/test/hook-postcommit-observation.vitest.config.mts', 'packages/core/test/helpers/headless-runtime-fixture.ts', 'packages/core/test/helpers/fixture-values.ts',
  'packages/core/test/fixtures/headless-runtime-worker.mjs', 'packages/core/test/fixtures/fake-codex-cli.mjs',
  'packages/core/dist/control-endpoint-listener-worker.js', `packages/core/vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`]
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(join(root, path)))])))
const receipt = { schema: 'agentmux.launch-smoke-connection.v1', passed: false,
  scope: 'Actual source Desktop smoke wait helper and Hosted SDK waitForReady:false, compiled private semantic Core, real RPC and official private ctxmux. One first owner read is withheld and rejected; the same SDK consumer reconnects without replacing metadata, original Run or Native process. Focused fake ports prove bootstrap, observation origin, exact terminal diagnostic and listener cancellation. No GUI, installed App, launchd, package or product build qualification.',
  environment: { node: process.versions.node, sqlite: process.versions.sqlite, platform: process.platform, architecture: process.arch },
  harness: await hashes(harnessPaths), runs: [] }
const save = () => writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
await save()
try {
  for (const label of ['baseline', ...Object.keys(launchSmokeMutations), 'restored']) {
    const mutation = launchSmokeMutations[label], loaded = join(attempt, label + '-loaded.jsonl'), facts = join(attempt, label + '-facts.jsonl'), result = join(attempt, label + '-result.json')
    await writeFile(loaded, ''); await writeFile(facts, '')
    const run = await new Promise((accept, reject) => {
      const child = spawn('pnpm', ['exec', 'vitest', 'run', '--config', 'apps/desktop/test/launch-smoke-connection.config.mts',
        ...(mutation ? ['-t', '^' + mutation.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'] : []),
        '--reporter=default', '--reporter=json', '--outputFile=' + result], { cwd: root,
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !['AGENTMUX_TEST_OWNER_ENTRY', 'AGENTMUX_TEST_SERVICE_ENTRY', 'AGENTMUX_TEST_CLIENT_ENTRY', 'AGENTMUX_TEST_RPC_CLIENT_ENTRY'].includes(key))),
          LAUNCH_SMOKE_MUTANT: mutation ? label : '', LAUNCH_SMOKE_LOADED: loaded, LAUNCH_SMOKE_FACTS: facts },
        stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
      child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, output }))
    })
    await writeFile(join(attempt, label + '.log'), run.output)
    const report = JSON.parse(await readFile(result, 'utf8')), rows = report.testResults.flatMap(value => value.assertionResults)
    const failures = rows.filter(value => value.status === 'failed'), passed = rows.filter(value => value.status === 'passed')
    const evaluations = (await readFile(loaded, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
    const observations = (await readFile(facts, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
    const cleanup = observations.filter(value => Object.hasOwn(value, 'cleanup'))
    receipt.runs.push({ label, code: run.code, signal: run.signal, passed: report.numPassedTests, failed: report.numFailedTests,
      selected: passed.length + failures.length, collected: report.numTotalTests, skipped: report.numPendingTests,
      evaluations: [...new Map(evaluations.map(value => [JSON.stringify(value), value])).values()], observations,
      failures: failures.map(value => ({ name: value.fullName, messages: value.failureMessages })), reportSHA256: sha(await readFile(result)) })
    await save()
    assert.equal(run.signal, null); assert.ok(rows.length > 0); assert.equal(rows.length, report.numTotalTests)
    assert.equal(passed.length, report.numPassedTests); assert.equal(failures.length, report.numFailedTests)
    assert.equal(passed.length + failures.length, mutation ? 1 : 7, 'The exact focused contracts must execute')
    assert.equal(cleanup.length, passed.length + failures.length, 'Every selected case must emit actual cleanup evidence')
    assert.ok(cleanup.every(value => value.cleanup === 'confirmed'), 'Private resources and listeners must close')
    for (const path of launchSmokeOwners) assert.ok(evaluations.some(value => value.path === path), 'Actual source must evaluate: ' + path)
    if (mutation) {
      assert.equal(run.code, 1); assert.equal(failures.length, 1); assert.equal(failures[0].fullName, mutation.target)
      assert.ok(failures[0].failureMessages.some(message => /AssertionError|__VITEST_(?:REJECTS|RESOLVES)__/u.test(message)
        && !/timed out|test timed|Cannot find module|Failed to load url/iu.test(message)), 'Only the target assertion qualifies a mutant')
      assert.ok(evaluations.some(value => value.path === launchSmokeOwners[0] && value.mutant === label && value.originalSHA256 !== value.loadedSHA256), 'The changed original smoke owner must evaluate')
    } else {
      assert.equal(run.code, 0, run.output); assert.equal(report.numPassedTests, 7); assert.equal(failures.length, 0)
      for (const path of ['packages/core/dist/index.js', 'packages/core/dist/hosted-runtime-service.js', 'packages/core/dist/client.js']) {
        assert.ok(evaluations.some(value => value.path === path && value.surface === 'evaluated-compiled-owner'), 'Actual compiled owner must evaluate: ' + path)
      }
      assert.equal(observations.filter(value => value.phase === 'actual-hosted-reconnect').length, 1)
    }
    process.stdout.write(JSON.stringify({ label, passed: report.numPassedTests, failed: report.numFailedTests }) + '\n')
  }
  const evaluatedPaths = [...new Set(receipt.runs.flatMap(run => run.evaluations.map(value => value.path)))]
  receipt.inputs = await hashes(evaluatedPaths)
  for (const run of receipt.runs) for (const row of run.evaluations) assert.equal(row.originalSHA256, receipt.inputs[row.path], 'An evaluated input changed: ' + row.path)
  assert.deepEqual(await hashes(harnessPaths), receipt.harness, 'The actual test inputs must remain unchanged')
  receipt.passed = true; receipt.unchanged = true; await save()
  await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ passed: true, receipt: '.local/state/mobile-independent-host/launch-smoke-connection/receipt.json' }) + '\n')
} catch (error) {
  receipt.error = { name: error.name, message: error.message, stack: error.stack }; await save(); throw error
}
