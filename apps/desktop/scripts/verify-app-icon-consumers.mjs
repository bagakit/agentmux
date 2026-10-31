import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { runProbeProcess } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..')
const installedRoot = dirname(resolve(root, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()))
const evidence = join(root, '.tmp/app-icon-consumers', randomUUID())
await mkdir(evidence, { recursive: true })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function sources(directory) {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sources(path) : /\.(?:tsx?|html)$/u.test(entry.name) ? [path] : []
  }))).flat()
}
const files = [...await sources(join(root, 'apps/desktop/src/renderer')), ...await sources(join(root, 'apps/mobile/src'))]
assert.ok(files.length > 0, 'Production consumer scan must be nonempty')
const obsolete = [], inputs = {}
for (const file of files) {
  const source = await readFile(file, 'utf8')
  if (/from\s+['"][^'"]*(?:brand\/icon-source|assets\/dragon|resources\/icon-(?:128|512))\.png['"]/u.test(source)) obsolete.push(relative(root, file))
  if (/BrandIcon|appIcon|app-icon-url/u.test(source)) inputs[relative(root, file)] = sha(source)
}
assert.deepEqual(obsolete, [], 'All original production brand bindings use the shared presentation or asset projection')
inputs['apps/host/src/theme-observation.ts'] = sha(await readFile(join(root, 'apps/host/src/theme-observation.ts')))
const runs = []
for (const name of ['baseline', 'bot', 'host-change', 'mobile-welcome', 'mobile-retain', 'missing-observation']) {
  const mutant = name !== 'baseline', reportPath = join(evidence, name + '.json'), mutationLog = join(evidence, name + '-source.txt')
  const selected = mutant ? [name === 'bot' ? 'apps/desktop/test/bot-enrollment-pane.test.tsx'
    : name === 'missing-observation' ? 'apps/desktop/test/app-brand-icon-notice.test.tsx' : 'apps/mobile/test/host-appearance.test.tsx'] : []
  const logs = []
  const execution = await runProbeProcess(process.execPath, [join(installedRoot, 'node_modules/vitest/vitest.mjs'),
    'run', '--config', 'apps/desktop/test/vitest.app-icon-consumers.config.mts', ...selected, '--reporter=json', '--outputFile', reportPath], {
    cwd: root, env: { ...process.env, ...(mutant ? { AGENTMUX_APP_ICON_CONSUMER_MUTANT: name, AGENTMUX_APP_ICON_MUTATION_LOG: mutationLog } : {}) },
    timeoutMs: 90_000, onLine: line => logs.push(line)
  })
  await writeFile(join(evidence, name + '.log'), logs.join('\n'))
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  assert.ok(report.numTotalTests > 0 && report.testResults.every(suite => suite.assertionResults.length > 0), 'No empty or failed collection may stand in for consumer evidence')
  assert.equal(execution.exitConfirmed, true)
  if (mutant) {
    assert.notEqual(execution.exitCode, 0)
    assert.ok(report.numFailedTests > 0, 'A real consumer assertion must kill the broken owner')
    assert.ok((await readFile(mutationLog, 'utf8')).trim(), 'The exact mutated source must be loaded')
  } else { assert.equal(execution.exitCode, 0, logs.join('\n')); assert.equal(report.numFailedTests, 0) }
  runs.push({ name, tests: report.numTotalTests, failed: report.numFailedTests, execution })
  console.log(name + ': ' + (mutant ? 'assertion RED' : 'PASS'))
}
for (const [file, digest] of Object.entries(inputs)) assert.equal(sha(await readFile(join(root, file))), digest, 'Consumer source remained unchanged')
await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ passed: true, evidence, scannedSources: files.length, inputs, runs,
  boundary: 'Original bot creation UI/public request and PNG bytes, Host Unix appearance watch, retained Mobile root and real MobileApp welcome. Capture and independent visual review are separate receipts; no install or remote Relay claim.' }, null, 2))
console.log(JSON.stringify({ passed: true, evidence }))
