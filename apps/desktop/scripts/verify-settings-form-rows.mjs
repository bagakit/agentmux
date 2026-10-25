import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.bagakit/feature-tracker/plans/ui-detail-polish/forms')
const row = 'packages/client-ui/src/components/FormRow.tsx'
const general = 'apps/desktop/src/renderer/src/components/settings/GeneralSettingsPane.tsx'
const notifications = 'apps/desktop/src/renderer/src/components/settings/NotificationSettingsPane.tsx'
const product = 'apps/desktop/test/settings-form-rows.test.tsx'
const config = 'apps/desktop/test/settings-form-rows.config.mts'
const name = 'mutations-' + randomUUID()
const mutations = [
  { label: 'label-loses-explicit-original-control', file: row, before: 'htmlFor={id}', after: 'htmlFor={undefined}' },
  { label: 'field-loses-title-name', file: row, before: "'aria-labelledby': labelId", after: "'aria-labelledby': undefined" },
  { label: 'field-loses-description', file: row, before: "'aria-describedby': descriptionId", after: "'aria-describedby': undefined" },
  { label: 'general-loses-original-draft-change', file: general,
    before: "onChange={(event) => draft.setField('copyPathsAsAbsolute', event.target.checked)}", after: 'onChange={undefined}' },
  { label: 'sound-discards-original-checked-draft', file: notifications, before: 'checked={sound}', after: 'checked={false}' },
  { label: 'sound-off-revokes-independent-editing', file: notifications,
    before: 'type="checkbox" name="sound"', after: 'type="checkbox" name="sound" disabled={mode === \'off\'}' }
]
const sources = [row, general, notifications, 'apps/desktop/src/renderer/src/components/SettingsPanel.tsx',
  'apps/desktop/src/renderer/src/components/settings/modules/general.tsx', 'apps/desktop/src/renderer/src/components/settings/modules/notifications.tsx',
  'apps/desktop/src/renderer/src/components/settings/SettingsSaveBar.tsx', 'apps/desktop/src/renderer/src/components/settings/use-setting-draft.ts',
  'apps/desktop/src/main/config-owner.ts', 'apps/desktop/src/main/config-store.ts', 'apps/desktop/test/helpers/config-owner-fixture.ts',
  'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx',
  'apps/desktop/test/vitest.ui-controls-owning.config.mts', 'packages/capsule/package.json']
await verifyRendererSourceMutations({ name, evidenceRoot: evidence, owningConfig: config, tests: [product], sources, mutations })
let proofPath = join(evidence, name, 'receipt.json')
if (process.env.AGENTMUX_MUTATION_RECEIPTS) {
  const records = await Promise.all(JSON.parse(process.env.AGENTMUX_MUTATION_RECEIPTS).map(async path => ({ path: resolve(path), value: JSON.parse(await readFile(resolve(path), 'utf8')) })))
  const matching = records.filter(({ value }) => JSON.stringify(value.cases?.map(({ label, file, before, after }) => ({ label, file, before, after }))) === JSON.stringify(mutations))
  assert.equal(matching.length, 1, 'One exact original form proof must match these mutation definitions.')
  proofPath = matching[0].path
}
const proof = JSON.parse(await readFile(proofPath, 'utf8'))
assert.equal(proof.passed, true); assert.equal(proof.cases.length, mutations.length)
const baseline = await readFile(join(dirname(proofPath), 'baseline-green.log'), 'utf8')
assert.match(baseline, /Tests\s+[1-9]\d* passed/)
assert.doesNotMatch(baseline, /Tests\s+[1-9]\d* failed|Failed Suites|Unhandled Error/)
const files = [...sources, product, config, 'apps/desktop/scripts/verify-settings-form-rows.mjs', 'packages/client-ui/README.md',
  'apps/desktop/src/renderer/src/styles/surfaces.css', 'packages/client-ui/src/styles/native-controls.css']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const candidate = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(join(root, file)))])))
const receipt = { schema: 'agentmux.settings-form-rows-qualification.v1', passed: true, candidate,
  consumers: ['general', 'notifications'].map(section => ({ file: section === 'general' ? general : notifications, section,
    path: 'SettingsPanel registered module -> original native checkbox in FormRow -> original draft/save hooks -> api.config.save(next, expected) -> ConfigOwner.edit -> ConfigStore',
    test: product, boundary: 'Actual SettingsPanel and registered module, original input and Save nodes; real temporary configuration owner and durable writes. Runtime preparation is isolated; no installed App or live Session is touched.' })),
  mutationReceipt: proofPath,
  mutations: proof.cases.map(value => ({ label: value.label, assertionRed: join(dirname(proofPath), value.log), restoredGreen: join(dirname(proofPath), value.restore.log) })),
  nativeBoundary: 'Mounted native input ref/id/name/checked/disabled and label activation are covered. Real Chromium Tab/Space, focus drawing and wide/narrow light/dark layout require the separately source-bound SettingsPanel visual receipt and independent image review.',
  stylesBoundary: 'Existing surface classes and native checkbox drawing remain with their original owners; FormRow adds no CSS or Switch role.',
  sharedTreeMutations: 0, runtimeControl: [], publicCapability: 'Existing config get/save next/expected and save feedback reused; no new business API, Store, validation fact or CLI/RPC method.' }
await mkdir(evidence, { recursive: true })
const output = join(evidence, 'qualified-receipt.json')
await writeFile(output, JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, mutants: mutations.length, receipt: output, mutationReceipt: proofPath }))
