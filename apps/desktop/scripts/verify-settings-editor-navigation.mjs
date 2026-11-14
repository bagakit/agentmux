import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { qualify } from './verify-settings-glass-prompts.mjs'

const root = resolve(import.meta.dirname, '../../..')
const args = process.argv.slice(2)
const outputIndex = args.indexOf('--output')
const output = resolve(root, outputIndex >= 0 ? args[outputIndex + 1] : '.local/state/settings-editor-navigation')
const directory = join(output, 'run-' + randomUUID())
const mode = 'settings-editor-navigation'
const script = 'apps/desktop/scripts/verify-settings-editor-navigation.mjs'
const scenario = `apps/desktop/scripts/fixtures/${mode}/scenario.cjs`
const settings = 'apps/desktop/src/renderer/src/components/settings/'
const panel = 'apps/desktop/src/renderer/src/components/SettingsPanel.tsx'
const variants = [
  { name: 'derived-loses-editor-on-shrink', file: settings + 'DerivedActionsSettingsPane.tsx', before: "onFocusCapture={() => rememberFocus('editor')}", after: 'onFocusCapture={undefined}', hits: 2, failure: 'Derived actions keeps the focused switch visible when shrinking' },
  { name: 'toolkit-loses-editor-on-shrink', file: settings + 'ToolkitSettingsPane.tsx', before: "onFocusCapture={() => rememberFocus('editor')}", after: 'onFocusCapture={undefined}', hits: 1, failure: 'Toolkit keeps the focused name visible when shrinking' },
  { name: 'search-focuses-label', file: panel, before: '? control : target', after: '? target : target', hits: 1, failure: 'Search focuses the native Display name input' },
  { name: 'search-return-loses-result', file: panel, before: 'result.focus({ preventScroll: true })', after: 'void result', hits: 1, failure: 'Returning to results focuses the exact chosen Display name result' },
  { name: 'proxy-loses-server-field-semantics', file: settings + 'BrowserProxyLibrary.tsx', before: 'invalid={Boolean(shownServerError)} error={shownServerError ?? null}', after: 'invalid={false} error={null}', hits: 1, failure: 'The invalid proxy address is explained by the Server field before saving' }
]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const options = { modes: [mode], sources: [script, scenario] }
const controlPath = join(directory, 'control')
const control = await qualify(controlPath, false, false, options)
assert.equal(control.completed, true, `Actual Settings proof failed in ${controlPath}. ${JSON.stringify(control.failure)}`)
assert.deepEqual(control.remainingPrivateProcesses, [])
assert.equal(control.privateRootRemoved, true)
const actual = JSON.parse(await readFile(join(controlPath, mode + '.json'), 'utf8'))
assert.equal(actual.surface.exact, true)
assert.deepEqual(actual.disk.agentDerivedActions.hidden, ['take-over'])
assert.equal(actual.toolkitSave.receipt.definition.name, 'Edited audit tool')
assert.equal(actual.disk.toolkit.tools[0].revision, actual.toolkitSave.receipt.definition.revision)
assert.notEqual(actual.disk.toolkit.tools[0].revision, actual.startedConfig.toolkit.tools[0].revision)
assert.deepEqual(actual.profiles.proxyAssets, [actual.proxySave.proxy])
assert.deepEqual(control.png.map(frame => frame.file), [
  'derived-editor-narrow-light.png', 'proxy-server-field-dark.png', 'search-return-narrow-light.png', 'toolkit-editor-narrow-light.png'
])
console.log(JSON.stringify({ control: controlPath, sourceIdentity: control.sourceIdentity, images: control.png.map(frame => frame.file) }))

if (!args.includes('--capture-only')) {
  const mutations = []
  for (const { name, file, before, after, hits, failure } of variants) {
    const path = join(directory, name)
    await mkdir(path, { recursive: true })
    const original = await readFile(join(root, file), 'utf8')
    assert.equal(original.split(before).length - 1, hits, `Exact source occurrences for ${name}`)
    assert.equal(hash(original), control.source[file].sha256)
    const mutated = original.replaceAll(before, after)
    const overridePath = join(path, 'override.txt')
    await writeFile(overridePath, mutated)
    const override = { originalSha256: hash(original), sha256: hash(mutated), file: overridePath }
    const receipt = await qualify(path, false, false, { ...options, sourceOverrides: { [file]: override } })
    assert.equal(receipt.completed, undefined, `Mutant must be rejected by the actual product scenario: ${name}`)
    const raw = JSON.parse(await readFile(join(path, mode + '.json'), 'utf8'))
    assert.equal(raw.failure?.name, 'AssertionError', JSON.stringify(raw.failure))
    assert.ok(raw.failure.message.includes(failure), `Wrong failure for ${name}: ${raw.failure.message}`)
    assert.equal(receipt.source[file].sha256, override.sha256)
    assert.equal(receipt.originalInputs[file].sha256, override.originalSha256)
    assert.equal(hash(await readFile(join(root, file))), override.originalSha256)
    assert.equal(receipt.privateRootRemoved, true)
    assert.deepEqual(receipt.remainingPrivateProcesses, [])
    mutations.push({ name, file, source: override.originalSha256, mutated: override.sha256, failure: raw.failure.message })
    await rm(join(path, 'compiled'), { recursive: true })
    await rm(join(path, receipt.coreDirectory), { recursive: true })
    console.log(`AssertionRED ${name}`)
  }
  await writeFile(join(directory, 'mutations.json'), JSON.stringify({ control: control.sourceIdentity, mutations }, null, 2))
}
