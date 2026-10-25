import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const evidence = resolve(root, '.tmp/provider-outcome-ui')
await mkdir(evidence, { recursive: true })
const receipts = []
for (const mutation of [null, 'drop-card', 'fold-failure', 'replace-original-message', 'lose-deferred-outcome']) {
  const name = mutation ?? 'baseline', loaded = resolve(evidence, name + '-loaded.jsonl')
  await writeFile(loaded, '')
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'packages/client-ui/test/provider-outcome.config.mts'], {
    cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, AGENTMUX_OUTCOME_UI_MUTATION: mutation ?? '', AGENTMUX_OUTCOME_UI_LOADED: loaded }
  })
  if (result.error) throw result.error
  const output = result.stdout + result.stderr
  await writeFile(resolve(evidence, name + '.log'), output)
  const sources = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(sources.some(source => source.path === 'packages/core/src/providers/codex-saved-history.ts'), 'Real Provider history must execute')
  assert.ok(sources.some(source => source.path === 'packages/client-ui/src/components/ConversationView.tsx'), 'Real shared product consumer must execute')
  if (!mutation) { assert.equal(result.status, 0, output); assert.match(output, /4 passed/u) }
  else {
    assert.equal(sources.filter(source => source.mutation === mutation).length, 1, 'Exactly one loaded source must carry the mutation')
    assert.notEqual(result.status, 0, 'Mutation survived: ' + mutation)
    assert.match(output, /Tests\s+\d+ failed/u, 'Mutation must fail a collected test')
    assert.match(output, /AssertionError|expected .* to/u, 'Mutation must fail a behavior assertion')
  }
  receipts.push({ mutation, status: result.status, loaded: relative(root, loaded) })
  console.log(name + ': ' + (mutation ? 'killed' : 'passed'))
}
await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify({ passed: true, receipts }, null, 2) + '\n')
