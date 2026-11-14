import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'), require = createRequire(new URL('../../../packages/core/package.json', import.meta.url))
const directory = join(root, '.local/state/mac-mini-first-run/executor-environment')
await mkdir(directory, { recursive: true })
const attempt = await mkdtemp(join(directory, 'proof-'))
const paths = ['apps/host/src/index.ts', 'apps/host/src/host.ts', 'packages/core/src/client.ts', 'packages/core/src/client-contract.ts',
  'packages/core/src/login-shell-environment.ts', 'apps/desktop/src/main/runtime-controller.ts',
  'apps/desktop/src/renderer/src/components/NewTabSurface.tsx', 'apps/desktop/src/renderer/src/components/settings/AgentSettingsPane.tsx',
  'apps/host/test/helpers/executor-environment-fixture.ts', 'apps/host/test/executor-environment-refresh.test.ts',
  'apps/desktop/test/executor-environment-refresh.test.tsx', 'apps/host/test/executor-environment-refresh.config.mts',
  'apps/host/test/executor-environment-node-loader.mjs', 'apps/host/test/mobile-web-node-loader.mjs',
  'apps/host/scripts/verify-executor-environment-refresh.mjs']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = Object.fromEntries(await Promise.all(paths.map(async path => [path, hash(await readFile(join(root, path)))])))
const receipt = { schema: 'agentmux.executor-environment-refresh-proof.v1', passed: false, userRuntimeTouched: false, inputs, results: [] }
try {
  for (const [mutant, target, count] of [['', undefined, 3], ['old-success-cache', 'mounted Settings refresh', 1],
    ['skip-inventory-preparation', 'cold inventory waits', 1], ['skip-probe-refresh', 'mounted Settings refresh', 1]]) {
    const name = mutant || 'candidate', report = join(attempt, name + '.json'), loaded = join(attempt, name + '-loaded.ndjson')
    await writeFile(loaded, '')
    const args = [require.resolve('vitest/vitest.mjs'), 'run', '--config', 'apps/host/test/executor-environment-refresh.config.mts',
      '--reporter=default', '--reporter=json', '--outputFile=' + report]
    if (target) args.push('-t', target)
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env,
        EXECUTOR_ENVIRONMENT_MUTANT: mutant, EXECUTOR_ENVIRONMENT_LOADED: loaded }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, output }))
    })
    await writeFile(join(attempt, name + '.log'), result.output)
    const tests = JSON.parse(await readFile(report, 'utf8')), all = tests.testResults.flatMap(file => file.assertionResults)
    const active = all.filter(test => ['passed', 'failed'].includes(test.status)), failed = active.filter(test => test.status === 'failed')
    const loads = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    assert.equal(active.length, count, 'Exact nonempty owner/consumer inventory: ' + name)
    assert.ok(loads.length > 0, 'The actual original Host must load production sources')
    if (mutant) {
      assert.equal(result.code, 1); assert.equal(result.signal, null)
      assert.ok(loads.some(value => value.mutant === mutant && value.loadedSHA256 !== value.originalSHA256), 'Mutation must load in the original Host')
      assert.ok(failed.some(test => test.failureMessages.some(message => /AssertionError/su.test(message))), 'Loaded owner mutation needs semantic assertion RED')
    } else { assert.equal(result.code, 0, result.output); assert.equal(tests.numPassedTests, 3) }
    receipt.results.push({ name, code: result.code, passed: tests.numPassedTests, failed: tests.numFailedTests,
      loads, failures: failed.map(test => ({ name: test.fullName, messages: test.failureMessages })) })
    process.stdout.write(name + ': ' + (mutant ? 'assertion RED' : 'GREEN') + '\n')
  }
  for (const [path, before] of Object.entries(inputs)) assert.equal(hash(await readFile(join(root, path))), before, 'Candidate changed during proof: ' + path)
  receipt.passed = true
} catch (error) { receipt.error = error.message; throw error }
finally {
  await writeFile(join(directory, 'proof.json'), JSON.stringify(receipt, null, 2) + '\n')
  if (receipt.passed) await rm(attempt, { recursive: true, force: true })
  else process.stderr.write('Retained failed owner proof: ' + attempt + '\n')
}
