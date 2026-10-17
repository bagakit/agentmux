import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, relative } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const args = process.argv.slice(2)
let receiptArgument, consumerOnly = false
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--receipt' && !receiptArgument) receiptArgument = args[++index]
  else if (args[index] === '--consumer-only' && !consumerOnly) consumerOnly = true
  else throw new Error('Use --receipt PATH and optional --consumer-only for a bounded development diagnostic')
}
const directory = join(root, '.tmp/browser-resource-presentation', 'attempt-' + randomUUID())
const receiptPath = receiptArgument ? resolve(receiptArgument) : join(directory, 'receipt.json')
await mkdir(join(directory, 'home'), { recursive: true }); await mkdir(dirname(receiptPath), { recursive: true })
const hash = input => createHash('sha256').update(input).digest('hex')
const candidate = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const sources = new Map()
const receipt = { schema: 'agentmux.browser-resource-presentation.v1', candidate: candidate(), passed: false,
  diagnostic: consumerOnly, consumersPassed: false, sources: {}, runs: [], sharedTreeMutations: 0,
  boundary: 'Actual SettingsPanel/Browser module/Store and production preload consume original directory, performance lease and exact release/restore APIs over controlled typed IPC facts. Original Main lifecycle ownership is unchanged. Native presentation and independent OS image approval are separate source-bound inputs; this consumer receipt alone does not qualify visuals or resource lifecycle.' }
const save = () => writeFile(receiptPath, JSON.stringify({ ...receipt, sources: Object.fromEntries(sources) }, null, 2))
const config = 'apps/desktop/test/browser-resource-presentation.config.mts'
const tests = ['apps/desktop/test/browser-resource-directory-ui.fixture.tsx']
for (const file of [config, ...tests, 'apps/desktop/scripts/verify-browser-resource-presentation.mjs'])
  sources.set(file, hash(await readFile(join(root, file))))
await save()
function execute(env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config,
      '--reporter=json', '--outputFile=' + env.AGENTMUX_RESOURCE_REPORT], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = '', timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 60000)
    child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', (code, signal) => { clearTimeout(timer); resolveRun({ code, signal, timedOut, log }) })
  })
}
const mutants = [
  { id: 'shared', file: 'apps/desktop/src/renderer/src/components/settings/browser-resource-view.ts',
    expected: 'shares one all-Workspace directory and preserves partial positions while deduplicating exact process births' },
  { id: 'receipt', file: 'apps/desktop/src/renderer/src/components/settings/BrowserResources.tsx',
    expected: 'dispatches one finite release batch serially through preload and keeps each original mixed receipt without retry' },
  { id: 'selection', file: 'apps/desktop/src/renderer/src/components/settings/BrowserResources.tsx',
    expected: 'keeps the selected original document when refresh, filtering and new pages change the visible directory' }
]
async function run(label, mutation) {
  const reportFile = join(directory, label + '.json'), inputFile = join(directory, label + '-inputs.jsonl')
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key))), NODE_ENV: 'test', HOME: join(directory, 'home'), AGENTMUX_DIRECTORY_PRIVATE_HOME: join(directory, 'home'), AGENTMUX_RESOURCE_REPORT: reportFile, AGENTMUX_RESOURCE_INPUTS: inputFile, AGENTMUX_RESOURCE_CACHE: join(directory, 'cache') }
  delete env.AGENTMUX_RESOURCE_MUTATION
  if (mutation) env.AGENTMUX_RESOURCE_MUTATION = mutation.id
  const result = await execute(env)
  await writeFile(join(directory, label + '.log'), result.log)
  assert.equal(result.timedOut, false, 'A timeout is not a behavioral result')
  assert.equal(result.signal, null, 'A process failure is not an owning assertion')
  const report = JSON.parse(await readFile(reportFile, 'utf8'))
  assert.equal(report.numTotalTests, 11, 'Both actual consumer suites must collect their complete cases')
  assert.equal(report.numPendingTests, 0); assert.equal(report.numTodoTests, 0)
  assert.equal(report.testResults.length, 1)
  assert.ok(report.testResults.every(suite => suite.assertionResults.length > 0 && !suite.message), 'Collection failure is not semantic RED')
  const failures = report.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed')
  if (mutation) {
    assert.notEqual(result.code, 0); assert.equal(report.success, false); assert.ok(failures.length > 0)
    assert.ok(failures.some(test => test.fullName === mutation.expected && test.failureMessages.some(message => message.includes('AssertionError'))),
      'The owning resource assertion must fail: ' + mutation.id)
    assert.ok(failures.every(test => test.failureMessages.every(message => message.includes('AssertionError'))), 'Setup errors do not qualify RED')
  } else { assert.equal(result.code, 0); assert.equal(report.success, true); assert.equal(report.numPassedTests, 11); assert.equal(failures.length, 0) }
  const inputs = (await readFile(inputFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const changed = new Set()
  for (const input of inputs) {
    assert.equal(input.source, hash(await readFile(join(root, input.path))), 'The executed source must match the candidate')
    if (sources.has(input.path)) assert.equal(input.source, sources.get(input.path), 'Source cannot drift between proof runs')
    else sources.set(input.path, input.source)
    if (input.mutated) { changed.add(input.path); assert.notEqual(input.served, input.source) }
    else assert.equal(input.served, input.source)
  }
  for (const file of ['apps/desktop/src/renderer/src/components/settings/BrowserResources.tsx',
    'apps/desktop/src/renderer/src/components/settings/browser-resource-view.ts',
    'apps/desktop/src/renderer/src/components/SettingsPanel.tsx',
    'apps/desktop/src/renderer/src/components/settings/BrowserSettingsPane.tsx',
    'apps/desktop/src/renderer/src/lib/api.ts', 'apps/desktop/src/preload/index.ts',
    'apps/desktop/src/renderer/src/lib/use-performance-observation.ts'])
    assert.ok(inputs.some(input => input.path === file), 'The actual resource consumer must load candidate source: ' + file)
  assert.deepEqual([...changed], mutation ? [mutation.file] : [])
  receipt.runs.push({ label, mutation: mutation?.id ?? null, result: mutation ? 'owning-AssertionRED' : 'GREEN',
    report: reportFile, reportSha256: hash(await readFile(reportFile)), inputs: inputFile, inputsSha256: hash(await readFile(inputFile)),
    tests: report.numTotalTests, failedTests: report.numFailedTests, exitCode: result.code })
  await save(); console.log(label + ': ' + (mutation ? 'owning AssertionRED' : 'GREEN'))
}
try {
  await run('baseline')
  for (const mutation of mutants) await run('mutant-' + mutation.id, mutation)
  await run('restored')
  assert.equal(receipt.runs.length, 5)
  for (const [file, digest] of sources) assert.equal(hash(await readFile(join(root, file))), digest, 'The final source and tests must remain exact')
  receipt.endingCandidate = candidate()
  receipt.consumersPassed = true
  if (!consumerOnly) {
    const reviewPath = join(root, '.tmp/browser-resource-presentation/visual-review.json')
    const reviewBytes = await readFile(reviewPath), review = JSON.parse(reviewBytes)
    assert.equal(review.approved, true, 'An independent reviewer must approve the original two product images')
    const nativePath = resolve(root, review.nativeReceipt), nativeBytes = await readFile(nativePath), native = JSON.parse(nativeBytes)
    assert.equal(native.passed, true); assert.equal(native.capture.passed, true); assert.equal(native.capture.cleanup.windowDestroyed, true)
    assert.equal(native.capture.frames.length, 2); assert.equal(review.files.length, 2)
    for (const file of ['apps/desktop/src/renderer/src/components/settings/BrowserResources.tsx',
      'apps/desktop/src/renderer/src/components/settings/browser-resource-view.ts',
      'apps/desktop/src/renderer/src/styles/browser-resources.css', 'apps/desktop/src/renderer/src/styles/settings-materials.css']) {
      const current = hash(await readFile(join(root, file)))
      assert.equal(native.sources[file]?.file, current, 'The actual visual surface remains exact: ' + file)
      assert.equal(native.sources[file]?.consumed, current)
    }
    for (const frame of native.capture.frames) {
      const file = resolve(dirname(nativePath), frame.file), reviewed = review.files.find(item => resolve(root, item.file) === file)
      assert.ok(reviewed, 'Every original normal/narrow image must be independently reviewed')
      assert.equal(hash(await readFile(file)), frame.sha256); assert.equal(reviewed.sha256, frame.sha256)
    }
    receipt.visual = { review: relative(root, reviewPath), sha256: hash(reviewBytes), nativeReceipt: relative(root, nativePath), nativeSha256: hash(nativeBytes),
      boundary: 'Independent static normal/narrow OS image approval of actual Settings with controlled protocol data; no resource lifecycle, real machine measurement or physical input claim.' }
    receipt.passed = true
  }
  await save()
  console.log((consumerOnly ? 'Resource consumer diagnostic: ' : 'Qualified resource presentation: ') + receiptPath)
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; await save(); throw error }
