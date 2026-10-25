import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.bagakit/feature-tracker/plans/ui-p1-controls-composer/button-consumers')
const confirmation = 'apps/desktop/src/renderer/src/components/ConfirmationDialog.tsx'
const notebook = 'apps/desktop/src/renderer/src/components/NotebookNavigation.tsx'
const goal = 'apps/desktop/src/renderer/src/components/GoalDetail.tsx'
const product = 'apps/desktop/test/ui-button-consumers.test.tsx'
const craft = 'apps/desktop/test/confirmation-dialog-craft.test.tsx'
const config = 'apps/desktop/test/ui-button-consumers.config.mts'
const name = 'mutations-' + randomUUID()
const mutations = [
  { label: 'goal-cancel-executes-dangerous-confirmation', file: confirmation,
    before: 'disabled={busy} onClick={onCancel}>Cancel', after: 'disabled={busy} onClick={onConfirm}>Cancel' },
  { label: 'goal-confirm-loses-original-action', file: confirmation,
    before: 'onClick={onConfirm}', after: 'onClick={undefined}' },
  { label: 'notebook-close-loses-original-dismissal', file: notebook,
    before: 'aria-label="Close notebook creation" disabled={operation.busy} onClick={close}', after: 'aria-label="Close notebook creation" disabled={operation.busy} onClick={undefined}' },
  { label: 'notebook-cancel-submits-form', file: notebook,
    before: '<Button type="button" disabled={operation.busy} onClick={close}>Cancel', after: '<Button type="submit" disabled={operation.busy} onClick={close}>Cancel' },
  { label: 'notebook-create-loses-native-submit', file: notebook,
    before: '<Button type="submit" variant="primary"', after: '<Button type="button" variant="primary"' },
  { label: 'notebook-explicit-retry-discards-original-operation', file: notebook,
    before: 'if (operation.pending) { await operation.retry(); return }', after: 'if (operation.pending) { return }' }
]
const sources = [confirmation, notebook, goal, 'packages/client-ui/src/components/Button.tsx', 'packages/client-ui/src/components/IconButton.tsx',
  'apps/desktop/src/renderer/src/components/NotebookOperation.tsx', 'apps/desktop/src/renderer/src/lib/notebook-library.ts',
  'apps/desktop/src/renderer/src/store.ts', 'packages/core/src/notebook-store.ts',
  'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx',
  'apps/host/src/goal-projection.ts', 'apps/desktop/test/vitest.ui-controls-owning.config.mts']
await verifyRendererSourceMutations({ name, evidenceRoot: evidence, owningConfig: config, tests: [product, craft], sources, mutations })
let proofPath = join(evidence, name, 'receipt.json')
if (process.env.AGENTMUX_MUTATION_RECEIPTS) {
  const records = await Promise.all(JSON.parse(process.env.AGENTMUX_MUTATION_RECEIPTS).map(async path => ({ path: resolve(path), value: JSON.parse(await readFile(resolve(path), 'utf8')) })))
  const matching = records.filter(({ value }) => JSON.stringify(value.cases?.map(({ label, file, before, after }) => ({ label, file, before, after }))) === JSON.stringify(mutations))
  assert.equal(matching.length, 1, 'One exact original consumer proof must match these mutation definitions.')
  proofPath = matching[0].path
}
const proof = JSON.parse(await readFile(proofPath, 'utf8'))
assert.equal(proof.passed, true); assert.equal(proof.cases.length, mutations.length)
const baseline = await readFile(join(dirname(proofPath), 'baseline-green.log'), 'utf8')
assert.match(baseline, /Tests\s+[1-9]\d* passed/)
assert.doesNotMatch(baseline, /Tests\s+[1-9]\d* failed|Failed Suites|Unhandled Error/)
const files = [...sources, product, craft, config, 'apps/desktop/scripts/verify-ui-button-consumers.mjs', 'packages/client-ui/src/styles/buttons.css']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const candidate = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(join(root, file)))])))
const receipt = { schema: 'agentmux.ui-button-consumers-qualification.v1', passed: true, candidate,
  consumers: [
    { file: goal, path: 'GoalDetail original menu -> ConfirmationDialog -> shared Button -> original Store.deleteDemand -> api.goals.execute -> durable DemandStore.remove',
      test: product, boundary: 'Real GoalDetail, original cancel/focus and delete Store action. Controlled public transport delegates the exact ID to a temporary original durable owner; no live Goal or Session is mutated.' },
    { file: notebook, path: 'NotebookCreateDialog original form -> shared Button/IconButton -> useNotebookOperation -> changeNotebook -> api.notebooks -> AgentMuxNotebookStore',
      test: product, boundary: 'Real product dialog, original name/form/operation hooks and durable owner. First original write commits while its reply is withheld then rejected; only explicit native submit retries the original operation ID and change. Full App/Recall initialization is outside this bounded proof.' }
  ],
  mutationReceipt: proofPath, mutations: proof.cases.map(value => ({ label: value.label, assertionRed: join(dirname(proofPath), value.log), restoredGreen: join(dirname(proofPath), value.restore.log) })),
  stylesBoundary: 'Existing canonical shared classes only; final compiled App screenshots and independent visual review are separate join evidence.',
  sharedTreeMutations: 0, runtimeControl: [], publicCapability: 'Existing Goal execute and Notebook apply/read/operation receipts reused; no new business API, state, error or CLI/RPC method.' }
await mkdir(evidence, { recursive: true })
const output = join(evidence, 'qualified-receipt.json')
await writeFile(output, JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, mutants: mutations.length, receipt: output, mutationReceipt: proofPath }))
