import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runProbeProcess } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..')
const output = resolve(root, '.tmp/settings-access-expression', randomUUID())
const settings = 'apps/desktop/src/renderer/src/components/settings/'
const mutations = [
  { id: 'browser-reason', file: 'apps/desktop/src/renderer/src/components/browser/BrowserResources.tsx', before: '{directory.notice}</p>', after: '{"Unavailable"}</p>', test: 'Browser summarizes a failed observation' },
  { id: 'host-return', file: settings + 'HostSettingsPane.tsx', before: 'onClick={backToLibrary}', after: 'onClick={() => {}}', test: 'Hosts returns from the compact toolbar' },
  { id: 'host-return-context', file: settings + 'HostSettingsPane.tsx', before: "view === 'editor' && <button type=\"button\" className=\"settings-resource-back", after: 'true && <button type="button" className="settings-resource-back', test: 'Hosts returns from the compact toolbar' },
  { id: 'mobile-previous', file: settings + 'DeviceManagementSettings.tsx', before: "readIssue ? ' · last observed' : ''", after: "''", test: 'Mobile keeps the original device record' }
]
const files = [...new Set([...mutations.map(item => item.file), settings + 'BrowserSettingsPane.tsx', settings + 'RetainedBrowserUploads.tsx',
  settings + 'browser-settings.css', settings + 'mobile-settings.css', 'apps/desktop/src/renderer/src/styles/remote-management.css',
  'apps/desktop/test/settings-connectivity-presentation.test.tsx', 'apps/desktop/scripts/fixtures/settings-access-expression/vitest.config.mts'])]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const source = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(resolve(root, file)))])))
await mkdir(output, { recursive: true })
const runs = []
for (const mutation of [null, ...mutations, null]) {
  const id = mutation?.id ?? (runs.length ? 'restored' : 'baseline')
  const directory = resolve(output, id)
  await mkdir(directory)
  const env = { ...process.env }
  delete env.AGENTMUX_SETTINGS_ACCESS_MUTATION
  if (mutation) {
    env.AGENTMUX_SETTINGS_ACCESS_MUTATION = resolve(directory, 'mutation.json')
    await writeFile(env.AGENTMUX_SETTINGS_ACCESS_MUTATION, JSON.stringify({ ...mutation, receipt: resolve(directory, 'source.jsonl') }))
  }
  const log = []
  const execution = await runProbeProcess(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config',
    'apps/desktop/scripts/fixtures/settings-access-expression/vitest.config.mts', '--reporter=json', '--outputFile=' + resolve(directory, 'tests.json')],
    { cwd: root, env, temporaryRoot: directory, timeoutMs: 90000, onLine: line => log.push(line) })
  await writeFile(resolve(directory, 'test.log'), log.join('\n'))
  const report = JSON.parse(await readFile(resolve(directory, 'tests.json'), 'utf8'))
  assert.equal(execution.timedOut, false)
  assert.equal(report.numTotalTests, 4)
  assert.equal(report.testResults.length, 1)
  assert.equal(report.testResults[0].message, '', 'Load failure cannot qualify')
  assert.equal(report.testResults[0].assertionResults.length, 4)
  if (mutation) {
    assert.equal(execution.exitCode, 1)
    const loaded = (await readFile(resolve(directory, 'source.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].original, source[mutation.file])
    assert.notEqual(loaded[0].original, loaded[0].consumed)
    const owning = report.testResults[0].assertionResults.filter(test => test.fullName.startsWith(mutation.test))
    assert.equal(owning.length, 1)
    assert.equal(owning[0].status, 'failed')
    assert.ok(owning[0].failureMessages.some(message => /AssertionError|expected .* to /su.test(message)))
  } else {
    assert.equal(execution.exitCode, 0, log.join('\n'))
    assert.equal(report.numPassedTests, 4)
    assert.equal(report.numFailedTests, 0)
  }
  runs.push({ id, execution, ...(mutation ? { mutation } : {}) })
  console.log(JSON.stringify({ id, assertionRed: !!mutation, evidence: directory }))
}
for (const [file, digest] of Object.entries(source)) assert.equal(sha(await readFile(resolve(root, file))), digest, 'Candidate source unchanged')
await writeFile(resolve(output, 'receipt.json'), JSON.stringify({ passed: true, source, runs,
  boundary: 'Production SettingsPanel, original module adapters, draft and observation consumers. Does not prove native layout, external services or installation.' }, null, 2))
console.log(JSON.stringify({ passed: true, receipt: resolve(output, 'receipt.json') }))
