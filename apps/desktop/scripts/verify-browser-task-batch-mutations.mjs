import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const out = resolve(argument('--out') ?? (".tmp/browser-task-batch-mutations-" + (globalThis.crypto.randomUUID()) + ""))
mkdirSync(out, { recursive: true })
const subjects = [
  ['batch-cli-input-shape', 'actual public batch CLI refuses empty or extra-field'],
  ['batch-active-preparation-projection', 'Stop during preparation cancels the group'],
  ['batch-active-public-binding', 'actual public client rejects reordered items'],
  ['batch-grouped-run-owner', 'original grouped run cannot be continued'],
  ['batch-grouped-human-owner', 'original UI run entry cannot approve'],
  ['batch-single-ui-escape', 'real AssetEditor mounts batch input'],
  ['batch-item-secret', 'refuses changed item order and per-item secrets'],
  ['batch-original-binding', 'binds every returned item report'],
  ['batch-unknown-next-item', 'unknown condition retains the original item cursor'],
  ['batch-repeat-human-intent', 'a new person takeover between batch items'],
  ['batch-preparation-stop', 'Stop during preparation cancels the group'],
  ['batch-lease-gap', 'holds the existing Browser execution lease'],
  ['batch-aggregate-ops', 'aggregate operation budget stops at 256'],
  ['batch-aggregate-time', 'remaining aggregate time travels'],
  ['batch-cost-projection', 'in-flight original operation and uncertain elapsed time'],
  ['batch-public-item-order', 'actual public client rejects reordered items'],
  ['batch-public-cost-binding', 'actual public client rejects reordered items'],
  ['batch-transient-values', 'runs each explicit item exactly once'],
  ['batch-ui-secret-clear', 'invokes the saved version with two actual item inputs'],
  ['batch-ui-item-budget', 'will not expand past 16 items'],
  ['batch-editor-mount', 'real AssetEditor mounts batch input'],
  ['batch-cli-drops-items', 'actual public batch CLI forwards each fresh value']
]
const selected = argument('--only') ? subjects.filter(([name]) => argument('--only').split(',').includes(name)) : subjects
assert.ok(selected.length > 0, 'Actual batch Source mutation selection is nonempty')
const rows = [], sha = bytes => createHash('sha256').update(bytes).digest('hex')
function run(name, pattern, mutation) {
  const loaded = resolve(out, `${name}.loaded.jsonl`)
  const args = ['exec', 'vitest', 'run', '--config', 'apps/desktop/scripts/fixtures/browser-task-batch/vitest.owning.config.mts', '--maxWorkers=1', '-t', pattern]
  const env = { ...process.env, PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false', AGENTMUX_BROWSER_TASK_LOADED: loaded }
  if (mutation) env.AGENTMUX_BROWSER_TASK_MUTATION = mutation
  else delete env.AGENTMUX_BROWSER_TASK_MUTATION
  const result = spawnSync('pnpm', args, { env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(resolve(out, `${name}.stdout.log`), result.stdout ?? '')
  writeFileSync(resolve(out, `${name}.stderr.log`), result.stderr ?? '')
  const sources = readFileSync(loaded, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.ok(sources.length > 0, 'Actual loaded product Source is nonempty')
  const changed = sources.filter(row => mutation && row.mutation === mutation && row.sha256 !== row.loadedSha256)
  if (mutation) {
    assert.ok(changed.length > 0, 'Actual product Source semantic block loaded changed')
    assert.notEqual(result.status, 0, 'Changed implementation must be RED')
    assert.match((result.stdout ?? '') + (result.stderr ?? ''), /AssertionError/, 'RED is the target semantic assertion, not a bootstrap/hash error')
  } else assert.equal(result.status, 0, 'Restored original Source must be GREEN')
  rows.push({ name, command: ['pnpm', ...args], mutation: mutation ?? null, exitCode: result.status, loadedPath: loaded,
    loadedSha256: sha(readFileSync(loaded)), changed })
  writeFileSync(resolve(out, 'progress.json'), JSON.stringify({ scope: 'bounded-task-batch-source', rows }, null, 2) + '\n')
  process.stdout.write(`${name}: ${mutation ? 'Assertion RED' : 'restored GREEN'}\n`)
}
for (const [name, pattern] of selected) { run(name, pattern, name); run(`${name}-restored`, pattern) }
writeFileSync(resolve(out, 'receipt.json'), JSON.stringify({ schema: 'agentmux.browser-task-source-mutations.v1', scope: 'bounded-task-batch-source', passed: true,
  native: 'not-tested', rows }, null, 2) + '\n')
