import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = resolve(import.meta.dirname, '../../..')
const evidenceRoot = join(root, '.local/state/settings-editor-input')
await mkdir(evidenceRoot, { recursive: true })
const evidence = await mkdtemp(join(evidenceRoot, 'verify-'))
const variants = {
  'stale-composition': { file: 'packages/client-ui/src/lib/composer-composition.ts',
    test: 'applies the final IME input and releases the field for a subsequent answer choice', message: /to be ''/ },
  'detached-editor-size': { file: 'packages/client-ui/src/input/ComposerTextarea.tsx',
    test: 'expands and restores the same queued draft with its native selection and explicit Save', message: /to be 'true'/ }
}
const product = [
  'apps/desktop/src/renderer/src/components/ComposerQueuedMessageEditor.tsx',
  'packages/client-ui/src/components/AgentAsyncQuestionCard.tsx',
  ...Object.values(variants).map(({ file }) => file)
]
const original = Object.fromEntries(await Promise.all(product.map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])))
const receipt = { passed: false, tests: {}, native: null }

async function verifyTests(name) {
  const variant = variants[name]
  const reportFile = join(evidence, `${name}.json`)
  const loadsFile = join(evidence, `${name}.loads.jsonl`)
  const command = ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/scripts/fixtures/settings-editor-input/vitest.config.mts',
    '--reporter=json', '--outputFile', reportFile]
  const result = await run(process.execPath, command, { cwd: root, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, AGENTMUX_SETTINGS_EDITOR_INPUT_LOADS: loadsFile, AGENTMUX_SETTINGS_EDITOR_INPUT_MUTATION: variant ? name : '' } }).catch(error => error)
  await writeFile(join(evidence, `${name}.log`), (result.stdout ?? '') + (result.stderr ?? ''))
  assert.equal(result.code ?? 0, variant ? 1 : 0, `${name}: expected test process exit`)
  const report = JSON.parse(await readFile(reportFile, 'utf8'))
  assert.equal(report.testResults.length, 2, `${name}: both product consumers collected`)
  assert.ok(report.testResults.every(suite => suite.assertionResults.length > 0), `${name}: both product consumers exercised`)
  assert.equal(report.numPendingTests, 0)
  assert.equal(report.numRuntimeErrorTestSuites ?? 0, 0)
  const failures = report.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed')
  assert.equal(failures.length, variant ? 1 : 0)
  if (variant) {
    assert.equal(failures[0].title, variant.test)
    assert.match(failures[0].failureMessages.join('\n'), /AssertionError/)
    assert.match(failures[0].failureMessages.join('\n'), variant.message)
  }
  const loads = (await readFile(loadsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  for (const file of product) {
    const actual = loads.filter(load => load.file === file)
    assert.ok(actual.length, `${name}: loaded real product source ${file}`)
    for (const load of actual) {
      assert.equal(load.original, original[file], `${name}: source drift ${file}`)
      assert.equal(load.loaded !== load.original, file === variant?.file, `${name}: applied actual source variant ${file}`)
    }
  }
  receipt.tests[name] = { count: report.numTotalTests, assertion: failures[0]?.title ?? null }
  console.log(`${name}: ${variant ? 'AssertionRED' : 'GREEN'} (${report.numTotalTests} tests)`)
}

try {
  const cases = ['candidate', ...Object.keys(variants), 'restored']
  for (const name of cases) await verifyTests(name)
  const native = join(evidence, 'queue-renderer')
  const result = await run(process.execPath, ['apps/desktop/scripts/capture-message-delivery-diagnostics.mjs', '--only=queued-editor', `--evidence=${native}`],
    { cwd: root, maxBuffer: 4 * 1024 * 1024 }).catch(error => error)
  await writeFile(join(evidence, 'queue-renderer.log'), (result.stdout ?? '') + (result.stderr ?? ''))
  assert.equal(result.code ?? 0, 0, 'Private Electron queued draft consumer failed')
  receipt.native = relative(root, join(native, 'render.json'))
  receipt.passed = true
} finally {
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(relative(root, join(evidence, 'receipt.json')))
}
