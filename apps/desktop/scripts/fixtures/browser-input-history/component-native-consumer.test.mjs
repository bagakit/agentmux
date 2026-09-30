import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { after, before, test } from 'node:test'

const repo = resolve(new URL('../../../../..', import.meta.url).pathname)
const modulePath = process.env.AGENTMUX_HISTORY_COMPONENT_CONSUMER_MODULE ?? join(repo, 'apps/desktop/scripts/verify-browser-input-history-native-receipt.mjs')
const { verifyInputHistoryNativeReceipt } = await import(pathToFileURL(modulePath).href)
const evidence = join(repo, 'docs/reviews/evidence/browser-input-history-component-native-2026-10-04')
const actual = join(evidence, 'behavior-final-visual-pending')
const oldActual = join(evidence, 'attempt-1791107009138/receipt.json')
const reviewPath = join(repo, 'docs/reviews/evidence/browser-input-history-component-independent-visual-2026-10-04/attempt-1791107009138-independent-visual-review.json')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const originalBytes = await readFile(join(actual, 'receipt.json')), oldBytes = await readFile(oldActual), reviewBytes = await readFile(reviewPath)
let scratch, index = 0
before(async () => { scratch = await mkdtemp(join(tmpdir(), 'agentmux-history-component-consumer-own-')) })
after(async () => {
  await rm(scratch, { recursive: true })
  assert.equal(hash(await readFile(join(actual, 'receipt.json'))), hash(originalBytes))
  assert.equal(hash(await readFile(oldActual)), hash(oldBytes)); assert.equal(hash(await readFile(reviewPath)), hash(reviewBytes))
})
function pending(report) {
  assert.equal(report.passed, false); assert.equal(report.nativePassed, false); assert.equal(report.taskComplete, false)
  assert.deepEqual(report.actions, []); assert.ok(report.missing.length > 0)
}
async function changed(modify) {
  const directory = join(scratch, String(index++)); await import('node:fs/promises').then(fs => fs.mkdir(directory))
  for (const row of await readdir(actual, { withFileTypes: true })) if (!['receipt.json', 'first-receipt.json', 'second-receipt.json'].includes(row.name))
    await symlink(join(actual, row.name), join(directory, row.name))
  const top = JSON.parse(originalBytes), phases = await Promise.all(['first', 'second'].map(async phase => JSON.parse(await readFile(join(actual, phase + '-receipt.json')))))
  await modify(top, phases)
  for (let i = 0; i < phases.length; i++) {
    const bytes = Buffer.from(JSON.stringify(phases[i])), path = ['first', 'second'][i] + '-receipt.json'
    await writeFile(join(directory, path), bytes); top.phases[i].original = { path, bytes: bytes.length, sha256: hash(bytes) }
  }
  const path = join(directory, 'receipt.json'); await writeFile(path, JSON.stringify(top)); return path
}
async function rejected(modify, reason) {
  const report = await verifyInputHistoryNativeReceipt(['--receipt', await changed(modify)])
  pending(report); assert.equal(report.outcome, 'rejected'); assert.equal(report.component, undefined)
  if (reason) assert.match(report.reason, reason)
}
async function changedReview(modify) {
  const review = JSON.parse(reviewBytes); await modify(review)
  const path = join(scratch, 'review-' + index++ + '.json'); await writeFile(path, JSON.stringify(review)); return path
}

test('actual partial component behavior is consumed while formal CLI remains exit 2', async () => {
  const report = await verifyInputHistoryNativeReceipt(['--receipt', join(actual, 'receipt.json')])
  pending(report); assert.equal(report.outcome, 'partial'); assert.equal(report.component.behaviorVerified, true)
  assert.deepEqual(report.component.actualPids, [67165, 68145]); assert.equal(report.component.sourceOriginalCount, 350)
  assert.deepEqual(report.component.loadedArtifactsNotBoundInBothPhases, ['index.html'])
  assert.equal(report.component.composedPageVisibility, 'not-reviewed'); assert.equal(report.component.osNativeImeCommit, 'not-tested')
  const cli = spawnSync(process.execPath, [modulePath, '--receipt', join(actual, 'receipt.json')], { encoding: 'utf8', timeout: 10000 })
  assert.equal(cli.status, 2); pending(JSON.parse(cli.stdout)); assert.equal(JSON.parse(cli.stdout).outcome, 'partial')
})
test('actual independent false visual review is preserved and refuses the older passed true probe', async () => {
  const report = await verifyInputHistoryNativeReceipt(['--receipt', oldActual, '--visual-review', reviewPath])
  pending(report); assert.equal(report.outcome, 'rejected'); assert.equal(report.visualReview.passed, false)
  assert.equal(report.visualReview.originalPageComposedVisibilityPassed, false); assert.equal(report.visualReview.reviewedImages, 9)
  assert.equal(report.evidence.sha256, hash(oldBytes)); assert.equal(report.visualReview.sha256, hash(reviewBytes))
  const wrong = await verifyInputHistoryNativeReceipt(['--receipt', join(actual, 'receipt.json'), '--visual-review', reviewPath])
  pending(wrong); assert.equal(wrong.outcome, 'rejected'); assert.match(wrong.reason, /Visual review binds this exact receipt/)
})
test('actual visual review rejects duplicate images and wrong author/phase/case/kind', async () => {
  for (const modify of [review => { review.images = Array(review.images.length).fill(review.images[0]) },
    review => { review.author = 'different-producer' }, review => { review.images[0].phase = 'second' },
    review => { review.images[0].label = 'short' }, review => { review.images[0].kind = 'actual-exact-pid-composed-window' }]) {
    const report = await verifyInputHistoryNativeReceipt(['--receipt', oldActual, '--visual-review', await changedReview(modify)])
    pending(report); assert.equal(report.outcome, 'rejected'); assert.equal(report.visualReview, undefined)
    assert.match(report.reason, /Visual review binds the actual producer author|Reviewed original paths are unique|Reviewed image binds the actual case/)
  }
})
test('actual receipt with no OS originals cannot acquire a true composed visibility claim', async () => {
  // Corrupt a real failed review with a forged visibility claim; this is never a fabricated successful Native packet.
  const path = await changedReview(async review => {
    const top = JSON.parse(originalBytes), first = JSON.parse(await readFile(join(actual, 'first-receipt.json')))
    review.receipt.sha256 = hash(originalBytes); review.receipt.bytes = originalBytes.length; review.candidate = top.source.candidate
    review.originalPageComposedVisibilityPassed = true
    review.images = first.images.map(image => ({ ...image, actuallyViewed: true, viewedUsing: 'view_image' }))
  })
  const report = await verifyInputHistoryNativeReceipt(['--receipt', join(actual, 'receipt.json'), '--visual-review', path])
  pending(report); assert.equal(report.outcome, 'rejected'); assert.equal(report.component, undefined)
  assert.match(report.reason, /Three current cases have actual OS composed-window originals/)
})
test('empty actual Source collection is rejected', async () => {
  await rejected(top => { top.source.inputs = [] }, /Actual emitted Source originals is nonempty/)
})
test('corrupted actual Source identity is rejected', async () => {
  await rejected(top => { top.source.inputs[0].sha256 = '0'.repeat(64) }, /Original hash matches/)
})
test('actual loaded artifact binding is required', async () => {
  await rejected((_top, phases) => { phases[1].loaded[0].sha256 = '0'.repeat(64) }, /Actual loaded hash matches compiled original/)
})
test('actual Native recovery requires two different PIDs', async () => {
  await rejected((top, phases) => { phases[1].pid = phases[0].pid; top.phases[1].process.pid = phases[0].pid }, /two different actual Native PIDs/)
})
test('actual history IPC actor is checked', async () => {
  await rejected((_top, phases) => { phases[0].calls[0].senderWebContentsId += 100 }, /actual Renderer owner/)
})
test('actual second-process recovery is compared with the first original', async () => {
  await rejected((_top, phases) => { phases[1].durable.recovered.entries = []; phases[1].durable.file = phases[1].durable.afterDeletionFile }, /recovered the original history/)
})
test('actual late response selection is checked', async () => {
  await rejected((_top, phases) => { phases[0].assertions.find(row => row.label === 'late-main-list-keeps-draft-selection-focus').after.selection = [0, 0] }, /Late response preserved selection/)
})
test('actual composing Enter submission is checked', async () => {
  await rejected((_top, phases) => {
    const row = phases[0].assertions.find(row => row.label === 'actual-CDP-composition-no-implicit-submit')
    const enter = row.during.events.find(event => event.type === 'keydown' && event.key === 'Enter' && event.isComposing)
    row.during.submissions.push({ text: 'unexpected composition submission', at: enter.at })
  }, /Actual composing Enter did not submit/)
})
test('empty loaded/call/action/PNG collections and source-less success flags cannot be consumed', async () => {
  for (const modify of [(_top, phases) => { phases[0].loaded = [] }, (_top, phases) => { phases[0].calls = [] },
    (_top, phases) => { phases[0].actions = [] }, (_top, phases) => { phases[0].images = [] }, top => { top.passed = true }]) await rejected(modify)
})
test('producer strict CLI refuses unknown arguments before any private process work', () => {
  const driver = join(repo, 'apps/desktop/scripts/capture-browser-input-history-component-native.mjs')
  const bad = spawnSync(process.execPath, [driver, '--unknown'], { encoding: 'utf8', timeout: 10000 })
  assert.equal(bad.status, 1); assert.match(bad.stderr, /Only an evidence directory/)
  const help = spawnSync(process.execPath, [driver, '--help'], { encoding: 'utf8', timeout: 10000 })
  assert.equal(help.status, 0); assert.match(help.stdout, /Private shared-component behavior producer only/)
})
