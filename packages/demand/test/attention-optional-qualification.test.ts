import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDemandStore } from '../src/demand-store.js'
import { seedStoredDemand } from '../../../test/fixtures/stored-demand.mjs'
import { parseDemandDelegationAttentionInput, type DemandDelegationIntent } from '../src/delegations.js'

const task: DemandDelegationIntent = { operationId: 'original-delegation', sourceMessageId: 'original-source', hostId: 'host', ownerAgentSessionId: 'owner', workerAgentSessionId: 'worker',
  ownerRunId: 'owner-run', workerRunId: 'worker-run', threadId: 'original-thread', text: 'Original task', alignmentRevision: 1, criterionIds: ['criterion'] }
const attention = { operationId: 'original-attention', intentId: 'original-input', hostId: 'host', supervisorAgentSessionId: 'owner', supervisorRunId: 'owner-run', occurrenceAt: 100, agentMuxNote: ' Original note\nwith exact spacing.  ' }
let root: string, store: ReturnType<typeof openDemandStore>
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'goal-attention-qualification-')); store = openDemandStore({ root })
  await seedStoredDemand(store, { id: 'goal', title: 'Original Goal', status: 'in_progress', assigneeSessionIds: ['owner', 'worker'], supervisorSessionId: 'owner' })
  await seedStoredDemand(store, { id: 'another-goal', title: 'Another retained Goal' })
  await store.proposeAlignment('goal', { summary: 'Original target', criteria: [{ id: 'criterion', text: 'Original result' }], openQuestions: [] })
  await store.prepareDelegation('goal', task, 'owner'); await store.linkDelegation('goal', task.operationId, task.sourceMessageId, 'owner')
})
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })
async function originalSnapshot(inputEpoch?: unknown) {
  const file = join(root, 'store.json'), value = JSON.parse(await fs.readFile(file, 'utf8'))
  value.demands.find((row: {id: string}) => row.id === 'goal').delegations[0].attention = { ...attention, preparedAt: 110, attemptedAt: 120, ...(inputEpoch === undefined ? {} : { inputEpoch }) }
  await fs.writeFile(file, JSON.stringify(value))
  return { file, bytes: await fs.readFile(file) }
}

it('the original attention input accepts an absent qualification without manufacturing one and retains a provided value', () => {
  expect(parseDemandDelegationAttentionInput(attention)).toEqual(attention)
  expect(parseDemandDelegationAttentionInput(attention)).not.toHaveProperty('inputEpoch')
  expect(parseDemandDelegationAttentionInput({ ...attention, inputEpoch: 'original-epoch' })).toEqual({ ...attention, inputEpoch: 'original-epoch' })
})
it('provided malformed qualifications and unrelated fields remain rejected', () => {
  for (const inputEpoch of [null, 4, '', '\0', 'x'.repeat(513)]) expect(() => parseDemandDelegationAttentionInput({ ...attention, inputEpoch })).toThrow()
  expect(() => parseDemandDelegationAttentionInput({ ...attention, inventedField: 'no' })).toThrow()
  const { supervisorRunId: _run, ...missingRun } = attention
  expect(() => parseDemandDelegationAttentionInput(missingRun)).toThrow()
})
it('a cold public Store reads original attention and the other Goal without rewriting any snapshot bytes', async () => {
  const original = await originalSnapshot(), cold = openDemandStore({ root })
  expect((await cold.inspectDelegation('goal', task.operationId))!.attention).toEqual({ ...attention, preparedAt: 110, attemptedAt: 120 })
  expect((await cold.get('another-goal'))!.title).toBe('Another retained Goal')
  expect((await cold.snapshot()).demands).toHaveLength(2)
  expect(await fs.readFile(original.file)).toEqual(original.bytes)
})
it('the original Store producer freezes the same unqualified request and a fresh reader retains its operation and note', async () => {
  await store.prepareDelegationAttention('goal', task.operationId, attention)
  await store.markDelegationAttentionAttempt('goal', task.operationId, attention.operationId)
  const original = await fs.readFile(join(root, 'store.json'))
  const read = (await openDemandStore({ root }).inspectDelegation('goal', task.operationId))!
  expect(read.attention).toMatchObject(attention); expect(read.attention).not.toHaveProperty('inputEpoch')
  expect(read.workerRunId).toBe(task.workerRunId); expect(read.sourceMessageId).toBe(task.sourceMessageId)
  expect(await fs.readFile(join(root, 'store.json'))).toEqual(original)
})
it('a cold reader retains a valid qualification and refuses a malformed one without replacing the original data', async () => {
  await originalSnapshot('original-epoch')
  expect((await openDemandStore({ root }).inspectDelegation('goal', task.operationId))!.attention!.inputEpoch).toBe('original-epoch')
  const malformed = await originalSnapshot(null)
  await expect(openDemandStore({ root }).snapshot()).rejects.toThrow()
  expect(await fs.readFile(malformed.file)).toEqual(malformed.bytes)
})
