import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'

const repository = path.resolve(import.meta.dirname, '../../..')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const evidence = path.join(repository, '.tmp/demand-collaboration-contract', String(globalThis.crypto.randomUUID()))
await fs.mkdir(evidence, { recursive: true })
const mutations = [
  { id: 'atomic-history-union', file: 'packages/demand/src/demand-store.ts', before: 'demand.sessionIds = [...new Set([...demand.sessionIds, ...patch.assigneeSessionIds])]', after: 'demand.sessionIds = [...patch.assigneeSessionIds]' },
  { id: 'supervisor-membership', file: 'packages/demand/src/demand-store.ts', before: 'if (assigneeSessionIds.some(id => !sessionIds.includes(id)) || supervisorSessionId !== null && !assigneeSessionIds.includes(supervisorSessionId))', after: 'if (assigneeSessionIds.some(id => !sessionIds.includes(id)))' },
  { id: 'authenticated-request-source', file: 'apps/desktop/src/main/demand-participation.ts', before: 'agentSessionId: context.actor.id,', after: "agentSessionId: 'body-claim'," },
  { id: 'authored-first-default-clear', file: 'packages/demand/src/demand-store.ts', before: 'if (demand.creationOrigin) demand.creationOrigin.supervisorDefaultPending = false', after: 'if (demand.creationOrigin) demand.creationOrigin.supervisorDefaultPending = true' },
  { id: 'owner-only-origin-patch', file: 'packages/demand/src/demand-store.ts', before: '    rejectProvenanceInput(patch)', after: '    void patch' },
  { id: 'public-assignee-filter', file: 'packages/core/src/public-rpc-service.ts', before: '(!filters.assigneeSessionId || goal.assigneeSessionIds.includes(String(filters.assigneeSessionId)))', after: '(!filters.assigneeSessionId || goal.sessionIds.includes(String(filters.assigneeSessionId)))' },
  { id: 'original-cli-relations', file: 'packages/core/src/agentmux-cli-commands.ts', before: "assigneeSessionIds: jsonValue(value(f, '--assignees', true)!, '--assignees')", after: 'assigneeSessionIds: []' },
  { id: 'desktop-actual-projection', file: 'apps/desktop/src/renderer/src/store.ts', before: 'assigneeSessionIds: [...demand.assigneeSessionIds],', after: 'assigneeSessionIds: [],' },
  { id: 'mobile-actual-writer', file: 'apps/mobile/src/goals/MobileGoalActions.tsx', before: "const params = { ...common, assigneeSessionIds: assigneeIds.split(',').map(value => value.trim()).filter(Boolean), supervisorSessionId: supervisorId.trim() || null, expectedUpdatedAt: goal.updatedAt, start: false }", after: 'const params = { ...common, assigneeSessionIds: [], supervisorSessionId: supervisorId.trim() || null, expectedUpdatedAt: goal.updatedAt, start: false }' }
]
const receipt = { schema: 'agentmux.demand-collaboration-contract.proof.v1', passed: false,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
  source: {}, baseline: null, mutations: [], limitations: ['Actual Source CLI, socket service, Main IPC owner, preload, store and GoalDetail are exercised with isolated Electron transport and synthetic authenticated Session; no native Agent, user input, installed package, first-default execution, Loop identity change or final visual approval is claimed. Domain relations and trusted eligibility are verified; T008 and T004 own their consumers.'] }
const qualifiedPaths = [
  'packages/demand/src/demand-types.ts', 'packages/demand/src/demand-store.ts', 'packages/demand/src/collaboration.ts', 'packages/demand/src/goals.ts', 'packages/demand/src/index.ts', 'packages/demand/src/cli.ts',
  'packages/core/src/control.ts', 'packages/core/src/control-codec.ts', 'packages/core/src/public-rpc.ts',
  'packages/core/src/public-rpc-service.ts', 'packages/core/src/rpc-business-codec.ts', 'packages/core/src/rpc-native-codec.ts',
  'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/agentmux-cli-help.ts',
  'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/demand-participation.ts', 'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/preload/index.ts',
  'apps/desktop/src/renderer/src/lib/api.ts', 'apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/renderer/src/lib/global-demand-board.ts', 'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx', 'apps/desktop/src/renderer/src/components/GoalProperties.tsx',
  'apps/mobile/src/goals/MobileGoalActions.tsx', 'apps/mobile/src/goals/MobileGoalsSurface.tsx',
  'packages/demand/test/demand-collaboration.test.ts', 'packages/demand/test/demand-store.test.ts', 'packages/demand/test/demand-cli.test.ts',
  'apps/desktop/test/mote-daily-goal.test.tsx', 'apps/desktop/scripts/fixtures/demand-collaboration/vitest.config.mts', 'apps/desktop/scripts/fixtures/demand-collaboration/tsconfig.core.json', 'apps/desktop/scripts/verify-demand-collaboration-contract.mjs'
]
async function run(name, mutant) {
  const proof = path.join(evidence, name + '.loaded.ndjson'), log = path.join(evidence, name + '.log')
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/scripts/fixtures/demand-collaboration/vitest.config.mts', '-t', '^collaboration |^original activity public Source CLI'], {
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
  assert.equal(baseline.exitCode, 0); assert.equal(baseline.signal, null); assert.ok(baseline.testsPassed >= 7)
  for (const consumer of ['actual-source-cli', 'actual-vite-module']) assert.ok(baseline.graph.some(row => row.consumer === consumer), 'Original actual consumer: ' + consumer)
  for (const file of ['packages/core/src/public-rpc-service.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/GoalDetail.tsx', 'packages/demand/src/demand-store.ts', 'apps/desktop/src/main/demand-participation.ts', 'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx', 'apps/desktop/src/renderer/src/components/GoalProperties.tsx', 'apps/mobile/src/goals/MobileGoalActions.tsx'])
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
  assert.equal(final.exitCode, 0); assert.equal(final.signal, null); assert.ok(final.testsPassed >= 7)
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
