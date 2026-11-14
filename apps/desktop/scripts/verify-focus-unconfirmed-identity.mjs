import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const temporary = mkdtempSync(join(tmpdir(), 'focus-identity-proof-'))
const target = 'apps/desktop/src/renderer/src/lib/focus-source-model.ts'
const name = 'legacy unknown original member'
try {
  for (const mutation of [null, 'unconfirmed-name', 'unconfirmed-position', null]) {
    const loaded = join(temporary, `loaded-${mutation ?? Math.random()}.jsonl`)
    const env = { ...process.env, AGENTMUX_FOCUS_SOURCE_LOADED: loaded }
    if (mutation) env.AGENTMUX_FOCUS_SOURCE_MUTATION = mutation
    else delete env.AGENTMUX_FOCUS_SOURCE_MUTATION
    const args = ['exec', 'vitest', 'run', '--config', 'apps/desktop/test/vitest.focus-source-unification.config.mts', '--maxWorkers=1']
    if (mutation) args.push('-t', name)
    const run = spawnSync('pnpm', args, { cwd: root, env, encoding: 'utf8' })
    const output = run.stdout + run.stderr
    assert.ok(!run.error && run.status !== null, `Test process completed: ${run.error ?? run.signal}`)
    const sources = readFileSync(loaded, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(item => item.path === target)
    assert.ok(sources.length, 'The actual Focus source was loaded')
    if (mutation) {
      assert.notEqual(run.status, 0, 'The changed production source must fail')
      assert.match(output, mutation === 'unconfirmed-name' ? /Agent · same-original-sid/ : /Position unknown-original-position/, 'The original identity or position assertion must catch the changed source')
      assert.ok(sources.some(item => item.mutation === mutation && item.loadedSHA256 !== item.originalSHA256), 'The actual changed source was loaded')
    } else {
      assert.equal(run.status, 0, output)
      assert.match(output, /10 passed/, 'The complete source consumer suite actually ran')
      assert.ok(sources.every(item => item.loadedSHA256 === item.originalSHA256), 'The original source was loaded')
    }
    console.log(`${mutation ?? 'original'}: ${mutation ? 'detected' : 'passed'}`)
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
