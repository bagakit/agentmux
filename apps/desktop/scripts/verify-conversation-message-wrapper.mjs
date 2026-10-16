import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { captureWrapper } from './fixtures/conversation-message-wrapper/capture.mjs'

const root = resolve(import.meta.dirname, '../../..'), area = join(root, '.tmp/a2a-conversation-wrapper')
const config = 'apps/desktop/scripts/fixtures/conversation-message-wrapper/vitest.owning.config.mts'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const read = async file => JSON.parse(await readFile(file, 'utf8'))
const owned = [
  'packages/client-ui/src/components/ConversationMessage.tsx', 'packages/client-ui/src/components/ConversationInputText.tsx',
  'packages/client-ui/src/components/ConversationResourceText.tsx', 'packages/client-ui/src/styles/conversation-message.css',
  'packages/client-ui/test/conversation-leading-context.test.tsx', 'apps/desktop/test/conversation-message-wrapper.integration.test.tsx', 'apps/desktop/scripts/verify-conversation-message-wrapper.mjs', config,
  ...['capture.mjs', 'generate.mjs', 'main.cjs', 'entry.tsx', 'inputs.mjs', 'index.html', 'preview.css'].map(file => 'apps/desktop/scripts/fixtures/conversation-message-wrapper/' + file)
]
function mergeSources(target, inputs) {
  for (const [file, sha] of Object.entries(inputs)) {
    if (target[file]) assert.equal(target[file], sha, 'Candidate source changed between consumers: ' + file)
    target[file] = sha
  }
}
const mutations = ['reminder-missing', 'packet-plain', 'copy-body-only', 'resource-nonleading', 'input-parser-missing']
async function execute(command, args, log, env = {}) {
  const result = await new Promise((yes, no) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    child.on('error', no); child.on('close', (code, signal) => yes({ code, signal, output }))
  })
  await writeFile(log, result.output)
  return { exit: result.code, signal: result.signal, log: relative(root, log) }
}
async function tests(directory, name, mutation, adjacent = false) {
  const report = join(directory, name + '.json'), loaded = join(directory, name + '.loaded.jsonl')
  const processResult = await execute(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
    '--maxWorkers=1', '--reporter=json', '--outputFile=' + report], join(directory, name + '.log'),
  { AGENTMUX_MESSAGE_WRAPPER_ADJACENT: adjacent ? '1' : '', AGENTMUX_MESSAGE_WRAPPER_MUTATION: mutation ?? '', AGENTMUX_MESSAGE_WRAPPER_LOADED_SOURCE: loaded })
  const value = await read(report), cases = value.testResults.flatMap(item => item.assertionResults)
  assert.ok(cases.length > 0 && value.numTotalTests === cases.length, 'Nonempty exact test collection')
  assert.equal(processResult.signal, null)
  const inputs = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(inputs.length > 0 && inputs.every(item => !item.path.startsWith('.worktrees/')), 'Actual candidate inputs')
  return { ...processResult, report: relative(root, report), loaded: relative(root, loaded), cases: cases.map(item => ({ name: item.fullName, status: item.status })),
    assertionFailures: cases.filter(item => item.status === 'failed' && item.failureMessages.some(message => message.includes('AssertionError'))).length, inputs }
}
async function prepare() {
  const directory = join(area, 'run-' + Date.now()); await mkdir(directory, { recursive: true })
  const receipt = { schema: 'agentmux.conversation-a2a-reading.v1', passed: false, sources: {}, baseline: null, mutants: [], restored: null, capture: null }
  try {
    for (const file of owned) receipt.sources[file] = hash(await readFile(join(root, file)))
    const baseline = await tests(directory, 'baseline')
    assert.equal(baseline.exit, 0, 'Owning baseline: ' + baseline.log)
    receipt.baseline = baseline
    mergeSources(receipt.sources, Object.fromEntries(baseline.inputs.map(input => [input.path, input.originalSHA256])))
    for (const mutation of mutations) {
      const mutant = await tests(directory, mutation, mutation)
      assert.ok(mutant.exit > 0 && mutant.assertionFailures > 0, 'Behavior assertion must fail: ' + mutation)
      assert.deepEqual(mutant.cases.map(item => item.name), baseline.cases.map(item => item.name), 'Same mutant collection')
      const changed = mutant.inputs.filter(input => input.mutation === mutation)
      assert.equal(changed.length, 1, 'One actual transformed owning module')
      receipt.mutants.push({ name: mutation, ...mutant })
      console.log(mutation + ': assertion RED')
    }
    receipt.adjacent = await tests(directory, 'adjacent', undefined, true)
    assert.equal(receipt.adjacent.exit, 0, 'Reading regressions: ' + receipt.adjacent.log)
    mergeSources(receipt.sources, Object.fromEntries(receipt.adjacent.inputs.map(input => [input.path, input.originalSHA256])))
    receipt.restored = await tests(directory, 'restored')
    assert.equal(receipt.restored.exit, 0)
    const types = await execute('pnpm', ['--filter', '@agentmux/client-ui', 'typecheck'], join(directory, 'types.log'))
    assert.equal(types.exit, 0, 'Shared component types: ' + types.log); receipt.types = types
    receipt.capture = await captureWrapper(join(directory, 'visual'))
    mergeSources(receipt.sources, receipt.capture.sources)
    for (const [file, sha] of Object.entries(receipt.sources)) assert.equal(hash(await readFile(join(root, file))), sha, 'Input changed during qualification: ' + file)
    receipt.artifacts = {}
    const results = [receipt.baseline, ...receipt.mutants, receipt.adjacent, receipt.restored]
    const files = [...results.flatMap(result => [result.report, result.loaded, result.log]), receipt.types.log,
      ...['capture.json', 'actual.json', 'public-reading.json'].map(file => relative(root, join(directory, 'visual', file)))]
    for (const file of files) receipt.artifacts[file] = hash(await readFile(join(root, file)))
    receipt.passed = true
  } catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
  await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  assert.equal(receipt.passed, true, receipt.failure?.message)
  await writeFile(join(area, 'current.json'), JSON.stringify({ directory: relative(root, directory) }) + '\n')
  await writeFile(join(directory, 'review.md'), '# Independent visual review pending\n\n' + receipt.capture.boundary + '\n\n' + receipt.capture.frames.map(frame => `- [${frame.file}](visual/${frame.file})`).join('\n') + '\n\nOpen every full PNG. Confirm body precedence, secondary reminder, narrow readability, Mobile and complete resource. Store a review.json with reviewer, passed, captureSha256 and exact image hashes; do not infer aesthetic acceptance from capture success.\n')
  console.log(JSON.stringify({ prepared: true, directory: relative(root, directory), independentVisualReview: 'pending' }))
}
async function verify() {
  const pointer = await read(join(area, 'current.json')), directory = resolve(root, pointer.directory)
  assert.ok(directory.startsWith(area + '/run-'), 'Current qualification belongs to this owner')
  const receipt = await read(join(directory, 'receipt.json'))
  assert.equal(receipt.schema, 'agentmux.conversation-a2a-reading.v1'); assert.equal(receipt.passed, true)
  for (const [file, sha] of Object.entries(receipt.sources)) assert.equal(hash(await readFile(join(root, file))), sha, 'Qualified source changed: ' + file)
  assert.ok(Object.keys(receipt.artifacts).length > 0, 'Nonempty bound proof artifacts')
  for (const [file, sha] of Object.entries(receipt.artifacts)) assert.equal(hash(await readFile(join(root, file))), sha, 'Qualified proof changed: ' + file)
  for (const file of [receipt.baseline.report, receipt.adjacent.report, receipt.restored.report]) {
    const report = await read(join(root, file)); assert.equal(report.success, true); assert.ok(report.numPassedTests > 0 && report.numFailedTests === 0)
  }
  for (const mutant of receipt.mutants) { assert.ok(mutant.exit > 0 && mutant.assertionFailures > 0); assert.equal((await read(join(root, mutant.report))).success, false) }
  assert.equal(receipt.mutants.length, mutations.length)
  const captureFile = join(directory, 'visual/capture.json'), capture = await read(captureFile), review = await read(join(directory, 'review.json'))
  assert.equal(capture.passed, true); assert.equal(review.passed, true); assert.ok(review.reviewer && review.reviewer !== 'a2a_envelope_review', 'Independent actual image reviewer')
  assert.equal(review.captureSha256, hash(await readFile(captureFile)))
  assert.equal(review.images.length, capture.frames.length)
  for (const frame of capture.frames) {
    const sha = hash(await readFile(join(directory, 'visual', frame.file)))
    assert.equal(sha, frame.sha256); assert.ok(review.images.some(image => image.file === frame.file && image.sha256 === sha && image.passed === true), 'Actually reviewed full image ' + frame.file)
  }
  console.log(JSON.stringify({ passed: true, directory: pointer.directory, tests: receipt.baseline.cases.length, mutants: receipt.mutants.length, images: capture.frames.length }))
}
await mkdir(area, { recursive: true })
if (process.argv.includes('--prepare')) await prepare()
else await verify()
