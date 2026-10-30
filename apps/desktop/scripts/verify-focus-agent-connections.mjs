import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { connectionMutations } from '../test/focus-agent-connection-mutations.mjs'

assert.equal(process.argv[2], '--evidence')
const root = resolve(import.meta.dirname, '../../..'), evidence = resolve(process.argv[3])
await mkdir(evidence, { recursive: true })
const hash = input => createHash('sha256').update(input).digest('hex')
const config = 'apps/desktop/test/vitest.focus-agent-connections.config.mts'
const tests = ['apps/desktop/test/focus-agent-connections.test.tsx', 'apps/desktop/test/connector-room-target-consumer.test.tsx']
const files = [...new Set([...connectionMutations.map(item => item.file), config, ...tests,
  'apps/desktop/scripts/verify-focus-agent-connections.mjs', 'apps/desktop/test/vitest.mote-context.config.mts', 'apps/desktop/test/channel-metadata-watch.config.mts',
  'apps/desktop/test/focus-agent-connection-mutations.mjs', 'apps/desktop/test/fixtures/connector-journey.tsx',
  'packages/connectors/test/fixtures/room-provisioning.ts', 'apps/desktop/src/renderer/src/components/FocusContextMenu.tsx',
  'apps/desktop/src/renderer/src/components/AgentConnectorDialog.tsx', 'apps/desktop/src/main/connector-ipc.ts',
  'packages/connectors/src/room-target.ts', 'packages/connectors/src/room-binding.ts', 'packages/connectors/src/room-provisioning.ts'])]
const original = new Map(await Promise.all(files.map(async file => [file, await readFile(join(root, file), 'utf8')])))
const sourceBefore = Object.fromEntries([...original].map(([file, value]) => [file, hash(value)]))
const receipt = { schema: 'agentmux.focus-connections-mutation.v1', passed: false, sourceBefore, sharedTreeMutations: 0, runtimeControl: [], cases: [],
  boundary: 'Mounted actual Focus/Region menus and Session-only header through original confirmation Dialog, registered trusted IPC and private Unix Core/Host owner. Adapter and terminal I/O are controlled; no user Session or actual network group.' }
async function run(label, variant) {
  const trace = join(evidence, label + '-loaded.jsonl')
  await writeFile(trace, '')
  const args = ['exec', 'vitest', 'run', ...(variant ? [tests[0], '-t', variant.test] : tests), '--config', config, '--maxWorkers=1']
  const result = await new Promise((yes, no) => {
    const child = spawn('pnpm', args, { cwd: root, env: { ...process.env, FOCUS_CONNECTIONS_MUTANT: variant?.label ?? '', FOCUS_CONNECTIONS_TRACE: trace, AGENTMUX_TEST_CONNECTOR_ARTIFACTS: join(evidence, 'public-consumption'), pnpm_config_verify_deps_before_run: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    child.on('error', no); child.on('close', (exit, signal) => yes({ exit, signal, output }))
  })
  await writeFile(join(evidence, label + '.log'), result.output)
  const loaded = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(loaded.length > 0, 'Actual production source load set must be nonempty')
  return { ...result, log: label + '.log', loaded }
}
function green(result) { assert.equal(result.exit, 0, result.output); assert.match(result.output, /Tests\s+[1-9]\d* passed/); assert.doesNotMatch(result.output, /Tests\s+[1-9]\d* failed/) }
if (process.env.AGENTMUX_FOCUS_CONNECTIONS_RECEIPT) {
  const path = resolve(process.env.AGENTMUX_FOCUS_CONNECTIONS_RECEIPT), saved = JSON.parse(await readFile(path, 'utf8'))
  const prior = resolve(path, '..')
  assert.equal(saved.schema, receipt.schema); assert.equal(saved.passed, true)
  assert.equal(saved.sharedTreeMutations, 0); assert.deepEqual(saved.runtimeControl, [])
  assert.deepEqual(saved.sourceBefore, sourceBefore); assert.deepEqual(saved.sourceAfter, sourceBefore)
  assert.deepEqual(saved.cases.map(({ label, file, test, before, after }) => ({ label, file, test, before, after })), connectionMutations)
  const baseline = await readFile(join(prior, saved.baseline.log), 'utf8')
  assert.equal(hash(baseline), saved.baseline.logSHA256); green({ ...saved.baseline, output: baseline })
  const baselineLoad = (await readFile(join(prior, 'baseline-green-loaded.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.deepEqual(baselineLoad, saved.baseline.loaded)
  for (const item of saved.cases) {
    const source = original.get(item.file)
    assert.equal(source.split(item.before).length - 1, 1)
    assert.ok(item.exit > 0); assert.equal(item.loaded.loadedSHA256, hash(source.replace(item.before, item.after)))
    const red = await readFile(join(prior, item.log), 'utf8')
    assert.equal(hash(red), item.logSHA256); assert.match(red, /AssertionError/); assert.match(red, /Tests\s+[1-9]\d* failed/)
    const redLoad = (await readFile(join(prior, item.label + '-red-loaded.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.ok(redLoad.some(value => JSON.stringify(value) === JSON.stringify(item.loaded)))
    const restored = await readFile(join(prior, item.restore.log), 'utf8')
    assert.equal(hash(restored), item.restore.logSHA256); green({ ...item.restore, output: restored })
    const restoreLoad = (await readFile(join(prior, item.label + '-restore-green-loaded.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.deepEqual(restoreLoad, item.restore.loaded)
    assert.ok(restoreLoad.some(value => value.path === item.file && value.loadedSHA256 === sourceBefore[item.file]))
  }
  assert.ok(saved.cases.length > 0)
  console.log(JSON.stringify({ passed: true, exactEvidenceReused: path, sourceBefore, mutants: saved.cases.length }))
  process.exit(0)
}
try {
  const baseline = await run('baseline-green'); green(baseline)
  // Every owner in the real Focus → confirmation → public Core/Host chain must load.
  for (const file of ['apps/desktop/src/renderer/src/components/FocusContextMenu.tsx', 'apps/desktop/src/renderer/src/lib/use-agent-connector-menu.tsx', 'apps/desktop/src/renderer/src/components/AgentConnections.tsx', 'apps/desktop/src/renderer/src/components/AgentConnectorDialog.tsx', 'apps/desktop/src/main/connector-ipc.ts', 'packages/connectors/src/room-target.ts', 'packages/connectors/src/room-binding.ts', 'packages/connectors/src/room-provisioning.ts']) {
    assert.ok(baseline.loaded.some(item => item.path === file && item.loadedSHA256 === sourceBefore[file]), 'Original consumer/owner must load current source: ' + file)
  }
  receipt.baseline = { exit: baseline.exit, log: baseline.log, logSHA256: hash(baseline.output), loaded: baseline.loaded }
  for (const variant of connectionMutations) {
    const source = original.get(variant.file)
    assert.equal(source.split(variant.before).length - 1, 1, 'Unique original production mutation: ' + variant.label)
    const red = await run(variant.label + '-red', variant)
    assert.ok(red.exit > 0 && red.signal === null, red.output); assert.match(red.output, /AssertionError/); assert.match(red.output, /Tests\s+[1-9]\d* failed/)
    const loaded = red.loaded.find(item => item.path === variant.file && item.mutation === variant.label)
    assert.ok(loaded, 'Mutated production source was actually loaded'); assert.equal(loaded.loadedSHA256, hash(source.replace(variant.before, variant.after)))
    const restored = await run(variant.label + '-restore-green', { ...variant, label: '' }); green(restored)
    assert.ok(restored.loaded.some(item => item.path === variant.file && item.loadedSHA256 === sourceBefore[variant.file]))
    receipt.cases.push({ ...variant, exit: red.exit, log: red.log, logSHA256: hash(red.output), loaded,
      restore: { exit: restored.exit, log: restored.log, logSHA256: hash(restored.output), loaded: restored.loaded } })
    console.log('PASS ' + variant.label + ': actual loaded AssertionRED → restoreGREEN')
  }
  receipt.sourceAfter = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(root, file)))])))
  assert.deepEqual(receipt.sourceAfter, sourceBefore, 'Candidate stayed unchanged during the bounded proof')
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, mutants: receipt.cases.length, receipt: join(evidence, 'receipt.json') }))
