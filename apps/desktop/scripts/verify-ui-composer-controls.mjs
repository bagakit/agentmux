import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const evidenceDirectory = join(root, '.bagakit/feature-tracker/plans/ui-p1-controls-composer/composer')
await mkdir(evidenceDirectory, { recursive: true })
const evidence = await realpath(evidenceDirectory)
const mobile = 'apps/mobile/src/conversation/MobileConversationSurface.tsx'
const tools = 'apps/mobile/src/conversation/MobileMessageTools.tsx'
const gallery = 'apps/desktop/src/renderer/src/components/ObservationSurfaceGallery.tsx'
const owningConfig = 'apps/desktop/test/vitest.ui-composer-controls.config.mts'
const tests = ['apps/mobile/test/composer-tool-groups.test.tsx', 'apps/desktop/test/composer-tool-groups.test.tsx',
  'apps/mobile/test/mobile-command-entry.test.tsx', 'apps/desktop/test/composer-input-ownership.test.tsx']
const sources = [mobile, tools, gallery, 'packages/client-ui/src/components/AgentComposer.tsx',
  'packages/client-ui/src/styles/composer.css', 'apps/mobile/src/conversation/conversation.css',
  'apps/desktop/test/vitest.ui-controls-owning.config.mts',
  'apps/desktop/scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts', 'apps/mobile/test/device-locks.ts',
  'apps/mobile/test/conversation-fixture.tsx', 'apps/mobile/test/conversation-reading-fixture.ts', 'apps/mobile/test/activity-status-fixture.ts',
  'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'test/fixture-values.mjs']
const mutations = [
  { label: 'mobile-drops-original-reference-tools', file: mobile, before: 'referenceTools={referenceTools}', after: 'referenceTools={null}' },
  { label: 'gallery-drops-original-reference-tools', file: gallery, before: 'referenceTools={referenceTools}', after: 'referenceTools={null}' }
]
await mkdir(evidence, { recursive: true })
const name = 'mutations-' + randomUUID()
await verifyRendererSourceMutations({ name, evidenceRoot: evidence, tests, sources, mutations, owningConfig })
const explicit = process.env.AGENTMUX_MUTATION_RECEIPTS ? JSON.parse(process.env.AGENTMUX_MUTATION_RECEIPTS) : []
const records = await Promise.all(explicit.map(async path => ({ path, proof: JSON.parse(await readFile(path, 'utf8')) })))
const matching = records.filter(({ proof }) => JSON.stringify(proof.cases?.map(({ label, file, before, after }) => ({ label, file, before, after }))) === JSON.stringify(mutations))
if (explicit.length) assert.equal(matching.length, 1)
const mutationReceipt = explicit.length ? matching[0].path : join(evidence, name, 'receipt.json')
const proof = JSON.parse(await readFile(mutationReceipt, 'utf8'))
assert.equal(proof.passed, true); assert.equal(proof.cases.length, mutations.length)
const chain = [
  ['apps/mobile/src/MobileApp.tsx', /<MobileConversationSurface\b/u, 'MobileApp → MobileConversationSurface'],
  [mobile, /tools=\{referenceTools => <MobileMessageTools referenceTools=\{referenceTools\}/u, 'Mobile Surface → original shared referenceTools → MobileMessageTools'],
  ['apps/desktop/src/renderer/src/components/WorkflowComponentGallery.tsx', /<ObservationSurfaceGallery\b/u, 'Standalone Gallery → ObservationSurfaceGallery'],
  [gallery, /tools=\{referenceTools => <AgentComposerTools referenceTools=\{referenceTools\}/u, 'Gallery → original shared referenceTools → AgentComposerTools'],
  ['apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', /tools=\{\(referenceTools\) => <AgentComposerTools/u, 'Desktop Session retains the original reference injection'],
  ['apps/desktop/src/renderer/src/components/NewTabSurface.tsx', /referenceTools=\{<ComposerReferenceTool/u, 'Launcher retains the original reference injection']
]
const callers = []
for (const [file, pattern, consumer] of chain) {
  assert.match(await readFile(join(root, file), 'utf8'), pattern, consumer)
  callers.push({ file, consumer })
}
const inputs = Object.fromEntries(await Promise.all([...new Set([...sources, ...tests, owningConfig])].map(async file =>
  [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])))
const geometryPath = join(evidence, 'geometry.json')
const geometry = JSON.parse(await readFile(geometryPath, 'utf8'))
assert.equal(geometry.schema, 'agentmux.ui-composer-controls-geometry.v1'); assert.equal(geometry.passed, true)
assert.equal(geometry.desktop.cases, 24); assert.equal(geometry.desktop.frames, 26); assert.equal(geometry.desktop.mutations, 2)
assert.equal(geometry.mobile.cases, 16); assert.ok(geometry.mobile.touchReceipts > 0); assert.equal(geometry.gallery.frames, 8)
for (const [file, expected] of Object.entries(geometry.inputs)) assert.equal(createHash('sha256').update(await readFile(join(root, file))).digest('hex'), expected, 'Exact current Composer geometry source: ' + file)
for (const { path, sha256 } of geometry.receipts) assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), sha256, 'Original Renderer receipt remains readable and exact')
assert.equal(geometry.frames.length, 51)
for (const { path, sha256 } of geometry.frames) assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), sha256, 'Exact complete Renderer frame for independent review')
const receipt = { schema: 'agentmux.ui-composer-controls-qualification.v1', passed: true, inputs, callers, mutationReceipt, geometry: geometryPath,
  verified: ['Real Mobile and Gallery reference group with exactly one usable Files', 'Original editor document and selection across all input modes',
    'Original Mobile Session/Run input target, IME, queue Enter, immediate Cmd Enter and independent interrupt', 'Original command insertion and undoable history owner'],
  pending: ['Independent visual review'],
  boundary: 'Mounted original Surface/Gallery/shared rich editor; controlled native transport and Gallery examples. No live Runtime, real Provider input, installation or new model capability.' }
const output = join(evidence, 'qualification.json')
await writeFile(output, JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, receipt: output, mutations: mutations.length }))
