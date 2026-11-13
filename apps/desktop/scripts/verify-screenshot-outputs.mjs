import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2), slice = args[args.indexOf('--slice') + 1]
assert.ok(['export', 'pin', 'documents', 'capture'].includes(slice), 'Choose an output verification slice')
assert.ok(args.every((arg, index) => ['--slice', '--mutations', slice].includes(arg)), 'Unsupported output verification option')
if (slice === 'pin') {
  const code = await new Promise((done, reject) => {
    const child = spawn(process.execPath, ['apps/desktop/scripts/verify-screenshot-pins.mjs'], { stdio: 'inherit' })
    child.once('error', reject); child.once('exit', (code, signal) => { if (signal) reject(new Error('The original pin verifier was terminated')); else done(code ?? 1) })
  })
  process.exit(code)
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const source = slice === 'capture' ? 'apps/desktop/src/main/screenshot-source-picker.ts' : slice === 'documents' ? 'apps/desktop/src/main/screenshot-original-files.ts' : 'apps/desktop/src/main/screenshot-files.ts'
const original = await readFile(source, 'utf8')
const mutations = slice === 'capture' ? [
  { id: 'exact-source-key', source, from: 'request.choices.get(input.key)', to: 'request.choices.values().next().value', owner: 'selects the exact original display key rather than the first or similarly labelled display' },
  { id: 'original-source-request', source, from: 'input?.requestId !== request.input.requestId', to: 'false', owner: 'rejects stale source requests and embedded frames without changing a healthy selection' }
] : slice === 'documents' ? [
  { id: 'original-file-revision', source, from: 'expectedRevision, ...(expectedRevision === null ? { exclusive: true } : {})',
    to: 'expectedRevision: (await this.read(grant, false)).file.revision, ...(expectedRevision === null ? { exclusive: true } : {})', owner: 'preserves an externally changed original instead of overwriting it with an earlier revision' },
  { id: 'late-original-decode', source: 'apps/desktop/src/renderer/screenshot-editor/use-system-screenshot-original.ts', from: 'if (edits.current !== startEdit)', to: 'if (false)', owner: 'keeps newer edits when original image decode or an earlier save finishes later' },
  { id: 'unknown-first-save', source: 'apps/desktop/src/renderer/screenshot-editor/use-system-screenshot-original.ts', from: 'uncertain.current.set(operationId, attempt)', to: 'void attempt', owner: 'retains the first save operation after a lost IPC response and reconciles only that receipt' }
] : [
  { id: 'cancel-must-not-write', source, from: "if (path === null) return { status: 'cancelled' }", to: 'void path', owner: 'cancelling the native save choice writes no file and keeps the image' },
  { id: 'actual-final-pixels', source, from: 'await ports.writeFile(path, bytes)', to: 'await ports.writeFile(path, new Uint8Array([1, 2, 3]))', owner: 'exports the actual processed PNG bytes to the user chosen destination' }
]
const originals = Object.fromEntries(await Promise.all([...new Set([source, ...mutations.map(row => row.source)])].map(async path => [path, await readFile(path, 'utf8')])))
await mkdir(resolve('.tmp'), { recursive: true })
const out = await mkdtemp(resolve('.tmp/screenshot-output-proof-'))
const testFiles = slice === 'capture' ? ['screenshot-sources.test.ts', 'screen-capture.test.ts'] : slice === 'documents'
  ? ['screenshot-original-files.test.ts', 'system-screenshot-original.test.tsx'] : ['screenshot-files.test.ts', 'system-screenshot-editor.test.ts']
const inputFiles = [...new Set([...Object.keys(originals), ...testFiles.map(file => 'apps/desktop/test/' + file),
  'apps/desktop/test/screenshot-outputs.config.mts', 'apps/desktop/scripts/verify-screenshot-outputs.mjs',
  ...(slice === 'export' ? ['apps/desktop/src/main/system-screenshot-editor.ts'] : []),
  ...(slice === 'capture' ? ['apps/desktop/src/main/screen-capture.ts', 'apps/desktop/src/shared/screenshot-source.ts'] : [])])]
const inputHashes = async () => Object.fromEntries(await Promise.all(inputFiles.map(async file => [file, sha(await readFile(file))])))
const sourceHashes = await inputHashes()
const receipt = { schema: 'agentmux.screenshot-output-proof.v1', passed: false, slice, sourceHash: sha(original), sourceHashes, runs: [] }
async function run(mutation) {
  const label = mutation?.id ?? 'baseline', report = join(out, label + '.json'), loaded = join(out, label + '.loaded.ndjson')
  const result = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/test/screenshot-outputs.config.mts', '--reporter=json', '--outputFile=' + report], {
      env: { ...process.env, AGENTMUX_OUTPUT_SLICE: slice, AGENTMUX_OUTPUT_MUTATION: mutation ? JSON.stringify(mutation) : '', AGENTMUX_OUTPUT_LOADED: loaded }, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''; child.stdout.on('data', data => { log += data }); child.stderr.on('data', data => { log += data })
    child.on('error', reject); child.on('exit', (code, signal) => done({ code, signal, log }))
  })
  await writeFile(join(out, label + '.log'), result.log)
  assert.equal(result.signal, null, 'A terminated test is not behavioral evidence')
  const parsed = JSON.parse(await readFile(report, 'utf8')), assertions = parsed.testResults.flatMap(file => file.assertionResults)
  assert.ok(assertions.length > 0 && parsed.testResults.every(file => !file.message), 'Fresh nonempty collected tests required')
  assert.doesNotMatch(result.log, /Unhandled Errors|Unhandled Rejection/)
  if (mutation) {
    const consumed = (await readFile(loaded, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.ok(consumed.length > 0 && consumed.every(row => row.hash === sha(originals[mutation.source].replace(mutation.from, mutation.to))), 'The original production owner must load the mutation')
    assert.notEqual(result.code, 0, 'Production mutation survived')
    assert.equal(assertions.find(row => row.title === mutation.owner)?.status, 'failed', 'The intended behavior must fail')
  } else { assert.equal(result.code, 0, result.log); assert.ok(assertions.every(row => row.status === 'passed')) }
  receipt.runs.push({ label, assertions: assertions.length, exitCode: result.code })
  process.stdout.write(label + ': ' + (mutation ? 'AssertionRED' : 'GREEN') + '\n')
}
try {
  await run()
  if (args.includes('--mutations')) for (const mutation of mutations) await run(mutation)
  for (const [path, source] of Object.entries(originals)) assert.equal(sha(await readFile(path)), sha(source), 'The owning candidate changed during proof')
  assert.deepEqual(await inputHashes(), sourceHashes, 'The complete output candidate changed during proof')
  receipt.passed = true
} finally { await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2)) }
process.stdout.write(JSON.stringify({ passed: receipt.passed, receipt: join(out, 'receipt.json') }) + '\n')
