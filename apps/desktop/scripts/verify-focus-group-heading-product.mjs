import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

// Join existing qualified evidence. Both producers must explicitly report exact
// reuse; this command never starts another mutation, capture or Runtime.
const root = resolve(import.meta.dirname, '../../..'), execute = promisify(execFile)
const options = {}
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index]
  if (flag === '--help') {
    console.log('Use --evidence <directory> and --inputs <JSON> (or AGENTMUX_FOCUS_GROUP_HEADING_PRODUCT_INPUTS). JSON fields: behaviorReceipt, sceneReceipt, review.')
    process.exit(0)
  }
  assert.ok(['--evidence', '--inputs'].includes(flag) && process.argv[index + 1], 'Unknown or incomplete argument')
  assert.equal(options[flag], undefined, 'Duplicate argument')
  options[flag] = process.argv[index + 1]
}
assert.ok(options['--evidence'], 'Use --evidence <private evidence directory>')
const evidence = resolve(root, options['--evidence'])
await mkdir(evidence, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function artifact(path) {
  assert.equal(typeof path, 'string'); assert.ok(path.length > 0)
  const file = resolve(root, path), bytes = await readFile(file)
  return { file, sha256: hash(bytes), value: JSON.parse(bytes) }
}
const ref = value => ({ file: relative(root, value.file), sha256: value.sha256 })
const receipt = { schema: 'agentmux.focus-group-heading-product.v1', passed: false, readOnlyJoin: true,
  userRuntimeTouched: false, newRuntimeCreated: false, checks: [],
  boundary: 'Actual shared Renderer menus and independent complete-image review, plus original private consumer/CAS/clipboard tests and source mutations. No new Provider, Session, Runtime or installation is qualified by these images.' }
let stage = 'read-qualified-inputs'
try {
  const manifest = await artifact(options['--inputs'] ?? process.env.AGENTMUX_FOCUS_GROUP_HEADING_PRODUCT_INPUTS)
  const behavior = await artifact(manifest.value.behaviorReceipt), scene = await artifact(manifest.value.sceneReceipt), review = await artifact(manifest.value.review)
  receipt.inputs = { manifest: ref(manifest), behavior: ref(behavior), scene: ref(scene), review: ref(review) }
  const b = behavior.value, s = scene.value, r = review.value
  assert.equal(b.schema, 'agentmux.renderer-source-mutation.v1'); assert.equal(b.passed, true)
  assert.equal(b.sharedTreeMutations, 0); assert.equal(b.cases.length, 7)
  assert.equal(s.schema, 'agentmux.focus-group-heading-menu-scene.v1'); assert.equal(s.mode, 'heading-menu-join'); assert.equal(s.capturedPass, true)
  assert.equal(s.actual.passed, true); assert.equal(s.userRuntimeTouched, false)
  assert.deepEqual(s.actual.previewHeadingIsolation, { nativeRightClick: true, nativeShiftF10: true, noBusinessMenu: true })
  assert.deepEqual(s.actual.headingLeftClick, { collectionFoldAndExpand: true, projectFilterAndClear: true, noExtraMenuOrDialog: true })
  assert.ok(s.actual.headingInteractions.length >= 13)
  for (const interaction of s.actual.headingInteractions) assert.equal(interaction.returnedToOriginal, true)
  for (const key of ['sameSessions', 'sameTabs', 'sameLayouts', 'sameDrafts', 'sameFocus']) assert.equal(s.actual.after[key], true)
  assert.deepEqual(s.actual.after.controls, { stop: 0, resume: 0, write: 0, launchAgent: 0, interrupt: 0 })
  assert.deepEqual(s.actual.after.selections, [])
  for (const key of ['topicWrites', 'avatarWrites', 'reveals', 'terminalOpens', 'workspaceSelections']) {
    assert.deepEqual(s.actual.after.headingTransport[key], [], 'No real business mutation in the visual scene: ' + key)
  }
  const feedback = s.actual.savedAvatarFeedback
  assert.equal(feedback.choice, 'book'); assert.equal(feedback.source, 'manual'); assert.equal(feedback.storeChoice, feedback.choice)
  assert.equal(feedback.key, feedback.subject.spaceId); assert.ok(feedback.subject.hostId && feedback.subject.categoryId)
  assert.equal(feedback.originalStoreSave, true); assert.equal(feedback.privateConfigurationOnly, true)
  assert.equal(feedback.originalActorsPreserved, true); assert.equal(feedback.appearanceReadsAfterSave, 0)
  assert.equal(feedback.writeCount, 1); assert.equal(feedback.configurationWrite.accepted, true)
  assert.deepEqual(feedback.configurationWrite.subject, feedback.subject)
  assert.equal(feedback.configurationWrite.key, feedback.key); assert.equal(feedback.configurationWrite.choice, feedback.choice)
  assert.deepEqual(feedback.configurationWrite.after, { ...feedback.configurationWrite.before, [feedback.key]: feedback.choice })
  assert.deepEqual(feedback.appearanceSpaceObjectIcons, feedback.configurationWrite.after)
  assert.deepEqual(s.actual.after.headingTransport.iconWrites, [feedback.configurationWrite])
  assert.ok(Object.keys(s.ownerSources).length > 0); assert.equal(s.frames.length, 32)
  assert.deepEqual([...s.requiredScenes].sort(), s.frames.map(frame => frame.file).sort())
  const owners = ['FocusLaneHeadingMenu', 'FocusProjectLanes', 'TopicCategoryMenu', 'TopicCategoryDialog', 'SpaceIconPicker', 'WorkspaceRowContextMenu', 'SpaceObjectIcon', 'SpaceDirectoryImage']
    .map(name => 'apps/desktop/src/renderer/src/components/' + name + '.tsx')
  for (const name of owners) {
    assert.equal(typeof s.ownerSources[name], 'string', 'Declared original owner: ' + name)
    assert.equal(s.inputs[name], s.ownerSources[name], 'The actual Renderer loaded: ' + name)
    assert.equal(hash(await readFile(join(root, name))), s.ownerSources[name], 'Current original owner: ' + name)
    assert.equal(b.sourceBefore[name], s.ownerSources[name], 'Same behavioral and visual owner: ' + name)
  }

  stage = 'independent-image-and-code-review'
  assert.equal(r.schema, 'agentmux.focus-group-heading-menu-review.v1'); assert.equal(r.status, 'approved')
  assert.equal(r.independent, true); assert.equal(r.codeReviewApproved, true); assert.ok(r.reviewer)
  assert.deepEqual(r.mustChange, []); assert.equal(r.sceneReceiptSHA256, scene.sha256)
  assert.equal(resolve(root, r.sceneReceipt), scene.file)
  assert.deepEqual(r.ownerSources, s.ownerSources); assert.deepEqual(r.compiled, s.compiled)
  const frames = s.frames.map(({ file, sha256 }) => ({ file, sha256 })).sort((a, b) => a.file.localeCompare(b.file))
  assert.equal(new Set(frames.map(frame => frame.file)).size, frames.length)
  assert.equal(r.frames.length, frames.length)
  for (const frame of r.frames) assert.equal(frame.reviewed, true, 'Complete image actually reviewed: ' + frame.file)
  assert.deepEqual(r.frames.map(({ file, sha256 }) => ({ file, sha256 })).sort((a, b) => a.file.localeCompare(b.file)), frames)
  for (const frame of frames) {
    assert.equal(isAbsolute(frame.file), false)
    const file = resolve(dirname(scene.file), frame.file), local = relative(dirname(scene.file), file)
    assert.ok(local && !local.startsWith('..') && !isAbsolute(local), 'Image stays beside its receipt')
    assert.equal(hash(await readFile(file)), frame.sha256)
  }
  receipt.review = { reviewer: r.reviewer, frames: frames.length, codeReviewApproved: true }

  stage = 'reuse-original-producers'
  const env = { ...process.env, AGENTMUX_MUTATION_RECEIPTS: JSON.stringify([behavior.file]),
    AGENTMUX_FOCUS_GROUP_HEADING_SCENE_RECEIPT: scene.file }
  for (const [name, script, original] of [['behavior', 'verify-focus-group-heading-menu.mjs', behavior], ['scene', 'capture-focus-group-heading-menu.mjs', scene]]) {
    const result = await execute(process.execPath, [join(root, 'apps/desktop/scripts', script), '--evidence', join(evidence, name)],
      { cwd: root, env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
    const log = result.stdout + result.stderr, file = name + '-exact-reuse.log'
    await writeFile(join(evidence, file), log)
    const reports = result.stdout.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    assert.equal(reports.length, 1); assert.equal(reports[0].passed ?? reports[0].capturedPass, true)
    assert.equal(reports[0].exactEvidenceReused, true); assert.equal(resolve(root, reports[0].receipt), original.file)
    receipt.checks.push({ name, reused: true, file, sha256: hash(log) })
  }
  receipt.driver = { file: relative(root, import.meta.filename), sha256: hash(await readFile(import.meta.filename)) }
  receipt.passed = true
} catch (error) {
  receipt.failure = { stage, name: error.name, message: error.message }; process.exitCode = 1
} finally { await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n') }
console.log(JSON.stringify({ passed: receipt.passed, receipt: join(evidence, 'receipt.json'), failure: receipt.failure }))
