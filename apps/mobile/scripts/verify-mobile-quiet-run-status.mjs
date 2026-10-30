import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../../..')
const output = resolve(root, process.argv[2] ?? `.local/state/mobile-quiet-run-status/gate-${Date.now()}`)
mkdirSync(output, { recursive: true })
const sourceFiles = ['src/navigation/mobile-agent-status.ts', 'src/navigation/MobileAgentStatusDetails.tsx', 'src/navigation/agent-status.css',
  'src/navigation/MobileSpatialNavigation.tsx', 'src/navigation/MobileMoteTeam.tsx', 'src/navigation/MobileAgentRow.tsx',
  'src/conversation/MobileAgentActions.tsx', 'src/MobileApp.tsx', 'test/mobile-quiet-run-status.test.tsx', 'test/mobile-quiet-run-status.config.mts',
  'scripts/verify-mobile-quiet-run-status.mjs'].map(file => 'apps/mobile/' + file)
const hash = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')
const source = Object.fromEntries(sourceFiles.map(file => [file, hash(file)]))
const mutations = {
  'show-unknown': 'quiets ordinary unknown text and glyph', attention: 'quiets ordinary unknown text and glyph',
  request: 'keeps original Team reasons', 'team-visible': 'keeps original Team reasons',
  'missing-details': 'healthy Team members with missing presentation',
  'menu-presentation': 'actual App menu retains the original reason', 'menu-refresh': 'actual App menu retains the original reason',
  'app-source': 'actual App menu retains the original reason', 'details-source': 'keeps original Team reasons',
  'menu-fence': 'actual App stale menu source', 'refresh-visible': 'actual App menu retains the original reason',
  'directory-fence': 'an original row menu refresh cannot be lent'
}
const receipt = { passed: false, source, boundary: 'Actual mounted MobileApp / directory / Team / menu consumers with controlled public SDK and parsed catalog facts. Loaded in-process production mutations; no physical phone, live Host, lifecycle/recovery, package or install claim.', runs: [] }
function run(name, target) {
  const trace = resolve(output, name + '-loaded.jsonl'), report = resolve(output, name + '.json'), log = resolve(output, name + '.log')
  const env = { ...process.env, AGENTMUX_MOBILE_QUIET_TRACE: trace }
  delete env.AGENTMUX_MOBILE_QUIET_MUTATION
  if (target) env.AGENTMUX_MOBILE_QUIET_MUTATION = name
  const result = spawnSync(process.execPath, [resolve(root, 'apps/mobile/node_modules/vitest/vitest.mjs'), 'run', '--config',
    resolve(root, 'apps/mobile/test/mobile-quiet-run-status.config.mts'), '--reporter=json', '--outputFile=' + report],
  { cwd: root, env, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024 })
  writeFileSync(log, (result.stdout ?? '') + (result.stderr ?? ''))
  assert.ifError(result.error)
  const tests = JSON.parse(readFileSync(report, 'utf8'))
  assert.equal(tests.numTotalTests, 8, 'Exact nonempty mounted consumer matrix executed')
  assert.equal(tests.numPendingTests, 0, 'No consumer assertion skipped')
  assert.equal(tests.numRuntimeErrorTestSuites ?? 0, 0, 'No import/transform/runtime infrastructure failure')
  const records = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const evaluated = records.filter(record => record.phase === 'evaluated')
  assert.ok(evaluated.length >= 7, 'The actual product consumer modules evaluated')
  if (target) {
    assert.equal(result.status, 1, 'Loaded mutant must fail the original consumer assertions')
    assert.ok(tests.numFailedTests > 0)
    const failures = tests.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
    assert.ok(failures.some(test => test.fullName.includes(target) && test.failureMessages.some(message => /AssertionError|expected/.test(message))), 'Expected behavioral assertion killed this mutant')
    assert.ok(evaluated.some(record => record.name === name && record.applied && record.originalSha256 !== record.loadedSha256), 'Mutated production source really evaluated')
  } else {
    assert.equal(result.status, 0)
    assert.equal(tests.numPassedTests, 8)
    assert.equal(tests.numFailedTests, 0)
  }
  const actual = [...new Map(evaluated.map(record => [record.file, record])).values()]
  const entry = { name, exitCode: result.status, total: tests.numTotalTests, passed: tests.numPassedTests, failed: tests.numFailedTests,
    mutated: actual.filter(record => record.applied), report, log, trace }
  receipt.runs.push(entry)
  console.log(JSON.stringify({ name, passed: entry.passed, failed: entry.failed, evaluated: actual.length }))
}
try {
  run('baseline')
  for (const [name, target] of Object.entries(mutations)) run(name, target)
  run('restored')
  for (const [file, digest] of Object.entries(source)) assert.equal(hash(file), digest, 'Production/test source retained during loaded mutation gate: ' + file)
  receipt.passed = true
} finally {
  writeFileSync(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(resolve(output, 'receipt.json'))
