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
const desktopImages = [...desktopScenes.map(scene => `${scene}-light.png`), ...desktopScenes.map(scene => `${scene}-dark.png`), 'focus-lod-menu-narrow-dark.png', 'routes-device-tail-narrow-dark.png', 'projects-executor-unavailable-narrow-dark.png', 'projects-executor-unavailable-narrow-light.png', 'focus-lod-menu-short-light.png'].sort()
const settingsImages = ['connection-transport-draft-420-dark.png', 'connection-transport-menu-420-dark.png', 'connection-transport-selected-420-dark.png', 'node-menu-960-light.png', 'node-selected-960-light.png', 'node-menu-420-dark.png', 'node-selected-420-dark.png', 'node-menu-320-light.png', 'node-selected-320-light.png', 'node-missing-menu-420-dark.png', 'node-missing-recovered-420-dark.png', 'node-identity-error-420-dark.png', 'node-owner-error-420-dark.png'].sort()
const settingsOwningSources = [
  'apps/desktop/src/renderer/src/components/SelectionField.tsx',
  'apps/desktop/src/renderer/src/components/settings/HostSettingsPane.tsx',
  'apps/desktop/src/renderer/src/components/settings/NetworkNodeSettingsPane.tsx',
  'apps/desktop/src/renderer/src/components/settings/hosts-settings.css',
  'apps/desktop/src/renderer/src/components/settings/network-node.css',
  'apps/desktop/scripts/fixtures/settings-connections/entry.tsx',
]
const requiredDriverSources = section => [
  'apps/desktop/scripts/capture-ui-selection-field.mjs',
  `apps/desktop/scripts/fixtures/ui-selection-field/${section}-main.cjs`,
  'apps/desktop/scripts/fixtures/settings-connections/native-input.cjs',
  'apps/desktop/scripts/fixtures/settings-connections/environment.mjs',
  'apps/desktop/scripts/fixtures/settings-resource-library/environment.mjs',
  'apps/desktop/scripts/candidate-package-resolve.mjs',
  'apps/desktop/scripts/probe-process.mjs',
  'apps/desktop/scripts/radix-overlay-aliases.ts',
]

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
  const section = mode === 'settings' ? 'node' : mode === 'desktop' || mode === 'final' ? 'desktop' : undefined
  for (const file of section ? requiredDriverSources(section) : []) assert.ok(captureSources[file], `Capture required source is missing: ${file}`)
  assert.equal(sourceIdentity(captureSources), capture.sourceIdentity, 'Capture source identity must match its own manifest')
  const currentSources = Object.fromEntries(Object.keys(captureSources).map(file => [file, sha(readFileSync(resolve(root, file)))]))
  assert.equal(sourceIdentity(currentSources), capture.sourceIdentity, 'Capture source identity must match the current candidate')
  const receiptDirectory = dirname(receiptPath)
  assert.equal(capture.sourceIdentity, review.sourceIdentity, 'Review and capture must share sourceIdentity')
  for (const [file, digest] of Object.entries(review.sourceHashes ?? {})) {
    assert.equal(capture.sources?.[file], digest, `Reviewed source hash must match capture: ${file}`)
    assert.equal(sha(readFileSync(resolve(root, file))), digest, `Reviewed source must match the current candidate: ${file}`)
  }
  if (mode === 'settings') {
    for (const file of settingsOwningSources) assert.ok(review.sourceHashes?.[file], `Review owning source hash is required: ${file}`)
    const interactions = capture.interactions ?? []
    assert.ok(interactions.some(item => item.kind === 'native-renderer-click' && item.selector?.includes('[data-value=')), 'Native selection evidence is required')
    assert.ok(interactions.some(item => item.kind === 'native-renderer-key' && item.expectedDOMKey === 'Escape' && item.events?.some(event => event.type === 'keydown' && event.key === 'Escape' && event.trusted)), 'Native Escape evidence is required')
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
  if (mode === 'settings') assert.deepEqual(captured, settingsImages, 'Settings capture must contain the exact complete scene set')
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
  const identity = sha(JSON.stringify(source))
  const receiptPath = join(directory, 'capture.json')
  writeFileSync(receiptPath, JSON.stringify({ completed: true, execution: { exitCode: 0 }, sourceIdentity: identity, sources: source, images: [{ path: 'node.png', sha256: sha(readFileSync(image)) }] }))
  const receiptSHA = sha(readFileSync(receiptPath))
  const review = {
    schema: 'agentmux.ui-selection-visual-review.v1', reviewer: 'independent-ui-reviewer', verdict: 'approved', mustFix: [], unconfirmed: ['controlled fixture only'],
    sourceIdentity: identity, captureReceipt: { path: 'capture.json', sha256: receiptSHA }, sourceHashes: source,
    actualViews: ['node.png'], images: [{ path: 'node.png', sha256: sha(readFileSync(image)), conclusion: 'Actual field and menu are readable' }],
  }
  assert.deepEqual(validate(review, directory), { reviewer: 'independent-ui-reviewer', images: 1, sourceIdentity: identity })
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
  const driverReceiptPath = join(directory, 'driver-capture.json')
  const driverSources = Object.fromEntries([...requiredDriverSources('node'), ...settingsOwningSources, relative(root, sourceFile)].map(file => [file, sha(readFileSync(resolve(root, file)))]))
  const driverIdentity = sourceIdentity(driverSources)
  const driverFrames = settingsImages.map(name => { const path = join(directory, name); writeFileSync(path, Buffer.from('controlled-png-content')); return { path: name, sha256: sha(readFileSync(path)), conclusion: 'Controlled complete scene' } })
  const driverReceipt = { completed: true, execution: { exitCode: 0 }, sourceIdentity: driverIdentity, sources: { ...driverSources }, images: driverFrames.map(({ path, sha256 }) => ({ path, sha256 })),
    interactions: [{ kind: 'native-renderer-click', selector: '.selection-field__menu [data-value="host-02"]' }, { kind: 'native-renderer-key', expectedDOMKey: 'Escape', events: [{ type: 'keydown', key: 'Escape', trusted: true }] }] }
  writeFileSync(driverReceiptPath, JSON.stringify(driverReceipt))
  const driverReview = { ...review, sourceIdentity: driverIdentity, sourceHashes: Object.fromEntries(settingsOwningSources.map(file => [file, driverSources[file]])), captureReceipt: { path: 'driver-capture.json', sha256: sha(readFileSync(driverReceiptPath)) },
    actualViews: settingsImages, images: driverFrames }
  assert.deepEqual(validate(driverReview, directory, 'settings'), { reviewer: 'independent-ui-reviewer', images: settingsImages.length, sourceIdentity: driverIdentity })
  delete driverReceipt.sources['apps/desktop/scripts/fixtures/settings-connections/native-input.cjs']
  driverReceipt.sourceIdentity = sourceIdentity(driverReceipt.sources)
  writeFileSync(driverReceiptPath, JSON.stringify(driverReceipt))
  driverReview.sourceIdentity = driverReceipt.sourceIdentity
  driverReview.captureReceipt.sha256 = sha(readFileSync(driverReceiptPath))
  assert.throws(() => validate(driverReview, directory, 'settings'), /Capture required source/)
  driverReceipt.sources = { ...driverSources, 'apps/desktop/scripts/fixtures/settings-connections/native-input.cjs': '0'.repeat(64) }
  driverReceipt.sourceIdentity = driverIdentity
  writeFileSync(driverReceiptPath, JSON.stringify(driverReceipt))
  driverReview.sourceIdentity = driverIdentity
  driverReview.captureReceipt.sha256 = sha(readFileSync(driverReceiptPath))
  assert.throws(() => validate(driverReview, directory, 'settings'), /its own manifest/)
  driverReceipt.sources = driverSources
  driverReceipt.sourceIdentity = driverIdentity
  writeFileSync(driverReceiptPath, JSON.stringify(driverReceipt))
  driverReview.sourceIdentity = driverIdentity
  driverReview.captureReceipt.sha256 = sha(readFileSync(driverReceiptPath))
  const owningHashes = driverReview.sourceHashes
  driverReview.sourceHashes = {}
  assert.throws(() => validate(driverReview, directory, 'settings'), /Review owning source hash is required/)
  driverReview.sourceHashes = owningHashes
  driverReceipt.interactions = []
  writeFileSync(driverReceiptPath, JSON.stringify(driverReceipt))
  driverReview.captureReceipt.sha256 = sha(readFileSync(driverReceiptPath))
  assert.throws(() => validate(driverReview, directory, 'settings'), /Native selection evidence is required/)
  driverReceipt.interactions = [{ kind: 'native-renderer-click', selector: '.selection-field__menu [data-value="host-02"]' }]
  writeFileSync(driverReceiptPath, JSON.stringify(driverReceipt))
  driverReview.captureReceipt.sha256 = sha(readFileSync(driverReceiptPath))
  assert.throws(() => validate(driverReview, directory, 'settings'), /Native Escape evidence is required/)
  driverReceipt.interactions = [{ kind: 'native-renderer-click', selector: '.selection-field__menu [data-value="host-02"]' }, { kind: 'native-renderer-key', expectedDOMKey: 'Escape', events: [{ type: 'keydown', key: 'Escape', trusted: true }] }]
  driverReceipt.images = driverReceipt.images.slice(1)
  writeFileSync(driverReceiptPath, JSON.stringify(driverReceipt))
  driverReview.captureReceipt.sha256 = sha(readFileSync(driverReceiptPath))
  assert.throws(() => validate(driverReview, directory, 'settings'), /Settings capture must contain the exact complete scene set/)
  const finalReceiptPath = join(directory, 'final-capture.json')
  const finalSources = { ...driverSources, 'apps/desktop/scripts/fixtures/ui-selection-field/desktop-main.cjs': sha(readFileSync(resolve(root, 'apps/desktop/scripts/fixtures/ui-selection-field/desktop-main.cjs'))) }
  delete finalSources['apps/desktop/scripts/fixtures/settings-connections/native-input.cjs']
  const finalIdentity = sourceIdentity(finalSources)
  writeFileSync(finalReceiptPath, JSON.stringify({ completed: true, execution: { exitCode: 0 }, sourceIdentity: finalIdentity, sources: finalSources, images: [{ path: 'node.png', sha256: sha(readFileSync(image)) }] }))
  const finalReview = { ...review, sourceIdentity: finalIdentity, sourceHashes: {}, captureReceipt: { path: 'final-capture.json', sha256: sha(readFileSync(finalReceiptPath)) } }
  assert.throws(() => validate(finalReview, directory, 'final'), /Capture required source/)
  review.actualViews = []
  assert.throws(() => validate(review, directory), /Every declared image must be actually viewed/)
  const nested = join(directory, 'nested')
  mkdirSync(nested, { recursive: true })
  const nestedImage = join(nested, 'node.png')
  writeFileSync(nestedImage, Buffer.from('controlled-png-content'))
  const nestedReceiptPath = join(nested, 'capture.json')
  writeFileSync(nestedReceiptPath, JSON.stringify({ completed: true, execution: { exitCode: 0 }, sourceIdentity: identity, sources: source, images: [{ path: 'node.png', sha256: sha(readFileSync(nestedImage)) }] }))
  const nestedReview = { ...review, actualViews: ['node.png'], captureReceipt: { path: 'nested/capture.json', sha256: sha(readFileSync(nestedReceiptPath)) }, images: [{ path: 'node.png', sha256: sha(readFileSync(nestedImage)), conclusion: 'Nested receipt owns its image root' }] }
  assert.deepEqual(validate(nestedReview, directory), { reviewer: 'independent-ui-reviewer', images: 1, sourceIdentity: identity })
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
