import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const root = process.cwd()
const index = process.argv.indexOf('--proof')
assert(index >= 0 && process.argv[index + 1], '--proof is required')
const proofPath = path.resolve(root, process.argv[index + 1])
const proof = JSON.parse(await fs.readFile(proofPath, 'utf8'))
const dir = path.dirname(proofPath)
const hash = data => createHash('sha256').update(data).digest('hex')
const checked = async entry => {
  const bytes = await fs.readFile(path.resolve(root, entry.path))
  assert(bytes.length > 0, `nonempty ${entry.path}`)
  assert.equal(hash(bytes), entry.sha256, `exact identity ${entry.path}`)
  return bytes
}
assert.equal(proof.schema, 'agentmux.conversation-ruler-geometry.v1')
const css = (await checked(proof.css)).toString()
const selector = '.activity-ruler__stack > .activity-ruler__track'
const ownedRule = css.match(/\.activity-ruler__stack\s*>\s*\.activity-ruler__track\s*\{([^}]+)\}/g)
assert.equal(ownedRule?.length, 1, 'nonempty exact owned selector')
assert.match(ownedRule[0], /flex:\s*none\s*;/)
assert(!ownedRule[0].includes('height'), 'reuse original height declaration')
const activity = await fs.readFile(path.resolve(root, proof.ruler.path), 'utf8')
const start = activity.indexOf(proof.ruler.from), end = activity.indexOf(proof.ruler.to, start)
assert(start >= 0 && end > start, 'Ruler source anchors must both exist')
const ruler = activity.slice(start, end)
assert(ruler.includes('className="activity-ruler__track"') && ruler.includes('onKeyDown={handleKeyDown}'), 'nonempty actual Ruler surface')
assert.equal(hash(ruler), proof.ruler.sha256, 'current owned Ruler fragment matches compiled source')
const compiled = JSON.parse((await checked(proof.compiled)).toString())
assert(compiled.loaded.length > 0, 'actual compiled inputs are nonempty')
for (const source of [proof.css.path, proof.ruler.path, 'apps/desktop/src/renderer/src/styles/activity.css']) {
  const entries = compiled.loaded.filter(entry => entry.path === source)
  assert.equal(entries.length, 1, `actual loaded source ${source}`)
  assert(entries[0].bytes > 0, 'loaded bytes are nonempty')
}
assert.equal(compiled.css.sha256, proof.css.sha256)
assert.equal(compiled.ruler.sha256, proof.ruler.sha256)
const currentHeight = await fs.readFile(path.resolve(root, 'apps/desktop/src/renderer/src/styles/activity.css'), 'utf8')
assert.match(currentHeight, /\.activity-ruler__track\s*\{[^}]*height:\s*18px/)
const loadedHeight = compiled.loaded.find(entry => entry.path === 'apps/desktop/src/renderer/src/styles/activity.css')
assert.equal(hash(currentHeight), loadedHeight.sha256, 'original height source was compiled')
const baselineCss = await checked(proof.assets.baselineCss)
const mutantCss = await checked(proof.assets.mutantCss)
const restoredCss = await checked(proof.assets.restoredCss)
await checked(proof.assets.javascript)
assert.equal(hash(baselineCss), hash(restoredCss), 'CSS exact restore')
assert.notEqual(hash(baselineCss), hash(mutantCss), 'real compiled CSS changed for mutation')
assert.equal(compiled.outputs.baseline['entry.js'], compiled.outputs.mutant['entry.js'], 'CSS-only mutation keeps product JS')
assert.equal(compiled.outputs.baseline['entry.js'], proof.assets.javascript.sha256)
for (const caller of proof.callers) {
  assert(caller.path !== caller.definition && !caller.path.includes('/test/'), 'production caller is outside definition and tests')
  const code = await fs.readFile(path.resolve(root, caller.path), 'utf8')
  assert(code.includes(caller.symbol), `nonempty production caller ${caller.symbol}`)
}
assert(proof.callers.length >= 2, 'both stylesheet and product entry are consumed')
const browser = JSON.parse((await checked(proof.actions)).toString())
assert.equal(browser.observations.length, 6, 'actual wide/narrow baseline, mutation and restoration')
for (const variant of ['baseline', 'mutant', 'restored']) {
  for (const width of [1000, 332]) {
    const scenes = browser.observations.filter(scene => scene.variant === variant && scene.width === width)
    assert.equal(scenes.length, 1, `nonempty exact scene ${variant}/${width}`)
    const scene = scenes[0], initial = scene.initial
    assert.equal(initial.selectorCount, 1)
    assert.equal(initial.ticks, 19)
    assert.equal(initial.recordCount, 19)
    assert(Math.abs(initial.sceneWidth - width) < 0.02)
    if (variant === 'mutant') {
      assert.equal(initial.track.height, 0, 'real mutant geometry is zero')
      assert.equal(scene.assertionRed.code, 'ERR_ASSERTION', 'actual geometry assertion turned red')
      assert(scene.focusRejected.length > 0, 'unforced focus was rejected')
      continue
    }
    assert(initial.track.width > 0 && Math.abs(initial.track.height - 18) < 0.02)
    assert.deepEqual(initial.cssSelectorRules, [{ selector, flex: '0 0 auto' }], 'actual browser consumed the fixed rule')
    assert.deepEqual(scene.actions.map(action => [action.key, action.selected]), [['Home', 0], ['ArrowRight', 1], ['ArrowDown', 2], ['ArrowLeft', 1], ['ArrowUp', 0], ['End', 18], ['ArrowLeft', 17], ['End', 18]])
    for (const action of scene.actions) {
      assert.equal(action.selected, action.selectedTick)
      assert(action.rawId.length > 0 && action.eventTime.length > 0 && action.readout.includes(action.eventTime))
      assert(action.active && action.originalRecords && action.originalBodyNode && action.originalBody && action.originalRange)
      assert.equal(action.draft, 'Keep the original unsent reply draft.')
      assert.deepEqual(action.controls, [])
      assert.equal(action.sessionId, 'private-agent')
      assert(action.segmentKeys.length > 0, 'original event hosts are nonempty')
    }
    const keys = scene.actions.at(-1).trustedKeys
    assert.equal(keys.length, 8, 'actual keyboard collection is nonempty')
    assert(keys.every(event => event.trusted), 'trusted browser input')
    const imageEntry = proof.images.find(image => path.resolve(root, image.path) === path.resolve(dir, scene.image))
    assert(imageEntry, 'image belongs to this exact scene')
    await checked(imageEntry)
  }
}
assert.equal(proof.images.length, 4, 'all actual green scenes are captured')
const review = JSON.parse(await fs.readFile(path.resolve(dir, proof.visualReview), 'utf8'))
assert.equal(review.verdict, 'approved', 'independent visual approval is required')
assert(review.reviewer && review.reviewer !== proof.owner, 'reviewer is independent from implementation owner')
assert.equal(review.cssSha256, proof.css.sha256, 'review belongs to the exact CSS candidate')
assert.deepEqual(review.images, proof.images.map(image => image.path), 'independent reviewer opened all exact images')
assert(review.notes.length > 0 && review.boundary.length > 0, 'conclusion and scope are explicit')
console.log(JSON.stringify({ passed: true, ownedCss: proof.css.path, scenes: 6, keyboardActions: 32, assertionRed: 2, images: 4, boundary: proof.boundary }))
