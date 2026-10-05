import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { listProbeProcesses } from './probe-process.mjs'

const repository = resolve(import.meta.dirname, '../../..')
const evidence = join(repository, '.bagakit/editor-format-implementation/evidence/notebook-svg-native-mutation')
const producer = 'apps/desktop/scripts/verify-notebook-svg-native.mjs'
const runner = 'apps/desktop/scripts/verify-file-format-native.mjs'
const component = 'apps/desktop/src/renderer/src/components/file-preview/StaticMarkupPreview.tsx'
const inputs = [producer, runner, component, 'apps/desktop/scripts/fixtures/file-format-capabilities/main.cjs',
  'apps/desktop/scripts/fixtures/file-format-capabilities/entry.tsx', 'apps/desktop/scripts/fixtures/file-format-capabilities/documents.mjs',
  'apps/desktop/scripts/fixtures/file-surface-quality/visual/entry.tsx',
  'apps/desktop/src/renderer/src/components/file-preview/NotebookFilePreview.tsx', 'apps/desktop/scripts/probe-process.mjs']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const sourceHashes = async () => Object.fromEntries(await Promise.all(inputs.map(async file => [file, sha(await readFile(join(repository, file)))])))
const anchor = "FORBID_ATTR: ['srcdoc', 'srcset', 'target', 'action', 'formaction', 'autofocus']"
const after = anchor + ",\n        ALLOWED_URI_REGEXP: /^(?:#|data:image\\/(?:png|jpeg|gif|webp);base64,)/i"
const original = await readFile(join(repository, component), 'utf8')
assert.equal(original.split(anchor).length - 1, 1)
await mkdir(evidence, { recursive: true })
const report = { schema: 'agentmux.notebook-svg-native-mutation.v1', passed: false, sharedTreeMutations: 0, sourceBefore: await sourceHashes(),
  mutation: { label: 'notebook-svg-old-uri-regexp-strips-geometry', file: component, before: anchor, after }, cases: [] }
try {
  for (const [name, mutated] of [['baseline-green', false], ['red', true], ['restore-green', false]]) {
    const directory = join(evidence, name), args = [runner, '--diagnose-notebook', '--output=' + directory, ...(mutated ? ['--static-uri-mutation'] : [])]
    const outcome = await new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, args, { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] }); let log = ''
      child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
      child.once('error', rejectRun); child.once('close', (code, signal) => resolveRun({ code, signal, log }))
    })
    await writeFile(join(evidence, name + '.log'), outcome.log)
    const receipt = JSON.parse(await readFile(join(directory, 'capture-receipt.json'), 'utf8'))
    const native = JSON.parse(await readFile(join(directory, 'capture-render.json'), 'utf8'))
    assert.equal(outcome.signal, null); assert.equal(receipt.captureOutcome.timedOut, false); assert.equal(receipt.captureOutcome.interruption, null)
    assert.deepEqual(receipt.cleanup.remaining, []); assert.doesNotMatch(await readFile(join(directory, 'capture-process.log'), 'utf8'), /FATAL|SIGTRAP/)
    const expectedLoaded = sha(mutated ? original.replace(anchor, after) : original)
    assert.equal(receipt.staticMarkupLoaded.sha256, expectedLoaded); assert.equal(receipt.staticMarkupLoaded.mutated, mutated)
    assert.equal(sha(await readFile(join(directory, 'loaded-static-markup.ts'))), expectedLoaded)
    if (mutated) {
      assert.equal(outcome.code, 1); assert.equal(receipt.captureOutcome.exitCode, 1); assert.equal(native.passed, false)
      assert.equal(native.failure.name, 'AssertionError'); assert.match(native.failure.stack, /staticFrames/); assert.match(native.failure.message, /420|100/)
    } else {
      assert.equal(outcome.code, 0); assert.equal(receipt.captureOutcome.exitCode, 0); assert.equal(receipt.diagnosticPassed, true); assert.equal(native.passed, true)
      assert.ok(native.staticOutputs.some(fact => fact.svg?.rect.width === '360' && fact.svg?.text.y === '54'))
      assert.ok(native.notebookPaint.length >= 2); assert.equal(native.network.length, 0); assert.equal(native.writes.length, 0)
    }
    assert.ok(receipt.diagnosticTemporary)
    const remaining = await listProbeProcesses(-1, receipt.diagnosticTemporary); assert.deepEqual(remaining, [])
    await rm(receipt.diagnosticTemporary, { recursive: true, force: true })
    report.cases.push({ name, mutated, exit: outcome.code, nativeOutcome: receipt.captureOutcome, sourceDigest: receipt.sourceDigest,
      loaded: receipt.staticMarkupLoaded, raw: { receipt: name + '/capture-receipt.json', receiptSha256: sha(await readFile(join(directory, 'capture-receipt.json'))),
        native: name + '/capture-render.json', nativeSha256: sha(await readFile(join(directory, 'capture-render.json'))), log: name + '.log', logSha256: sha(outcome.log),
        processLog: name + '/capture-process.log', processLogSha256: sha(await readFile(join(directory, 'capture-process.log'))) },
      assertion: native.failure ?? null, cleanup: { remaining, temporaryRemoved: true } })
    console.log(name + ': actual native SVG ' + (mutated ? 'AssertionRED' : 'restoreGREEN'))
  }
  report.sourceAfter = await sourceHashes(); assert.deepEqual(report.sourceAfter, report.sourceBefore); report.passed = true
} catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack } }
await writeFile(join(evidence, 'receipt.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ passed: report.passed, receipt: join(evidence, 'receipt.json'), failure: report.failure ?? null }))
process.exitCode = report.passed ? 0 : 1
