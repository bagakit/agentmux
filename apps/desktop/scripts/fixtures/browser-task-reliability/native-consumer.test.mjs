import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync, gunzipSync } from 'node:zlib'
import { verifyTaskReliabilityNativeReceipt } from '../../verify-browser-task-reliability-native-receipt.mjs'

// The fixture reads actual immutable Native8 originals. Typed review doubles below only
// exercise evidence shape; they never count as an independent visual examination.
assert.ok(process.env.AGENTMUX_RELIABILITY_NATIVE_ORIGINAL, 'Provide the actual immutable archive through AGENTMUX_RELIABILITY_NATIVE_ORIGINAL; no generated Native receipt fixture is substituted')
const archive = resolve(process.env.AGENTMUX_RELIABILITY_NATIVE_ORIGINAL)
const raw = await readFile(join(archive, 'receipt.json')), original = JSON.parse(raw)
const scratch = await mkdtemp(join(tmpdir(), 'amx-reliability-consumer-'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
after(() => rm(scratch, { recursive: true }))
let index = 0

async function changed(change, phaseChange = null, sourceChange = null) {
  const base = join(scratch, String(index++)); await import('node:fs/promises').then(fs => fs.mkdir(base))
  for (const row of await readdir(archive, { withFileTypes: true })) {
    if (row.name !== 'receipt.json') await symlink(join(archive, row.name), join(base, row.name))
  }
  const receipt = structuredClone(original)
  if (phaseChange) {
    const row = receipt.phases.find(row => row.phase === phaseChange.phase)
    const value = JSON.parse(await readFile(join(archive, row.original.path)))
    phaseChange.mutate(value)
    const bytes = Buffer.from(JSON.stringify(value))
    await rm(join(base, row.original.path)); await writeFile(join(base, row.original.path), bytes)
    row.original.sha256 = sha(bytes); row.original.bytes = bytes.length
  }
  if (sourceChange) {
    const row = receipt.inputs.find(source => source.path.endsWith(sourceChange.suffix))
    const bytes = gunzipSync(await readFile(join(archive, row.snapshot)))
    // The actual archived hash stays unchanged: this is a corrupted original test.
    const corrupted = Buffer.from(bytes); corrupted[0] ^= 1
    const target = join(base, 'changed-source.gz'); await writeFile(target, gzipSync(corrupted))
    row.snapshot = 'changed-source.gz'
  }
  change(receipt)
  await writeFile(join(base, 'receipt.json'), JSON.stringify(receipt))
  return { base, receipt, path: join(base, 'receipt.json') }
}

function review(receipt, receiptSha256) {
  return { schema: 'agentmux.browser-task-reliability-independent-visual-review.v1', producerAuthor: receipt.author,
    reviewer: '/test/typed-review-double', independent: true, receiptSha256, producerScope: receipt.scope,
    scope: 'Shape-only fixture; no independent visual proof', assessment: 'pass', nativePassed: false, taskComplete: false,
    images: receipt.images.map(row => ({ ...Object.fromEntries(['path', 'phase', 'label', 'kind', 'sha256', 'bytes'].map(key => [key, row[key]])), viewed: true, assessment: 'Shape-only parser double, not an independent image examination.' })) }
}

test('actual two-process original consumes only a partial Native scope', async () => {
  const result = await verifyTaskReliabilityNativeReceipt(['--receipt', join(archive, 'receipt.json')])
  assert.equal(result.outcome, 'partial')
  assert.equal(result.partial.sourceInputs, original.inputs.length)
  assert.deepEqual(result.partial.processIds, original.phases.map(row => row.pid))
  assert.deepEqual(result.partial.observedRates, [1, 0])
  assert.equal(result.partial.privateSelectedDurableRestore, true)
  assert.equal(result.partial.visual, 'pending')
  assert.equal(result.nativePassed, false); assert.equal(result.taskComplete, false)
})

test('fake full scope and empty actual source collection are rejected', async () => {
  for (const mutate of [row => { row.nativePassed = true }, row => { row.inputs = [] }]) {
    const sample = await changed(mutate)
    assert.equal((await verifyTaskReliabilityNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
  }
})

test('changed actual source gzip cannot inherit its original SHA', async () => {
  const sample = await changed(() => {}, null, { suffix: 'browser-task-reliability.ts' })
  assert.equal((await verifyTaskReliabilityNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
})

test('empty compiled bytes and a repeated original process identity are rejected', async () => {
  for (const mutate of [row => { row.compiled = [] }, row => { row.phases[1].pid = row.phases[0].pid }]) {
    const sample = await changed(mutate)
    assert.equal((await verifyTaskReliabilityNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
  }
})

test('real passed verification must preserve all original condition statuses', async () => {
  const sample = await changed(() => {}, { phase: 'first', mutate: row => {
    row.calls.find(call => call.method === 'verifyOutcome' && call.result.status === 'passed').result.conditions[0].status = 'unavailable'
  } })
  assert.equal((await verifyTaskReliabilityNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
})

test('real public rate cannot disagree with its terminal denominator', async () => {
  const sample = await changed(() => {}, { phase: 'first', mutate: row => {
    row.calls.find(call => call.method === 'controlTask' && call.result.reliability.counts.passed === 1).result.reliability.passRate = 0.5
  } })
  assert.equal((await verifyTaskReliabilityNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
})

test('real public counts cannot relabel the actual retained sample', async () => {
  const sample = await changed(() => {}, { phase: 'first', mutate: row => {
    row.calls.find(call => call.method === 'controlTask' && call.result.reliability.counts.passed === 1).result.reliability.samples[0].result = 'unavailable'
  } })
  assert.equal((await verifyTaskReliabilityNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
})

test('second process selected facts cannot silently change', async () => {
  const sample = await changed(() => {}, { phase: 'second', mutate: row => { row.recovered.state.selectedRunId = 'foreign-run' } })
  assert.equal((await verifyTaskReliabilityNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
})

test('new original document cannot replay the old actions on restore', async () => {
  const sample = await changed(() => {}, { phase: 'second', mutate: row => { row.originalPage.clicks = 2 } })
  assert.equal((await verifyTaskReliabilityNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
})

test('actual image bytes cannot inherit another image hash', async () => {
  const sample = await changed(row => { row.images[0].sha256 = '0'.repeat(64) })
  assert.equal((await verifyTaskReliabilityNativeReceipt(['--receipt', sample.path])).outcome, 'rejected')
})

test('review shape is exact and cannot claim whole Native acceptance', async () => {
  const sample = await changed(() => {})
  const bytes = await readFile(sample.path), typed = review(sample.receipt, sha(bytes)), reviewPath = join(sample.base, 'typed-review-double.json')
  await writeFile(reviewPath, JSON.stringify(typed))
  const result = await verifyTaskReliabilityNativeReceipt(['--receipt', sample.path, '--visual-review', reviewPath])
  assert.equal(result.outcome, 'partial'); assert.equal(result.partial.visual, 'passed-increment-only')
  assert.equal(result.nativePassed, false); assert.equal(result.taskComplete, false)
  // This is a parser double, not an independent image receipt.
  typed.images[0].phase = 'second'; await writeFile(reviewPath, JSON.stringify(typed))
  assert.equal((await verifyTaskReliabilityNativeReceipt(['--receipt', sample.path, '--visual-review', reviewPath])).outcome, 'rejected')
})

test('review author and original image bijection cannot be replaced', async () => {
  const sample = await changed(() => {}), receiptBytes = await readFile(sample.path)
  for (const mutate of [row => { row.reviewer = row.producerAuthor }, row => { row.images[1] = row.images[0] }, row => { row.producerScope = 'full-desktop' }]) {
    const typed = review(sample.receipt, sha(receiptBytes)); mutate(typed)
    const path = join(sample.base, 'bad-review.json'); await writeFile(path, JSON.stringify(typed))
    assert.equal((await verifyTaskReliabilityNativeReceipt(['--receipt', sample.path, '--visual-review', path])).outcome, 'rejected')
  }
})

test('missing and unexpected CLI inputs never become task success', async () => {
  assert.equal((await verifyTaskReliabilityNativeReceipt()).outcome, 'pending')
  assert.equal((await verifyTaskReliabilityNativeReceipt(['--receipt', join(scratch, 'absent.json')])).outcome, 'pending')
  const result = await verifyTaskReliabilityNativeReceipt(['--unknown'])
  assert.equal(result.outcome, 'rejected'); assert.deepEqual(result.actions, [])
  assert.equal(result.taskComplete, false)
})

test('actual Root typed review binds every original and keeps complete Native pending', async () => {
  assert.ok(process.env.AGENTMUX_RELIABILITY_NATIVE_VISUAL_REVIEW, 'Provide the actual Root review through AGENTMUX_RELIABILITY_NATIVE_VISUAL_REVIEW')
  const result = await verifyTaskReliabilityNativeReceipt(['--receipt', join(archive, 'receipt.json'), '--visual-review', process.env.AGENTMUX_RELIABILITY_NATIVE_VISUAL_REVIEW])
  assert.equal(result.outcome, 'partial')
  assert.equal(result.partial.visual, 'passed-increment-only')
  assert.equal(result.partial.images, original.images.length)
  assert.equal(result.partial.privateSelectedDurableRestore, true)
  assert.equal(result.nativePassed, false); assert.equal(result.taskComplete, false)
})
