import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { qualify } from './verify-settings-glass-prompts.mjs'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const args = process.argv.slice(2)
const outputIndex = args.indexOf('--output')
const output = resolve(root, outputIndex >= 0 && args[outputIndex + 1] ? args[outputIndex + 1] : '.bagakit/feature-tracker/verify/settings-inputs-workflows')
assert.ok(!(args.includes('--mutations-only') && args.includes('--capture-only')), 'Choose one proof mode')
const mode = 'settings-inputs-workflows'
const name = 'run-' + randomUUID()
const scenario = 'apps/desktop/scripts/fixtures/settings-inputs-workflows/scenario.cjs'
const settings = 'apps/desktop/src/renderer/src/components/settings/'
const tests = ['apps/desktop/test/settings-inputs-workflows.test.tsx', 'apps/desktop/test/settings-form-rows.test.tsx']
const owningConfig = 'apps/desktop/test/settings-inputs-workflows.config.mts'
const variants = [
  { label: 'profile-discards-edit', file: settings + 'ProfileSettingsPane.tsx',
    before: "onChange={event => draft.setField('displayName', event.currentTarget.value)}", after: 'onChange={undefined}' },
  { label: 'prompt-search-discards-query', file: settings + 'ShortcutSettingsPane.tsx',
    before: 'value={query} onValueChange={setQuery}', after: 'value={query} onValueChange={() => {}}' },
  { label: 'notes-loses-error-description', file: settings + 'NotesSettingsPane.tsx',
    before: 'aria-describedby={`${fontId}-hint`}', after: 'aria-describedby={undefined}' },
  { label: 'switch-loses-native-accessible-role', file: 'packages/client-ui/src/input/Switch.tsx',
    before: 'role="switch"', after: 'role="checkbox"' }
]

if (!args.includes('--capture-only')) {
  await verifyRendererSourceMutations({
    name: name + '-mutations', evidenceRoot: output, tests, owningConfig, mutations: variants,
    sources: [...new Set([
      ...variants.map(item => item.file), 'apps/desktop/src/renderer/src/components/SettingsPanel.tsx',
      settings + 'modules/notes.tsx', settings + 'modules/profile.tsx', settings + 'modules/prompts.tsx',
      settings + 'GeneralSettingsPane.tsx', settings + 'NotificationSettingsPane.tsx',
      'packages/client-ui/src/input/NativeSelect.tsx', 'packages/client-ui/src/input/SearchInput.tsx',
      'apps/desktop/test/helpers/config-owner-fixture.ts', 'apps/desktop/src/main/config-owner.ts', 'apps/desktop/src/main/config-store.ts'
    ])]
  })
}

if (!args.includes('--mutations-only')) {
  const directory = join(output, name, 'electron')
  const receipt = await qualify(directory, false, false, { modes: [mode],
    sources: [scenario, 'apps/desktop/scripts/verify-settings-inputs-workflows.mjs'] })
  assert.equal(receipt.completed, true, `Actual Settings proof failed. Inspect ${directory}. ${JSON.stringify(receipt.failure)}`)
  assert.deepEqual(receipt.remainingPrivateProcesses, [])
  assert.equal(receipt.privateRootRemoved, true)
  const actual = JSON.parse(await readFile(join(directory, mode + '.json'), 'utf8'))
  assert.deepEqual(Object.keys(actual.workflowControls), ['profile', 'appearance', 'prompts', 'toolkit', 'channels', 'space', 'notes', 'automation'])
  assert.ok(receipt.png.length >= 9 && receipt.sourceIdentity)
  console.log(JSON.stringify({ directory, sourceIdentity: receipt.sourceIdentity, images: receipt.png.map(frame => frame.file) }))
}
