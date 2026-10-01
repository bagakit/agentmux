import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const evidence = '.tmp/survey-top-density'
const read = file => readFile(resolve(root, file))
const json = async file => JSON.parse(await read(file))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const acceptance = await json(`${evidence}/acceptance.json`)
assert.ok(Object.keys(acceptance.sources).length > 0, 'Owning source manifest must be nonempty.')
for (const [file, hash] of Object.entries(acceptance.sources)) {
  assert.equal(digest(await read(file)), hash, `Owning source: ${file}`)
}
const compilation = await json(`${evidence}/compiled-inputs.json`)
const inputs = { ...compilation.inputs, ...compilation.css }
assert.ok(Object.keys(compilation.inputs).length > 0 && Object.keys(compilation.css).length > 0)
for (const [file, hash] of Object.entries(inputs)) {
  assert.equal(digest(await read(file)), hash, `Actual Renderer input: ${file}`)
}
const capture = await json(`${evidence}/capture.json`)
assert.equal(capture.passed, true)
assert.equal(capture.frames.length, 9)
assert.equal(acceptance.visual.satisfied, true)
assert.equal(acceptance.visual.independentAgentReview, false)
for (const frame of capture.frames) {
  assert.equal(digest(await read(`${evidence}/${frame.file}`)), acceptance.visual.frames[frame.file])
  assert.equal(frame.geometry.topbar, false)
  assert.equal(frame.geometry.surfaceTop, 0)
  assert.equal(frame.geometry.contentActions, 0)
  assert.equal(frame.geometry.count, 2)
  assert.equal(frame.geometry.visible, true)
  assert.ok(frame.geometry.tabs.length > 0, 'Actual projected tabs must be visible.')
  if (frame.geometry.native && frame.geometry.left.width < 80) {
    assert.ok(frame.geometry.toggle.top >= 36, 'Collapsed toggle must avoid native window controls.')
    assert.ok(frame.geometry.tabs[0].left >= 80, 'First Pane must retain the shared native gutter.')
  }
}
assert.ok(acceptance.callers.length > 0)
for (const { file, definition, call } of acceptance.callers) {
  assert.notEqual(file, definition, 'A definition is not a product caller.')
  assert.ok((await read(file)).toString().includes(call), `Definition-external caller: ${call}`)
}

const app = 'apps/desktop/src/renderer/src/App.tsx'
const workbench = 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx'
await verifyRendererSourceMutations({
  name: ("survey-top-density-" + (globalThis.crypto.randomUUID()) + ""),
  evidenceRoot: resolve(root, evidence),
  owningConfig: 'apps/desktop/scripts/fixtures/note-restore/vitest.owning.config.mts',
  tests: ['apps/desktop/test/survey-surface.test.tsx', 'apps/desktop/test/global-titlebar-inset.test.tsx'],
  sources: [app, workbench, 'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/helpers/styles.ts'],
  mutations: [
    { label: 'survey-must-use-merged-top-row', file: app,
      before: "const mergedTopRow = mainSurface === 'agents' || mainSurface === 'survey' ||",
      after: "const mergedTopRow = mainSurface === 'agents' ||" },
    { label: 'projection-must-pass-window-gutter-to-first-pane', file: workbench,
      before: "          showWindowChrome={viewOwnership === 'owner'}\n          leadingChrome={leadingChrome}\n",
      after: "          showWindowChrome={viewOwnership === 'owner'}\n          leadingChrome={undefined}\n" }
  ]
})
