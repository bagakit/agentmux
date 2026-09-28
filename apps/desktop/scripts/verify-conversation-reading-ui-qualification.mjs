import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const proofArg = process.argv.indexOf('--proof')
assert.ok(proofArg > 0 && process.argv[proofArg + 1], 'Supply --proof <qualification.json>')
const read = (path) => readFileSync(resolve(root, path))
const json = (path) => JSON.parse(read(path).toString())
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const q = json(process.argv[proofArg + 1])
assert.equal(q.schema, 'agentmux.conversation-reading-ui-qualification.v1')
assert.equal(q.featureId, 'f-2gc8fw5dv')
assert.equal(q.taskId, 'T-001')
assert.ok(q.artifacts.length > 30, 'Qualification must include original commands, source, and images')
for (const item of q.artifacts) assert.equal(sha(read(item.path)), item.sha256, item.path)
const attested = new Set(q.artifacts.map((item) => item.path))
const get = (path) => {
  assert.ok(attested.has(path), `Missing integrity binding: ${path}`)
  return json(path)
}
const manifest = get(q.sourceManifest)
assert.equal(manifest.files.length, 12)
execFileSync('git', ['merge-base', '--is-ancestor', q.subjectMain, 'main'], { cwd: root })
for (const item of manifest.files) {
  assert.equal(sha(read(`${q.frozenSource}/${item.path}`)), item.sha256, item.path)
  assert.equal(sha(execFileSync('git', ['show', `${q.subjectMain}:${item.path}`], { cwd: root })), item.sha256, item.path)
}
const production = manifest.files.slice(0, 4)
const modules = production.slice(0, 2)
assert.deepEqual(production.map((item) => item.path.split('/').at(-1)), [
  'ConversationMessage.tsx', 'ConversationReasoningTrace.tsx', 'activity-conversation.css', 'session-history.css',
])
const callers = get(q.callers)
for (const [symbol, definition] of [
  ['ConversationMessage', 'ConversationMessage.tsx'],
  ['ConversationReasoningTrace', 'ConversationReasoningTrace.tsx'],
]) {
  const actual = callers[symbol].filter((line) => line.includes(`<${symbol}`) && !line.split(':')[0].endsWith(`/${definition}`))
  assert.ok(actual.length > 0, `${symbol} has no product caller outside its definition`)
}
function command(stem, exitCode, testCount) {
  const meta = get(`${stem}.command.json`)
  assert.equal(meta.exitCode, exitCode, stem)
  assert.ok(meta.argv.length > 1 && meta.finishedAt >= meta.startedAt, stem)
  assert.equal(sha(read(`${stem}.stdout`)), meta.stdoutSHA256, stem)
  assert.equal(sha(read(`${stem}.stderr`)), meta.stderrSHA256, stem)
  const output = read(`${stem}.stdout`).toString() + read(`${stem}.stderr`).toString()
  if (testCount) assert.ok(output.includes(`${testCount} passed`), `${stem}: missing nonempty collected tests`)
  return output
}
command(q.owning, 0, 6)
command(q.adjacent, 0, 53)
command(q.readingAdjacent, 0, 25)
for (const stem of q.types) command(stem, 0)
assert.equal(q.types.length, 2)
const loaded = (path) => {
  assert.ok(attested.has(path), `Loaded input log not bound: ${path}`)
  const rows = read(path).toString().trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  assert.ok(rows.length > 0, `Empty actual loaded input log: ${path}`)
  return rows
}
const restored = loaded(q.mutationRestored + '.loaded.jsonl')
for (const item of modules) assert.ok(restored.some((row) => row.path === item.path && row.sha256 === item.sha256))
command(q.mutationRestored, 0, 6)
assert.equal(q.mutations.length, 6)
assert.equal(new Set(q.mutations.map((stem) => stem.split('/').at(-1))).size, 6)
for (const stem of q.mutations) {
  assert.match(command(stem, 1), /AssertionError/, stem)
  const rows = loaded(stem + '.loaded.jsonl')
  assert.ok(rows.some((row) => modules.some((item) => row.path === item.path && row.originalSHA256 === item.sha256 && row.sha256 !== item.sha256)), `No actual product mutation loaded: ${stem}`)
}
const css = get(q.cssMutation)
assert.equal(css.actualCssWidth, 332)
assert.equal(css.targets, 2)
assert.equal(css.assertion.name, 'AssertionError')
assert.equal(css.red.length, 2)
assert.ok(css.red.every((row) => row.bodyWidth === 20 && row.text.length > 0))
assert.equal(css.green.restored, true)
assert.equal(css.green.rows.length, 2)
assert.ok(css.green.rows.every((row) => row.bodyWidth > 100))
const loadedCss = read(q.cssOriginal).toString()
for (const item of production.slice(2)) assert.ok(loadedCss.includes(read(`${q.frozenSource}/${item.path}`).toString()), `Frozen CSS not actually loaded: ${item.path}`)
const browserLoaded = loaded(q.browserLoaded)
for (const item of modules) assert.ok(browserLoaded.some((row) => row.path.endsWith(`${q.frozenSource}/${item.path}`) && row.sha256 === item.sha256), `Frozen browser module not loaded: ${item.path}`)
const observation = get(q.observations)
assert.equal(observation.subjectMain, q.subjectMain)
assert.equal(observation.cases.length, 6)
const expected = ['activity-1000', 'activity-332', 'history-1000', 'history-332', 'orca-1000', 'orca-332']
assert.deepEqual(observation.cases.map((row) => `${row.surface}-${row.actualCssWidth}`), expected)
for (const row of observation.cases) {
  assert.equal(row.before.width, row.actualCssWidth)
  assert.equal(row.after.width, row.actualCssWidth)
  assert.ok(row.after.selection.length > 20)
  assert.equal(row.after.proof.clipboard.length, 1)
  assert.ok(row.after.proof.clipboard[0].length > 100)
  assert.deepEqual(row.after.proof.links, ['https://example.com/guide'])
  for (const stage of [row.before, row.after]) {
    assert.equal(stage.errors.length, 0)
    assert.equal(stage.proof.runtimeCalls, 0)
    assert.equal(stage.proof.outgoingCalls, 0)
  }
  if (row.surface !== 'orca') {
    assert.equal(row.before.heavy, 0)
    assert.ok(row.before.rows.length > 0)
    assert.ok(row.before.rows.every((record) => record.width > 100 && record.text.length > 0))
  }
}
assert.equal(q.images.length, 12)
assert.equal(new Set(q.images).size, 12)
assert.deepEqual(q.images.map((path) => path.split('/').at(-1)), expected.flatMap((name) => [`${name}-closed.png`, `${name}-expanded-selected.png`]))
for (const image of q.images) {
  assert.ok(attested.has(image), `Image not bound: ${image}`)
  assert.ok(read(image).length > 1000, image)
}
const privacy = get(q.emptyRedacted)
assert.equal(privacy.actualCssWidth, 332)
assert.ok(privacy.empty.includes('No reasoning text recorded.'))
assert.ok(privacy.redacted.includes('Reasoning content redacted.'))
assert.equal(privacy.copyControls.length, 0)
assert.equal(privacy.leak, false)
const peer = get(q.visualReview)
assert.equal(peer.decision, 'PASS', 'Independent actual image review is required')
assert.equal(peer.captured_binding.subject_commit, q.subjectMain)
assert.equal(peer.p1_findings.length, 0)
assert.equal(peer.images_actually_viewed.length, 12)
assert.equal(typeof peer.conclusion, 'string', 'Independent comparison conclusion is required')
assert.match(peer.conclusion, /不弱于本地 Orca/, 'Matched local Orca reading comparison is required')
assert.match(peer.conclusion, /有限/, 'Image review must retain its finite scope')
assert.equal(new Set(peer.images_actually_viewed.map((item) => item.path)).size, 12)
for (const image of q.images) {
  const item = peer.images_actually_viewed.find((record) => record.path === image)
  assert.equal(item?.actually_viewed, true, `Image not independently viewed: ${image}`)
  assert.equal(item.sha256, sha(read(image)), `Independent image identity differs: ${image}`)
}
const gemini = get(q.geminiReview)
assert.equal(gemini.finiteSourceAccepted, true)
assert.equal(gemini.finiteVisualAccepted, true)
assert.equal(q.claimScope, 'shared reading UI only; no wholeApp, vendor Writer, installation, or performance claim')
console.log(JSON.stringify({ pass: true, featureId: q.featureId, taskId: q.taskId, subjectMain: q.subjectMain, owning: 6, adjacent: 78, productMutations: 6, matchedScenes: 6, images: 12 }))
