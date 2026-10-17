import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const at = process.argv.indexOf('--output')
const directory = resolve(root, at >= 0 ? process.argv[at + 1] : '.bagakit/settings-polish/policy-verification')
await mkdir(directory, { recursive: true })
const settings = 'apps/desktop/src/renderer/src/components/settings/'
const suite = 'apps/desktop/test/settings-policy-polish.test.tsx'
const config = 'apps/desktop/scripts/fixtures/settings-policy-polish/vitest.config.mts'
const sha = value => createHash('sha256').update(value).digest('hex')
const mutations = [
  { id: 'recovery-draft', file: settings + 'ContinuitySettingsPane.tsx', before: "draft.setField('retryMaxAttempts', event.target.value)", after: "draft.setField('retryMaxAttempts', '3')", test: 'keeps recovery drafts mounted through disclosures' },
  { id: 'task-default-units', file: settings + 'AutomationDefaultsSettingsPane.tsx', before: 'Math.round(Number(value[key]) * units[key])', after: 'Math.round(Number(value[key]))', test: 'keeps quiet follow-up drafts through collapse' },
  { id: 'a2a-route', file: settings + 'modules/a2a.tsx', before: "onNavigate('notifications')", after: "onNavigate('general')", test: 'opens global Notifications from A2A' },
  { id: 'general-route', file: settings + 'modules/general.tsx', before: "onNavigate('continuity')", after: "onNavigate('general')", test: 'General links open the original recovery and Host owners' },
  { id: 'inapp-route', file: settings + 'modules/inapp-conversation.tsx', before: "onNavigate('appearance')", after: "onNavigate('general')", test: 'InApp destinations retain the original page owners' },
  { id: 'shortcut-context', file: settings + 'KeyboardShortcutsPane.tsx', before: 'group.id === selectedGroup', after: 'group.id !== selectedGroup', test: 'shortcut contexts and chord queries compose' },
  { id: 'protocol-example', file: settings + 'modules/amux-protocols.tsx', before: 'firstExample.current.open = true', after: 'firstExample.current.open = false', test: 'opens the first protocol example explicitly' },
  { id: 'duration-canonical', file: settings + 'ContinuitySettingsPane.tsx', before: '        setUnit(next)', after: "        setUnit(next); onChange('0')", test: 'duration units explain the natural default' },
  { id: 'duration-precision', file: settings + 'ContinuitySettingsPane.tsx', before: 'if (numerator % scale !== 0n) return NaN', after: 'if (false) return NaN', test: 'duration unit editing rejects sub-millisecond input' },
  { id: 'duration-conversion', file: settings + 'ContinuitySettingsPane.tsx', before: 'const value = Number(numerator / scale)', after: 'const value = Number(numerator / scale) + 1', test: 'duration units explain the natural default' }
]
const sources = Object.fromEntries(await Promise.all([...new Set(mutations.map(item => item.file))].map(async file => [file, await readFile(resolve(root, file), 'utf8')])))
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
  assert.equal(result.numTotalTests, 9, 'Empty or partial test collections cannot qualify')
  const tests = result.testResults[0].assertionResults
  assert.equal(tests.length, 9)
  assert.equal(result.testResults[0].message, '', 'Setup or transform errors cannot qualify')
  assert.doesNotMatch(log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/)
  if (!mutation) {
    assert.equal(exitCode, 0, log)
    assert.equal(result.numPassedTests, 9)
  } else {
    assert.equal(exitCode, 1)
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
  runs.push({ id, passed: result.numPassedTests, failed: result.numFailedTests, exitCode })
  process.stdout.write(JSON.stringify(runs.at(-1)) + '\n')
}
await run('baseline')
for (const mutation of mutations) await run(mutation.id, mutation)
await run('restored')
for (const [file, digest] of Object.entries(sourceIdentity)) assert.equal(sha(await readFile(resolve(root, file))), digest, `Candidate source drift: ${file}`)
await writeFile(resolve(directory, 'receipt.json'), JSON.stringify({ passed: true, sourceIdentity, runs, productBoundary: 'Original SettingsPanel, module adapters, mounted drafts, save callbacks and registry/catalog readers. Native layout and visual quality require the independent product review.' }, null, 2))
