import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 2 && args[0] === '--receipt', 'Use --receipt PATH or no arguments')
const directory = join(root, '.tmp/browser-selection-image-reading', 'attempt-' + randomUUID())
const receiptPath = args.length ? resolve(args[1]) : join(directory, 'receipt.json')
await mkdir(directory, { recursive: true }); await mkdir(dirname(receiptPath), { recursive: true })
const hash = input => createHash('sha256').update(input).digest('hex')
const candidate = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const sources = new Map()
const receipt = { schema: 'agentmux.browser-selection-image-reading.v1', candidate: candidate(), passed: false,
  sources: {}, runs: [], sharedTreeMutations: 0,
  boundary: 'Actual shared message/reading components, Desktop platform and ConversationImage through its typed exact-reference API adapter. The image transport, viewport observations and DOM image decoding errors are controlled test inputs; no Main filesystem validation, native screenshot, OS input or complete T006 qualification.' }
const save = () => writeFile(receiptPath, JSON.stringify({ ...receipt, sources: Object.fromEntries(sources) }, null, 2))
const config = 'apps/desktop/test/browser-selection-image-reading.config.mts'
const tests = ['apps/desktop/test/browser-selection-image-reading.test.tsx', 'packages/client-ui/test/conversation-browser-context.test.tsx']
for (const file of [config, ...tests, 'apps/desktop/scripts/verify-browser-selection-image-reading.mjs'])
  sources.set(file, hash(await readFile(join(root, file))))
await save()
function execute(env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config,
      '--reporter=json', '--outputFile=' + env.AGENTMUX_SELECTION_READING_REPORT], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = '', timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 60000)
    child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', (code, signal) => { clearTimeout(timer); resolveRun({ code, signal, timedOut, log }) })
  })
}
const mutants = [
  { id: 'disclosure', file: 'packages/client-ui/src/components/ConversationBrowserContext.tsx',
    expected: 'A closed context must not read its image' },
  { id: 'readonly', file: 'packages/client-ui/src/components/ConversationBrowserContext.tsx',
    expected: 'Read-only without the image opt-in must have zero image IO' },
  { id: 'reference', file: 'apps/desktop/src/renderer/src/components/BrowserSelectionImage.tsx',
    expected: 'The exact changed image reference must reach its original Host reader' }
]
async function run(label, mutation) {
  const reportFile = join(directory, label + '.json'), inputFile = join(directory, label + '-inputs.jsonl')
  const env = { ...process.env, NODE_ENV: 'test', AGENTMUX_SELECTION_READING_REPORT: reportFile, AGENTMUX_SELECTION_READING_INPUTS: inputFile }
  delete env.AGENTMUX_SELECTION_READING_MUTATION
  if (mutation) env.AGENTMUX_SELECTION_READING_MUTATION = mutation.id
  const result = await execute(env)
  await writeFile(join(directory, label + '.log'), result.log)
  assert.equal(result.timedOut, false, 'A timeout is not a behavioral result')
  assert.equal(result.signal, null, 'A process failure is not an owning assertion')
  const report = JSON.parse(await readFile(reportFile, 'utf8'))
  assert.equal(report.numTotalTests, 13, 'Both actual consumer suites must collect their complete cases')
  assert.equal(report.numPendingTests, 0); assert.equal(report.numTodoTests, 0)
  assert.equal(report.testResults.length, 2)
  assert.ok(report.testResults.every(suite => suite.assertionResults.length > 0 && !suite.message), 'Collection failure is not semantic RED')
  const failures = report.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed')
  if (mutation) {
    assert.notEqual(result.code, 0); assert.equal(report.success, false); assert.ok(failures.length > 0)
    assert.ok(failures.some(test => test.failureMessages.some(message => message.includes('AssertionError') && message.includes(mutation.expected))),
      'The owning image-reading assertion must fail: ' + mutation.id)
    assert.ok(failures.every(test => test.failureMessages.every(message => message.includes('AssertionError'))), 'Setup errors do not qualify RED')
  } else { assert.equal(result.code, 0); assert.equal(report.success, true); assert.equal(report.numPassedTests, 13); assert.equal(failures.length, 0) }
  const inputs = (await readFile(inputFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const changed = new Set()
  for (const input of inputs) {
    assert.equal(input.source, hash(await readFile(join(root, input.path))), 'The executed source must match the candidate')
    if (sources.has(input.path)) assert.equal(input.source, sources.get(input.path), 'Source cannot drift between proof runs')
    else sources.set(input.path, input.source)
    if (input.mutated) { changed.add(input.path); assert.notEqual(input.served, input.source) }
    else assert.equal(input.served, input.source)
  }
  for (const file of ['apps/desktop/src/renderer/src/components/DesktopClientUiProvider.tsx',
    'apps/desktop/src/renderer/src/components/BrowserSelectionImage.tsx', 'apps/desktop/src/renderer/src/lib/api.ts',
    'packages/client-ui/src/platform.tsx', 'packages/client-ui/src/components/ConversationInputText.tsx',
    'packages/client-ui/src/components/ConversationBrowserContext.tsx', 'packages/client-ui/src/components/ConversationImage.tsx'])
    assert.ok(inputs.some(input => input.path === file), 'The actual consumer must load candidate source: ' + file)
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
  assert.equal(candidate(), receipt.candidate)
  receipt.passed = true; await save()
  console.log('Qualified shared image-reading receipt: ' + receiptPath)
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; await save(); throw error }
