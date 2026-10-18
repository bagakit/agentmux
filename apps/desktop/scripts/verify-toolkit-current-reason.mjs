import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { readToolkitNativeProof } from './fixtures/toolkit-tui/verify-capture.mjs'

const root = resolve(import.meta.dirname, '../../..'), evidence = resolve(root, '.local/toolkit-tui-polish/current-reason')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const read = async file => JSON.parse(await readFile(file, 'utf8'))
async function current(inputs) {
  assert.ok(Object.keys(inputs).length > 0, 'Nonempty source bindings required')
  for (const [file, digest] of Object.entries(inputs)) assert.equal(hash(await readFile(resolve(root, file))),
    typeof digest === 'string' ? digest : digest.sha256, 'Reason proof source changed: ' + file)
}
if (process.argv.includes('--run')) {
  await mkdir(evidence, { recursive: true })
  const files = ['apps/desktop/src/main/toolkit-custom-owner.ts', 'apps/desktop/src/main/config-owner.ts',
    'apps/desktop/src/main/config-store.ts', 'apps/desktop/src/main/toolkit-config.ts', 'apps/desktop/src/shared/config-edit.ts',
    'packages/core/src/toolkit.ts', 'packages/core/src/object-id.ts',
    'apps/desktop/src/renderer/src/components/toolkit/UserToolkitResult.tsx',
    'apps/desktop/src/renderer/src/components/toolkit/use-toolkit-script-observation.ts',
    'apps/desktop/test/toolkit-custom-owner.test.ts', 'apps/desktop/test/toolkit-current-reason-ui.test.tsx',
    'apps/desktop/test/toolkit-current-reason.config.mts', 'apps/desktop/test/helpers/composer-dom-fixture.tsx',
    'apps/desktop/test/helpers/toolkit-custom-owner-fixture.ts',
    'apps/desktop/scripts/fixtures/toolkit-custom/vitest.config.mts', 'vitest.setup.ts',
    'test/fixture-values.mjs', 'apps/desktop/scripts/lib/fixture-values.mjs',
    'apps/desktop/scripts/verify-toolkit-current-reason.mjs', 'apps/desktop/scripts/fixtures/toolkit-tui/verify-capture.mjs']
  const inputs = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(resolve(root, file)))])))
  const results = []
  for (const mutation of [null, 'ordinary-reason', 'display-reason']) {
    const name = mutation ?? 'baseline', output = resolve(evidence, name + '.json'), loaded = resolve(evidence, name + '.jsonl')
    await writeFile(loaded, '')
    let log = ''
    const child = spawn(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
      'apps/desktop/test/toolkit-current-reason.config.mts', ...(mutation ? ['-t', 'Toolkit current execution reason|renders actual Owner'] : []),
      '--reporter=json', '--outputFile=' + output], { cwd: root, env: { ...process.env,
      AGENTMUX_TOOLKIT_EVIDENCE: evidence, AGENTMUX_TOOLKIT_REASON_MUTATION: mutation ?? '', AGENTMUX_TOOLKIT_REASON_RECEIPT: loaded }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) })
    await writeFile(resolve(evidence, name + '.log'), log)
    const suite = await read(output)
    assert.ok(suite.numPassedTests + suite.numFailedTests > 0 && suite.testResults.length > 0, 'Nonempty reason consumers required')
    if (mutation) {
      assert.notEqual(code, 0, 'Reason mutant survived')
      assert.ok(suite.testResults.flatMap(file => file.assertionResults ?? []).some(test => test.status === 'failed' &&
        test.failureMessages.some(message => /AssertionError|expected/iu.test(message))), 'Reason consumer assertion must fail')
      assert.ok(suite.testResults.flatMap(file => file.assertionResults ?? []).some(test => test.status === 'failed' &&
        test.fullName.includes('renders actual Owner ' + (mutation === 'ordinary-reason' ? 'ordinary' : 'display'))), 'The real Owner-to-UI consumer must reject the mutant')
      const consumed = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
      assert.ok(consumed.some(item => item.mutation === mutation && item.sourceSHA256 !== item.loadedSHA256), 'Actual reason mutant must load')
    } else { assert.equal(code, 0, 'Reason baseline failed'); assert.equal(suite.success, true) }
    results.push({ name, mutation, passed: suite.numPassedTests, failed: suite.numFailedTests, result: relative(root, output) })
    process.stdout.write(name + ': ' + (mutation ? 'mutant killed' : 'passed') + '\n')
  }
  await current(inputs)
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify({ status: 'passed', inputs, results }, null, 2) + '\n')
} else {
  // Consume the already executed, source-bound owner/UI and shared Native proof.
  const receipt = await read(resolve(evidence, 'receipt.json'))
  assert.equal(receipt.status, 'passed'); await current(receipt.inputs)
  assert.deepEqual(receipt.results.map(item => item.name).sort(), ['baseline', 'ordinary-reason', 'display-reason'].sort())
  for (const result of receipt.results) assert.ok(result.mutation ? result.failed > 0 : result.passed > 0 && result.failed === 0)
  const { native, raw, input } = await readToolkitNativeProof(root)
  const { stopped, restarted, inspected, oldNoticeRemoved, explicitNewRun } = raw.polish.stopStart
  assert.equal(stopped.latestConfirmed.state, 'stopped'); assert.equal(stopped.latestConfirmed.reason, 'Stopped explicitly.')
  assert.equal(restarted.state, 'running'); assert.equal(restarted.reason, null); assert.equal(restarted.admission.reason, null)
  assert.notEqual(restarted.admission.executionId, stopped.latestConfirmed.executionId)
  assert.notDeepEqual(restarted.admission.run, stopped.latestConfirmed.run)
  assert.deepEqual(restarted.latestConfirmed, stopped.latestConfirmed)
  assert.equal(inspected.reason, null); assert.equal(inspected.admission.executionId, restarted.admission.executionId)
  assert.equal(oldNoticeRemoved, true); assert.equal(explicitNewRun, true)
  await writeFile(resolve(evidence, 'integration.json'), JSON.stringify({ status: 'passed', nativeSourceIdentity: native.sourceIdentity,
    rawSHA256: input.sha256, currentExecutionId: restarted.admission.executionId, historicalExecutionId: stopped.latestConfirmed.executionId }, null, 2) + '\n')
  process.stdout.write('Current Toolkit reason: owner/UI mutations and actual Native restart verified\n')
}
