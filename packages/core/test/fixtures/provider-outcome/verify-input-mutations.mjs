import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../../../..')
const evidence = resolve(root, '.bagakit/provider-input-mutations')
mkdirSync(evidence, { recursive: true })
const cases = [
  ['screen-grants-idle', 'client-submit-prompt-run-binding.test.ts', 'refuses to renew consumed automatic input authority'],
  ['reject-native-idle-queue', 'native-conversation-input.test.ts', 'admits a later saved occurrence']
]
for (const [mutation, file, title] of cases) {
  const loaded = resolve(evidence, mutation + '.jsonl'), report = resolve(evidence, mutation + '.json')
  rmSync(loaded, { force: true }); rmSync(report, { force: true })
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'packages/core/test/provider-input-boundary.config.mts',
    'packages/core/test/' + file, '-t', title, '--reporter=json', '--outputFile=' + report], {
    cwd: root, encoding: 'utf8', env: { ...process.env, AMX_INPUT_BOUNDARY_MUTATION: mutation, AMX_INPUT_BOUNDARY_LOADED: loaded }, maxBuffer: 4 * 1024 * 1024
  })
  const facts = readFileSync(loaded, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const tests = JSON.parse(readFileSync(report, 'utf8'))
  if (result.status === 0 || result.error || !facts.some(fact => fact.mutation === mutation && fact.original !== fact.loaded) ||
    !tests.testResults.some(suite => suite.assertionResults.some(test => test.status === 'failed' && test.title.includes(title)))) {
    throw Error('Production mutation did not fail its owning assertion: ' + mutation + '\n' + result.stdout + result.stderr)
  }
  console.log('Killed production mutation: ' + mutation)
}
