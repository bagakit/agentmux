import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
assert.equal(process.argv[2], '--proof'); assert.equal(process.argv.length, 4)
const bytes = path => readFile(resolve(root, path)), hash = value => createHash('sha256').update(value).digest('hex')
async function bound(ref) { const data = await bytes(ref.path); assert.equal(hash(data), ref.sha256, ref.path); return data }
const proof = JSON.parse(await bytes(process.argv[3]))
assert.equal(proof.schema, 'agentmux.conversation-sender-context-qualification.v1')
assert.equal(proof.status, 'PASS')
assert.equal(Object.keys(proof.source).length, 12, 'declared JS, fixture and configuration inputs are nonempty')
const currentSource = proof.integration?.source ?? proof.source
assert.equal(Object.keys(currentSource).length, 12)
for (const [path, input] of Object.entries(currentSource)) assert.equal(hash(await bytes(path)), input.sha256, path)
assert.equal(hash(await bytes(proof.css.path)), proof.css.sha256, 'exact current CSS separately qualified by Renderer')
async function command(ref, exit, expectedSource = proof.source) {
  const receipt = JSON.parse(await bound(ref.receipt))
  assert.equal(receipt.exit, exit); assert.equal(receipt.error, null); assert.equal(receipt.signal, null)
  assert.deepEqual(receipt.sourceBefore, receipt.sourceAfter)
  for (const [path, input] of Object.entries(expectedSource)) assert.equal(receipt.sourceBefore[path]?.sha256, input.sha256, path)
  assert.equal(receipt.cssNotImportedByDOMOrTS, true, 'DOM and TypeScript receipts do not claim CSS consumption')
  assert.equal(receipt.originalAppRuntimeRunControls, 0)
  await bound(receipt.stdout); await bound(receipt.stderr)
  return receipt
}
async function report(ref, count, files) {
  const value = JSON.parse(await bound(ref)); assert.equal(value.numTotalTests, count)
  assert.equal(value.testResults.length, files); assert.equal(value.testResults.reduce((n, file) => n + file.assertionResults.length, 0), count)
  return value
}
async function loaded(receipt) { const data = (await bound(receipt.loaded)).toString().trim(); assert.ok(data.length > 0); return data.split('\n').map(line => JSON.parse(line)) }
const own = await command(proof.owning, 0), ownReport = await report(proof.owning.report, 13, 1)
assert.equal(ownReport.numPassedTests, 13); assert.equal(ownReport.numFailedTests, 0)
const graph = await loaded(own)
for (const name of ['ConversationInputDetails.tsx', 'ConversationMessage.tsx', 'ActivityView.tsx', 'SessionHistoryView.tsx', 'SessionPane.tsx', 'ProjectIcon.tsx', 'conversation-sender-details.ts']) {
  const matches = graph.filter(row => row.path.endsWith(`/${name}`)); assert.equal(matches.length, 1, `${name} must be actually loaded once`)
  assert.equal(matches[0].sha256, proof.source[matches[0].path]?.sha256, name)
}
const mutations = {
  'native-source-omitted': 'apps/desktop/src/renderer/src/components/ActivityView.tsx',
  'header-author-claimed': 'apps/desktop/src/renderer/src/components/ConversationMessage.tsx',
  'ended-from-updated': 'apps/desktop/src/renderer/src/components/ConversationInputDetails.tsx',
  'closed-project-icon': 'apps/desktop/src/renderer/src/components/ConversationInputDetails.tsx',
  'unlinked-goal': 'apps/desktop/src/renderer/src/lib/conversation-sender-details.ts'
}
assert.deepEqual(proof.mutations.map(pair => pair.name).sort(), Object.keys(mutations).sort())
for (const pair of proof.mutations) {
  const red = await command(pair.red, 1), restored = await command(pair.restore, 0)
  const r = await report(pair.red.report, 13, 1), g = await report(pair.restore.report, 13, 1)
  const failures = r.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
  const semantic = failures.filter(test => test.failureMessages.some(message => message.includes('AssertionError')))
  assert.ok(semantic.length > 0, `${pair.name}: actual semantic AssertionRED required`)
  assert.equal(pair.assertionFailures, semantic.length); assert.equal(pair.runtimeFailures, failures.length - semantic.length)
  assert.equal(pair.runtimeFailures, 0, 'runtime/setup errors do not prove behavior')
  assert.equal(g.numPassedTests, 13); assert.equal(g.numFailedTests, 0); assert.equal(restored.mutation, null)
  const edits = (await loaded(red)).filter(row => row.mutation === pair.name)
  assert.equal(edits.length, 1); assert.equal(edits[0].path, mutations[pair.name])
  assert.equal(edits[0].originalSHA256, proof.source[edits[0].path].sha256); assert.notEqual(edits[0].originalSHA256, edits[0].sha256)
  const restoredModule = (await loaded(restored)).find(row => row.path === edits[0].path)
  assert.equal(restoredModule.sha256, edits[0].originalSHA256, 'exact actual loaded restoration')
}
await command(proof.adjacent, 0)
const adjacent = await report(proof.adjacent.report, 24, 3); assert.equal(adjacent.numPassedTests, 24); assert.equal(adjacent.numFailedTests, 0)
assert.equal(proof.types.length, 2); for (const run of proof.types) await command(run, 0)
const caller = JSON.parse(await bound(proof.callers)); assert.ok(caller.matches.length >= 4, 'no empty caller collection')
for (const row of caller.matches) { assert.ok(!row.path.includes('/test/')); assert.ok(row.consumerKind === 'jsx' || row.consumerKind === 'call'); assert.ok((await bytes(row.path)).toString().includes(row.text)) }
assert.ok(caller.matches.some(row => row.path.endsWith('/ConversationMessage.tsx') && row.symbol === 'ConversationInputDetails' && row.consumerKind === 'jsx'))
assert.ok(caller.matches.some(row => row.path.endsWith('/SessionPane.tsx') && row.symbol === 'currentConversationSenderDetails' && row.consumerKind === 'call'))
for (const name of ['ActivityView.tsx', 'SessionHistoryView.tsx']) assert.ok(caller.matches.some(row => row.path.endsWith(`/${name}`) && row.symbol === 'ConversationMessage.inputSource'))
const scene = JSON.parse(await bound(proof.publicScene)); assert.equal(scene.schema, 'agentmux.conversation-sender-public-scene.v1')
assert.equal(scene.page.items.length, 2); assert.deepEqual(scene.page.items.map(item => item.id), ['original-native-first', 'original-native-second'])
assert.equal(scene.messages.length, 4); assert.equal(scene.messages[0].content, scene.messages[1].content)
assert.notEqual(scene.messages[0].rawId, scene.messages[1].rawId)
assert.deepEqual(scene.messages.map(message => message.source.kind), ['native', 'native', 'captured', 'captured'])
assert.equal(scene.controls.length, 32); assert.deepEqual(scene.controls.filter(([, calls]) => calls !== 0), [])
const visual = JSON.parse(await bound(proof.visualManifest)); assert.equal(visual.passed, true)
for (const [path, input] of Object.entries(proof.source)) assert.equal(visual.source[path]?.sha256, input.sha256, path)
assert.equal(visual.css.sha256, proof.css.sha256); assert.equal(visual.originalAppRuntimeRunControls, 0)
assert.ok(visual.scenes.length >= 5); assert.ok(visual.scenes.some(item => item.name.includes('wide'))); assert.ok(visual.scenes.some(item => item.name.includes('narrow')))
for (const item of visual.scenes) {
  await bound(item.image); const state = JSON.parse(await bound(item.state)); assert.deepEqual(state.controls, [])
  assert.equal(state.draft, 'Keep this existing reply draft.')
  if (state.sameBody !== undefined) assert.equal(state.sameBody, true)
  if (state.rangeText !== undefined) assert.equal(state.rangeText, 'One original passage')
  if (state.scrollWidth !== undefined) assert.ok(state.scrollWidth <= state.clientWidth + 1, 'no metadata horizontal overflow')
}
const styles = JSON.parse(await bound(visual.actualStyles)); assert.ok(styles.length > 0)
const cssText = (await bytes(proof.css.path)).toString()
assert.ok(styles.some(style => style.text.includes(cssText)), 'actual Renderer consumed the full current dedicated CSS')
const visualGraph = JSON.parse(await bound(visual.actualLoaded)); assert.ok(visualGraph.length > 0)
for (const [path, input] of Object.entries(proof.source).filter(([path]) => path.startsWith('apps/desktop/src/'))) assert.ok(visualGraph.some(row => row.path === path && row.sha256 === input.sha256), path)
if (proof.integration) {
  const join = proof.integration
  assert.deepEqual(join.allowedChangedPaths.sort(), ['apps/desktop/src/renderer/src/components/ConversationMessage.tsx', 'apps/desktop/src/renderer/src/components/ActivityView.tsx', 'apps/desktop/src/renderer/src/components/SessionPane.tsx'].sort())
  for (const [path, input] of Object.entries(proof.source)) if (input.sha256 !== currentSource[path].sha256) assert.ok(join.allowedChangedPaths.includes(path), path)
  await command(join.owning, 0, currentSource)
  const g = await report(join.owning.report, 13, 1); assert.equal(g.numPassedTests, 13); assert.equal(g.numFailedTests, 0)
  const currentCallers = JSON.parse(await bound(join.callers)); assert.ok(currentCallers.matches.length >= 4)
  assert.deepEqual(currentCallers.matches.map(({ path, symbol, consumerKind, text }) => ({ path, symbol, consumerKind, text })), caller.matches.map(({ path, symbol, consumerKind, text }) => ({ path, symbol, consumerKind, text })), 'precise input detail/source caller scope survives legitimate adjacent edits')
  const approval = JSON.parse(await bound(join.review)); assert.equal(approval.decision, 'PASS'); assert.equal(approval.preservedInputDetailScopes, true)
}
const sourceReview = JSON.parse(await bound(proof.sourceReview)), visualReview = JSON.parse(await bound(proof.visualReview))
assert.equal(sourceReview.decision, 'PASS'); assert.equal(visualReview.result, 'pass')
assert.ok(visualReview.images.length >= 5)
assert.ok(visualReview.images.every(image => image.actuallyViewed === true), 'independent actual image inspection required')
for (const image of visualReview.images) { await bound(image); assert.ok(visual.scenes.some(scene => scene.image.path === image.path && scene.image.sha256 === image.sha256)) }
assert.equal(sourceReview.source['apps/desktop/src/renderer/src/components/ConversationInputDetails.tsx'].sha256, proof.source['apps/desktop/src/renderer/src/components/ConversationInputDetails.tsx'].sha256)
assert.equal(sourceReview.css.sha256, proof.css.sha256)
assert.equal(visualReview.feature, 'f-2ha8ftgxa'); assert.equal(visualReview.task, 'T-002')
assert.equal(proof.originalAppRuntimeRunControls, 0)
console.log(JSON.stringify({result:'PASS',owning:13,adjacent:24,loadedSemanticMutations:5,boundary:'actual public Claude reader/FileStore/projector/shared Activity/History plus declared current Store metadata; controlled records and light Source preview, not vendor writer/physical terminal channel/installed App/Runtime'}))
