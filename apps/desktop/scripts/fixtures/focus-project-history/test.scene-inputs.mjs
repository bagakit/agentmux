import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const repo = resolve(import.meta.dirname, '../../../../..')
const consumer = process.env.AGENTMUX_FOCUS_SCENE_INPUTS_CONSUMER ?? resolve(repo, 'apps/desktop/scripts/focus-timeline-reading-qualification.mjs')
const { assertFocusTimelineSceneInputs } = await import(pathToFileURL(consumer).href)
const archive = resolve(repo, 'docs/reviews/evidence/focus-timeline-reading-2026-10-04/original-receipts')
const sceneBytes = readFileSync(resolve(archive, 'focus-timeline-read-coverage-scene-recipient-proof-final/receipt.json'))
const scene = JSON.parse(sceneBytes)
const scopeBytes = readFileSync(resolve(archive, 'focus-timeline-stable-main-20261004/css-join-preview.json'))
const scope = JSON.parse(scopeBytes)
const acceptedMainCssBytes = execFileSync('git', ['show', 'b432eccfd928493ed47c5e0ad177d7110915f0c6:apps/desktop/src/renderer/src/styles/focus.css'], { cwd: repo })
const hash = value => createHash('sha256').update(value).digest('hex')
const cssPath = 'apps/desktop/src/renderer/src/styles/focus.css'
const paths = ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'apps/desktop/src/renderer/src/components/FocusMessagePreview.tsx', 'apps/desktop/src/renderer/src/lib/focus-history-timeline.ts', cssPath]
assert.equal(scene.passed, true); assert.equal(hash(sceneBytes), scope.sceneReceiptSHA256)
assert.equal(hash(acceptedMainCssBytes), scope.acceptedMainCssSHA256)

function fixture(run) {
  const root = mkdtempSync(resolve(tmpdir(), 'focus-scene-inputs-'))
  try {
    mkdirSync(dirname(resolve(root, cssPath)), { recursive: true })
    writeFileSync(resolve(root, cssPath), acceptedMainCssBytes)
    const scopeFile = resolve(root, 'scope.json'); writeFileSync(scopeFile, scopeBytes)
    const options = { root, sceneBytes, paths, expectedInputs: { ...scene.inputs, [cssPath]: hash(acceptedMainCssBytes) }, styleScopeFile: scopeFile, acceptedMainCssBytes }
    return run(options)
  } finally { rmSync(root, { recursive: true }) }
}

test('joins actual b432 Main CSS to the exact original scene only for its nonempty Timeline suffix', () => fixture(options => {
  const consumed = assertFocusTimelineSceneInputs(options)
  assert.equal(consumed.timelineBytes, 22675)
  assert.equal(consumed.timelineSuffixSHA256, scope.ownSuffixSHA256)
  assert.equal(consumed.acceptedWholeCssSHA256, scope.acceptedMainCssSHA256)
  assert.equal(consumed.sceneWholeCssSHA256, scene.inputs[cssPath])
  assert.notEqual(consumed.acceptedWholeCssSHA256, consumed.sceneWholeCssSHA256)
}))

test('preserves the physical in-flight prefix without pretending that it is accepted Main CSS', () => fixture(options => {
  const physical = `/* Another surface is still being edited. */\n${acceptedMainCssBytes.toString('utf8')}`
  writeFileSync(resolve(options.root, cssPath), physical)
  options.expectedInputs[cssPath] = hash(physical)
  const consumed = assertFocusTimelineSceneInputs(options)
  assert.equal(consumed.timelineSuffixSHA256, scope.ownSuffixSHA256)
  assert.equal(consumed.physicalWholeCssSHA256, hash(physical))
  assert.notEqual(consumed.physicalWholeCssSHA256, consumed.acceptedWholeCssSHA256)
}))

test('rejects an actually changed same-size suffix despite correct Main, scene and physical whole hashes', () => fixture(options => {
  const needle = 'background: var(--blue); pointer-events: none;'
  const original = acceptedMainCssBytes.toString('utf8'); assert.equal(original.split(needle).length, 2)
  const wrong = original.replace(needle, 'background: var(--pink); pointer-events: none;')
  assert.equal(Buffer.byteLength(wrong), acceptedMainCssBytes.length)
  writeFileSync(resolve(options.root, cssPath), wrong); options.expectedInputs[cssPath] = hash(wrong)
  assert.throws(() => assertFocusTimelineSceneInputs(options), { code: 'ERR_ASSERTION', message: /Timeline suffix SHA256/u })
}))

test('keeps the exact other product inputs and requires explicit CSS scope', () => fixture(options => {
  assert.throws(() => assertFocusTimelineSceneInputs({ ...options, styleScopeFile: undefined }), { code: 'ERR_ASSERTION' })
  const expectedInputs = { ...options.expectedInputs, [paths[0]]: '0'.repeat(64) }
  assert.throws(() => assertFocusTimelineSceneInputs({ ...options, expectedInputs }), { code: 'ERR_ASSERTION' })
}))

test('rejects a different mother or empty/ambiguous CSS selector scope', () => fixture(options => {
  assert.throws(() => assertFocusTimelineSceneInputs({ ...options, sceneBytes: Buffer.from(`${sceneBytes}\n`) }), { code: 'ERR_ASSERTION', message: /Exact original scene receipt/u })
  const wrong = `${acceptedMainCssBytes}\n${scope.ownMarker}\n`
  writeFileSync(resolve(options.root, cssPath), wrong); options.expectedInputs[cssPath] = hash(wrong)
  assert.throws(() => assertFocusTimelineSceneInputs(options), { code: 'ERR_ASSERTION', message: /Unique actual Timeline CSS anchor/u })
}))
