import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2)
const at = args.indexOf('--output'), output = path.resolve(root, at < 0 ? `.tmp/probe-cleanup-observation/${randomUUID()}` : args[at + 1])
await fs.mkdir(output, { recursive: true })
await fs.rm(path.join(output, 'receipt.json'), { force: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const names = { probe: 'apps/desktop/scripts/probe-process.mjs', cases: 'apps/desktop/test/probe-process-identity.test.ts' }
const sourceFiles = [...Object.values(names), 'apps/desktop/scripts/lib/fixture-values.mjs',
  'apps/desktop/scripts/fixtures/settings-overview/vitest.config.mts', 'apps/desktop/scripts/verify-probe-cleanup-observation.mjs']
const pins = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, sha(await fs.readFile(path.join(root, file)))])))
const before = await pins(), text = Object.fromEntries(await Promise.all(Object.entries(names).map(async ([key, file]) => [key, await fs.readFile(path.join(root, file), 'utf8')])))
const unknownTest = 'private probe cleanup identity keeps a persistent unknown PID explicit and never signals it after the bounded reobservation'
const variants = [
  { id: 'missing-reobservation', owner: 'probe', before: 'Date.now() < observationDeadline', after: 'false', count: 1,
    test: 'private probe cleanup identity reobserves the exact transient exiting PID until a real Zombie without signalling unknown state' },
  { id: 'signal-unknown', owner: 'probe', before: '/^[RSDTIUWZ]/', after: '/^\\S/', count: 2, test: unknownTest },
  { id: 'unknown-as-absent', owner: 'probe', before: 'await delay(50)\n    return await recheckOwnedProbeProcess(pid, temporaryRoot, name, groupId, observationDeadline)',
    after: 'return false', count: 1, test: unknownTest }
]
const runs = []
for (const variant of [{ id: 'baseline' }, ...variants]) {
  const file = variant.owner ? names[variant.owner] : null, original = file ? text[variant.owner] : null
  if (file) assert.equal(original.split(variant.before).length, variant.count + 1, 'Unique owning mutation anchor')
  const changed = file ? original.replaceAll(variant.before, variant.after) : null
  const report = path.join(output, variant.id + '.json'), loaded = path.join(output, variant.id + '.loaded.json'), config = path.join(output, variant.id + '.config.mts')
  await fs.rm(report, { force: true }); await fs.rm(loaded, { force: true })
  const plugin = file ? `plugins:[{name:'actual-cleanup-observation-mutation',enforce:'pre',load(id){if(id.split('?')[0]!==${JSON.stringify(path.join(root, file))})return;const current=readFileSync(id.split('?')[0],'utf8');if(current!==${JSON.stringify(original)})throw Error('Candidate drift');const code=${JSON.stringify(changed)};writeFileSync(${JSON.stringify(loaded)},JSON.stringify({original:${JSON.stringify(sha(original))},loaded:${JSON.stringify(sha(changed))}}));return code}}],` : ''
  await fs.writeFile(config, `import {readFileSync,writeFileSync} from 'node:fs';import base from ${JSON.stringify(path.join(root, 'apps/desktop/scripts/fixtures/settings-overview/vitest.config.mts'))};export default {...base,${plugin}test:{...base.test,include:${JSON.stringify([names.cases])}}}\n`)
  let log = ''
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config, '--reporter=json', '--outputFile=' + report], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => { log += chunk }); child.stderr.on('data', chunk => { log += chunk })
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
  await fs.writeFile(path.join(output, variant.id + '.log'), log)
  const result = JSON.parse(await fs.readFile(report, 'utf8')), assertions = result.testResults.flatMap(suite => suite.assertionResults)
  assert.equal(result.testResults.length, 1)
  for (const suite of result.testResults) { assert.ok(suite.assertionResults.length); assert.equal(suite.message, '') }
  assert.equal(assertions.length, 24); assert.equal(result.numTotalTests, assertions.length)
  assert.equal(result.numPassedTests, assertions.filter(test => test.status === 'passed').length)
  assert.equal(result.numFailedTests, assertions.filter(test => test.status === 'failed').length)
  assert.equal(result.numPendingTests, 0); assert.doesNotMatch(log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception|Test timed out/)
  let witness
  if (file) {
    assert.equal(exitCode, 1); witness = JSON.parse(await fs.readFile(loaded, 'utf8'))
    assert.equal(witness.original, before[file]); assert.equal(witness.loaded, sha(changed)); assert.notEqual(witness.original, witness.loaded)
    const target = assertions.find(test => test.fullName === variant.test)
    assert.equal(target?.status, 'failed', 'The owning business assertion must fail')
    assert.ok(target.failureMessages.some(message => /AssertionError|__VITEST_(?:REJECTS|RESOLVES)__|expected .* to /su.test(message)), 'No arbitrary runtime failure may qualify')
    assert.ok(target.failureMessages.every(message => !/TypeError|ReferenceError|SyntaxError/u.test(message)), 'Setup and runtime exceptions cannot qualify')
  } else { assert.equal(exitCode, 0, log); assert.equal(result.numFailedTests, 0); assert.equal(result.success, true) }
  runs.push({ id: variant.id, exitCode, passed: result.numPassedTests, failed: result.numFailedTests, rawReport: path.relative(root, report), rawSha256: sha(await fs.readFile(report)), ...(witness ? { witness, target: variant.test } : {}) })
  assert.deepEqual(await pins(), before); console.log(JSON.stringify(runs.at(-1)))
}
await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify({ schema: 'agentmux.probe-cleanup-observation-proof.v1', passed: true, scope: 'Exact private cleanup PID observation and signal ownership only', sourceBefore: before, sourceAfter: await pins(), sourceStable: true, runs, limitations: ['The actual private Native product runner separately consumes this exact helper; controlled process ports exercise transient and persistent unknown state without signalling a real unrelated process.'] }, null, 2) + '\n')
