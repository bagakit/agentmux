import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const index = process.argv.indexOf('--out')
const out = resolve(index < 0 ? (".tmp/browser-task-branch-mutations-" + (globalThis.crypto.randomUUID()) + "") : process.argv[index + 1])
mkdirSync(out, { recursive: true })
const only = process.argv.indexOf('--only')
const branchTests = [
  ['branch-empty-observation', 'empty returned nodes cannot manufacture'],
  ['branch-selected-save-navigation', 'rechecks navigation after the chosen action'],
  ['branch-unknown-chooses-false', 'unknown/incomplete/empty observation'],
  ['branch-unbound-result', 'rejects a condition result from another'],
  ['branch-late-navigation', 'late navigation/owner loss'],
  ['branch-back-edge', 'rejects back edges'],
  ['branch-unreachable', 'rejects back edges'],
  ['branch-budget', 'rejects back edges'],
  ['branch-run-budget', 'enforces the existing run'],
  ['branch-native-stale-document', 'actual Main dispatcher refuses'],
  ['branch-public-path-unbound', 'public task result requires']
]
const scope = process.argv.indexOf('--scope')
const tests = [
  ['cli-drops-fresh-parameters', 'positive public CLI run'],
  ['control-approves-human-wait', 'Agent cannot approve'],
  ['control-takes-human-input', 'control does not take input'],
  ['unbound-version-history', 'deduplicates only exact-version'],
  ['empty-terminal-samples', 'rejects mismatched identities'],
  ['nonfinite-rate', 'rejects mismatched identities'],
  ['wrong-public-target', 'real public client refuses reliability'],
  ...branchTests
]
const sha = value => createHash('sha256').update(value).digest('hex')
const rows = []
function run(name, pattern, mutation) {
  const loaded = resolve(out, `${name}.loaded.jsonl`)
  const args = ['exec', 'vitest', 'run', '--config', 'apps/desktop/scripts/fixtures/browser-task-branch/vitest.owning.config.mts', '--maxWorkers=1', '-t', pattern]
  const env = { ...process.env, PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false', AGENTMUX_BROWSER_TASK_LOADED: loaded }
  if (mutation) env.AGENTMUX_BROWSER_TASK_MUTATION = mutation
  else delete env.AGENTMUX_BROWSER_TASK_MUTATION
  const result = spawnSync('pnpm', args, { env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(resolve(out, `${name}.stdout.log`), result.stdout ?? '')
  writeFileSync(resolve(out, `${name}.stderr.log`), result.stderr ?? '')
  const sources = readFileSync(loaded, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.ok(sources.length > 0, 'Actual loaded Source evidence is nonempty')
  const changed = sources.filter(row => mutation && row.mutation === mutation && row.sha256 !== row.loadedSha256)
  if (mutation) {
    assert.ok(changed.length > 0, 'The actual production Source block was loaded changed')
    assert.notEqual(result.status, 0, 'Changed implementation must be RED')
    assert.match((result.stdout ?? '') + (result.stderr ?? ''), /AssertionError/, 'RED must be a semantic assertion, not a bootstrap/hash failure')
  } else assert.equal(result.status, 0, 'Original Source is restored GREEN')
  const row = { name, command: ['pnpm', ...args], mutation: mutation ?? null, exitCode: result.status,
    loadedPath: loaded, loadedSha256: sha(readFileSync(loaded)), changed }
  rows.push(row)
  writeFileSync(resolve(out, 'progress.json'), JSON.stringify({ scope: 'source-control-guards', rows }, null, 2) + '\n')
  process.stdout.write(`${name}: ${mutation ? 'Assertion RED' : 'restored GREEN'}\n`)
}
const candidates = scope >= 0 && process.argv[scope + 1] === 'branch' ? branchTests : tests
const selected = only < 0 ? candidates : tests.filter(([key]) => process.argv[only + 1].split(',').includes(key))
assert.ok(selected.length > 0, 'Selected Source mutations must be nonempty')
for (const [key, pattern] of selected) { run(key, pattern, key); run(`${key}-restored`, pattern) }
writeFileSync(resolve(out, 'receipt.json'), JSON.stringify({ schema: 'agentmux.browser-task-source-mutations.v1', scope: scope >= 0 ? 'bounded-task-branch-guards' : 'public-task-control-and-branch',
  passed: true, native: 'not-tested', rows }, null, 2) + '\n')
