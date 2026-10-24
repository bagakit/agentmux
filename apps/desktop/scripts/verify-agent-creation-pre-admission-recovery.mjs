import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(root, '.local/pre-admission-resource-recovery/surface')
const config = 'apps/desktop/test/agent-creation-pre-admission-surface.config.mts'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const rows = async file => (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
const sources = [
  'apps/desktop/src/renderer/src/components/SessionPane.tsx',
  'apps/desktop/src/renderer/src/lib/session-state.ts',
  'apps/desktop/test/disk-start-recovery-surface.test.tsx',
  'apps/desktop/test/disk-start-recovery-surface.config.mts', config,
  'apps/desktop/test/helpers/composer-dom-fixture.tsx',
  'apps/desktop/test/helpers/agent-creation-fixture.ts'
]
async function inputsMatch(inputs, required = sources) {
  for (const file of required) assert.match(inputs[file] ?? '', /^[a-f0-9]{64}$/u, 'Required exact input: ' + file)
  for (const [file, digest] of Object.entries(inputs)) assert.equal(hash(await readFile(resolve(root, file))), digest, 'Candidate changed: ' + file)
}
async function run(command, args, env = process.env) {
  let log = ''
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
  const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) })
  return { code, log }
}

if (process.argv.includes('--run-surface')) {
  await mkdir(evidence, { recursive: true })
  const inputs = Object.fromEntries(await Promise.all(sources.map(async file => [file, hash(await readFile(resolve(root, file)))])))
  const results = []
  for (const mutation of [null, 'unconfirmed-as-not-started']) {
    const name = mutation ?? 'baseline'
    const report = resolve(evidence, name + '.json'), loaded = resolve(evidence, name + '-loaded.jsonl')
    await writeFile(loaded, '')
    const result = await run(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
      '--reporter=json', '--outputFile=' + report], { ...process.env,
      AGENTMUX_CREATION_PREPARATION_UI_MUTATION: mutation ?? '', AGENTMUX_CREATION_PREPARATION_UI_LOADED: loaded,
      AGENTMUX_STORAGE_WAIT_MUTANT: '' })
    await writeFile(resolve(evidence, name + '.log'), result.log)
    const suite = await json(report), consumed = await rows(loaded)
    const assertions = suite.testResults.flatMap(file => file.assertionResults)
    assert.equal(suite.numRuntimeErrorTestSuites ?? 0, 0, 'Loading errors are not semantic proof')
    assert.ok(assertions.some(test => test.status === 'passed' || test.status === 'failed'), 'Nonempty mounted consumer assertions')
    for (const file of sources.slice(0, 2)) assert.ok(consumed.some(row => row.file === file && row.sourceSHA256 === inputs[file]), 'Actual production consumer loaded: ' + file)
    if (mutation) {
      assert.equal(result.code, 1, result.log)
      assert.ok(consumed.some(row => row.mutation === mutation && row.sourceSHA256 !== row.loadedSHA256), 'Production decision mutation actually loaded')
      assert.ok(assertions.some(test => test.status === 'failed' && test.fullName.includes('keeps uncertain preparation facts neutral') &&
        test.failureMessages.some(message => /AssertionError|expected/iu.test(message))), 'Actual uncertain-state surface kills false no-Start claim')
    } else {
      assert.equal(result.code, 0, result.log); assert.equal(suite.success, true)
      assert.ok(suite.numPassedTests >= 8, 'Complete focused pending-owner consumers')
    }
    results.push({ name, passed: suite.numPassedTests, failed: suite.numFailedTests,
      report: relative(root, report), reportSHA256: hash(await readFile(report)),
      loaded: relative(root, loaded), loadedSHA256: hash(await readFile(loaded)) })
    process.stdout.write(name + ': ' + (mutation ? 'semantic mutant rejected' : 'mounted consumers passed') + '\n')
  }
  await inputsMatch(inputs)
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify({ schema: 'agentmux.creation-preparation-surface-proof.v1', status: 'passed', inputs, results }, null, 2) + '\n')
} else {
  const core = await run(process.execPath, ['packages/core/scripts/verify-agent-creation-pre-admission-recovery.mjs'])
  assert.equal(core.code, 0, core.log)
  const restart = await run(process.execPath, ['apps/desktop/scripts/verify-agent-creation-pre-admission-restart.mjs'])
  assert.equal(restart.code, 0, restart.log)
  const receipt = await json(resolve(evidence, 'receipt.json'))
  assert.equal(receipt.status, 'passed'); await inputsMatch(receipt.inputs)
  assert.deepEqual(receipt.results.map(row => row.name), ['baseline', 'unconfirmed-as-not-started'])
  for (const row of receipt.results) {
    assert.ok(row.name === 'baseline' ? row.passed >= 8 && row.failed === 0 : row.failed > 0)
    assert.equal(hash(await readFile(resolve(root, row.report))), row.reportSHA256)
    assert.equal(hash(await readFile(resolve(root, row.loaded))), row.loadedSHA256)
  }
  const visual = await json(resolve(evidence, 'visual-review.json'))
  assert.equal(visual.verdict, 'deliverable'); assert.ok(visual.reviewer && visual.reviewer !== '/root', 'Independent image review')
  assert.deepEqual(Object.keys(visual.inputs).sort(), sources.slice(0, 2).sort(), 'Both reviewed presentation owners')
  await inputsMatch(visual.inputs, sources.slice(0, 2))
  const capture = await json(resolve(evidence, 'visual/receipt.json'))
  assert.equal(capture.passed, true); assert.equal(capture.exit.code, 0)
  assert.equal(capture.userRuntimeTouched, false)
  assert.match(capture.loadedRendererSha256, /^[a-f0-9]{64}$/u, 'Actual loaded Renderer identity')
  for (const [file, digest] of Object.entries(visual.inputs)) assert.equal(capture.sourcePins[file], digest, 'Review consumes captured source')
  assert.deepEqual(visual.images.map(frame => frame.path.split('/').at(-1)).sort(), [
    'storage-wait-dark.png', 'storage-wait-narrow-light.png', 'storage-wait-original-details.png', 'storage-wait-read-feedback.png'
  ], 'All four independently reviewed scenes')
  for (const frame of visual.images) {
    assert.equal(hash(await readFile(resolve(root, frame.path))), frame.sha256)
    assert.ok(capture.images.some(row => resolve(root, row.path) === resolve(root, frame.path) && row.sha256 === frame.sha256), 'Reviewed image comes from actual capture')
  }
  assert.equal(hash(await readFile(resolve(root, visual.review))), visual.reviewSHA256)
  process.stdout.write(core.log + restart.log + 'Creation preparation: exact Core, restarted workface, mounted surface and independent image proof verified\n')
}
