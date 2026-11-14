import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()
const evidence = resolve(dirname(common), '.local/browser-context-menu-design')
const json = file => JSON.parse(readFileSync(file, 'utf8'))
const matches = (file, sha256) => assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), sha256, 'Exact evidence or loaded input ' + file)
const nativeRoot = resolve(evidence, 'native')
const native = json(resolve(nativeRoot, 'receipt.json'))
assert.equal(native.selectedCase, 'context-menu')
assert.equal(native.passed, true)
assert.equal(native.mutation, null)
assert.deepEqual(native.privateProcessesRemaining, [])
assert.deepEqual(native.sourceDrift, [])
assert.deepEqual(native.artifactDrift, [])
assert.equal(native.phases.length, 2)
const [first, restart] = native.phases.map(phase => {
  const file = resolve(nativeRoot, phase.receipt)
  matches(file, phase.sha256)
  const result = json(file)
  assert.ok(result.passed && result.businessPassed)
  return result
})
assert.notEqual(first.pid, restart.pid)
assert.ok(first.savedIdentity?.agent?.runId && restart.cases.some(item => item.passed && item.kind === 'context-menu-original-workface-recovered'))
assert.deepEqual(restart.recoveredIdentity, first.savedIdentity)
assert.deepEqual(first.cases.filter(item => item.passed && item.kind === 'context-menu-directional-split').map(item => item.direction).sort(), ['down', 'left', 'right', 'up'])
for (const kind of ['context-menu-object-hierarchy', 'context-menu-profile-admission', 'context-menu-original-frame-reload', 'context-menu-short-keyboard']) {
  assert.ok(first.cases.some(item => item.passed && item.kind === kind), 'Product outcome ' + kind)
}
assert.deepEqual(first.contextMenuKeyboard, ['Open Link in New Tab', 'Split Left', 'Split Right', 'Split Up', 'Split Down', 'Copy Link Address', 'Open in Profile', 'More Link Actions'])
assert.equal(first.contextMenuKeyboardFocus.label, 'Open Link Here')
assert.ok(parseFloat(first.contextMenuKeyboardFocus.width) > 0)
for (const file of [
  'apps/desktop/src/main/browser-page-context-menu.ts', 'apps/desktop/src/main/browser-page-menu-presentation.ts',
  'apps/desktop/src/main/text-edit-context-menu.ts', 'apps/desktop/src/shared/browser-page-menu.ts',
  'apps/desktop/src/renderer/src/components/BrowserPageContextMenuHost.tsx', 'apps/desktop/src/renderer/src/styles/context-menu.css',
  'apps/desktop/scripts/fixtures/browser-profile-survey-workface/context-menu-case.ts',
  'apps/desktop/scripts/fixtures/browser-profile-survey-workface/context-video.webm',
  'apps/desktop/scripts/fixtures/browser-profile-survey-workface/origin-server.mjs',
  'apps/desktop/scripts/verify-browser-profile-survey-workface.mjs'
]) matches(resolve(root, file), native.sources[file])

const mutation = json(resolve(evidence, 'mutations/receipt.json'))
assert.ok(mutation.passed && mutation.scratchRemoved)
assert.deepEqual(mutation.drift, [])
const reordered = mutation.runs.find(run => run.id === 'browser-context-menu-hierarchy')
assert.ok(reordered && reordered.redExit !== 0 && reordered.restoredExit === 0)
assert.equal(reordered.originalSha256, native.sources[reordered.source])
assert.notEqual(reordered.changedSha256, reordered.originalSha256)

const review = json(resolve(nativeRoot, 'independent-visual-review.json'))
assert.ok(review.passed && review.reviewer)
for (const name of ['dark', 'light', 'frame', 'linked-image', 'video', 'selection', 'page', 'short-keyboard', 'profiles']) {
  const file = `first-context-menu-${name}.png`
  const image = review.images.find(item => item.file === file)
  assert.ok(image && first.frames.some(frame => frame.file === file), 'Independently viewed actual menu ' + file)
  matches(resolve(nativeRoot, file), image.sha256)
}
console.log('Browser menu design qualified: object hierarchy, short-window keyboard, Profile, four directions, two PIDs and independent review.')
