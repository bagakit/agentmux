import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

// Read-only consumption of Root's one shared actual capture. This command never
// compiles, captures, starts a process, controls a Run or changes product state.
const repository = resolve(import.meta.dirname, '../../..')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const args = process.argv.slice(2)
assert.equal(args.length, 2, 'Use --input <actual-consumption.json>'); assert.equal(args[0], '--input')
const input = JSON.parse(await readFile(resolve(repository, args[1]), 'utf8'))
assert.equal(input.schema, 'agentmux.mote-default-dialogue-actual-consumption.v1')
async function artifact(reference) {
  assert.ok(reference && typeof reference.path === 'string' && reference.path.length > 0)
  assert.match(reference.sha256, /^[a-f0-9]{64}$/)
  const path = resolve(repository, reference.path), bytes = await readFile(path)
  assert.equal(hash(bytes), reference.sha256, 'Referenced original artifact SHA must agree')
  return { path, bytes, value: JSON.parse(bytes) }
}
const actual = await artifact(input.actualReceipt), candidate = await artifact(input.candidate), visual = await artifact(input.visualReview)
const receipt = actual.value
assert.equal(receipt.schema, 'agentmux.mote-navigation-footer-renderer.v1')
assert.equal(receipt.passed, true); assert.equal(receipt.userAppOrRunTouched, false)
assert.equal(receipt.captureSelection.mode, 'mote-archive')
assert.equal(receipt.candidate.sha256, input.candidate.sha256)
assert.ok(candidate.value.files.length > 0, 'Source candidate cannot be empty')
assert.deepEqual(receipt.candidate.files, candidate.value.files)
const owner = 'apps/desktop/src/renderer/src/lib/pmo-teams-topic-floating.ts'
const entries = candidate.value.files.filter(row => row.path === owner)
assert.equal(entries.length, 1, 'Candidate binds the real explicit-open owner exactly once')
assert.equal(receipt.inputs[owner], entries[0].sha256, 'Actual compiled Renderer consumed this owning Source')
assert.equal(hash(await readFile(join(repository, owner))), entries[0].sha256, 'Current owning Source still agrees')
assert.equal(hash(await readFile(join(receipt.originalInputs, owner))), entries[0].sha256, 'Original consumed bytes are preserved')
assert.ok(Object.keys(receipt.inputs).length > 0 && Object.keys(receipt.compiled).length > 0, 'Actual input/output graph is nonempty')
assert.equal(receipt.renderer.passed, true)
assert.deepEqual(receipt.renderer.phases.map(one => one.phase), ['seed', 'restore'])
for (const phase of receipt.renderer.phases) {
  assert.equal(phase.renderer.passed, true); assert.equal(phase.exit.exitCode, 0); assert.equal(phase.exit.timedOut, false)
  assert.ok(phase.renderer.checks.length > 0, 'Both actual process checks must be nonempty')
}
assert.notEqual(receipt.renderer.phases[0].renderer.pid, receipt.renderer.phases[1].renderer.pid)
const seed = receipt.renderer.phases[0].renderer
const expected = [
  { name: 'primary', topicId: 'launcher:leader', tabId: 'default-tab', regionId: 'default-region', sessionId: 'default-agent' },
  { name: 'custom', topicId: 'launcher:analyst', tabId: 'custom-tab', regionId: 'custom-region', sessionId: 'custom-agent' }
]
for (const target of expected) {
  const name = 'default-dialogue-' + target.name + '-explicit-reopen'
  const checks = seed.checks.filter(check => check.name === name)
  assert.equal(checks.length, 1, 'One actual separately named check is required: ' + name)
  const check = checks[0]; assert.equal(check.passed, true); assert.deepEqual(check.target, target)
  for (const [stage, mode] of [['terminal', 'terminal'], ['hovered', 'terminal'], ['dialogue', 'activity'], ['laterTerminal', 'terminal']]) {
    const facts = check[stage]
    assert.equal(facts.ui.visible, true); assert.equal(facts.ui.topicId, target.topicId); assert.equal(facts.ui.tabId, target.tabId)
    assert.equal(facts.ui.regionId, target.regionId); assert.equal(facts.ui.sessionId, target.sessionId)
    assert.equal(facts.ui.mode.effective, mode); assert.equal(facts.ui.mode.surface, mode)
    assert.ok(facts.ui.input.token > 0 && facts.ui.input.text.length > 0, 'Original actual Composer and draft are nonempty')
    assert.ok(facts.protected.sessionFacts.length >= 5 && Object.keys(facts.protected.drafts).length >= 4)
    assert.ok(facts.protected.sessionFacts.some(one => one.id === 'execution-agent' && one.control?.run?.runId), 'Unrelated real execution identity is present')
    assert.ok(facts.protected.sessionFacts.some(one => one.id === target.sessionId && one.kind === 'agent' && one.control?.run?.runId), 'Accurate original Agent/Run facts are present')
  }
  assert.equal(check.closed.ui.visible, false); assert.equal(check.closed.floating.open, false)
  assert.equal(check.hovered.floating.preview, true); assert.equal(check.hovered.floating.open, false)
  assert.deepEqual(check.closed.protected, check.terminal.protected)
  assert.deepEqual(check.hovered.protected, check.terminal.protected); assert.deepEqual(check.hovered.saved, check.closed.saved)
  assert.equal(check.dialogue.floating.open, true)
  assert.equal(check.dialogue.ui.input.token, check.terminal.ui.input.token)
  assert.equal(check.dialogue.ui.input.text, check.terminal.ui.input.text)
  assert.ok(check.dialogue.ui.mode.activityRect.width > 0 && check.dialogue.ui.mode.activityRect.height > 0 && check.dialogue.ui.mode.activityText.length > 0)
  assert.deepEqual(check.dialogue.protected, { ...check.terminal.protected,
    viewModes: { ...check.terminal.protected.viewModes, [target.sessionId]: 'activity' } })
  assert.deepEqual(check.laterTerminal.protected, check.terminal.protected)
}
const names = ['archive-wide-cards-menu', 'archive-narrow-avatars-current', 'archive-space-discover-restore',
  'archive-restored-original-workface', 'archive-save-unconfirmed-unknown']
assert.deepEqual(receipt.renderer.frames.map(frame => frame.name), names, 'The original five actual complete scenes are required')
const review = visual.value
assert.equal(review.status, 'approved'); assert.equal(review.actualReceiptSha256, input.actualReceipt.sha256)
assert.equal(review.candidateSha256, input.candidate.sha256); assert.deepEqual(review.must_fix, [])
assert.deepEqual(review.frames.map(frame => frame.name), names, 'Independent review must personally cover all five original scenes')
for (let index = 0; index < names.length; index++) {
  const frame = receipt.renderer.frames[index], seen = review.frames[index]
  assert.equal(hash(await readFile(join(dirname(actual.path), frame.file))), frame.sha256, 'Actual full PNG bytes are retained')
  assert.equal(seen.sha256, frame.sha256); assert.equal(seen.viewed, true); assert.equal(seen.status, 'approved')
  assert.deepEqual(seen.must_fix, [])
}
console.log(JSON.stringify({ passed: true, schema: input.schema, actualReceiptSha256: input.actualReceipt.sha256,
  candidateSha256: input.candidate.sha256, checks: expected.map(one => 'default-dialogue-' + one.name + '-explicit-reopen'),
  visualFrames: names.length, scope: 'Original shared private actual App/Renderer evidence; no user App, Core Run, Native or OS IME claim.' }))
