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
  { id: 'original-source-request', source, from: 'input?.requestId !== request.input.requestId', to: 'false', owner: 'rejects stale source requests and embedded frames without changing a healthy selection' },
  { id: 'capture-source-metadata', source: 'apps/desktop/src/main/screen-capture.ts', from: 'scale: shot.scale, capturedAt } } : {}', to: 'scale: 1, capturedAt } } : {}', owner: 'hands the editor the capture rectangle, scale and start time' }
] : slice === 'documents' ? [
  { id: 'original-file-revision', source, from: 'expectedRevision, ...(expectedRevision === null ? { exclusive: true } : {})',
    to: 'expectedRevision: (await this.read(grant, false)).file.revision, ...(expectedRevision === null ? { exclusive: true } : {})', owner: 'preserves an externally changed original instead of overwriting it with an earlier revision' },
  { id: 'late-original-decode', source: 'apps/desktop/src/renderer/screenshot-editor/use-system-screenshot-original.ts', from: 'if (edits.current !== startEdit)', to: 'if (false)', owner: 'keeps newer edits when original image decode or an earlier save finishes later' },
  { id: 'unknown-first-save', source: 'apps/desktop/src/renderer/screenshot-editor/use-system-screenshot-original.ts', from: 'uncertain.current.set(operationId, attempt)', to: 'void attempt', owner: 'retains the first save operation after a lost IPC response and reconciles only that receipt' }
] : [
  { id: 'cancel-must-not-write', source, from: "if (path === null) return { status: 'cancelled' }", to: 'void path', owner: 'cancelling the native save choice writes no file and keeps the image' },
  { id: 'actual-final-pixels', source, from: 'await ports.writeFile(path, bytes)', to: 'await ports.writeFile(path, new Uint8Array([1, 2, 3]))', owner: 'exports the actual processed PNG bytes to the user chosen destination' },
  { id: 'capture-time-name', source, from: 'two(time.getHours())', to: 'two(time.getMinutes())', owner: 'names the save choice by the local capture time' },
  { id: 'logical-size-halved', source, from: 'Math.round(image.width / scale)', to: 'Math.round(image.width)', owner: 'saves at 1x logical size by halving a scale 2 image before choosing a destination' },
  { id: 'pixel-save-keeps-pixels', source, from: 'scale !== undefined && scale > 1', to: 'scale !== undefined', owner: 'a pixel-exact save never resizes' },
  { id: 'overwrite-needs-confirmation', source, from: "properties: ['showOverwriteConfirmation', 'createDirectory']", to: "properties: ['createDirectory']", owner: 'the native save sheet names the capture, belongs to the image window and confirms replacing a file' },
  { id: 'editor-on-capture-display', source: 'apps/desktop/src/main/system-screenshot-editor.ts', from: 'screen.getDisplayMatching(rect).workArea', to: 'screen.getDisplayMatching({ x: 0, y: 0, width: 1, height: 1 }).workArea', owner: 'opens the editor centred on the display that holds the capture' },
  { id: 'pin-at-capture-origin', source: 'apps/desktop/src/main/system-screenshot-editor.ts', from: 'width: params.image!.width / source.scale', to: 'width: source.rect.width', owner: 'pins the edited image over its capture rectangle at the image logical size' },
  { id: 'notice-newest-editor', source: 'apps/desktop/src/main/system-screenshot-editor.ts', from: 'const request = [...this.requests.values()].at(-1)', to: 'const request = [...this.requests.values()][0]', owner: 'a repeated capture shortcut brings the newest editor forward with a notice' },
  { id: 'return-focus-last-editor', source: 'apps/desktop/src/main/system-screenshot-editor.ts', from: 'if (this.requests.size === 0 && !this.disposed)', to: 'if (!this.disposed)', owner: 'closing the last editor of a capture taken from another app returns focus to that app' },
  { id: 'return-focus-only-unmoved', source: 'apps/desktop/src/main/system-screenshot-editor.ts', from: 'if (focused === null || focused === window)', to: 'if (true)', owner: 'closing the last editor of a capture taken from another app returns focus to that app' },
  { id: 'logical-size-uses-capture-scale', source: 'apps/desktop/src/main/system-screenshot-editor.ts', from: '{ logicalScale: source!.scale }', to: '{}', owner: 'names the save by the capture time and saves at 1x by the capture scale only when asked' }
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
