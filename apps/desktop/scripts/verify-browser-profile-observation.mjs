import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

assert.deepEqual(process.argv.slice(2), ['--mutations'])
const root = resolve(import.meta.dirname, '../../..')
const source = 'apps/desktop/src/main/browser-profile-observation.ts'
const suite = 'apps/desktop/test/browser-profile-activity-revisions.test.ts'
const directory = join(root, '.tmp/browser-profile-observation')
await mkdir(directory, { recursive: true })
const out = await mkdtemp(join(directory, 'attempt-'))
const config = join(out, 'vitest.config.mts')
const sha = value => createHash('sha256').update(value).digest('hex')
const original = sha(await readFile(join(root, source)))
const mutations = [
  { name: 'overlap', test: 'counts two native incarnations by union',
    before: 'observation.unionMs += Math.max(0, monotonic - observation.tick)', after: 'observation.unionMs += observation.markers.size * Math.max(0, monotonic - observation.tick)' },
  { name: 'crash-gap', test: 'keeps crash and save-failure suffixes unknown',
    before: '    observation.gaps.set(gap.id, gap)\n', after: '' },
  { name: 'idle-sampling', test: 'stops sampling after the final checkpoint is confirmed',
    before: '      if (!this.active.size) this.clearTimer()\n', after: '' }
]

await writeFile(config, `import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mergeConfig } from 'vitest/config'
import base from '../../../vitest.config'

const { before, after } = JSON.parse(process.env.PROFILE_OBSERVATION_EDIT ?? '{}')
export default mergeConfig(base, { root: ${JSON.stringify(root)}, plugins: [{
  name: 'profile-observation-proof', enforce: 'pre', transform(source, id) {
    if (id !== ${JSON.stringify(join(root, source))}) return
    if (before) assert.equal(source.split(before).length - 1, 1, 'Unique production mutation anchor')
    const code = before ? source.replace(before, after) : source
    writeFileSync(process.env.PROFILE_OBSERVATION_WITNESS, createHash('sha256').update(code).digest('hex'))
    return code === source ? undefined : { code, map: null }
  }
}], test: { cache: false, maxWorkers: 1, passWithNoTests: false } })
`)

const receipt = { passed: false, source, original, runs: [] }
async function run(name, mutation) {
  const reportPath = join(out, name + '.json'), witness = join(out, name + '.sha256')
  const args = ['exec', 'vitest', 'run', '--config', config, suite, '--reporter=json', '--outputFile', reportPath]
  if (mutation) args.push('-t', mutation.test)
  const result = spawnSync('pnpm', args, { cwd: root, encoding: 'utf8', timeout: 120_000, env: {
    ...process.env, pnpm_config_verify_deps_before_run: 'false', PROFILE_OBSERVATION_EDIT: JSON.stringify(mutation ?? {}), PROFILE_OBSERVATION_WITNESS: witness
  } })
  await writeFile(join(out, name + '.log'), (result.stdout ?? '') + (result.stderr ?? ''))
  assert.ifError(result.error)
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const loaded = await readFile(witness, 'utf8')
  assert.equal(report.testResults.length, 1)
  const tests = report.testResults[0].assertionResults.filter(value => value.status === 'passed' || value.status === 'failed')
  assert.ok(tests.length > 0 && !result.stderr.includes('Unhandled Error'))
  receipt.runs.push({ name, loaded, passed: report.numPassedTests, failed: report.numFailedTests, tests: tests.map(({ title, status }) => ({ title, status })) })
  if (mutation) {
    assert.notEqual(loaded, original)
    assert.equal(result.status, 1)
    assert.equal(tests.length, 1)
    assert.ok(tests[0].title.includes(mutation.test))
    assert.equal(tests[0].status, 'failed')
    assert.ok(tests[0].failureMessages.some(message => message.startsWith('AssertionError:')), 'An actual behavior assertion must fail')
  } else {
    assert.equal(loaded, original)
    assert.equal(result.status, 0)
    assert.equal(report.numFailedTests, 0)
  }
}

try {
  await run('baseline')
  for (const mutation of mutations) await run(mutation.name, mutation)
  await run('restored')
  receipt.passed = true
} finally {
  const receiptPath = join(out, 'receipt.json')
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, receipt: receiptPath }))
}
