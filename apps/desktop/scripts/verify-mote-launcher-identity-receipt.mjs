import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

// Consume preserved production Renderer evidence. Never build, capture or touch a Run.
const repository = resolve(import.meta.dirname, '../../..')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const owners = ['apps/desktop/src/renderer/src/components/NewTabSurface.tsx',
  'apps/desktop/src/renderer/src/components/LauncherEnvironment.tsx']
const args = process.argv.slice(2)
assert.deepEqual(args.slice(0, 1), ['--input']); assert.equal(args.length, 2, 'Use --input <actual-consumption.json>')
const input = JSON.parse(await readFile(resolve(repository, args[1]), 'utf8'))
assert.equal(input.schema, 'agentmux.mote-launcher-identity-actual-consumption.v1')
async function artifact(reference) {
  assert(reference && typeof reference.path === 'string' && reference.path.length > 0, 'An explicit preserved artifact is required')
  assert.match(reference.sha256, /^[a-f0-9]{64}$/)
  const path = resolve(repository, reference.path), bytes = await readFile(path)
  assert.equal(hash(bytes), reference.sha256, 'Preserved artifact SHA must agree')
  return { path, bytes, value: JSON.parse(bytes) }
}
function relativeFile(path) {
  assert(typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.split(/[\\/]/).includes('..'), 'Graph files must stay inside their explicit preserved root')
  return path
}
async function graph(root, files, name) {
  assert(typeof root === 'string' && root.length > 0, name + ': explicit preserved root is required')
  assert(files && typeof files === 'object' && !Array.isArray(files) && Object.keys(files).length > 0, name + ': input/output graph cannot be empty')
  for (const [path, sha256] of Object.entries(files)) {
    relativeFile(path); assert.match(sha256, /^[a-f0-9]{64}$/)
    assert.equal(hash(await readFile(join(resolve(repository, root), path))), sha256, name + ': exact preserved bytes ' + path)
  }
}
function positive(rect, name) {
  assert(rect && Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 0 && rect.height > 0, name + ': real positive geometry is required')
}
function once(rows, name) {
  assert(Array.isArray(rows) && rows.length > 0, 'Actual collection must be nonempty')
  const matches = rows.filter(row => row.name === name)
  assert.equal(matches.length, 1, 'Exactly one original actual fact is required: ' + name)
  return matches[0]
}
function environment(facts) {
  assert.deepEqual(facts.errors, [])
  const resource = facts.sourceFacts?.environment, snapshot = facts.sourceFacts?.snapshot
  assert.equal(resource?.id, '__scratch__'); assert.equal(resource.hostId, 'local'); assert.equal(resource.path, '/topics')
  assert.equal(snapshot?.scope, JSON.stringify([resource.hostId, resource.path]))
  assert(Array.isArray(snapshot.topics) && snapshot.topics.length > 0, 'Raw scoped FS rows must be present')
  assert.equal(facts.launcher.path, resource.path); assert.equal(facts.launcher.pathTitle, resource.path)
  assert.equal(facts.launcher.host, 'This Mac'); positive(facts.launcher.hostRect, 'Actual Host')
}
function originalInput(facts, draft) {
  const original = facts.launcher.input
  assert(original && original.token > 0 && original.editable === true, 'Actual original input must be mounted and editable')
  assert.equal(original.text, draft); assert(draft.length > 0, 'Original draft cannot be empty')
  positive(original.rect, 'Original Launcher input')
  return original
}
function target(facts, topicId, tabId, heading, draft) {
  environment(facts)
  assert.equal(facts.ui.visible, true); assert.equal(facts.ui.topicId, topicId); assert.equal(facts.ui.tabId, tabId)
  assert.equal(facts.ui.panelInert, false); assert.equal(facts.ui.titleRows, 0, 'Keep the original single Launcher h2 without another title row')
  positive(facts.ui.panelRect, 'Mote panel'); positive(facts.ui.bodyRect, 'Original Launcher surface')
  assert.equal(facts.launcher.headingCount, 1); assert.equal(facts.launcher.heading, heading); assert.equal(facts.launcher.title, heading)
  positive(facts.launcher.headingRect, 'Original h2')
  return originalInput(facts, draft)
}

const actual = await artifact(input.capture), recorded = await artifact(input.renderer)
const visual = await artifact(input.visualReview), manifest = await artifact(input.visualManifest)
const compilation = await artifact(input.compilation)
const receipt = actual.value, renderer = recorded.value
assert.equal(receipt.schema, 'agentmux.mote-launcher-identity-capture.v1')
assert.equal(receipt.passed, true, 'Final actual capture must pass'); assert.equal(receipt.userAppOrRunTouched, false)
assert.equal(receipt.exit.exitCode, 0); assert.equal(receipt.exit.timedOut, false)
assert.deepEqual(receipt.changedInputs, []); assert.deepEqual(receipt.cleanup.remaining, []); assert.equal(receipt.cleanup.privateProfileRemoved, true)
assert.equal(renderer.passed, true); assert.equal(renderer.userAppOrRunTouched, false)
assert(Number.isInteger(renderer.pid) && renderer.pid > 0)
assert.deepEqual(receipt.renderer, renderer, 'Separate raw Renderer receipt must match the original capture')
await graph(input.preservedInputsRoot, receipt.inputs, 'Renderer Source')
await graph(input.preservedInputsRoot, receipt.stylesheets, 'Renderer stylesheets')
await graph(input.compiledRoot, receipt.compiled, 'Compiled Renderer')
for (const owner of owners) {
  assert.match(receipt.inputs[owner], /^[a-f0-9]{64}$/, 'Both actual title owners must be in the consumed graph')
  assert.equal(hash(await readFile(join(repository, owner))), receipt.inputs[owner], 'Current title owner must match the consumed Source')
}
// A failed earlier capture is only compilation provenance, never a passed frame.
assert.equal(receipt.reusedCompilation?.sha256, input.compilation.sha256)
assert.equal(compilation.value.schema, receipt.schema)
assert.deepEqual(compilation.value.inputs, receipt.inputs); assert.deepEqual(compilation.value.stylesheets, receipt.stylesheets)
assert.deepEqual(compilation.value.compiled, receipt.compiled, 'Reuse must bind the exact original compiled graph')

assert.deepEqual(renderer.baseline, renderer.after, 'Original execution, drafts, entities, layout and Session facts must remain unchanged')
const work = renderer.baseline
assert(Object.keys(work.tabs).length > 0 && Object.keys(work.layouts).length > 0 && Object.keys(work.drafts).length > 0)
assert(Array.isArray(work.sessions) && work.sessions.length > 0, 'Original controlled Session facts must be present')
assert(work.execution.history.length > 0 && work.execution.sessionId === 'execution-agent')
for (const id of ['default-agent', 'custom-agent', 'execution-agent'])
  assert.equal(work.sessions.filter(row => row.id === id && row.control?.run?.runId).length, 1, 'Original controlled Agent/Run identity must be retained: ' + id)
const primaryDraft = work.drafts['default-region'], customDraft = work.drafts['custom-region']
assert(typeof primaryDraft === 'string' && primaryDraft.length > 0 && typeof customDraft === 'string' && customDraft.length > 0)
for (const [tabId, topicId, regionId] of [['default-tab', 'launcher:leader', 'default-region'], ['custom-tab', 'launcher:analyst', 'custom-region']]) {
  const tab = work.tabs[tabId]
  assert.equal(tab?.id, tabId); assert.equal(tab.topicId, topicId); assert.equal(tab.workspaceId, '__scratch__')
  assert.equal(tab.regions[regionId]?.regionId, regionId); assert.equal(tab.regions[regionId]?.kind, 'launcher')
}
assert(Array.isArray(renderer.calls) && renderer.calls.length > 0, 'Actual original calls must be present')
const allowed = new Set(['controlledHistoryRead', 'preferenceSave', 'warm', 'detect', 'ensureMote'])
for (const call of renderer.calls) assert(allowed.has(call.operation), 'Title proof cannot launch, submit, stop or otherwise change a Run: ' + call.operation)

const names = ['launcher-wide-custom-long', 'launcher-narrow-primary']
assert.deepEqual(renderer.frames.map(frame => frame.name), names, 'Both complete original title scenes are required')
const [wide, narrow] = renderer.frames
const customRows = wide.facts.sourceFacts.snapshot.topics.filter(row => row.id === 'launcher:analyst')
const primaryRows = narrow.facts.sourceFacts.snapshot.topics.filter(row => row.id === 'launcher:leader')
assert.equal(customRows.length, 1); assert.equal(primaryRows.length, 1)
for (const row of [customRows[0], primaryRows[0]]) assert(row.title.length > 0 && row.soul && !row.readError, 'A title must be confirmed by its original raw Mote row')
const customInput = target(wide.facts, 'launcher:analyst', 'custom-tab', customRows[0].title, customDraft)
target(narrow.facts, 'launcher:leader', 'default-tab', primaryRows[0].title, primaryDraft)
const rename = once(renderer.checks, 'same-raw-snapshot-rename').facts
const error = once(renderer.checks, 'raw-topic-read-error-retains-input').facts
const runtime = once(renderer.checks, 'original-runtime-environment').facts
const renamedRows = rename.sourceFacts.snapshot.topics.filter(row => row.id === 'launcher:analyst')
const errorRows = error.sourceFacts.snapshot.topics.filter(row => row.id === 'launcher:analyst')
assert.equal(renamedRows.length, 1); assert.equal(errorRows.length, 1)
assert.notEqual(renamedRows[0].title, customRows[0].title); assert(renamedRows[0].title.length > 0 && !renamedRows[0].readError)
assert(typeof errorRows[0].readError === 'string' && errorRows[0].readError.length > 0)
for (const [facts, heading] of [[rename, renamedRows[0].title], [error, 'Context name unconfirmed'], [runtime, renamedRows[0].title]]) {
  const original = target(facts, 'launcher:analyst', 'custom-tab', heading, customDraft)
  assert.equal(original.token, customInput.token); assert.deepEqual(original.selection, customInput.selection, 'Original input identity, draft and selection must survive the raw title change')
}
assert.equal(runtime.launcher.environment?.directory, '/topics'); assert.equal(runtime.launcher.environment.directoryTitle, '/topics')
assert(runtime.launcher.environment.text.includes('This Mac'), 'The real opened runtime environment must keep the Host')
assert.equal(once(renderer.checks, 'nonempty-original-work-preserved').passed, true)
const ordinary = once(renderer.checks, 'ordinary-topic-original-heading').displayed
assert.equal(ordinary?.tabId, 'ordinary-tab'); assert.equal(ordinary.title, 'Topics')
assert.equal(ordinary.visible, true); assert.equal(ordinary.inert, false); positive(ordinary.rect, 'Visible original ordinary Topic h2')

const review = visual.value
assert.equal(review.schema, 'agentmux.mote-launcher-identity-independent-visual-review.v1')
assert.equal(review.status, 'approved', 'Independent actual visual review must be approved'); assert.deepEqual(review.must_fix, [])
assert.equal(review.captureSha256, input.capture.sha256); assert.equal(review.rendererSha256, input.renderer.sha256)
assert.deepEqual(review.frames.map(frame => frame.name), names)
assert.equal(review.sourceBindings.length, owners.length)
for (const owner of owners) {
  const matches = review.sourceBindings.filter(row => row.path === owner)
  assert.equal(matches.length, 1); assert.equal(matches[0].sha256, receipt.inputs[owner]); assert.equal(matches[0].preservedSourceMatchesCapturedInput, true)
}
for (let index = 0; index < names.length; index++) {
  const frame = renderer.frames[index], seen = review.frames[index]
  const png = await readFile(join(dirname(actual.path), relativeFile(frame.file)))
  assert.equal(hash(png), frame.sha256, 'Actual complete PNG bytes must be retained')
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  assert.equal(png.readUInt32BE(16), frame.dimensions.width); assert.equal(png.readUInt32BE(20), frame.dimensions.height)
  assert.equal(seen.file, frame.file); assert.equal(seen.sha256, frame.sha256); assert.equal(seen.viewed, true); assert.equal(seen.status, 'approved'); assert.deepEqual(seen.must_fix, [])
}
assert.equal(manifest.value.schema, 'agentmux.mote-launcher-identity-independent-visual-review-manifest.v1')
assert.equal(manifest.value.status, 'approved'); assert(Array.isArray(manifest.value.files) && manifest.value.files.length > 0)
for (const row of manifest.value.files) {
  const bytes = await readFile(join(dirname(manifest.path), relativeFile(row.file)))
  assert.equal(hash(bytes), row.sha256); assert.equal(bytes.length, row.bytes)
}
for (const reference of [input.capture, input.renderer, input.visualReview])
  assert.equal(manifest.value.files.filter(row => row.file === reference.path.split(/[\\/]/).at(-1) && row.sha256 === reference.sha256).length, 1, 'Manifest must bind each original receipt and review')
for (const frame of renderer.frames)
  assert.equal(manifest.value.files.filter(row => row.file === frame.file && row.sha256 === frame.sha256).length, 1, 'Manifest must bind both original complete PNGs')
console.log(JSON.stringify({ passed: true, schema: input.schema, captureSha256: input.capture.sha256,
  rendererSha256: input.renderer.sha256, visualReviewSha256: input.visualReview.sha256,
  sourceInputs: Object.keys(receipt.inputs).length, compiledFiles: Object.keys(receipt.compiled).length,
  frames: names, scope: 'Preserved production App/Workbench/Launcher title evidence with controlled FS/Session facts; no Native, live Core Run or restart claim.' }))
