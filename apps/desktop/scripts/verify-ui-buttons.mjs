import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.bagakit/feature-tracker/plans/ui-p1-controls-composer/buttons')
const button = 'packages/client-ui/src/components/Button.tsx'
const icon = 'packages/client-ui/src/components/IconButton.tsx'
const saveBar = 'apps/desktop/src/renderer/src/components/settings/SettingsSaveBar.tsx'
const appearance = 'apps/desktop/src/renderer/src/components/settings/modules/appearance.tsx'
const product = 'apps/desktop/test/ui-buttons.test.tsx'
const config = 'apps/desktop/test/ui-buttons.config.mts'
const helper = 'apps/desktop/test/helpers/config-owner-fixture.ts'
const name = 'mutations-' + randomUUID()
const mutations = [
  { label: 'ordinary-button-submits-form', file: button, before: "type = 'button'", after: "type = 'submit'" },
  { label: 'explicit-disabled-is-discarded', file: button, before: '<button {...props} type={type}', after: '<button {...props} disabled={false} type={type}' },
  { label: 'native-click-handler-is-discarded', file: button, before: '<button {...props} type={type}', after: '<button {...props} onClick={undefined} type={type}' },
  { label: 'native-focus-ref-is-discarded', file: button, before: '<button {...props} type={type}', after: '<button {...props} ref={undefined} type={type}' },
  { label: 'icon-action-loses-accessible-name', file: icon, before: 'aria-label={label}', after: 'aria-label={undefined}' },
  { label: 'settings-save-consumer-loses-original-callback', file: saveBar, before: 'onClick={onSave}', after: 'onClick={undefined}' }
]
await verifyRendererSourceMutations({ name, evidenceRoot: evidence, owningConfig: config, tests: [product],
  sources: [button, icon, saveBar, appearance, helper, 'apps/desktop/test/vitest.ui-controls-owning.config.mts'], mutations })
let proofPath = join(evidence, name, 'receipt.json')
if (process.env.AGENTMUX_MUTATION_RECEIPTS) {
  const records = await Promise.all(JSON.parse(process.env.AGENTMUX_MUTATION_RECEIPTS).map(async path => ({ path: resolve(path), value: JSON.parse(await readFile(resolve(path), 'utf8')) })))
  const matching = records.filter(({ value }) => JSON.stringify(value.cases?.map(({ label, file, before, after }) => ({ label, file, before, after }))) === JSON.stringify(mutations))
  assert.equal(matching.length, 1, 'One exact original buttons proof must match these mutation definitions.')
  proofPath = matching[0].path
}
const proof = JSON.parse(await readFile(proofPath, 'utf8'))
assert.equal(proof.passed, true); assert.equal(proof.cases.length, mutations.length)
const baseline = await readFile(join(dirname(proofPath), 'baseline-green.log'), 'utf8')
assert.match(baseline, /Tests\s+[1-9]\d* passed/)
assert.doesNotMatch(baseline, /Tests\s+[1-9]\d* failed|Failed Suites|Unhandled Error/)
const files = [button, icon, saveBar, appearance, helper, product, config, 'apps/desktop/test/vitest.ui-controls-owning.config.mts',
  'packages/client-ui/src/styles/buttons.css', 'packages/client-ui/src/styles/index.css', 'packages/client-ui/README.md',
  'apps/desktop/src/renderer/src/styles/base.css', 'apps/desktop/src/renderer/src/styles/index.css', 'apps/desktop/scripts/verify-ui-buttons.mjs']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const candidate = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(join(root, file)))])))
const receipt = { schema: 'agentmux.ui-buttons-qualification.v1', passed: true, candidate,
  consumers: [{ file: appearance, path: 'Registered Appearance pane -> original SettingsSaveBar -> shared Button -> existing api.config.save -> ConfigOwner -> ConfigStore',
    test: product, boundary: 'Mounted current production module and original save callback, original draft hooks and durable configuration owner. Runtime preparation is an isolated fixture; no live user Session or installed app is touched.' }],
  mutationReceipt: proofPath, mutations: proof.cases.map(value => ({ label: value.label, assertionRed: join(dirname(proofPath), value.log), restoredGreen: join(dirname(proofPath), value.restore.log) })),
  stylesBoundary: 'CSS is bound to this candidate and checked for a single canonical owner; real Chromium layout and independent visual review are separate join evidence.',
  sharedTreeMutations: 0, runtimeControl: [], publicCapability: 'Existing Settings save API and receipts are reused; no new business operation or CLI/RPC method.' }
await mkdir(evidence, { recursive: true })
const output = join(evidence, 'qualified-receipt.json')
await writeFile(output, JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, mutants: mutations.length, receipt: output, mutationReceipt: proofPath }))
