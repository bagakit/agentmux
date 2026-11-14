import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { desktopRequire, root } from './fixtures/settings-resource-library/environment.mjs'
import { runProbeProcess } from './probe-process.mjs'

const evidence = resolve(root, process.env.AGENTMUX_SETTINGS_RUNTIME_EVIDENCE ?? '.tmp/settings-inputs-runtime/' + randomUUID())
await mkdir(evidence, { recursive: true })
const receipt = { passed: false, runs: [], visual: null }
const config = resolve(root, 'apps/desktop/test/vitest.settings-inputs-runtime.config.mts')
const vitest = desktopRequire.resolve('vitest/vitest.mjs')
const tests = [
  'finds one of 51 Host projects',
  'keeps the complete unsaved draft',
  'preserves every later registration field',
  'compares the selected Host',
  'listener address is a masked credential',
  'the Mesh code field announces an invalid submission',
  'actual editor submits the original fence once',
  'actual Node editor preserves a later publication draft',
  'actual Remote route editor browses saved edges',
  'a changed Runtime or reused route',
  'fixes a newly captured Provider and identity while saving'
]
const mutations = [
  ['host-search', 'settings-product-polish', tests[0], 'The Host project query exposes an explicit clear action'],
  ['mesh-invalid', 'mesh-settings', tests[5], 'Invalid pairing code is associated with the authored field']
]

async function run(name, patterns, targetFile, mutation, reason) {
  const directory = resolve(evidence, name)
  await mkdir(directory, { recursive: true })
  const report = resolve(directory, 'vitest.json'), consumed = resolve(directory, 'consumed.jsonl')
  const env = { ...process.env, AGENTMUX_SETTINGS_RUNTIME_TEST_RECEIPT: consumed }
  delete env.AGENTMUX_SETTINGS_RUNTIME_MUTANT
  if (mutation) env.AGENTMUX_SETTINGS_RUNTIME_MUTANT = mutation
  const lines = []
  const args = [vitest, 'run', '--config', config]
  if (targetFile) args.push('apps/desktop/test/' + targetFile + '.test.tsx')
  const processResult = await runProbeProcess(process.execPath, [...args,
    '--testNamePattern', patterns.join('|'), '--reporter=json', '--outputFile', report],
  { cwd: root, env, timeoutMs: 90_000, temporaryRoot: directory, onLine: line => lines.push(line) })
  await writeFile(resolve(directory, 'vitest.log'), lines.join('\n') + '\n')
  await writeFile(resolve(directory, 'process.json'), JSON.stringify(processResult, null, 2) + '\n')
  assert.equal(processResult.timedOut, false, 'Runtime Settings tests exceeded their private process interval: ' + name)
  const result = JSON.parse(await readFile(report, 'utf8'))
  const loaded = (await readFile(consumed, 'utf8')).trim().split('\n').map(JSON.parse)
  const changed = [...new Map(loaded.filter(row => row.original !== row.consumed).map(row => [row.file, row])).values()]
  const assertions = result.testResults.flatMap(suite => suite.assertionResults)
  assert.ok(loaded.length > 0, 'The real Renderer source was consumed')
  if (mutation) {
    assert.equal(processResult.exitCode, 1)
    assert.equal(changed.length, 1)
    assert.equal(result.numFailedTests, 1)
    assert.ok(assertions.some(test => test.status === 'failed' && test.fullName.includes(patterns[0]) &&
      test.failureMessages.some(message => message.includes('AssertionError') && message.includes(reason))), 'The intended rule detected the mutated product')
  } else {
    assert.equal(processResult.exitCode, 0, JSON.stringify(assertions.filter(test => test.status === 'failed').map(test => test.failureMessages)))
    assert.equal(changed.length, 0)
    assert.equal(result.numPassedTests, patterns.length)
  }
  receipt.runs.push({ name, mutation, passed: result.numPassedTests, failed: result.numFailedTests, changed, directory })
}
try {
  await run('baseline', tests)
  for (const [mutation, file, target, reason] of mutations) {
    await run(mutation, [target], file, mutation, reason)
    await run(mutation + '-restored', [target], file)
  }
  if (!process.argv.includes('--tests-only')) {
    const outputs = resolve(evidence, 'visual')
    const capture = await runProbeProcess(process.execPath,
      [resolve(root, 'apps/desktop/scripts/capture-mesh-settings.mjs'), '--settings-inputs'],
      { cwd: root, env: { ...process.env, AGENTMUX_MESH_CAPTURE_EVIDENCE: outputs }, temporaryRoot: outputs, timeoutMs: 90_000,
        onLine: line => process.stderr.write(line + '\n') })
    assert.equal(capture.exitCode, 0, 'Private Settings input Electron capture')
    const visual = JSON.parse(await readFile(resolve(outputs, 'capture.json'), 'utf8'))
    assert.equal(visual.passed, true)
    assert.ok(visual.frames.length >= 10, 'Cover Agents, providers, Hosts, Mesh, Node and Remote Settings')
    receipt.visual = { outputs, frames: visual.frames, captureOnly: true, independentReview: 'pending' }
  }
  receipt.passed = true
} finally {
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  process.stdout.write(resolve(evidence, 'receipt.json') + '\n')
}
