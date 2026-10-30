import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { lifecycleRecoveryMutations } from '../test/host-lifecycle-recovery-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..'), directory = join(root, '.local/state/mobile-independent-host/host-lifecycle-recovery')
await mkdir(directory, { recursive: true })
const attempt = await mkdtemp(join(directory, 'attempt-')), sha = value => createHash('sha256').update(value).digest('hex')
const harnessPaths = ['apps/host/scripts/verify-host-lifecycle-recovery.mjs', 'apps/host/test/host-lifecycle-recovery.test.ts',
  'apps/host/test/host-lifecycle-recovery.config.mts', 'apps/host/test/host-lifecycle-recovery-mutations.mjs', 'apps/host/test/host-lifecycle-recovery-node-loader.mjs',
  'apps/host/test/fixtures/host-lifecycle-runtime.mjs', 'apps/host/test/fixtures/host-lifecycle-ssh.mjs', 'apps/host/test/fixtures/host-configuration-ssh.mjs',
  'packages/core/test/helpers/public-rpc-owner.ts', 'packages/core/test/helpers/headless-runtime-fixture.ts', 'packages/core/test/helpers/fixture-values.ts',
  'packages/core/test/helpers/workspace-source-export.mjs',
  'packages/core/test/helpers/private-node-source-bundle.mjs',
  'packages/core/test/fixtures/fake-system-ssh.mjs', 'packages/identity/scripts/runtime-bundle.mjs', 'packages/identity/src/runtime-entry.ts', 'packages/identity/src/index.ts',
  'package.json', 'pnpm-lock.yaml', ...['core', 'identity', 'relay', 'client-ui', 'capsule', 'connectors', 'demand', 'diagnostic-evidence'].map(name => 'packages/' + name + '/package.json'),
  'apps/host/package.json', `packages/core/vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`, `packages/core/vendor/ctxmux/${process.platform}-${process.arch}/manifest.json`]
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(join(root, path)))])))
const receipt = { schema: 'agentmux.host-lifecycle-recovery.v1', passed: false,
  scope: 'Source Host/DeviceAuthority, real persistent file and public device/input RPC with controlled Native I/O; source configured Host lease -> original SSH SDK -> controlled system-SSH leaf -> source Core/real RPC and official private ctxmux retaining an actual terminal Run. Separate fake-route port tests only capped timer policy. No installed App, live remote SSH deployment, user namespace, Browser, product dist or product build qualification.',
  environment: { node: process.versions.node, sqlite: process.versions.sqlite, platform: process.platform, architecture: process.arch },
  harness: await hashes(harnessPaths), runs: [] }
const save = () => writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
await save()
try {
  for (const label of ['baseline', ...Object.keys(lifecycleRecoveryMutations), 'restored']) {
    const mutation = lifecycleRecoveryMutations[label], loaded = join(attempt, label + '-loaded.jsonl'), facts = join(attempt, label + '-facts.jsonl'), result = join(attempt, label + '-result.json'), generated = join(attempt, label + '-generated')
    await writeFile(loaded, ''); await writeFile(facts, '')
    const run = await new Promise((accept, reject) => {
      const child = spawn('pnpm', ['exec', 'vitest', 'run', '--config', 'apps/host/test/host-lifecycle-recovery.config.mts',
        ...(mutation ? ['-t', '^' + mutation.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'] : []),
        '--reporter=default', '--reporter=json', '--outputFile=' + result], { cwd: root,
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_TEST_') && !key.startsWith('HOST_LIFECYCLE_'))),
          pnpm_config_verify_deps_before_run: 'false', HOST_LIFECYCLE_MUTANT: mutation ? label : '', HOST_LIFECYCLE_LOADED: loaded, HOST_LIFECYCLE_FACTS: facts, HOST_LIFECYCLE_GENERATED: generated },
        stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
      child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, output }))
    })
    await writeFile(join(attempt, label + '.log'), run.output)
    const report = JSON.parse(await readFile(result, 'utf8')), rows = report.testResults.flatMap(value => value.assertionResults)
    const failures = rows.filter(value => value.status === 'failed'), passed = rows.filter(value => value.status === 'passed')
    const evaluations = (await readFile(loaded, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
    const observations = (await readFile(facts, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
    const bundles = await Promise.all(JSON.parse(await readFile(join(generated, 'node-bundles.json'), 'utf8')).map(async value => {
      const bytes = await readFile(value.provenance), record = JSON.parse(bytes)
      assert.equal(record.schema, 'agentmux.private-node-source-bundle.v1')
      assert.equal(record.file, relative(root, value.file))
      assert.equal(record.bundleSHA256, sha(await readFile(value.file)), 'The private Node artifact must match its actual compilation provenance')
      assert.ok(record.sources.length > 0)
      return { name: value.name, provenanceSHA256: sha(bytes), ...record }
    }))
    assert.deepEqual(bundles.map(value => value.name), ['owner', 'listener', 'cli'])
    for (const row of evaluations.filter(value => value.surface === 'node-process')) {
      assert.ok(bundles.some(value => value.sources.some(source => source.path === row.path && source.originalSHA256 === row.originalSHA256)),
        'The actual Node evaluation must belong to the recorded original source bundle: ' + row.path)
    }
    const cleanup = observations.filter(value => Object.hasOwn(value, 'cleanup'))
    receipt.runs.push({ label, code: run.code, signal: run.signal, passed: report.numPassedTests, failed: report.numFailedTests,
      selected: passed.length + failures.length, collected: report.numTotalTests, skipped: report.numPendingTests,
      evaluations: [...new Map(evaluations.map(value => [JSON.stringify(value), value])).values()], observations,
      failures: failures.map(value => ({ name: value.fullName, messages: value.failureMessages })), reportSHA256: sha(await readFile(result)),
      generatedIdentitySHA256: sha(await readFile(join(generated, 'identity-runtime-source.mjs'))), bundles })
    await save()
    assert.equal(run.signal, null); assert.ok(rows.length > 0); assert.equal(rows.length, report.numTotalTests)
    assert.equal(passed.length, report.numPassedTests); assert.equal(failures.length, report.numFailedTests)
    assert.equal(passed.length + failures.length, mutation ? 1 : 5, 'The exact focused consumer set must execute')
    assert.equal(cleanup.length, passed.length + failures.length, 'Every selected consumer must publish actual cleanup evidence')
    assert.ok(cleanup.every(value => value.cleanup === 'confirmed'), 'Private resources must finish their original cleanup')
    assert.ok(evaluations.length > 0, 'The actual source must evaluate')
    if (mutation) {
      assert.equal(run.code, 1); assert.equal(failures.length, 1); assert.equal(failures[0].fullName, mutation.target)
      assert.ok(failures[0].failureMessages.some(message => /AssertionError|__VITEST_(?:REJECTS|RESOLVES)__/u.test(message)
        && !/Test timed out|Cannot find module|Failed to load url|unhandled rejection/iu.test(message)), 'Only a target assertion qualifies the mutation')
      assert.ok(evaluations.some(value => value.path === mutation.path && value.mutant === label && value.originalSHA256 !== value.loadedSHA256), 'The altered original owner must evaluate')
    } else {
      assert.equal(run.code, 0, run.output); assert.equal(report.numPassedTests, 5); assert.equal(failures.length, 0)
      for (const path of ['apps/host/src/host.ts', 'apps/host/src/device-authority.ts', 'apps/host/src/device-administration.ts', 'apps/host/src/configured-host-clients.ts',
        'packages/core/src/public-rpc-server.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/hosted-client.ts', 'packages/core/src/runtime-client.ts', 'packages/core/src/agentmux.ts', 'packages/core/src/control-endpoint-listener-worker.ts']) {
        assert.ok(evaluations.some(value => value.path === path), 'The actual owner/consumer source must evaluate: ' + path)
      }
      for (const phase of ['authority-recovered', 'authority-missing-original-retained', 'original-dispose-result', 'original-route-converged', 'original-ssh-process-cleanup', 'failed-route-backoff-policy']) {
        assert.equal(observations.filter(value => value.phase === phase).length, 1, 'The exact real consumer result must be present: ' + phase)
      }
    }
    process.stdout.write(JSON.stringify({ label, passed: report.numPassedTests, failed: report.numFailedTests }) + '\n')
  }
  receipt.inputs = await hashes([...new Set(receipt.runs.flatMap(run => [
    ...run.evaluations.map(value => value.path), ...run.bundles.flatMap(bundle => bundle.sources.map(value => value.path))
  ]))])
  for (const run of receipt.runs) for (const row of run.evaluations) assert.equal(row.originalSHA256, receipt.inputs[row.path], 'An evaluated original input changed: ' + row.path)
  for (const run of receipt.runs) for (const bundle of run.bundles) {
    for (const source of bundle.sources) assert.equal(source.originalSHA256, receipt.inputs[source.path], 'A private bundle source changed: ' + source.path)
    assert.equal(bundle.bundleSHA256, sha(await readFile(join(root, bundle.file))), 'A private Node artifact changed')
    assert.equal(bundle.provenanceSHA256, sha(await readFile(join(root, bundle.file + '.provenance.json'))), 'A private Node compilation record changed')
  }
  assert.deepEqual(await hashes(harnessPaths), receipt.harness, 'The test harness inputs changed')
  receipt.passed = true; receipt.unchanged = true; await save()
  await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ passed: true, receipt: '.local/state/mobile-independent-host/host-lifecycle-recovery/receipt.json' }) + '\n')
} catch (error) {
  receipt.error = { name: error.name, message: error.message, stack: error.stack }; await save(); throw error
}
