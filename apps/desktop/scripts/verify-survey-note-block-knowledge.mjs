import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const [mode, evidenceRef = '.tmp/survey-note-block-knowledge/qualification.json'] = process.argv.slice(2)
assert.equal(mode, '--check-evidence', 'Expected --check-evidence [qualification.json]')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const nonempty = (value, label) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `Missing ${label}`)
  const entries = Object.entries(value)
  assert.ok(entries.length > 0, `${label} is empty`)
  return entries
}
async function bytesMatch(file, expected) {
  assert.match(expected, /^[a-f0-9]{64}$/, `Missing SHA256: ${file}`)
  const bytes = await readFile(file)
  assert.equal(hash(bytes), expected, `Changed bytes: ${file}`)
  return bytes
}
async function sourceFiles(files, label) {
  const entries = nonempty(files, label)
  for (const [file, sha] of entries) {
    const resolved = path.resolve(root, file)
    assert.ok(resolved.startsWith(root + path.sep), `Source leaves workspace: ${file}`)
    await bytesMatch(resolved, sha)
  }
  return entries.length
}
async function artifact(ref) {
  assert.ok(ref?.path, 'Missing artifact path')
  const file = path.resolve(root, ref.path)
  return { value: JSON.parse(await bytesMatch(file, ref.sha256)), file }
}
function retainedCandidate(commit) {
  assert.match(commit, /^[a-f0-9]{40}$/, 'Missing Source candidate')
  execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: root })
}
async function command(receipt, label, expectedCases) {
  assert.equal(receipt?.exit, 0, `${label} did not pass`)
  assert.ok(receipt.command && receipt.log, `Missing ${label} command/log`)
  const log = (await bytesMatch(path.resolve(root, receipt.log), receipt.sha256)).toString('utf8')
  if (expectedCases !== undefined) {
    assert.ok(Number.isInteger(expectedCases) && expectedCases > 0, `Empty ${label} result`)
    assert.equal(receipt.cases, expectedCases, `${label} case count changed`)
    assert.match(log, new RegExp(`Tests\\s+${expectedCases} passed \\(${expectedCases}\\)`), `No nonempty ${label} result`)
  }
}
async function mutation(ref, current) {
  const { value, file } = await artifact(ref)
  assert.equal(value.schema, 'agentmux.renderer-source-mutation.v1')
  assert.equal(value.passed, true)
  assert.equal(value.sharedTreeMutations, 0)
  assert.deepEqual(value.runtimeControl, [])
  nonempty(value.sourceBefore, 'mutation Source')
  assert.deepEqual(value.sourceBefore, value.sourceAfter, 'Shared Source changed during mutation')
  assert.deepEqual(value.sourceBefore, value.copyAfter, 'Private Source was not restored')
  assert.equal(value.cleanup?.copyRemoved, true)
  assert.ok(Array.isArray(value.cases) && value.cases.length > 0, 'No loaded mutations')
  // Historical dependency inputs remain in the original receipt. The current owning test/type
  // manifests qualify the joined dependencies; each current mutated production leaf must match.
  if (current) await sourceFiles(Object.fromEntries(value.cases.map(test => [test.file, value.sourceBefore[test.file]])), 'current mutated Source')
  if (ref.cases !== undefined) assert.equal(value.cases.length, ref.cases)
  for (const test of value.cases) {
    assert.equal(test.exit, 1, `No Assertion RED: ${test.label}`)
    assert.equal(test.restore?.exit, 0, `No restore GREEN: ${test.label}`)
    assert.ok(test.file.includes('/src/'), `Not a production mutation: ${test.label}`)
    assert.match(test.loaded?.sha256, /^[a-f0-9]{64}$/)
    assert.notEqual(test.loaded.sha256, value.sourceBefore[test.file], 'Mutated Source was not loaded')
    assert.equal(test.restore.loaded?.sha256, value.sourceBefore[test.file], 'Restored Source was not loaded')
    const red = await readFile(path.resolve(path.dirname(file), test.log), 'utf8')
    const green = await readFile(path.resolve(path.dirname(file), test.restore.log), 'utf8')
    assert.match(red, /AssertionError/, `RED was not an assertion: ${test.label}`)
    assert.match(green, /Tests\s+\d+ passed/, `Restore collected no cases: ${test.label}`)
  }
  return value.cases.length
}
const definitionFiles = {
  NoteFileSurfaceView: 'apps/desktop/src/renderer/src/components/NoteFileSurfaceView.tsx',
  NoteBlockEditor: 'apps/desktop/src/renderer/src/components/NoteBlockEditor.tsx',
  noteKnowledge: 'apps/desktop/src/renderer/src/lib/note-knowledge.ts',
  noteBacklinks: 'apps/desktop/src/renderer/src/lib/note-knowledge.ts',
  createNote: 'apps/desktop/src/renderer/src/store.ts',
  setNoteBlockSelection: 'apps/desktop/src/renderer/src/store.ts',
  refreshNoteDirectorySources: 'apps/desktop/src/renderer/src/store.ts',
  blockReference: 'apps/desktop/src/shared/note-content-schema.ts'
}
async function callers(groups) {
  let count = 0
  for (const [symbol, rows] of nonempty(groups, 'product callers')) {
    assert.ok(definitionFiles[symbol], `Unknown caller symbol: ${symbol}`)
    assert.ok(Array.isArray(rows) && rows.length > 0, `No callers: ${symbol}`)
    let actual = 0
    for (const row of rows) {
      const match = /^(.+):(\d+):(.*)$/.exec(row)
      assert.ok(match, `Not a Source caller: ${row}`)
      const [, file, line, text] = match
      if (file === definitionFiles[symbol] || /^\s*import\b/.test(text)) continue
      assert.ok(file.includes('/src/') && !file.includes('/test/'), `Not a product file: ${file}`)
      const sourceLines = (await readFile(path.resolve(root, file), 'utf8')).split('\n')
      assert.ok(sourceLines.includes(text), `Changed caller: ${row}`)
      assert.ok(text.includes(symbol), `Caller does not use ${symbol}`)
      actual++
    }
    assert.ok(actual > 0, `Only definitions/imports found: ${symbol}`)
    count += actual
  }
  return count
}

const proof = await json(path.resolve(root, evidenceRef))
assert.equal(proof.schema, 'agentmux.survey-note-block-knowledge.evidence.v1')
const { value: owner } = await artifact(proof.owner)
const { value: ui } = await artifact(proof.ui)
assert.equal(owner.schema, 'agentmux.note-owner-source-qualification.v1')
assert.equal(ui.schema, 'agentmux.note-rich-ui.source-qualification.v1')
assert.equal(ui.passed, true)
retainedCandidate(owner.candidate)
retainedCandidate(ui.sourceCommit)
retainedCandidate(owner.joinedSourceCommit)
const ownerFiles = await sourceFiles(owner.source, 'owner Source')
const uiFiles = await sourceFiles(ui.owningFiles, 'UI Source')
for (const receipt of [owner.formal?.tests, ui.mounted]) assert.ok(Number.isInteger(receipt?.cases) && receipt.cases > 0, 'Missing nonempty owning test result')
await command(owner.formal?.tests, ui.previousQualification ? 'historical formal tests' : 'formal tests', owner.formal?.tests?.cases)
assert.equal(owner.formal.tests.suites, 7)
await command(owner.formal?.productionTypes, 'production types')
await command(owner.formal?.strictTypes, 'strict fixture types')
await command(owner.formal?.persistence, 'original persistence fixture', 31)
await command(ui.mounted, 'current rich mounted tests', ui.mounted?.cases)
await command(ui.sourceTypes, 'UI Source types')
await command(ui.strictTypes, 'UI strict types')

const strictFile = path.resolve(root, owner.formal.strictTypes.config)
const strict = await json(strictFile)
assert.equal(strict.compilerOptions.strict, true)
assert.ok(Array.isArray(strict.include) && strict.include.length > 0, 'Strict fixture includes nothing')
for (const file of strict.include) assert.ok((await readFile(path.resolve(path.dirname(strictFile), file))).length > 0)
const aliases = nonempty(strict.compilerOptions.paths, 'strict Source aliases')
assert.equal(aliases.length, 26)
const base = path.resolve(path.dirname(strictFile), strict.compilerOptions.baseUrl)
for (const [name, targets] of aliases) {
  assert.ok(Array.isArray(targets) && targets.length > 0, `Missing Source alias: ${name}`)
  for (const file of targets) assert.ok((await readFile(path.resolve(base, file))).length > 0, `Empty Source alias: ${name}`)
}
let mutations = 0
assert.ok(Array.isArray(owner.mutations) && owner.mutations.length > 0, 'No owner mutations')
for (const ref of owner.mutations) mutations += await mutation(ref, ref.current)
assert.ok(Array.isArray(ui.mutations?.receipts) && ui.mutations.receipts.length > 0, 'No UI mutations')
const currentUiMutation = ui.mutations.currentClipboardSlice ?? ui.mutations.currentSemanticSlice
assert.ok(ui.mutations.receipts.some(ref => ref.path === currentUiMutation), 'Current UI mutation slice missing')
for (const ref of ui.mutations.receipts) mutations += await mutation(ref, ref.path === currentUiMutation)
const productCallers = await callers({ ...owner.actualCallers, ...ui.actualCallers })

const { value: restore } = await artifact(proof.restore)
assert.equal(restore.schema, 'agentmux.note-restore.v1')
assert.equal(restore.passed, true)
assert.deepEqual(restore.sourceBefore, restore.sourceAfter, 'Source changed during restore')
const restoreFiles = await sourceFiles(restore.sourceBefore, 'two-process Source')
assert.ok(Array.isArray(restore.phases) && restore.phases.length === 2, 'Need two ordinary private processes')
assert.deepEqual(restore.phases.map(phase => phase.phase), ['seed', 'restore'])
for (const phase of restore.phases) {
  assert.equal(phase.passed, true)
  assert.ok(Number.isInteger(phase.pid) && phase.pid > 0)
  assert.ok(phase.sourceCount >= 2 && phase.referenceCount >= 2, 'No actual two-Note knowledge path')
  assert.ok(nonempty(phase.noteBlockSelections, 'semantic block selection').length >= 2)
  assert.ok(Array.isArray(phase.tabs) && phase.tabs.length > 0, 'Restored workface is empty')
  nonempty(phase.layouts, 'restored layouts')
  assert.ok(phase.surveyZoneSelection?.selection?.length >= 2, 'No exact Survey selection')
}
assert.notEqual(restore.phases[0].pid, restore.phases[1].pid, 'Restore reused the process')
for (const field of ['tabs', 'layouts', 'surveyZoneSelection', 'noteBlockSelections']) {
  assert.deepEqual(restore.phases[0][field], restore.phases[1][field], `Restore changed ${field}`)
}
assert.equal(restore.cleanup?.compiledRemoved, true)
assert.equal(restore.cleanup?.privateResourcesRemoved, true)

const { value: compiled, file: compiledFile } = await artifact(proof.compiled)
assert.equal(compiled.passed, true)
assert.equal(compiled.sourceCommit, ui.sourceCommit)
assert.deepEqual(compiled.rawSourceBefore, compiled.rawSourceAfter, 'Source changed during UI compilation')
const compiledSourceFiles = await sourceFiles(compiled.rawSourceBefore, 'compiled raw Source')
assert.deepEqual(Object.keys(compiled.loaded).sort(), Object.keys(compiled.rawSourceBefore).sort(), 'Loaded/raw input mismatch')
for (const [, sha] of nonempty(compiled.loaded, 'actual transformed inputs')) assert.match(sha, /^[a-f0-9]{64}$/)
const styles = await sourceFiles(compiled.styles, 'compiled CSS')
const compiledBase = path.dirname(compiledFile)
const outputs = nonempty(compiled.compiled, 'preserved compiled outputs')
for (const [file, sha] of outputs) await bytesMatch(path.resolve(compiledBase, 'compiled', file), sha)
await bytesMatch(path.resolve(compiledBase, 'main.tsx'), compiled.fixture?.main)
await bytesMatch(path.resolve(compiledBase, 'index.html'), compiled.fixture?.html)

const { value: sourceReview } = await artifact(proof.sourceReview)
assert.equal(sourceReview.status, 'pass')
assert.equal(sourceReview.sourceCommit, ui.sourceCommit)
assert.equal(sourceReview.uiQualificationSha256, proof.ui.sha256)
let previousImages = 0, historicalMutations = 0
if (ui.previousQualification) {
  assert.equal(sourceReview.schema, 'agentmux.note-null-reference-independent-finite-review.v1')
  const { value: previous } = await artifact(proof.previous)
  assert.deepEqual(previous.ui, { path: ui.previousQualification.path, sha256: ui.previousQualification.sha256 })
  const { value: previousUi } = await artifact(previous.ui)
  const { value: previousSourceReview } = await artifact(previous.sourceReview)
  const { value: previousVisualReview } = await artifact(previous.visualReview)
  const { value: previousCompiled, file: previousCompiledFile } = await artifact(previous.compiled)
  const { value: previousPng } = await artifact(previous.png)
  assert.equal(previousUi.sourceCommit, ui.previousQualification.sourceCommit)
  assert.equal(previousSourceReview.status, 'pass')
  assert.equal(previousSourceReview.ownerQualificationSha256, proof.owner.sha256)
  assert.equal(previousSourceReview.uiQualificationSha256, previous.ui.sha256)
  assert.deepEqual(previousSourceReview.ownerStable11Files, owner.source)
  assert.deepEqual(previousSourceReview.owning16Files, previousUi.owningFiles)
  assert.equal(sourceReview.previousSourceReview.sha256, previous.sourceReview.sha256)
  assert.equal(sourceReview.previousVisualReview.sha256, previous.visualReview.sha256)
  const changed = Object.keys(ui.owningFiles).filter(file => ui.owningFiles[file] !== previousUi.owningFiles[file]).sort()
  assert.deepEqual(changed, ui.clipboardFix.changedFiles.toSorted())
  assert.deepEqual(Object.keys(sourceReview.changedFiles).sort(), changed)
  await sourceFiles(sourceReview.changedFiles, 'reviewed current clipboard leaves')
  for (const file of changed) {
    const historicalBytes = execFileSync('git', ['show', `${previousUi.sourceCommit}:${file}`], { cwd: root })
    assert.equal(hash(historicalBytes), previousUi.owningFiles[file], `Changed historical Source: ${file}`)
  }
  assert.deepEqual(previousCompiled.rawSourceBefore, previousCompiled.rawSourceAfter)
  assert.deepEqual(compiled.styles, previousCompiled.styles, 'Historical aesthetics cannot cover changed CSS')
  const rawChanges = Object.keys(compiled.rawSourceBefore).filter(file => compiled.rawSourceBefore[file] !== previousCompiled.rawSourceBefore[file]).sort()
  assert.deepEqual(rawChanges, sourceReview.compilationIdentity.changedRawVersusReviewedEba.toSorted())
  assert.ok(rawChanges.length > 0 && rawChanges.every(file => changed.includes(file)), 'Compilation changed outside the reviewed leaves')
  for (const [file, sha] of nonempty(previousCompiled.compiled, 'historical compiled outputs')) {
    await bytesMatch(path.resolve(path.dirname(previousCompiledFile), 'compiled', file), sha)
  }
  assert.equal(previousVisualReview.status, 'pass')
  assert.equal(previousVisualReview.compiledReceiptSha256, previous.compiled.sha256)
  assert.equal(previousVisualReview.pngManifestSha256, previous.png.sha256)
  assert.equal(previousPng.sourceCommit, previousUi.sourceCommit)
  assert.ok(Array.isArray(previousPng.captures) && previousPng.captures.length > 0, 'Historical full visual coverage is empty')
  for (const image of previousPng.captures) {
    await bytesMatch(path.resolve(root, image.path), image.sha256)
    assert.ok(previousVisualReview.readImages.some(read => read.file === image.path && read.sha256 === image.sha256 && read.actualOpened === true), `Historical image was not reviewed: ${image.path}`)
  }
  previousImages = previousPng.captures.length
  historicalMutations = mutations - ui.mutations.receipts.find(ref => ref.path === currentUiMutation).cases
} else {
  assert.equal(sourceReview.schema, 'agentmux.note-final-independent-source-review.v1')
  assert.equal(sourceReview.ownerQualificationSha256, proof.owner.sha256)
  assert.deepEqual(sourceReview.ownerStable11Files, owner.source, 'Independent owner coverage changed')
  assert.deepEqual(sourceReview.owning16Files, ui.owningFiles, 'Independent UI coverage changed')
}
// PNG and independent review checks follow the actual capture manifests, never a command-success surrogate.
const { value: png } = await artifact(proof.png)
const { value: visualReview } = await artifact(proof.visualReview)
assert.equal(png.schema, 'agentmux.note-rich-ui.visual-manifest.v1')
assert.equal(png.passed, true)
assert.equal(png.sourceCommit, ui.sourceCommit)
assert.equal(png.compiledReceipt?.sha256, proof.compiled.sha256)
assert.equal(visualReview.schema, ui.previousQualification ? 'agentmux.note-null-reference-independent-finite-review.v1' : 'agentmux.note-final-independent-visual-review.v1')
assert.equal(visualReview.status, 'pass')
assert.equal(visualReview.sourceCommit, ui.sourceCommit)
assert.equal(visualReview.compiledReceiptSha256, proof.compiled.sha256)
assert.equal(visualReview.pngManifestSha256, proof.png.sha256)
for (const review of [sourceReview, visualReview]) {
  assert.ok(review.reviewer && !['/root/survey_zone_implementation', '/root/survey_zone_intake'].includes(review.reviewer), 'Independent reviewer required')
  assert.ok(Array.isArray(review.findings), 'Missing explicit findings')
  assert.ok(Array.isArray(review.observations) && review.observations.length > 0, 'No concrete independent coverage')
}
assert.ok(Array.isArray(png.captures) && png.captures.length > 0, 'No actual complete PNGs')
assert.ok(Array.isArray(visualReview.readImages) && visualReview.readImages.length > 0, 'No independent image reads')
for (const name of ['wide-workface', 'narrow-workface', 'short-workface', 'light-workface']) {
  assert.ok(png.captures.some(image => image.name === name), `Missing actual scene: ${name}`)
}
assert.ok(png.captures.some(image => image.actual?.appearance === 'dark'))
assert.ok(png.captures.some(image => image.actual?.appearance === 'light'))
for (const image of png.captures) {
  const bytes = await bytesMatch(path.resolve(root, image.path), image.sha256)
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'Not an original PNG')
  assert.equal(bytes.subarray(-8, -4).toString(), 'IEND', 'Incomplete PNG')
  assert.equal(bytes.readUInt32BE(16), image.pixelSize?.width, 'PNG width differs from original capture')
  assert.equal(bytes.readUInt32BE(20), image.pixelSize?.height, 'PNG height differs from original capture')
  assert.ok(image.actual?.innerWidth > 0 && image.actual?.innerHeight > 0 && image.actual?.root?.width > 0 && image.actual?.root?.height > 0, 'Missing actual viewport/root geometry')
  assert.ok(image.scene, 'Image has no actual scene')
  if (!ui.previousQualification) assert.ok(visualReview.readImages.some(read => read.file === image.path && read.sha256 === image.sha256 && read.actualOpened === true), `Image not independently reviewed: ${image.path}`)
}
for (const read of visualReview.readImages) {
  assert.equal(read.actualOpened, true)
  assert.ok(png.captures.some(image => read.file === image.path && read.sha256 === image.sha256), `Review has no current image: ${read.file}`)
}
if (ui.previousQualification) for (const scene of ['wide-workface', 'narrow-workface', 'unknown-selection']) {
  assert.ok(visualReview.readImages.some(read => read.scene === scene), `Current changed-leaf review missed ${scene}`)
}
let currentPublicCases = null
if (proof.publicTests) {
  const { value: publicTests } = await artifact(proof.publicTests)
  assert.equal(publicTests.suites, 7)
  assert.ok(Number.isInteger(publicTests.cases) && publicTests.cases > 0)
  await command(publicTests, 'current public formal tests', publicTests.cases)
  currentPublicCases = publicTests.cases
}
console.log(JSON.stringify({ passed: true, sourceCandidate: ui.sourceCommit, ownerFiles, uiFiles, restoreFiles,
  mutations, historicalMutations, currentMutations: mutations - historicalMutations, productCallers,
  compiledSourceFiles, styles, compiledOutputs: outputs.length, currentCaptures: png.captures.length,
  currentReadImages: visualReview.readImages.length, historicalReadImages: previousImages,
  currentRichCases: ui.mounted.cases, currentPublicCases, cachedFormalCases: owner.formal.tests.cases,
  cachedFormalScope: ui.previousQualification ? 'historical; current public gate is run separately' : 'same candidate',
  boundary: 'Ordinary Note Files/Store/rich UI and compiled preview reviewed; no Native Browser/Run or pixel-caret claim.' }))
