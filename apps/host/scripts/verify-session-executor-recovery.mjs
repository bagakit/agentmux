import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { executorRecoveryMutations } from '../test/session-executor-recovery-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..'), directory = join(root, '.local/state/mobile-independent-host/session-executor-recovery')
await mkdir(directory, { recursive: true })
const attempt = await mkdtemp(join(directory, 'attempt-')), sha = value => createHash('sha256').update(value).digest('hex')
const harnessPaths = ['apps/host/scripts/verify-session-executor-recovery.mjs', 'apps/host/test/session-executor-recovery.test.ts',
  'apps/host/test/session-executor-recovery-mutations.mjs', 'apps/host/test/session-executor-recovery-node-loader.mjs', 'apps/host/test/vitest.session-executor-recovery.config.mts',
  'packages/core/test/session-continuity-executor.test.ts', 'packages/core/test/helpers/continuity-executor-process.mjs',
  'packages/core/test/helpers/headless-runtime-fixture.ts', 'packages/core/test/hook-postcommit-observation.vitest.config.mts',
  'apps/host/test/mobile-web-node-loader.mjs', 'apps/host/test/fixtures/mobile-web-host.mjs', 'packages/core/test/fixtures/fake-codex-cli.mjs',
  ...['goals', 'diagnostics', 'creation', 'content', 'workspace', 'discovery'].map(name => 'apps/host/test/mobile-' + name + '-mutations.mjs'),
  'packages/identity/dist/runtime-source.js', 'packages/core/dist/control-endpoint-listener-worker.js',
  `packages/core/vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`]
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(join(root, path)))])))
const receipt = { schema: 'agentmux.session-executor-recovery.v1', passed: false,
  scope: 'Source Core/real FileStore and official private ctxmux processes; default Node Host original AppConfig agent.open without executorRevision, public agent.resume RPC and actual source CLI across Host restart. Automatic context-only retry, no-registry callback, restart, healthy raw input, original SDK empty args/env, target-owned registry, reader/provider errors. History is the original resolver invariant, not a history UI test. No Browser/Desktop GUI, user namespace, package or product build.',
  environment: { node: process.versions.node, sqlite: process.versions.sqlite, platform: process.platform, architecture: process.arch },
  harness: await hashes(harnessPaths), runs: [] }
const save = () => writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
await save()
try {
  for (const label of ['baseline', ...Object.keys(executorRecoveryMutations), 'restored']) {
    const mutation = executorRecoveryMutations[label], loaded = join(attempt, label + '-loaded.jsonl'), facts = join(attempt, label + '-facts.jsonl'), result = join(attempt, label + '-result.json')
    const consumers = join(attempt, label + '-consumers'); await mkdir(consumers)
    await writeFile(loaded, ''); await writeFile(facts, '')
    const run = await new Promise((accept, reject) => {
      const child = spawn('pnpm', ['exec', 'vitest', 'run', '--config', 'apps/host/test/vitest.session-executor-recovery.config.mts',
        '-t', mutation ? '^' + mutation.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$' : '^session configuration ',
        '--reporter=default', '--reporter=json', '--outputFile=' + result], { cwd: root,
        env: { ...process.env, SESSION_EXECUTOR_MUTANT: mutation ? label : '', SESSION_EXECUTOR_LOADED: loaded, SESSION_EXECUTOR_FACTS: facts,
          AGENTMUX_TEST_CONTINUITY_EXECUTOR_ENTRY: '', AGENTMUX_TEST_CONTINUITY_EXECUTOR_MUTANT: '',
          AGENTMUX_TEST_CONTINUITY_EXECUTOR_EVIDENCE: consumers }, stdio: ['ignore', 'pipe', 'pipe'] })
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
    assert.equal(passed.length + failures.length, mutation ? 1 : 7, 'The exact selected contracts must execute')
    assert.equal(cleanup.length, passed.length + failures.length, 'Every selected case must emit actual cleanup evidence')
    assert.ok(cleanup.every(value => value.cleanup === 'confirmed'), 'Private cleanup must complete independently')
    assert.ok(evaluations.length > 0, 'Actual source evaluation is required')
    if (mutation) {
      assert.equal(run.code, 1); assert.equal(failures.length, 1)
      assert.equal(failures[0].fullName, mutation.target)
      assert.ok(failures[0].failureMessages.some(message => /AssertionError|__VITEST_(?:REJECTS|RESOLVES)__/u.test(message)
        && !/timed out|test timed|Cannot find module|Failed to load url/iu.test(message)), 'Only an actual target assertion qualifies a mutant')
      assert.ok(evaluations.some(value => value.path === mutation.path && value.mutant === label && value.originalSHA256 !== value.loadedSHA256), 'The changed original owner must actually evaluate')
    } else {
      assert.equal(run.code, 0, run.output); assert.equal(report.numPassedTests, 7); assert.equal(failures.length, 0)
      for (const path of ['packages/core/src/client.ts', 'packages/core/src/agent-session-recovery/continuity-attempt.ts', 'packages/core/src/agent-session-recovery/lifecycle.ts',
        'apps/host/src/host.ts', 'apps/host/src/mote-resources.ts', 'apps/host/src/spatial-agent-control.ts', 'packages/core/src/public-rpc-service.ts',
        'packages/core/src/hosted-runtime-service.ts', 'packages/core/src/agentmux-cli-commands.ts']) assert.ok(evaluations.some(value => value.path === path), 'Actual owner/consumer must evaluate: ' + path)
      assert.equal(observations.filter(value => value.phase === 'default-host-original-configuration').length, 1)
    }
    process.stdout.write(JSON.stringify({ label, passed: report.numPassedTests, failed: report.numFailedTests }) + '\n')
  }
  const evaluatedPaths = [...new Set(receipt.runs.flatMap(run => run.evaluations.map(value => value.path)))]
  receipt.inputs = await hashes(evaluatedPaths)
  for (const run of receipt.runs) for (const row of run.evaluations) assert.equal(row.originalSHA256, receipt.inputs[row.path], 'Original evaluated input changed: ' + row.path)
  assert.deepEqual(await hashes(harnessPaths), receipt.harness, 'The actual test inputs must remain unchanged')
  receipt.passed = true; receipt.unchanged = true; await save()
  await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ passed: true, receipt: join('.local/state/mobile-independent-host/session-executor-recovery', 'receipt.json') }) + '\n')
} catch (error) {
  receipt.error = { name: error.name, message: error.message, stack: error.stack }; await save(); throw error
}
