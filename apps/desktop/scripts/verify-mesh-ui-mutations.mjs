import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const base = process.env.AGENTMUX_MESH_UI_BASE ? resolve(process.env.AGENTMUX_MESH_UI_BASE) : resolve(root, '.local/state/mesh-network-access/ui-mutants')
mkdirSync(base, { recursive: true })
const definitions = [
  ['lost-fence', 'actual Renderer bridge and registered Main route'], ['wrong-method', 'actual Renderer bridge'],
  ['lost-draft', 'actual editor submits'], ['lost-unknown', 'lost write ACK'],
  ['relocation', 'relocates the only visible local listener'],
  ['local-only-visibility', 'relocates the only visible local listener'],
  ['incoming-scope', 'the local switch remains a draft until Save incoming connections'],
  ['independent-save', 'the local switch remains a draft until Save incoming connections'],
  ['active-removal', 'saved clean listener stops helper I/O while hidden'],
  ['readActive-removal', 'saved clean listener stops helper I/O while hidden'],
  ['static-preserve', 'uses distinct original Mote assets'],
  ['rejected-entry-retained', 'a rejected static avatar read is retried'],
]
const runId = String(Date.now()), results = []
const config = resolve(root, 'apps/desktop/test/vitest.mesh-settings.config.mts')
function execute(name, mutant, pattern) {
  const evidence = resolve(base, name, runId); mkdirSync(evidence, { recursive: true })
  const reportPath = resolve(evidence, 'report.json')
  const args = [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
    ...(pattern ? ['-t', pattern] : []), '--reporter=json', '--outputFile', reportPath]
  const env = { ...process.env, AGENTMUX_MESH_UI_EVIDENCE: evidence }
  delete env.AGENTMUX_MESH_UI_MUTANT
  if (mutant) env.AGENTMUX_MESH_UI_MUTANT = mutant
  const run = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env, timeout: pattern ? 300000 : 600000, maxBuffer: 8 * 1024 * 1024 })
  writeFileSync(resolve(evidence, 'test.log'), run.stdout + run.stderr)
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null
  const tests = report?.testResults.flatMap(suite => suite.assertionResults) ?? []
  const failed = tests.filter(test => test.status === 'failed')
  const hits = existsSync(resolve(evidence, 'mutation.jsonl'))
    ? readFileSync(resolve(evidence, 'mutation.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  const consumed = existsSync(resolve(evidence, 'consumed.jsonl'))
    ? readFileSync(resolve(evidence, 'consumed.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length : 0
  const uniqueHits = [...new Map(hits.map(hit => [[hit.mutant, hit.path, hit.before, hit.after].join(':'), hit])).values()]
  const semanticRed = failed.some(test => (!pattern || test.fullName.includes(pattern)) && test.failureMessages.some(message =>
    /AssertionError/u.test(message) && !/Test timed out|Failed to resolve import|SyntaxError|No test files found/u.test(message)))
  const passed = mutant
    ? run.status === 1 && !run.error && report?.numTotalTests > 0 && uniqueHits.length === 1 && uniqueHits[0].mutant === mutant && uniqueHits[0].before !== uniqueHits[0].after && semanticRed
    : run.status === 0 && !run.error && report?.success === true && report.numTotalTests > 0 && report.numFailedTests === 0 && hits.length === 0 && consumed > 0
  const result = { name, mutant, pattern, passed, exitCode: run.status, totalTests: report?.numTotalTests ?? 0,
    failedTests: report?.numFailedTests ?? 0, semanticRed, consumed, hits: uniqueHits, rawHitCount: hits.length, evidence }
  results.push(result); writeFileSync(resolve(base, 'proof.json'), JSON.stringify({ passed: results.every(row => row.passed), results }, null, 2))
  console.log(JSON.stringify({ name, passed, exitCode: run.status, tests: result.totalTests, failed: result.failedTests, uniqueChanges: uniqueHits.length, semanticRed }))
  if (!passed) throw Error('Mesh UI mutation gate failed: ' + name)
}
execute('control-green', '', '')
for (const [mutant, pattern] of definitions) execute(mutant, mutant, pattern)
execute('restored-green', '', '')
writeFileSync(resolve(base, 'proof.json'), JSON.stringify({ passed: true, results }, null, 2))
process.stdout.write(JSON.stringify({ passed: true, mutants: definitions.length, controls: 2 }) + '\n')
