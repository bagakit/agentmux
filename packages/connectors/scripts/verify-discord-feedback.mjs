import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

const root = resolve(import.meta.dirname, '../../..'), evidence = join(root, '.tmp/discord-feedback')
await mkdir(evidence, { recursive: true })
const run = (pattern, mutant) => {
  const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'packages/connectors/test/vitest.discord.config.mts', '--maxWorkers=1', ...(pattern ? ['-t', pattern] : [])], {
    cwd: root, encoding: 'utf8', maxBuffer: 6 * 1024 * 1024, env: { ...process.env, DISCORD_MUTANT: mutant ?? '' }
  })
  if (result.error) throw result.error
  return { code: result.status, output: result.stdout + result.stderr }
}
const green = (result, minimum) => {
  assert.equal(result.code, 0, result.output)
  assert.ok(Number(result.output.match(/Tests\s+(\d+) passed/u)?.[1]) >= minimum, result.output)
}
try {
  const baseline = run(); await writeFile(join(evidence, 'baseline.log'), baseline.output); green(baseline, 26)
  for (const [mutant, pattern] of [['reply-metadata', 'default Discord reply metadata'], ['query-feedback', 'default Discord processing feedback']]) {
    const red = run(pattern, mutant); await writeFile(join(evidence, mutant + '.log'), red.output)
    assert.notEqual(red.code, 0, red.output)
    assert.match(red.output, new RegExp('DISCORD_LOADED_MUTANT:' + mutant))
    assert.match(red.output, /AssertionError/u)
    green(run(pattern), 1)
  }
  console.log('26 real Discord consumers passed; reply metadata and native feedback mutants rejected; original consumers restored. Account-backed visual acceptance remains separate.')
} catch (error) { await writeFile(join(evidence, 'failure.log'), String(error.stack)); throw error }
