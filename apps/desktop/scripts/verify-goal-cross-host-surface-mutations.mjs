import { parseArgs } from 'node:util'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const repository = resolve(import.meta.dirname, '../../..')
const { values } = parseArgs({ options: { evidence: { type: 'string' } } })
assert.ok(values.evidence, 'Supply --evidence DIR for this proof output.')
const evidence = resolve(values.evidence)
mkdirSync(evidence, { recursive: true })
const mutations = [
  { id: 'reviewed-identities', file: 'apps/desktop/src/main/settings-host-message-trust.ts',
    before: "if (!expected || !configValuesEqual(current.local.authority, expected.local?.authority) ||\n    !configValuesEqual(current.remote.authority, expected.remote?.authority))", after: 'if (false)', test: 'host-message-trust' },
  { id: 'direction-target', file: 'apps/desktop/src/main/settings-host-message-trust.ts',
    before: "hostId: direction === 'outbound' ? host.id : 'local'", after: 'hostId: host.id', test: 'host-message-trust' },
  { id: 'executor-host', file: 'apps/desktop/src/renderer/src/components/GoalPlanGraph.tsx',
    before: 'hostId: delegationWorkerHostId(item.delegation),', after: 'hostId: item.delegation.hostId,', test: 'goal-plan-graph' },
  { id: 'worker-run-events', file: 'apps/desktop/src/renderer/src/lib/goal-delegation-events.ts',
    before: 'key(workerHostId, delegation.workerRunId)', after: 'key(delegation.hostId, delegation.workerRunId)', test: 'goal-delegation-work' },
  { id: 'worker-responsibility', file: 'apps/desktop/src/renderer/src/lib/goal-current-work.ts',
    before: 'currentDemandKey(delegationWorkerHostId(delegation), delegation.workerAgentSessionId)',
    after: 'currentDemandKey(delegation.hostId, delegation.workerAgentSessionId)', test: 'goal-delegation-work' },
  { id: 'owner-answer-runtime', file: 'apps/desktop/src/renderer/src/lib/goal-delegation-presentation.ts',
    before: '(!delegation.runtimeIdentity || reply.envelope.senderRuntimeId === delegation.runtimeIdentity.ownerRuntimeId &&\n        reply.envelope.recipientRuntimeId === delegation.runtimeIdentity.workerRuntimeId)',
    after: 'true', test: 'goal-delegation-work' },
  { id: 'owner-answer-inbox', file: 'apps/desktop/src/renderer/src/lib/goal-delegation-presentation.ts',
    before: "reply.deliveryMode !== 'outbox' || reply.peerInbox !== undefined", after: 'true', test: 'goal-delegation-work' }
]
const results = []
for (const mutant of mutations) {
  const source = readFileSync(join(repository, mutant.file), 'utf8')
  assert.equal(source.split(mutant.before).length, 2, `One exact mutation anchor: ${mutant.id}`)
  const proof = join(evidence, `${mutant.id}-loaded.jsonl`)
  writeFileSync(proof, '')
  const run = spawnSync(process.execPath, [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/test/vitest.goal-cross-host-surface.config.mts', `apps/desktop/test/${mutant.test}.test.tsx`], {
    cwd: repository, encoding: 'utf8', env: { ...process.env, AGENTMUX_DAILY_GOAL_MUTANT: JSON.stringify(mutant), AGENTMUX_DAILY_GOAL_PROOF: proof }, maxBuffer: 5 * 1024 * 1024
  })
  const log = (run.stdout ?? '') + (run.stderr ?? '')
  writeFileSync(join(evidence, `${mutant.id}.log`), log)
  const loaded = readFileSync(proof, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(row => row.file === mutant.file && row.consumer === 'actual-loaded-mutant')
  assert.ok(run.status !== 0 && run.status !== null, `Mutation must fail an actual assertion: ${mutant.id}`)
  assert.ok(/Tests\s+\d+ failed/.test(log), `Mutation must reach tests: ${mutant.id}`)
  assert.ok(loaded.length > 0, `Actual source must be mutated: ${mutant.id}`)
  results.push({ id: mutant.id, file: mutant.file, sourceSha256: createHash('sha256').update(source).digest('hex'), status: run.status, loaded })
}
writeFileSync(join(evidence, 'receipt.json'), JSON.stringify({ passed: true, results }, null, 2))
console.log(JSON.stringify({ passed: true, mutations: results.length, evidence }))
