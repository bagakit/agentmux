import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const read = file => readFile(resolve(root, file))
const json = async file => JSON.parse(await read(file))
const acceptance = await json('.tmp/survey-sidebar-actions/acceptance.json')
assert.ok(Object.keys(acceptance.sources).length > 0)
for (const [file, hash] of Object.entries(acceptance.sources)) {
  assert.equal(createHash('sha256').update(await read(file)).digest('hex'), hash, `Owning source: ${file}`)
}
const compilation = await json('.tmp/survey-sidebar-actions/compiled-inputs.json')
const inputs = { ...compilation.inputs, ...compilation.css }
assert.ok(Object.keys(inputs).length > 0)
for (const [file, hash] of Object.entries(inputs)) {
  assert.equal(createHash('sha256').update(await read(file)).digest('hex'), hash, `Actual Renderer input: ${file}`)
}
const capture = await json('.tmp/survey-sidebar-actions/capture.json')
assert.equal(capture.passed, true)
assert.equal(capture.frames.length, 6)
assert.equal(acceptance.visual.satisfied, true)
assert.equal(acceptance.visual.independentAgentReview, false)
for (const frame of capture.frames) assert.ok((await read(`.tmp/survey-sidebar-actions/${frame.file}`)).length > 0)
assert.ok(acceptance.callers.length > 0)
for (const { file, call } of acceptance.callers) assert.ok((await read(file)).toString().includes(call), `Definition-external caller: ${call}`)

const component = 'apps/desktop/src/renderer/src/components/GlobalSurveySurface.tsx'
const source = (await read(component)).toString()
const start = source.indexOf('      <div className="survey-item-actions"')
const end = source.indexOf('      <div ref={resizeHandle}', start)
const header = source.indexOf('        <header className="survey-view-controls"', end)
assert.ok(start >= 0 && end > start && header > end, 'Both action block and destination must exist.')
const actions = source.slice(start, end), throughHeader = source.slice(start, header)
assert.ok(actions.includes('{options}') && actions.includes('Add note to this exploration'), 'The actual nonempty action block must be selected.')
await verifyRendererSourceMutations({
  name: ("survey-sidebar-actions-" + (globalThis.crypto.randomUUID()) + ""),
  owningConfig: 'apps/desktop/scripts/fixtures/note-restore/vitest.owning.config.mts',
  tests: ['apps/desktop/test/survey-surface.test.tsx'],
  sources: [component, 'apps/desktop/test/helpers/composer-dom-fixture.tsx'],
  mutations: [
    { label: 'exploration-actions-relocated-to-content', file: component, before: throughHeader, after: throughHeader.replace(actions, '') + actions },
    { label: 'add-note-must-retain-current-exploration', file: component, before: 'onClick={() => void openNote(false)}', after: 'onClick={() => void openNote(true)}' }
  ]
})
