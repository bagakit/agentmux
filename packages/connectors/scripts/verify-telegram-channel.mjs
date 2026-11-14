import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'), evidence = join(root, '.tmp/telegram-channel')
await mkdir(evidence, { recursive: true })
const scratch = await mkdtemp(join(tmpdir(), 'amxtg-'))
const run = (config, pattern, env = {}) => {
  const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--maxWorkers=1', '-t', pattern], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, TMPDIR: scratch, ...env } })
  if (result.error) throw result.error
  return { code: result.status, output: result.stdout + result.stderr }
}
const green = (result, count) => { assert.equal(result.code, 0, result.output); assert.match(result.output, new RegExp(`Tests\\s+${count} passed`, 'u')) }
const native = 'packages/connectors/test/vitest.telegram.config.mts', ui = 'apps/desktop/test/vitest.telegram-settings.config.mts'
const consumers = 'Telegram|source-boundary refusal|default (feishu|discord) ingress retains'
try {
  const baseline = run(native, consumers); await writeFile(join(evidence, 'baseline.log'), baseline.output); green(baseline, 11)
  const settings = run(ui, '.*'); await writeFile(join(evidence, 'settings.log'), settings.output); green(settings, 4)
  for (const [mutant, pattern] of [
    ['identity', 'checks distinguish'], ['proof', 'default Telegram registration'], ['custody', 'default Telegram registration'],
    ['boundary', 'pending pre-connection'], ['sharing', 'source-boundary refusal'], ['facts', 'source-boundary refusal'],
    ['page', 'full native page'], ['credentials', 'compiled CLI'], ['recipient', 'default Telegram registration']
  ]) {
    const result = run(native, pattern, { TELEGRAM_MUTANT: mutant }); await writeFile(join(evidence, mutant + '.log'), result.output)
    assert.notEqual(result.code, 0, result.output)
    assert.match(result.output, new RegExp('TELEGRAM_MUTANT_LOADED: ' + mutant))
    assert.match(result.output, /AssertionError/u); assert.match(result.output, /Tests\s+1 failed/u)
  }
  const isolation = run(ui, 'Telegram library isolates', { TELEGRAM_SETTINGS_MUTANT: 'platform-isolation' }); await writeFile(join(evidence, 'platform-isolation.log'), isolation.output)
  assert.notEqual(isolation.code, 0, isolation.output); assert.match(isolation.output, /TELEGRAM_SETTINGS_MUTANT_LOADED: platform-isolation/u)
  assert.match(isolation.output, /AssertionError/u); assert.match(isolation.output, /Tests\s+1 failed/u)
  const restored = run(native, consumers); await writeFile(join(evidence, 'restored.log'), restored.output); green(restored, 11)
  const restoredSettings = run(ui, '.*'); await writeFile(join(evidence, 'settings-restored.log'), restoredSettings.output); green(restoredSettings, 4)
  console.log('11 native/common/compiled CLI and 4 Settings/Hosted consumers passed; 9 native owner and 1 actual Settings loaded mutants rejected; consumers restored.')
} catch (error) { await writeFile(join(evidence, 'failure.log'), String(error.stack)); throw error }
finally { await rm(scratch, { recursive: true, force: true }) }
