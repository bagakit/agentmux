import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), evidence = join(root, '.tmp/native-application-identities')
await mkdir(evidence, { recursive: true })
// Scratch Topic roots are siblings of each fixture directory; a private parent keeps peer runs out of these identities.
const scratch = await mkdtemp(join(tmpdir(), 'amx-ids-'))
const vitest = (config, env = {}, pattern = '') => {
  const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--maxWorkers=1', ...(pattern ? ['-t', pattern] : [])],
    { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, TMPDIR: scratch, ...env } })
  if (result.error) throw result.error
  return { code: result.status, output: result.stdout + result.stderr }
}
const green = (result, count) => { assert.equal(result.code, 0, result.output); assert.match(result.output, new RegExp(`Tests\\s+${count} passed`, 'u')) }
const services = 'packages/connectors/test/vitest.application-issuer.config.mts', client = 'apps/desktop/test/native-issuer-client.config.mts'
const identityConsumers = 'keeps the same native|global native adapters|retains native identity|uses exact issuer audience|quote selection indexed candidate work'
try {
  green(vitest(services, {}, identityConsumers), 6); green(vitest(client), 6)
  const owners = [['old-parser', 'keeps the same native', /Binding data does not describe the original authorized objects/u, 1], ['lost-scope', 'keeps the same native', /AssertionError/u, 1],
    ['profile-scope', 'keeps the same native', /AssertionError/u, 1], ['intake-scope', 'keeps the same native', /AssertionError/u, 1],
    ['audience-index', 'uses exact issuer audience', /AssertionError/u, 1], ['context-index', 'quote selection indexed candidate work', /AssertionError/u, 1],
    ['grant-scope', 'retains native identity', /Application access data does not identify the original scope or operation/u, 2]]
  for (const [mutant, pattern, failure, failed] of owners) {
    const result = vitest(services, { APPLICATION_ISSUER_MUTANT: mutant }, pattern); await writeFile(join(evidence, mutant + '.log'), result.output)
    assert.notEqual(result.code, 0, result.output)
    assert.match(result.output, new RegExp('APPLICATION_ISSUER_MUTANT_LOADED: ' + mutant))
    assert.match(result.output, failure)
    assert.match(result.output, new RegExp(`Tests\\s+${failed} failed`, 'u'))
  }
  for (const mutant of ['default', 'member', 'locator', 'observation', 'removal', 'speaker', 'malformed-issuer']) {
    const loaded = join(evidence, mutant + '.loaded.jsonl'); await rm(loaded, { force: true })
    const result = vitest(client, { ISSUER_CLIENT_MUTANT: mutant, ISSUER_CLIENT_LOADED: loaded }); await writeFile(join(evidence, mutant + '.log'), result.output)
    assert.notEqual(result.code, 0, result.output)
    assert.match(result.output, /AssertionError/u)
    assert.match(result.output, /Tests\s+[1-6] failed/u)
    const records = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(records.some(record => record.mutation === mutant && record.original !== record.loaded), 'The ' + mutant + ' mutant was not loaded by the actual client consumer.')
  }
  green(vitest(services, {}, identityConsumers), 6); green(vitest(client), 6)
  console.log('6 Host/RPC/CLI/index and 6 Desktop/client native identity consumers passed; 7 owner and 7 client loaded mutants rejected; consumers restored.')
} catch (error) { await writeFile(join(evidence, 'failure.log'), String(error.stack)); throw error }
finally { await rm(scratch, { recursive: true, force: true }) }
