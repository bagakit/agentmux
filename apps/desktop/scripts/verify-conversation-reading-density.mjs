import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { captureReadingDensity } from './fixtures/conversation-reading-density/capture.mjs'

const root = resolve(import.meta.dirname, '../../..'), area = join(root, '.local/conversation-duplication')
const config = 'apps/desktop/scripts/fixtures/conversation-reading-density/vitest.owning.config.mts'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const read = async file => JSON.parse(await readFile(file, 'utf8'))
const own = 'apps/desktop/scripts/verify-conversation-reading-density.mjs'
const configText = await readFile(join(root, config), 'utf8')
const mutations = [...configText.matchAll(/^\s*'([^']+)': \[/gmu)].map(match => match[1])
assert.ok(mutations.length > 0 && new Set(mutations).size === mutations.length, 'Nonempty unique mutations from the actual owning config')
const sourceHash = sources => hash(JSON.stringify(Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)))))
function mergeSources(target, inputs) {
  for (const [file, sha] of Object.entries(inputs)) {
    if (target[file]) assert.equal(target[file], sha, 'Candidate source changed between proofs: ' + file)
    target[file] = sha
  }
}
async function execute(command, args, log, env = {}) {
  const result = await new Promise((yes, no) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    child.on('error', no); child.on('close', (code, signal) => yes({ code, signal, output }))
  })
  await writeFile(log, result.output)
  return { exit: result.code, signal: result.signal, argv: [command, ...args], log: relative(root, log) }
}
async function tests(directory, name, mutation, adjacent = false) {
  const report = join(directory, name + '.json'), loaded = join(directory, name + '.loaded.jsonl')
  const execution = await execute(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
    '--maxWorkers=1', '--reporter=json', '--outputFile=' + report], join(directory, name + '.log'),
  { AGENTMUX_READING_DENSITY_ADJACENT: adjacent ? '1' : '', AGENTMUX_READING_DENSITY_MUTATION: mutation ?? '', AGENTMUX_READING_DENSITY_LOADED: loaded })
  assert.equal(execution.signal, null, 'A terminated process is not semantic proof')
  const value = await read(report), cases = value.testResults.flatMap(item => item.assertionResults)
  assert.ok(cases.length > 0 && value.numTotalTests === cases.length, 'Nonempty exact test collection')
  const inputs = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(inputs.length > 0, 'Actual loaded candidate inputs')
  for (const input of inputs) assert.ok(!input.path.startsWith('.worktrees/'), 'The actual candidate is used')
  return { ...execution, report: relative(root, report), loaded: relative(root, loaded), cases: cases.map(item => ({ name: item.fullName, status: item.status })),
    assertionFailures: cases.filter(item => item.status === 'failed' && item.failureMessages.some(message => message.includes('AssertionError'))).length, inputs }
}
async function prepare() {
  const directory = join(area, 'reading-' + Date.now()); await mkdir(directory, { recursive: true })
  const receipt = { schema: 'agentmux.conversation-reading-density.v1', passed: false, sources: {}, baseline: null, mutants: [], restored: null, capture: null }
  try {
    for (const file of [own, config]) receipt.sources[file] = hash(await readFile(join(root, file)))
    receipt.baseline = await tests(directory, 'baseline')
    assert.equal(receipt.baseline.exit, 0, 'Owning baseline: ' + receipt.baseline.log)
    mergeSources(receipt.sources, Object.fromEntries(receipt.baseline.inputs.map(input => [input.path, input.originalSHA256])))
    for (const mutation of mutations) {
      const mutant = await tests(directory, mutation, mutation)
      assert.ok(mutant.exit > 0 && mutant.assertionFailures > 0, 'The actual implementation mutation must fail a behavioral assertion: ' + mutation)
      assert.deepEqual(mutant.cases.map(item => item.name), receipt.baseline.cases.map(item => item.name), 'Same baseline and mutant collection')
      const changed = mutant.inputs.filter(input => input.mutation === mutation)
      assert.equal(changed.length, 1, 'One actual transformed owning module: ' + mutation)
      assert.notEqual(changed[0].sha256, changed[0].originalSHA256)
      receipt.mutants.push({ name: mutation, ...mutant })
      console.log(mutation + ': assertion RED')
    }
    receipt.adjacent = await tests(directory, 'adjacent', undefined, true)
    assert.equal(receipt.adjacent.exit, 0, 'Owning adjacent reading checks: ' + receipt.adjacent.log)
    mergeSources(receipt.sources, Object.fromEntries(receipt.adjacent.inputs.map(input => [input.path, input.originalSHA256])))
    receipt.restored = await tests(directory, 'restored')
    assert.equal(receipt.restored.exit, 0, 'Restored actual implementation')
    assert.deepEqual(receipt.restored.cases.map(item => item.name), receipt.baseline.cases.map(item => item.name))
    mergeSources(receipt.sources, Object.fromEntries(receipt.restored.inputs.map(input => [input.path, input.originalSHA256])))
    receipt.types = await execute('pnpm', ['--filter', '@agentmux/client-ui', 'typecheck'], join(directory, 'types.log'))
    assert.equal(receipt.types.signal, null); assert.equal(receipt.types.exit, 0, 'Shared component types: ' + receipt.types.log)
    receipt.capture = await captureReadingDensity(join(directory, 'visual'))
    mergeSources(receipt.sources, receipt.capture.sources)
    for (const [file, sha] of Object.entries(receipt.sources)) assert.equal(hash(await readFile(join(root, file))), sha, 'Source changed during qualification: ' + file)
    receipt.sourceSha256 = sourceHash(receipt.sources)
    receipt.captureSha256 = hash(await readFile(join(directory, 'visual/capture.json')))
    receipt.artifacts = {}
    const runs = [receipt.baseline, ...receipt.mutants, receipt.adjacent, receipt.restored]
    const files = [...runs.flatMap(run => [run.report, run.loaded, run.log]), receipt.types.log,
      ...['capture.json', 'actual.json', 'public-reading.json'].map(file => relative(root, join(directory, 'visual', file)))]
    for (const file of files) receipt.artifacts[file] = hash(await readFile(join(root, file)))
    receipt.passed = true
  } catch (error) { receipt.failure = { message: error.message, stack: error.stack }; console.error(receipt.failure.message) }
  const receiptPath = join(directory, 'receipt.json')
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
  await writeFile(join(area, 'reading-current.json'), JSON.stringify({ directory: relative(root, directory), passed: receipt.passed,
    receiptSha256: hash(await readFile(receiptPath)), sourceSha256: receipt.sourceSha256 ?? null, captureSha256: receipt.captureSha256 ?? null,
    independentVisualReview: 'pending', independentCodeReview: 'pending' }, null, 2) + '\n')
  assert.equal(receipt.passed, true, receipt.failure?.message)
  console.log(JSON.stringify({ prepared: true, directory: relative(root, directory), sourceSha256: receipt.sourceSha256, captureSha256: receipt.captureSha256,
    tests: receipt.baseline.cases.length, mutants: receipt.mutants.length, images: receipt.capture.frames.length, independentReview: 'pending', boundary: receipt.capture.boundary }))
}
async function verify() {
  const pointer = await read(join(area, 'reading-current.json')), directory = resolve(root, pointer.directory)
  assert.ok(directory.startsWith(area + '/reading-'), 'The qualification belongs to this local owner')
  assert.equal(pointer.passed, true, 'Preparation passed')
  const receiptFile = join(directory, 'receipt.json'), receipt = await read(receiptFile)
  assert.equal(hash(await readFile(receiptFile)), pointer.receiptSha256)
  assert.equal(receipt.schema, 'agentmux.conversation-reading-density.v1'); assert.equal(receipt.passed, true)
  assert.equal(sourceHash(receipt.sources), pointer.sourceSha256)
  for (const [file, sha] of Object.entries(receipt.sources)) assert.equal(hash(await readFile(join(root, file))), sha, 'Qualified source changed: ' + file)
  assert.ok(Object.keys(receipt.artifacts).length > 0, 'Nonempty exact proof artifacts')
  for (const [file, sha] of Object.entries(receipt.artifacts)) assert.equal(hash(await readFile(join(root, file))), sha, 'Qualified proof changed: ' + file)
  for (const file of [receipt.baseline.report, receipt.adjacent.report, receipt.restored.report]) {
    const report = await read(join(root, file)); assert.equal(report.success, true); assert.ok(report.numPassedTests > 0 && report.numFailedTests === 0)
  }
  assert.deepEqual(receipt.mutants.map(mutant => mutant.name), mutations)
  for (const mutant of receipt.mutants) { assert.ok(mutant.exit > 0 && mutant.assertionFailures > 0); assert.equal((await read(join(root, mutant.report))).success, false) }
  const captureFile = join(directory, 'visual/capture.json'), capture = await read(captureFile)
  assert.equal(hash(await readFile(captureFile)), pointer.captureSha256); assert.equal(capture.passed, true)
  const visual = await read(join(area, 'visual-review.json'))
  assert.ok(visual.reviewer && visual.reviewer !== 'plan_review', 'Independent full-image reviewer identity')
  assert.equal(visual.passed, true); assert.equal(visual.captureSha256, pointer.captureSha256)
  assert.ok(capture.frames.length > 0); assert.equal(visual.images.length, capture.frames.length)
  for (const frame of capture.frames) {
    const sha = hash(await readFile(join(directory, 'visual', frame.file)))
    assert.equal(sha, frame.sha256); assert.ok(visual.images.some(image => image.file === frame.file && image.sha256 === sha && image.passed === true), 'Actually reviewed complete image: ' + frame.file)
  }
  const code = await read(join(area, 'code-review.json'))
  assert.ok(code.reviewer && code.reviewer !== 'plan_review', 'Independent code reviewer identity')
  assert.equal(code.passed, true); assert.equal(code.sourceSha256, pointer.sourceSha256); assert.deepEqual(code.unresolvedP0P1, [])
  console.log(JSON.stringify({ passed: true, directory: pointer.directory, tests: receipt.baseline.cases.length, mutants: receipt.mutants.length,
    images: capture.frames.length, sourceSha256: pointer.sourceSha256, captureSha256: pointer.captureSha256 }))
}
await mkdir(area, { recursive: true })
if (process.argv.includes('--prepare')) await prepare()
else if (process.argv.includes('--verify')) await verify()
else throw Error('Use --prepare to produce candidate evidence or --verify to consume independent reviews')
