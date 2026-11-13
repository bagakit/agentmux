import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

assert.equal(process.argv.length, 2, 'The integrated screenshot report has no skipped acceptance boundaries')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const read = async file => JSON.parse(await readFile(file, 'utf8'))
const report = { schema: 'agentmux.screenshot-experience-proof.v1', passed: false, proofs: {}, blockers: [], physicalAcceptance: 'outside-private-fixture-proof',
  boundary: 'Consumes current source-bound behavioral, public-consumer and independent image evidence. Never launches capture, changes a Session, packages, installs, or substitutes private Electron/AppKit fixtures for physical displays and WindowServer.' }
async function current(value) {
  const inputs = value.sourceHashes ?? value.sourceInputs ?? value.inputs
  assert.ok(inputs && Object.keys(inputs).length > 0, 'A receipt must bind its nonempty consumed inputs')
  for (const [file, digest] of Object.entries(inputs)) assert.equal(hash(await readFile(file)), digest, 'Changed consumed input: ' + file)
}
async function consume(name, directory, accepts, fixed = false, succeeded = value => value.passed === true) {
  try {
    const files = fixed ? [join(directory, 'receipt.json')] : (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => join(directory, entry.name, 'receipt.json'))
    for (const file of files) {
      try {
        const value = await read(file)
        assert.ok(succeeded(value)); assert.ok(accepts(value)); await current(value)
        report.proofs[name] = { file, sha256: hash(await readFile(file)) }
        return value
      } catch { /* An older, incomplete or changed candidate cannot sign this one. */ }
    }
    throw new Error('No complete current-candidate receipt')
  } catch (error) { report.blockers.push({ scope: name, message: error.message }); return null }
}
const completedMutants = rows => {
  if (!Array.isArray(rows) || rows.length < 2 || (rows[0].code ?? rows[0].exitCode) !== 0 || !rows.every(row => row.assertions > 0)) return false
  const negatives = rows.slice(1).filter(row => row.label !== 'restored')
  return negatives.length > 0 && negatives.every(row => (row.code ?? row.exitCode) !== 0) && rows.filter(row => row.label === 'restored').every(row => row.code === 0)
}
for (const slice of ['export', 'documents', 'capture']) await consume(slice, '.tmp', value => value.schema === 'agentmux.screenshot-output-proof.v1' && value.slice === slice && completedMutants(value.runs))
await consume('pins', '.local/screenshot-pins', value => value.schema === 'agentmux.screenshot-pins-proof.v1' && completedMutants(value.runs) && value.native?.passed && value.native.cases.length === 3 && value.native.screenshots.length === 4)
await consume('pin-recovery', '.local/screenshot-pin-recovery', value => value.schema === 'agentmux.screenshot-pin-recovery-proof.v1' && completedMutants(value.runs))
await consume('system-editor', '.local/system-screenshot-editor', value => value.schema === 'agentmux.system-screenshot-editor-proof.v1' && completedMutants(value.runs) && value.native?.passed && value.native.cases.length === 5 && value.native.metrics?.closedWindows === 0)
await consume('source-picker', '.local/screenshot-sources', value => value.schema === 'agentmux.screenshot-sources-proof.v1' && value.native?.passed && value.native.cases.length === 5)
for (const slice of ['enhancements', 'text-preservation']) await consume(slice, '.local/browser-image-annotation/' + slice, value => value.slice === slice && value.cases?.length > 1, true)
await consume('browser-output', '.local/browser-screenshot-workface', value => value.schema === 'agentmux.browser-screenshot-workface-native.v1' && value.mode === 'processed-output-vertical-slice' && value.cases?.length === 4)
await consume('browser-editor', '.local/browser-screenshot-workface', value => value.schema === 'agentmux.browser-screenshot-workface-native.v1' && value.mode === 'consumer-and-mutation-acceptance' && value.cases?.length > 1)
await consume('public-images', '.local/state/image-public', value => value.schema === 'agentmux.image-public-verification.v1' && value.mutations?.length > 0)
try {
  const file = '.local/reviews/screenshot-system-pin-final-review.json', review = await read(file)
  assert.equal(review.authoredReviewedProduction, false); assert.equal(review.visualVerdict, 'approved'); assert.equal(review.behaviorVerdict, 'approved')
  await current({ sourceHashes: review.reviewedSourceHashes })
  assert.equal(review.currentImages.length, 14)
  for (const image of review.currentImages) { assert.equal(image.verdict, 'approved'); assert.equal(hash(await readFile(image.path)), image.sha256) }
  report.proofs['independent-review'] = { file, sha256: hash(await readFile(file)) }
} catch (error) { report.blockers.push({ scope: 'independent-review', message: error.message }) }
try {
  const file = '.local/reviews/screenshot-source-independent-review.json', review = await read(file)
  assert.equal(review.authoredReviewedProduction, false); assert.equal(review.visualVerdict, 'approved')
  await current({ sourceHashes: review.reviewedSourceHashes })
  assert.equal(review.currentImages.length, 6)
  for (const image of review.currentImages) { assert.equal(image.verdict, 'approved'); assert.equal(hash(await readFile(image.path)), image.sha256) }
  report.proofs['source-review'] = { file, sha256: hash(await readFile(file)) }
} catch (error) { report.blockers.push({ scope: 'source-review', message: error.message }) }
await consume('native-selection', '.local/state/screenshot-experience/native-selection', value =>
  value.schema === 'agentmux.native-selection-verification.v1' && value.stateChecks?.tests > 0 && value.stateChecks.failures.length === 0 &&
  value.appKit?.tests > 0 && value.mutations?.length > 0 && value.mutations.every(mutation => mutation.state.startsWith('killed-by-')),
  false, value => value.state === 'behavior-passed-awaiting-independent-image-review')
await consume('native-pixel-lifetime', '.local/state/screenshot-experience/pixel-lifetime', value => value.mutations?.length > 0 && value.baseline)
// An optional task-local handoff can explain the missing native boundary, but never grant a pass.
try {
  const native = await read('.local/state/screenshot-experience/frozen-selection-evidence.json')
  await current(native)
  if (!native.ui.accepted) report.nativeObservation = { message: native.ui.blocker.observed, resumeWhen: native.ui.blocker.resumeWhen }
} catch { /* The canonical source-bound native receipt above remains the acceptance authority. */ }
report.passed = report.blockers.length === 0
await mkdir(resolve('.local/screenshot-experience'), { recursive: true })
const out = await mkdtemp(resolve('.local/screenshot-experience/run-'))
await writeFile(join(out, 'receipt.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ passed: report.passed, proofs: Object.keys(report.proofs), blockers: report.blockers, receipt: join(out, 'receipt.json') }))
process.exitCode = report.passed ? 0 : 1
