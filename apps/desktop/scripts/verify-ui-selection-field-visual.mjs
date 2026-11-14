import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const mode = process.argv[2] ?? '--self-test'
assert.ok(['--settings', '--desktop', '--final', '--self-test'].includes(mode), 'Known visual verification mode')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const read = path => JSON.parse(readFileSync(path, 'utf8'))

function validate(review, directory) {
  assert.equal(review.schema, 'agentmux.ui-selection-visual-review.v1', 'Visual review schema')
  assert.ok(review.reviewer, 'Independent reviewer is required')
  assert.ok(['approved', '可交付'].includes(review.verdict), 'Visual review must explicitly approve')
  assert.deepEqual(review.mustFix, [], 'Visual review must not retain must-fix items')
  assert.ok(Array.isArray(review.unconfirmed), 'Unconfirmed scope must be explicit')
  assert.ok(review.images.length > 0, 'Visual review must include actual images')
  const receiptPath = resolve(directory, review.captureReceipt.path)
  assert.equal(sha(readFileSync(receiptPath)), review.captureReceipt.sha256, 'Capture receipt must match the reviewed candidate')
  const capture = read(receiptPath)
  assert.equal(capture.sourceIdentity, review.sourceIdentity, 'Review and capture must share sourceIdentity')
  for (const [file, digest] of Object.entries(review.sourceHashes ?? {})) {
    assert.equal(capture.sources?.[file], digest, `Reviewed source hash must match capture: ${file}`)
    assert.equal(sha(readFileSync(resolve(root, file))), digest, `Reviewed source must match the current candidate: ${file}`)
  }
  const actual = [...review.actualViews].sort()
  const declared = review.images.map(image => image.path).sort()
  assert.deepEqual(actual, declared, 'Every declared image must be actually viewed, with no extras')
  const captured = (capture.images ?? []).map(image => image.path ?? image.image).filter(Boolean).sort()
  assert.ok(captured.length > 0, 'Capture must declare its actual image set')
  assert.deepEqual(declared, captured, 'Review must cover exactly every captured image and no unrelated file')
  for (const image of review.images) {
    const path = resolve(directory, image.path)
    assert.equal(sha(readFileSync(path)), image.sha256, `Reviewed PNG must be unchanged: ${image.path}`)
    assert.ok(image.conclusion, `Every image needs a concrete conclusion: ${image.path}`)
  }
  return { reviewer: review.reviewer, images: review.images.length, sourceIdentity: review.sourceIdentity }
}

function selfTest() {
  const directory = mkdtempSync(join(root, '.tmp/ui-selection-visual-self-test-'))
  const image = join(directory, 'node.png')
  writeFileSync(image, Buffer.from('controlled-png-content'))
  const source = { 'apps/desktop/src/renderer/src/components/SelectionField.tsx': sha(readFileSync(resolve(root, 'apps/desktop/src/renderer/src/components/SelectionField.tsx'))) }
  const sourceIdentity = sha(JSON.stringify(source))
  const receiptPath = join(directory, 'capture.json')
  writeFileSync(receiptPath, JSON.stringify({ sourceIdentity, sources: source, images: [{ path: 'node.png' }] }))
  const receiptSHA = sha(readFileSync(receiptPath))
  const review = {
    schema: 'agentmux.ui-selection-visual-review.v1', reviewer: 'independent-ui-reviewer', verdict: 'approved', mustFix: [], unconfirmed: ['controlled fixture only'],
    sourceIdentity, captureReceipt: { path: 'capture.json', sha256: receiptSHA }, sourceHashes: source,
    actualViews: ['node.png'], images: [{ path: 'node.png', sha256: sha(readFileSync(image)), conclusion: 'Actual field and menu are readable' }],
  }
  assert.deepEqual(validate(review, directory), { reviewer: 'independent-ui-reviewer', images: 1, sourceIdentity })
  writeFileSync(image, Buffer.from('changed-image'))
  assert.throws(() => validate(review, directory), /PNG must be unchanged/)
  writeFileSync(image, Buffer.from('controlled-png-content'))
  review.actualViews = []
  assert.throws(() => validate(review, directory), /Every declared image must be actually viewed/)
  return { selfTest: 'passed', directory: relative(root, directory) }
}

try {
  if (mode === '--self-test') console.log(JSON.stringify({ passed: true, ...selfTest() }))
  else {
    const directory = resolve(root, '.tmp/ui-selection-field')
    const review = read(resolve(directory, `${mode.slice(2)}-review.json`))
    console.log(JSON.stringify({ passed: true, mode, ...validate(review, directory) }))
  }
} catch (error) {
  console.error(JSON.stringify({ passed: false, mode, failure: { message: error instanceof Error ? error.message : String(error) } }))
  process.exitCode = 1
}
