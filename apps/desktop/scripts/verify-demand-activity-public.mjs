import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'

const repository = path.resolve(import.meta.dirname, '../../..')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const evidence = path.join(repository, '.tmp/demand-activity-public', String(globalThis.crypto.randomUUID()))
await fs.mkdir(evidence, { recursive: true })
const mutations = [
  { id: 'public-append-owner', file: 'packages/core/src/public-rpc.ts', before: "'goal.activity.append': 'demand.activity.append'", after: "'goal.activity.append': 'demand.activity.inspect'" },
  { id: 'cli-original-operation', file: 'packages/core/src/agentmux-cli-commands.ts', before: "goalId: id(f, '--goal', true), kind: value(f, '--kind', true), message: value(f, '--message', true), operationId: id(f, '--operation-id', true)", after: "goalId: id(f, '--goal', true), kind: value(f, '--kind', true), message: value(f, '--message', true), operationId: 'wrong-operation'" },
  { id: 'authenticated-main-author', file: 'apps/desktop/src/main/ipc.ts', before: 'actorId: admitted.context.actor.id,', after: 'actorId: null,' },
  { id: 'main-original-activity-owner', file: 'apps/desktop/src/main/ipc.ts', before: 'return await demands.addActivity(id, { kind: input.kind, message: input.message, actorId: admitted.context.actor.id,', after: 'return await demands.update(id, {' },
  { id: 'same-snapshot-replay', file: 'packages/demand/src/demand-store.ts', before: 'if (previousActivity) {', after: 'if (false && previousActivity) {' },
  { id: 'original-public-read', file: 'packages/core/src/public-rpc-service.ts', before: 'return read.activities.map(activity => ({ goalId: goal.id, ...activity }))', after: 'return []' },
  { id: 'actual-goal-consumer', file: 'apps/desktop/src/renderer/src/store.ts', before: 'activities: demand.activities,', after: 'activities: [],' }
]
const receipt = { schema: 'agentmux.demand-activity-public.proof.v1', passed: false,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
  source: {}, baseline: null, mutations: [], limitations: ['Actual Source CLI, socket service, Main IPC owner, preload, store and GoalDetail are exercised with isolated Electron transport and synthetic authenticated Session; no native Agent, user input, installed package or visual approval is claimed.'] }
const qualifiedPaths = [
  'packages/demand/src/demand-types.ts', 'packages/demand/src/demand-store.ts',
  'packages/core/src/control.ts', 'packages/core/src/control-codec.ts', 'packages/core/src/public-rpc.ts',
  'packages/core/src/public-rpc-service.ts', 'packages/core/src/rpc-business-codec.ts', 'packages/core/src/rpc-native-codec.ts',
  'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/agentmux-cli-help.ts',
  'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/preload/index.ts',
  'apps/desktop/src/renderer/src/lib/api.ts', 'apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/test/mote-daily-goal.test.tsx', 'apps/desktop/scripts/fixtures/demand-activity/vitest.config.mts'
]
async function run(name, mutant) {
  const proof = path.join(evidence, name + '.loaded.ndjson'), log = path.join(evidence, name + '.log')
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/scripts/fixtures/demand-activity/vitest.config.mts', '-t', 'original activity public Source CLI'], {
    cwd: repository, env: { ...process.env, AGENTMUX_DAILY_GOAL_PROOF: proof,
      ...(mutant ? { AGENTMUX_DAILY_GOAL_MUTANT: JSON.stringify(mutant) } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  const timer = setTimeout(() => child.kill('SIGTERM'), 60_000)
  const [exitCode, signal] = await once(child, 'exit'); clearTimeout(timer)
  await fs.writeFile(log, output)
  const bytes = await fs.readFile(proof), loaded = bytes.toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(loaded.length, 'No empty loaded graph may qualify')
  const rows = loaded.filter(row => row.consumer.endsWith('mutant'))
  return { exitCode, signal, assertionRed: /AssertionError|expected .* to/.test(output),
    testsPassed: Number(/Tests\s+(\d+) passed/.exec(output)?.[1] ?? 0),
    log: path.relative(repository, log), logSHA256: digest(output), loaded: path.relative(repository, proof), loadedSHA256: digest(bytes), rows, graph: loaded }
}
try {
  for (const mutation of mutations) assert.equal((await fs.readFile(path.join(repository, mutation.file), 'utf8')).split(mutation.before).length, 2, 'One exact source anchor: ' + mutation.id)
  const baseline = await run('baseline')
  receipt.baseline = { ...baseline }; delete receipt.baseline.graph
  assert.equal(baseline.exitCode, 0); assert.equal(baseline.signal, null); assert.ok(baseline.testsPassed > 0)
  for (const consumer of ['actual-source-cli', 'actual-vite-module']) assert.ok(baseline.graph.some(row => row.consumer === consumer), 'Original actual consumer: ' + consumer)
  for (const file of ['packages/core/src/public-rpc-service.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/GoalDetail.tsx', 'packages/demand/src/demand-store.ts'])
    assert.ok(baseline.graph.some(row => row.file === file), 'Actual loaded owner/consumer: ' + file)
  for (const file of qualifiedPaths) receipt.source[file] = digest(await fs.readFile(path.join(repository, file)))
  for (const mutation of mutations) {
    const result = await run(mutation.id, mutation); delete result.graph
    receipt.mutations.push({ id: mutation.id, file: mutation.file, ...result })
    assert.notEqual(result.exitCode, 0, mutation.id + ' must fail'); assert.equal(result.signal, null)
    assert.equal(result.assertionRed, true, mutation.id + ' must fail a product assertion')
    assert.ok(result.rows.some(row => row.file === mutation.file && row.beforeSha256 !== row.afterSha256), mutation.id + ' must mutate actual loaded implementation')
    console.log(mutation.id + ': assertion RED')
  }
  const final = await run('final-current-baseline')
  receipt.final = { ...final }; delete receipt.final.graph
  assert.equal(final.exitCode, 0); assert.equal(final.signal, null); assert.ok(final.testsPassed > 0)
  receipt.adjacentSourceChanges = []
  for (const row of baseline.graph.filter(row => row.sha256 && !qualifiedPaths.includes(row.file))) {
    const after = digest(await fs.readFile(path.join(repository, row.file)))
    if (after !== row.sha256) receipt.adjacentSourceChanges.push({ file: row.file, beforeSHA256: row.sha256, afterSHA256: after })
  }
  for (const [file, sha256] of Object.entries(receipt.source)) assert.equal(digest(await fs.readFile(path.join(repository, file))), sha256, 'Candidate Source changed: ' + file)
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack } }
await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: receipt.passed, evidence: path.relative(repository, path.join(evidence, 'receipt.json')), mutations: receipt.mutations.length }))
assert.equal(receipt.passed, true, receipt.error?.message)
