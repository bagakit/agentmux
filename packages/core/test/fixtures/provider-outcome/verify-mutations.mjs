import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../../../..')
const evidence = resolve(root, '.bagakit/provider-outcome-mutations')
mkdirSync(evidence, { recursive: true })
const cases = [
  ['failure-is-success', 'provider-turn-outcome.test.ts', 'delivers the same failed native turn'],
  ['drop-history-outcome', 'provider-turn-outcome.test.ts', 'delivers the same failed native turn'],
  ['drop-deferred-outcome', 'provider-turn-outcome.test.ts', 'delivers the same failed native turn'],
  ['lose-suppressed-failure', 'provider-session-failure.test.ts', 'retains a suppressed historical failure']
]
for (const [mutation, file, title] of cases) {
  const loaded = resolve(evidence, mutation + '.jsonl'), report = resolve(evidence, mutation + '.json')
  rmSync(loaded, { force: true }); rmSync(report, { force: true })
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'packages/core/test/fixtures/provider-outcome/vitest.config.mts',
    'packages/core/test/' + file, '-t', title, '--reporter=json', '--outputFile=' + report], {
    cwd: root, encoding: 'utf8', env: { ...process.env, AMX_OUTCOME_MUTATION: mutation, AMX_OUTCOME_LOADED: loaded }, maxBuffer: 4 * 1024 * 1024
  })
  const facts = readFileSync(loaded, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const tests = JSON.parse(readFileSync(report, 'utf8'))
  if (result.status === 0 || result.error || !facts.some(fact => fact.mutation === mutation && fact.original !== fact.loaded) ||
    !tests.testResults.some(suite => suite.assertionResults.some(test => test.status === 'failed' && test.title.includes(title)))) {
    throw Error('Production mutation did not fail its owning assertion: ' + mutation + '\n' + result.stdout + result.stderr)
  }
  console.log('Killed production mutation: ' + mutation)
}
