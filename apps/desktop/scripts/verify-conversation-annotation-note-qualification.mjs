import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
assert.equal(process.argv[2], '--proof')
assert.equal(process.argv.length, 4, 'provide the existing T003 proof file')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const bytes = path => readFile(resolve(root, path))
const json = async path => JSON.parse(await bytes(path))
async function bound(ref) {
  const value = await bytes(ref.path)
  assert.equal(hash(value), ref.sha256, ref.path)
  return value
}
const proof = await json(process.argv[3])
assert.equal(proof.schema, 'agentmux.conversation-annotation-qualification.v1')
assert.ok(Object.keys(proof.source).length > 0)
for (const [path, expected] of Object.entries(proof.source)) {
  assert.equal(hash(await bytes(path)), expected.sha256, `current Source differs: ${path}`)
}
const production = Object.keys(proof.source).filter(path => path.startsWith('apps/desktop/src/renderer/src/'))
assert.equal(production.length, 7)
const runtimeSource = production.filter(path => !path.endsWith('/lib/composer-composition.ts'))
assert.equal(runtimeSource.length, 6)
async function command(ref, exit) {
  const receipt = JSON.parse(await bound(ref.receipt))
  const stdout = (await bound(ref.stdout)).toString()
  const stderr = (await bound(ref.stderr)).toString()
  assert.equal(receipt.exit, exit)
  assert.deepEqual(receipt.sourceBefore, receipt.sourceAfter, 'command must preserve shared Source')
  for (const path of runtimeSource) {
    assert.ok(Object.hasOwn(receipt.sourceBefore, path), `command omitted actual runtime Source: ${path}`)
    assert.equal(receipt.sourceBefore[path].sha256, proof.source[path].sha256, path)
  }
  assert.equal(receipt.originalAppRuntimeRunControls, 0)
  return { receipt, stdout, stderr }
}
const owning = await command(proof.owning, 0)
assert.match(owning.stdout, /Tests\s+19 passed \(19\)/u)
const adjacent = await command(proof.adjacent, 0)
assert.match(adjacent.stdout, /Test Files\s+7 passed \(7\)/u)
assert.match(adjacent.stdout, /Tests\s+82 passed \(82\)/u)
assert.equal(proof.types.length, 2)
for (const ref of proof.types) await command(ref, 0)

assert.deepEqual(proof.mutations.map(pair => pair.name).sort(), ['drop-id', 'empty-range', 'wrong-range'])
for (const pair of proof.mutations) {
  const red = await command(pair.red, 1), restored = await command(pair.restored, 0)
  assert.match(red.stderr, /AssertionError/u)
  assert.match(red.stdout, /Tests\s+1 failed/u)
  assert.match(restored.stdout, /Tests\s+1 passed/u)
  assert.equal(red.receipt.sourceBefore[pair.target].sha256, restored.receipt.sourceBefore[pair.target].sha256)
  const originalJS = await bound(pair.originalCompiled), badJS = await bound(pair.mutatedCompiled), restoredJS = await bound(pair.restoredCompiled)
  assert.notEqual(hash(originalJS), hash(badJS), 'loaded mutation must change production JavaScript')
  assert.equal(hash(originalJS), hash(restoredJS), 'production JavaScript must restore exactly')
}
const callers = JSON.parse(await bound(proof.callers))
assert.ok(callers.matches.length > 0)
for (const symbol of ['ConversationAnnotationNote', 'ActivityView', 'SessionHistoryView', 'SessionPane']) {
  const hits = callers.matches.filter(hit => hit.symbol === symbol)
  assert.ok(hits.length > 0, `no product caller for ${symbol}`)
  for (const hit of hits) {
    assert.ok(!hit.path.includes('/test/') && !hit.path.endsWith(`/${symbol}.tsx`))
    assert.ok((await bytes(hit.path)).toString().includes(hit.text), `missing actual caller: ${hit.path}`)
  }
}
const sourceReview = JSON.parse(await bound(proof.sourceReview)), visualReview = JSON.parse(await bound(proof.visualReview))
assert.equal(sourceReview.decision, 'PASS'); assert.equal(visualReview.decision, 'PASS')
assert.equal(visualReview.actual_view_tool, 'view_image'); assert.equal(visualReview.images_viewed_count, 8)
const visual = JSON.parse(await bound(proof.visualManifest))
assert.equal(visual.passed, true); assert.equal(visual.scenes.length, 8)
assert.deepEqual(visual.sourceBefore, visual.sourceAfter)
for (const [path, identity] of Object.entries(visual.sourceBefore)) assert.equal(identity.sha256, proof.source[path].sha256)
assert.ok(visual.scenes.some(scene => scene.name.startsWith('wide-')))
assert.ok(visual.scenes.some(scene => scene.name.startsWith('narrow-332')))
assert.ok(visual.scenes.some(scene => scene.name.startsWith('history-')))
for (const scene of visual.scenes) {
  await bound(scene)
  assert.ok(scene.state.rangeRects.length > 0)
  assert.ok(scene.state.connected && scene.state.sameStart && scene.state.sameEnd && scene.state.sameContext && scene.state.sameFirstNode)
  assert.deepEqual(scene.state.controls, [])
}
const style = JSON.parse(await bound(proof.style))
assert.ok(style.annotationRules.length > 0); assert.equal(style.annotationCSSIncluded, true)
for (const [path, identity] of Object.entries(style.source)) assert.equal(identity, proof.source[path].sha256)
assert.ok(style.styles.length > 0)
for (const ref of style.styles) await bound(ref)
assert.equal(proof.originalAppRuntimeRunControls, 0)
console.log(JSON.stringify({ result: 'PASS', owning: 19, adjacent: 82, compiledMutations: 3, independentlyViewedImages: 8,
  boundary: 'T003 private mounted DOM/Renderer qualification; no installed App, Native writer, system Clipboard or restart claim' }))
