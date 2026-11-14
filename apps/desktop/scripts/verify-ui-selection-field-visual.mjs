import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const mode = process.argv[2] ?? '--self-test'
assert.ok(['--settings', '--desktop', '--final', '--self-test'].includes(mode), 'Known visual verification mode')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const desktopScenes = ['focus-form-menu', 'focus-information-menu', 'focus-lod-menu', 'projects-executor-menu', 'projects-executor-selected', 'routes-device-menu', 'routes-device-tail', 'routes-edge-menu']
const desktopImages = [...desktopScenes.map(scene => `${scene}-light.png`), ...desktopScenes.map(scene => `${scene}-dark.png`)].sort()

function sourceIdentity(sources) {
  return sha(JSON.stringify(Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)))))
}
function validate(review, directory, mode) {
  assert.equal(review.schema, 'agentmux.ui-selection-visual-review.v1', 'Visual review schema')
  assert.ok(review.reviewer, 'Independent reviewer is required')
  assert.ok(['approved', '可交付'].includes(review.verdict), 'Visual review must explicitly approve')
  assert.deepEqual(review.mustFix, [], 'Visual review must not retain must-fix items')
  assert.ok(Array.isArray(review.unconfirmed), 'Unconfirmed scope must be explicit')
  assert.ok(review.images.length > 0, 'Visual review must include actual images')
  const receiptPath = resolve(directory, review.captureReceipt.path)
  assert.equal(sha(readFileSync(receiptPath)), review.captureReceipt.sha256, 'Capture receipt must match the reviewed candidate')
  const capture = read(receiptPath)
  assert.equal(capture.completed, true, 'Capture must complete before review')
  assert.equal(capture.execution?.exitCode, 0, 'Capture process must exit successfully')
  const captureSources = capture.sources ?? {}
  assert.ok(Object.keys(captureSources).length > 0, 'Capture must bind a nonempty source manifest')
  const currentSources = Object.fromEntries(Object.keys(captureSources).map(file => [file, sha(readFileSync(resolve(root, file)))]))
  assert.equal(sourceIdentity(currentSources), capture.sourceIdentity, 'Capture source identity must match the current candidate')
  const receiptDirectory = dirname(receiptPath)
  assert.equal(capture.sourceIdentity, review.sourceIdentity, 'Review and capture must share sourceIdentity')
  for (const [file, digest] of Object.entries(review.sourceHashes ?? {})) {
    assert.equal(capture.sources?.[file], digest, `Reviewed source hash must match capture: ${file}`)
    assert.equal(sha(readFileSync(resolve(root, file))), digest, `Reviewed source must match the current candidate: ${file}`)
  }
  const actual = [...review.actualViews].sort()
  const declared = review.images.map(image => image.path).sort()
  assert.deepEqual(actual, declared, 'Every declared image must be actually viewed, with no extras')
  const capturedImages = new Map()
  for (const image of capture.images ?? []) {
    const path = image.path ?? image.image
    assert.ok(path, 'Every capture image needs a path')
    assert.equal(capturedImages.has(path), false, `Capture image paths must be unique: ${path}`)
    capturedImages.set(path, image.sha256)
  }
  const captured = [...capturedImages.keys()].sort()
  assert.ok(captured.length > 0, 'Capture must declare its actual image set')
  if (mode === 'desktop' || mode === 'final') assert.deepEqual(captured, desktopImages, 'Desktop capture must contain the exact complete scene set')
  assert.deepEqual(declared, captured, 'Review must cover exactly every captured image and no unrelated file')
  for (const image of review.images) {
    assert.equal(capturedImages.get(image.path), image.sha256, `Capture PNG must match review: ${image.path}`)
    const path = resolve(receiptDirectory, image.path)
    assert.equal(sha(readFileSync(path)), image.sha256, `Reviewed PNG must be unchanged: ${image.path}`)
    assert.ok(image.conclusion, `Every image needs a concrete conclusion: ${image.path}`)
  }
  return { reviewer: review.reviewer, images: review.images.length, sourceIdentity: review.sourceIdentity }
}

function selfTest() {
  const directory = mkdtempSync(join(root, '.tmp/ui-selection-visual-self-test-'))
  const image = join(directory, 'node.png')
  writeFileSync(image, Buffer.from('controlled-png-content'))
  const sourceFile = join(directory, 'fixture-input.ts')
  writeFileSync(sourceFile, 'controlled-source')
  const source = { [relative(root, sourceFile)]: sha(readFileSync(sourceFile)) }
  const sourceIdentity = sha(JSON.stringify(source))
  const receiptPath = join(directory, 'capture.json')
  writeFileSync(receiptPath, JSON.stringify({ completed: true, execution: { exitCode: 0 }, sourceIdentity, sources: source, images: [{ path: 'node.png', sha256: sha(readFileSync(image)) }] }))
  const receiptSHA = sha(readFileSync(receiptPath))
  const review = {
    schema: 'agentmux.ui-selection-visual-review.v1', reviewer: 'independent-ui-reviewer', verdict: 'approved', mustFix: [], unconfirmed: ['controlled fixture only'],
    sourceIdentity, captureReceipt: { path: 'capture.json', sha256: receiptSHA }, sourceHashes: source,
    actualViews: ['node.png'], images: [{ path: 'node.png', sha256: sha(readFileSync(image)), conclusion: 'Actual field and menu are readable' }],
  }
  assert.deepEqual(validate(review, directory), { reviewer: 'independent-ui-reviewer', images: 1, sourceIdentity })
  const declaredHashes = review.sourceHashes
  review.sourceHashes = {}
  writeFileSync(sourceFile, 'changed-source')
  assert.throws(() => validate(review, directory), /current candidate/)
  writeFileSync(sourceFile, 'controlled-source')
  review.sourceHashes = declaredHashes
  writeFileSync(image, Buffer.from('changed-image'))
  assert.throws(() => validate(review, directory), /PNG must be unchanged/)
  writeFileSync(image, Buffer.from('controlled-png-content'))
  writeFileSync(image, Buffer.from('changed-image'))
  review.images[0].sha256 = sha(readFileSync(image))
  assert.throws(() => validate(review, directory), /Capture PNG must match review/)
  writeFileSync(image, Buffer.from('controlled-png-content'))
  review.images[0].sha256 = sha(readFileSync(image))
  review.actualViews = []
  assert.throws(() => validate(review, directory), /Every declared image must be actually viewed/)
  const nested = join(directory, 'nested')
  mkdirSync(nested, { recursive: true })
  const nestedImage = join(nested, 'node.png')
  writeFileSync(nestedImage, Buffer.from('controlled-png-content'))
  const nestedReceiptPath = join(nested, 'capture.json')
  writeFileSync(nestedReceiptPath, JSON.stringify({ completed: true, execution: { exitCode: 0 }, sourceIdentity, sources: source, images: [{ path: 'node.png', sha256: sha(readFileSync(nestedImage)) }] }))
  const nestedReview = { ...review, actualViews: ['node.png'], captureReceipt: { path: 'nested/capture.json', sha256: sha(readFileSync(nestedReceiptPath)) }, images: [{ path: 'node.png', sha256: sha(readFileSync(nestedImage)), conclusion: 'Nested receipt owns its image root' }] }
  assert.deepEqual(validate(nestedReview, directory), { reviewer: 'independent-ui-reviewer', images: 1, sourceIdentity })
  return { selfTest: 'passed', directory: relative(root, directory) }
}

try {
  if (mode === '--self-test') console.log(JSON.stringify({ passed: true, ...selfTest() }))
  else {
    const directory = resolve(root, '.tmp/ui-selection-field')
    const review = read(resolve(directory, `${mode.slice(2)}-review.json`))
    console.log(JSON.stringify({ passed: true, mode, ...validate(review, directory, mode.slice(2)) }))
  }
} catch (error) {
  console.error(JSON.stringify({ passed: false, mode, failure: { message: error instanceof Error ? error.message : String(error) } }))
  process.exitCode = 1
}
