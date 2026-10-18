import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const directory = resolve(root, '.local/channel-protocol/t6-question-mutations')
mkdirSync(directory, { recursive: true })
const compiled = resolve(root, 'packages/connectors/dist/conversation-actions.js')
const ownerDigest = createHash('sha256').update(readFileSync(compiled)).digest('hex')
const cases = [
  { name: 'baseline' },
  { name: 'permission-grant-answers', pattern: 'permission grants do not authorize answers' },
  { name: 'changed-original-option', pattern: 'default Desktop and authenticated Feishu form answer' }
]
const results = []
for (const item of cases) {
  const output = resolve(directory, item.name + '.json')
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', 'packages/connectors/test/feishu-question-actions.test.ts', '--maxWorkers=1',
    '--reporter=json', '--outputFile=' + output, ...(item.pattern ? ['--testNamePattern', item.pattern] : [])], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, pnpm_config_verify_deps_before_run: 'false', AGENTMUX_TEST_QUESTION_ACTION_MUTANT: item.name === 'baseline' ? '' : item.name }
  })
  writeFileSync(resolve(directory, item.name + '.log'), result.stdout + result.stderr)
  if (result.error) throw result.error
  const report = JSON.parse(readFileSync(output, 'utf8'))
  const assertions = report.testResults.flatMap(test => test.assertionResults).filter(test => test.status === 'passed' || test.status === 'failed')
  if (!assertions.length) throw Error(item.name + ': no product consumer ran')
  if (item.name === 'baseline' ? result.status !== 0 || report.numFailedTests !== 0 :
    result.status === 0 || report.numFailedTests < 1 || !result.stderr.includes(`[loaded-question-mutant:${item.name}:ConversationActions]`))
    throw Error(item.name + ': baseline or loaded semantic mutation was not verified; inspect ' + output)
  results.push({ name: item.name, executed: assertions.length, failed: report.numFailedTests, loadedOwner: 'ConversationActions', ownerDigest })
  process.stdout.write(item.name + ': ' + assertions.length + ' consumer(s), ' + report.numFailedTests + ' failure(s)\n')
}
writeFileSync(resolve(directory, 'receipt.json'), JSON.stringify({ boundary: 'Default Desktop, official SDK callback, authenticated Hosted and original Core native question transaction; only native/SDK I/O ports controlled.', results }, null, 2) + '\n')
