import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const evidence = resolve(root, '.bagakit/provider-outcome-connectors')
mkdirSync(evidence, { recursive: true })
const candidates = [
  ['positive', 'provider outcome', 8],
  ['forget-failure-reference', 'provider outcome publishes capacity', 1],
  ['failure-as-completed', 'provider outcome publishes capacity', 1],
  ['drop-failure-card', 'provider outcome keeps unknown', 1],
  ['share-raw-error', 'provider outcome keeps unknown', 1],
  ['ignore-captured-cut', 'provider outcome publishes a generic captured', 1],
  ['drop-narrow-captured-failure', 'provider outcome publishes an existing narrow', 1],
  ['drop-binding-captured-cut', 'provider outcome retains an old narrow', 1],
  ['hide-missing-captured-start', 'provider outcome retains an old narrow', 1]
]
const results = []
for (const [name, pattern, expected] of candidates) {
  const report = resolve(evidence, name + '.json'), marker = resolve(evidence, name + '.loaded.jsonl')
  rmSync(report, { force: true }); rmSync(marker, { force: true })
  const env = { ...process.env, AGENTMUX_TEST_PROVIDER_OUTCOME_LOADED: marker }
  delete env.AGENTMUX_TEST_PROVIDER_OUTCOME_MUTANT
  if (name !== 'positive') env.AGENTMUX_TEST_PROVIDER_OUTCOME_MUTANT = name
  const child = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'packages/connectors/test/provider-outcome.config.mts', '--testNamePattern', pattern, '--reporter=json', '--outputFile', report], { cwd: root, env, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
  writeFileSync(resolve(evidence, name + '.log'), child.stdout + child.stderr)
  if (child.error || child.signal) throw child.error ?? Error(name + ': child terminated ' + child.signal)
  const result = JSON.parse(readFileSync(report, 'utf8'))
  const assertions = result.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status !== 'pending' && test.status !== 'skipped')
  if (assertions.length !== expected || assertions.some(test => !test.fullName.includes(pattern))) throw Error(name + ': missing or unexpected consumer assertions')
  if (result.numRuntimeErrorTestSuites) throw Error(name + ': infrastructure failure is not a killed mutation')
  const loaded = readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  for (const path of ['packages/core/src/providers/codex-saved-history.ts', 'packages/core/src/conversation-reader.ts', 'packages/connectors/src/publication-host.ts', 'packages/connectors/src/publication-store.ts', 'packages/connectors/src/adapters/feishu/publication.ts']) {
    if (!loaded.some(row => row.path === path)) throw Error(name + ': production consumer not executed: ' + path)
  }
  const mutations = loaded.filter(row => row.mutation === name)
  if (name === 'positive' ? child.status !== 0 || result.numFailedTests !== 0 : child.status === 0 || result.numFailedTests < 1 || mutations.length === 0 || mutations.some(row => row.originalSHA256 === row.loadedSHA256)) throw Error(name + ': verification did not bear the claimed result')
  results.push({ name, status: name === 'positive' ? 'passed' : 'killed', tests: assertions.length, failed: result.numFailedTests, mutations })
  console.log(name + ': ' + results.at(-1).status)
}
writeFileSync(resolve(evidence, 'summary.json'), JSON.stringify(results, null, 2) + '\n')
