import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Consume the owning review's current artifacts; a mutation pass alone is not visual or restart acceptance.
const root = resolve(import.meta.dirname, '../../..')
const read = file => readFile(resolve(root, file))
const json = async file => JSON.parse(await read(file))
const acceptance = await json('.tmp/survey-clarity/acceptance.json')
assert.ok(Object.keys(acceptance.sources).length > 0, 'The owning candidate must be pinned.')
for (const [file, sha256] of Object.entries(acceptance.sources)) {
  assert.equal(createHash('sha256').update(await read(file)).digest('hex'), sha256, `Current candidate: ${file}`)
}
assert.match((await read(acceptance.tests.log)).toString(), /Tests\s+103 passed \(103\)/)
assert.equal(acceptance.types.exit, 0)
assert.equal((await read(acceptance.types.log)).length, 0)
const restart = await json(acceptance.restart)
assert.equal(restart.passed, true)
assert.equal(restart.phases.length, 2)
assert.equal(new Set(restart.phases.map(phase => phase.pid)).size, 2)
assert.deepEqual(restart.sourceAfter, restart.sourceBefore)
assert.ok(Object.keys(restart.sourceBefore).length > 0)
for (const [file, sha256] of Object.entries(restart.sourceBefore)) {
  assert.equal(createHash('sha256').update(await read(file)).digest('hex'), sha256, `Restart input: ${file}`)
}
const compilation = await json(acceptance.visual.compilation)
const inputs = { ...compilation.inputs, ...compilation.css }
assert.ok(Object.keys(inputs).length > 0, 'Actual Renderer inputs must be present.')
for (const [file, sha256] of Object.entries(inputs)) {
  assert.equal(createHash('sha256').update(await read(file)).digest('hex'), sha256, `Actual Renderer input: ${file}`)
}
const visual = await json(acceptance.visual.capture)
assert.equal(visual.passed, true)
assert.equal(visual.frames.length, 6)
assert.equal(acceptance.visual.selfReview.satisfied, true)
assert.equal(acceptance.visual.selfReview.independentAgentReview, false)
assert.ok(acceptance.callers.length > 0, 'Definition-external product callers must be recorded.')
for (const { file, call } of acceptance.callers) assert.ok((await read(file)).toString().includes(call), `Actual product caller: ${call}`)
assert.ok(Object.keys(acceptance.artifacts).length > 0, 'Original evidence must be present.')
for (const [file, sha256] of Object.entries(acceptance.artifacts)) {
  assert.equal(createHash('sha256').update(await read(file)).digest('hex'), sha256, `Owning artifact: ${file}`)
}

const component = 'apps/desktop/src/renderer/src/components/GlobalSurveySurface.tsx'
const names = 'apps/desktop/src/renderer/src/lib/survey-exploration-name.ts'
await verifyRendererSourceMutations({
  name: `survey-clarity-${Date.now()}`,
  owningConfig: 'apps/desktop/scripts/fixtures/note-restore/vitest.owning.config.mts',
  tests: ['apps/desktop/test/survey-surface.test.tsx', 'apps/desktop/test/note-survey-presentation.test.tsx'],
  sources: ['apps/desktop/test/helpers/composer-dom-fixture.tsx', component, names, 'apps/desktop/src/renderer/src/lib/survey-workface.ts', 'apps/desktop/src/renderer/src/store.ts'],
  mutations: [
    { label: 'sole-confirmed-occurrence', file: 'apps/desktop/src/renderer/src/lib/survey-workface.ts', before: 'if (occurrences.size === 1)', after: 'if (false)' },
    { label: 'exploration-name-used', file: names, before: 'if (name?.trim()) return name.trim()', after: 'if (false) return name!.trim()' },
    { label: 'exploration-name-restored', file: 'apps/desktop/src/renderer/src/store.ts', before: 'surveyExplorationNames: restoredSurveyExplorationNames(persisted.surveyExplorationNames)', after: 'surveyExplorationNames: {}' },
    { label: 'note-recovery-same-intent', file: component, before: 'recover && retained ? await', after: 'false ? await' },
    { label: 'note-exact-selected-group', file: component, before: 'const groupId = active?.groupId ?? before.layouts[displayWorkspaceId]?.activeGroupId', after: 'const groupId = before.layouts[displayWorkspaceId]?.activeGroupId' }
  ]
})
