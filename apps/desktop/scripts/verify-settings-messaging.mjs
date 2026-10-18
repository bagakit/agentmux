import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const at = process.argv.indexOf('--output')
const directory = resolve(root, at >= 0 ? process.argv[at + 1] : '.bagakit/settings-expression/messaging-tests')
await mkdir(directory, { recursive: true })
const settings = 'apps/desktop/src/renderer/src/components/settings/'
const suite = 'apps/desktop/test/settings-messaging-expression.test.tsx'
const config = 'apps/desktop/scripts/fixtures/settings-messaging/vitest.config.mts'
const sha = value => createHash('sha256').update(value).digest('hex')
const mutations = [
  { id: 'a2a-draft-preview', file: settings + 'A2ASettingsPane.tsx', before: 'a2a: { notifications: draft.value }', after: 'a2a: { notifications }', test: 'A2A preview follows the effective global rule' },
  { id: 'input-prefix-preview', file: settings + 'MessageToolSettingsPane.tsx', before: "<kbd>{inputDraft.value[field.key] || 'Off'}</kbd>", after: "<kbd>{inputConfig[field.key] || 'Off'}</kbd>", test: 'User Input previews its literal prefix drafts' },
  { id: 'inapp-saved-input', file: settings + 'modules/inapp-conversation.tsx', before: 'resolveComposerInputConfig(config.messageToolCompletion)', after: 'resolveComposerInputConfig(undefined)', test: 'InApp reads saved input and appearance preferences' },
  { id: 'protocol-wire-pair', file: settings + 'modules/amux-protocols.tsx', before: '<pre>{example.wire}</pre>', after: '<pre>{entry.id}</pre>', test: 'Protocols pairs each exact original wire' },
  { id: 'shortcut-context', file: settings + 'KeyboardShortcutsPane.tsx', before: 'group.id === selectedGroup', after: 'group.id !== selectedGroup', test: 'Keyboard contexts preserve registry rows' }
]
const inputs = [suite, config,
  'apps/desktop/scripts/verify-settings-messaging.mjs',
  settings + 'modules/a2a.tsx', settings + 'modules/message-tool.tsx',
  settings + 'a2a-settings.css', settings + 'message-tool-settings.css', settings + 'inapp-conversation-settings.css',
  'apps/desktop/src/renderer/src/styles/settings-amux-protocols.css',
  'apps/desktop/src/renderer/src/styles/settings-keyboard-shortcuts.css'
]
const sources = Object.fromEntries(await Promise.all([...new Set([...mutations.map(item => item.file), ...inputs])].map(async file => [file, await readFile(resolve(root, file), 'utf8')])))
const sourceIdentity = Object.fromEntries(Object.entries(sources).map(([file, source]) => [file, sha(source)]))
const runs = []
async function run(id, mutation) {
  const report = resolve(directory, `${id}.tests.json`)
  const receipt = resolve(directory, `${id}.source.json`)
  const env = { ...process.env }
  delete env.AGENTMUX_SETTINGS_POLICY_MUTATION
  if (mutation) {
    assert.equal(sources[mutation.file].split(mutation.before).length, 2, `Unique owning source anchor: ${id}`)
    const definition = resolve(directory, `${id}.mutation.json`)
    await writeFile(definition, JSON.stringify({ ...mutation, receipt }))
    env.AGENTMUX_SETTINGS_POLICY_MUTATION = definition
  }
  const output = []
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config, suite, '--maxWorkers=1', '--reporter=json', `--outputFile.json=${report}`], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => output.push(chunk))
    child.on('error', reject); child.on('close', resolveExit)
  })
  const log = Buffer.concat(output).toString()
  await writeFile(resolve(directory, `${id}.log`), log)
  const result = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(result.testResults.length, 1, 'Exactly the product SettingsPanel suite must execute')
  assert.equal(result.numTotalTests, 5, 'Empty or partial test collections cannot qualify')
  const tests = result.testResults[0].assertionResults
  assert.equal(tests.length, 5)
  assert.equal(result.testResults[0].message, '', 'Setup or transform errors cannot qualify')
  assert.doesNotMatch(log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/)
  if (!mutation) {
    assert.equal(exitCode, 0, log)
    assert.equal(result.numPassedTests, 5)
  } else {
    assert.equal(exitCode, 1)
    assert.equal(result.numFailedTests, 1, 'Only the designated business assertion fails')
    assert.equal(result.numPassedTests, 4)
    const loaded = JSON.parse(await readFile(receipt, 'utf8'))
    assert.equal(loaded.loaded, true)
    assert.equal(loaded.before, sourceIdentity[mutation.file])
    assert.equal(loaded.after, sha(sources[mutation.file].replace(mutation.before, mutation.after)))
    assert.notEqual(loaded.before, loaded.after)
    assert.match(loaded.compiled, /^[a-f0-9]{64}$/)
    const owning = tests.filter(test => test.fullName.startsWith(mutation.test))
    assert.equal(owning.length, 1, 'The designated owning assertion must exist')
    assert.equal(owning[0].status, 'failed')
    assert.ok(owning[0].failureMessages.some(message => /AssertionError|expected .* to /su.test(message)), 'Runtime failure cannot replace an assertion failure')
  }
  runs.push({ id, passed: result.numPassedTests, failed: result.numFailedTests, exitCode, report, ...(mutation ? { sourceReceipt: receipt, expectedAssertion: mutation.test } : {}) })
  process.stdout.write(JSON.stringify(runs.at(-1)) + '\n')
}
await run('baseline')
for (const mutation of mutations) await run(mutation.id, mutation)
await run('restored')
for (const [file, digest] of Object.entries(sourceIdentity)) assert.equal(sha(await readFile(resolve(root, file))), digest, `Candidate source drift: ${file}`)
await writeFile(resolve(directory, 'receipt.json'), JSON.stringify({ passed: true, sourceDiskUnchanged: true, sourceIdentity, runs, productBoundary: 'Original SettingsPanel, module adapters, mounted drafts, save callbacks and registry/catalog readers. Native layout and visual quality require the independent product review.' }, null, 2))
