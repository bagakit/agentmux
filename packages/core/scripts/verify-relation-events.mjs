import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { relationMutations } from '../test/vitest.relation-events.config.mts'

const root = resolve(import.meta.dirname, '../../..'), base = join(root, '.tmp/relation-events-proof')
await mkdir(base, { recursive: true })
const attempt = await mkdtemp(join(base, 'candidate-')), config = 'packages/core/test/vitest.relation-events.config.mts'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const known = new Map(), suite = 'packages/core/test/a2a-relation-events.test.ts', observer = 'packages/core/test/agent-message-observer.test.ts'
const original = 'packages/core/test/a2a-broadcast-events.test.ts'
for (const file of [config, 'packages/core/scripts/verify-relation-events.mjs', 'packages/core/test/fixtures/message-journal-writer.mjs',
  'packages/core/src/agentmux.ts', 'packages/core/test/helpers/source-object-cli.ts',
  'apps/desktop/scripts/fixtures/performance-failure-evidence/source-loader.mjs'])
  known.set(file, digest(await readFile(join(root, file))))
async function run(label, tests, mutation, filter) {
  const reportPath = join(attempt, label + '.json'), loaded = join(attempt, label + '.loaded.jsonl')
  await writeFile(loaded, '')
  const env = { ...process.env, AGENTMUX_RELATION_LOADED: loaded }
  delete env.AGENTMUX_RELATION_MUTATION; delete env.AGENTMUX_COLLABORATION_MUTATION; delete env.AGENTMUX_TEST_RPC_CORE_ENTRY
  if (mutation) env.AGENTMUX_RELATION_MUTATION = mutation.name
  const result = await new Promise((yes, no) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
      ...tests, ...(filter ? ['-t', filter] : []), '--reporter=json', '--outputFile=' + reportPath], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''; child.stdout.on('data', value => { log += value }); child.stderr.on('data', value => { log += value })
    child.once('error', no); child.once('close', (code, signal) => yes({ code, signal, log }))
  })
  await writeFile(join(attempt, label + '.log'), result.log)
  assert.equal(result.signal, null, label + ': interrupted')
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const assertions = report.testResults.flatMap(item => item.assertionResults)
  const executed = assertions.filter(item => item.status === 'passed' || item.status === 'failed').length
  assert.ok(assertions.some(item => item.status === 'passed' || item.status === 'failed'), label + ': no executed tests')
  for (const file of tests) assert.ok(report.testResults.some(item => resolve(item.name) === resolve(root, file) && item.assertionResults.length), label + ': missing inventory ' + file)
  const records = (await readFile(loaded, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(records.length, label + ': no loaded source evidence')
  for (const record of records) {
    const actual = digest(await readFile(join(root, record.file)))
    assert.equal(actual, record.sourceSHA256, label + ': source changed during execution ' + record.file)
    if (known.has(record.file)) assert.equal(known.get(record.file), actual, label + ': candidate changed between cases ' + record.file)
    known.set(record.file, actual)
  }
  const failed = assertions.filter(item => item.status === 'failed')
  const behaviorFailures = failed.filter(item => item.failureMessages.some(message => message.includes('AssertionError') || /__VITEST_(?:RESOLVES|REJECTS)__/u.test(message)))
  const changed = records.filter(record => record.mutation)
  if (mutation) {
    assert.ok(result.code > 0 && behaviorFailures.length > 0, label + ': mutation must fail a behavior assertion')
    assert.ok(changed.length > 0 && changed.every(record => record.mutation === mutation.name && record.file === mutation.file && record.sourceSHA256 !== record.compilerInputSHA256), label + ': target source not mutated')
  } else {
    assert.equal(result.code, 0, label + ': baseline failed; inspect retained log')
    assert.equal(failed.length, 0); assert.equal(changed.length, 0)
  }
  process.stdout.write(JSON.stringify({ label, executed, failed: failed.length }) + '\n')
  return { report: relative(root, reportPath), loaded: relative(root, loaded), executed,
    failed: failed.length, behaviorFailures: behaviorFailures.length, mutations: changed }
}
const receipt = { schema: 'agentmux.relation-events-source-proof.v1', qualified: false, compiledOrInstalled: false, mutations: [] }
try {
  receipt.baseline = await run('baseline', [suite, original])
  receipt.observationRecovery = await run('observation-recovery', [observer], undefined, 'latest event reads recover')
  // Independent private owners permit two source cases without changing the shared tree.
  for (let index = 0; index < relationMutations.length; index += 2) {
    const cases = await Promise.all(relationMutations.slice(index, index + 2).map(async mutation => ({ name: mutation.name,
      result: await run(mutation.name, mutation.name === 'event-read-restores-observation' ? [observer] : [suite], mutation,
        mutation.name === 'event-read-restores-observation' ? 'latest event reads recover' : undefined) })))
    receipt.mutations.push(...cases)
  }
  receipt.restored = await run('restored', [suite, original])
  for (const [file, sha] of known) assert.equal(digest(await readFile(join(root, file))), sha, 'Final candidate changed: ' + file)
  receipt.qualified = true
} catch (error) { receipt.failure = { message: error.message } }
finally {
  receipt.inputs = Object.fromEntries(known)
  await writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  await writeFile(join(base, 'latest.json'), JSON.stringify({ receipt: relative(root, join(attempt, 'receipt.json')) }) + '\n')
}
assert.equal(receipt.qualified, true, receipt.failure?.message)
process.stdout.write(JSON.stringify({ sourceQualified: true, compiledOrInstalled: false, receipt: relative(root, join(attempt, 'receipt.json')) }) + '\n')
