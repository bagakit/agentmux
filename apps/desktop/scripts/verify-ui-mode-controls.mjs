import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.bagakit/feature-tracker/plans/ui-p1-controls-composer/modes')
const control = 'apps/desktop/src/renderer/src/components/SurfaceModeSwitch.tsx'
const focus = 'apps/desktop/src/renderer/src/components/FocusViewSwitch.tsx'
const config = 'apps/desktop/test/vitest.ui-mode-controls.config.mts'
const consumerConfig = 'apps/desktop/test/vitest.ui-mode-consumers.config.mts'
const unitTests = ['apps/desktop/test/ui-mode-controls.test.tsx', 'apps/desktop/test/surface-mode-switch.test.tsx']
const productTests = ['apps/desktop/test/ui-goal-view-controls.test.tsx', 'apps/desktop/test/collaboration-focus-product.test.tsx', 'apps/desktop/test/ui-recall-mode-controls.test.tsx']
const sources = [control, focus, 'apps/desktop/src/renderer/src/components/NotebookViews.tsx', 'apps/desktop/test/vitest.ui-controls-owning.config.mts']
const files = [...unitTests, ...productTests, ...sources, config, consumerConfig,
  'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx', 'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx',
  'apps/desktop/src/renderer/src/components/GlobalRecallSurface.tsx', 'apps/desktop/src/renderer/src/styles/collaboration.css',
  'apps/desktop/src/renderer/src/styles/surface-mode-switch.css']
const sha = value => createHash('sha256').update(value).digest('hex')
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(join(root, file)))])))
const mutations = [
  { label: 'focus-pretends-to-be-tabs', file: focus, before: 'active semantics="pressed"', after: 'active semantics="tabs"' },
  { label: 'mode-choice-loses-original-callback', file: control, before: 'onClick={() => onChange(option.value)}', after: 'onClick={() => void option.value}' },
  { label: 'decoration-withdraws-explicit-controls', file: control, before: 'onClick={() => onChange(option.value)}', after: 'onClick={() => { if (active) onChange(option.value) }}' }
]
await mkdir(evidence, { recursive: true })
const before = await hashes(), qualificationPath = join(evidence, 'qualification.json')
const name = 'mode-controls-' + randomUUID()
const invocation = randomUUID()
const consumerLog = join(evidence, `consumers-${invocation}.log`), loadedPath = join(evidence, `consumer-loaded-${invocation}.jsonl`)
const pattern = 'switches the original Goal list|opens Map without a selected Agent|switches real Recall modes'
const command = ['exec', 'vitest', 'run', ...productTests, '--config', consumerConfig, '--maxWorkers=1', '--reporter=verbose', '--testNamePattern', pattern]
let products
if (process.env.AGENTMUX_MUTATION_RECEIPTS) {
  let previous
  try { previous = JSON.parse(await readFile(qualificationPath, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (previous?.passed && JSON.stringify(previous.inputs) === JSON.stringify(before)) products = previous.products
}
if (!products) {
  await writeFile(loadedPath, '')
  // The product integration and isolated primitive mutations have independent inputs.
  products = new Promise((yes, no) => {
    const child = spawn('pnpm', command, { cwd: root, env: { ...process.env, AGENTMUX_UNIFIED_LOADED: loadedPath }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.on('error', no); child.on('close', async (code, signal) => {
      await writeFile(consumerLog, output)
      yes({ command: ['pnpm', ...command], exit: code, signal, log: consumerLog, sha256: sha(output), loaded: loadedPath })
    })
  })
}
const [mutationRun, consumerRun] = await Promise.allSettled([
  verifyRendererSourceMutations({ name, tests: unitTests, sources, mutations, evidenceRoot: evidence, owningConfig: config }),
  products
])
if (mutationRun.status === 'rejected') throw mutationRun.reason
if (consumerRun.status === 'rejected') throw consumerRun.reason
products = consumerRun.value
const log = await readFile(products.log, 'utf8')
assert.equal(products.exit, 0, log); assert.equal(products.signal, null)
assert.equal(sha(log), products.sha256)
assert.match(log, /Tests\s+3 passed/); assert.doesNotMatch(log, /Failed Suites|Unhandled Error/)
for (const name of ['switches the original Goal list', 'opens Map without a selected Agent', 'switches real Recall modes']) assert.ok(log.includes(name), name)
const loaded = (await readFile(products.loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
for (const file of [control, focus, 'apps/desktop/src/renderer/src/components/NotebookViews.tsx', 'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx']) {
  assert.ok(loaded.some(entry => entry.path === file && entry.sha256 === before[file]), 'Original product source loaded: ' + file)
}
assert.deepEqual(await hashes(), before)
let mutationReceipt = join(evidence, name, 'receipt.json')
if (process.env.AGENTMUX_MUTATION_RECEIPTS) {
  const records = await Promise.all(JSON.parse(process.env.AGENTMUX_MUTATION_RECEIPTS).map(async path => ({ path, value: JSON.parse(await readFile(path, 'utf8')) })))
  const matching = records.filter(({ value }) => JSON.stringify(value.cases?.map(({ label, file, before, after }) => ({ label, file, before, after }))) === JSON.stringify(mutations))
  assert.equal(matching.length, 1); mutationReceipt = matching[0].path
}
const result = { schema: 'agentmux.ui-mode-controls-qualification.v1', passed: true, inputs: before, products, mutationReceipt,
  scope: 'Original controlled modes and mounted Focus, Goal and Notebook consumers. Native/transport fixtures retain their original boundaries; no user Run or installation.' }
await writeFile(qualificationPath, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, qualificationPath, mutationReceipt, products: products.exit }))
