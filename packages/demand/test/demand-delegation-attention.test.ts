import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDemandStore } from '../src/demand-store.js'
import type { DemandDelegationAttentionInput, DemandDelegationIntent } from '../src/delegations.js'
let root: string, store: ReturnType<typeof openDemandStore>
const execute = promisify(execFile)
const task: DemandDelegationIntent = { operationId: 'delegation', sourceMessageId: 'source', hostId: 'host', ownerAgentSessionId: 'owner', workerAgentSessionId: 'worker',
  ownerRunId: 'owner-run', workerRunId: 'worker-run', threadId: 'thread', text: 'Original task', alignmentRevision: 1, criterionIds: ['AC'] }
const attention: DemandDelegationAttentionInput = { operationId: 'attention-operation', intentId: 'attention-intent', hostId: 'host', supervisorAgentSessionId: 'owner',
  supervisorRunId: 'owner-run', occurrenceAt: _reshape_fixtureEpoch(0, 0, 100), agentMuxNote: ' Original worker Run ended.\nInspect its retained Goal source and evidence. ' }
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'demand-attention-')); store = openDemandStore({ root })
  await store.create({ id: 'goal', title: 'Original Goal', status: 'in_progress', assigneeSessionIds: ['owner', 'worker', 'next-owner'], supervisorSessionId: 'owner' })
  await store.proposeAlignment('goal', { summary: 'Original target', criteria: [{ id: 'AC', text: 'Original result' }], openQuestions: [] })
  await store.prepareDelegation('goal', task, 'owner')
})
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }) })

describe('one frozen Goal responsibility attention reference', () => {
  it('freezes a reference only for the accurate linked Host and current Supervisor, without producing Runtime input', async () => {
    const beforeLink = await store.snapshot()
    await expect(store.prepareDelegationAttention('goal', task.operationId, attention)).rejects.toThrow(/linked Host/u)
    expect(await store.snapshot()).toEqual(beforeLink)
    await store.linkDelegation('goal', task.operationId, task.sourceMessageId, 'owner')
    const linked = await store.snapshot()
    await expect(store.prepareDelegationAttention('goal', task.operationId, { ...attention, hostId: 'other-host' })).rejects.toThrow(/linked Host/u)
    await expect(store.prepareDelegationAttention('goal', task.operationId, { ...attention, supervisorAgentSessionId: 'worker' })).rejects.toThrow(/current Supervisor/u)
    expect(await store.snapshot()).toEqual(linked)
    const saved = await store.prepareDelegationAttention('goal', task.operationId, attention)
    expect(saved.demand.delegations![0]!.attention).toMatchObject(attention)
    expect(saved.demand.delegations![0]!.attention!.attemptedAt).toBeUndefined()
    expect(saved.demand.status).toBe('in_progress')
    expect(saved.demand.supervisorSessionId).toBe('owner')
    expect(saved.demand.alignment!.confirmedAt).toBeNull()
    expect(saved.demand.grounding).toBeUndefined()
  })

  it('retains exact original note and input identities across duplicate events, Run changes and explicit responsibility handoff', async () => {
    await store.linkDelegation('goal', task.operationId, task.sourceMessageId, 'owner')
    await store.prepareDelegationAttention('goal', task.operationId, attention)
    const before = await store.snapshot()
    expect((await store.prepareDelegationAttention('goal', task.operationId, attention)).replayed).toBe(true)
    for (const change of [{ agentMuxNote: attention.agentMuxNote.trim() }, { supervisorRunId: 'new-owner-run' }, { operationId: 'new-notice' }, { intentId: 'new-intent' }, { occurrenceAt: _reshape_fixtureEpoch(0, 0, 200) }])
      await expect(store.prepareDelegationAttention('goal', task.operationId, { ...attention, ...change })).rejects.toThrow(/frozen/u)
    expect(await store.snapshot()).toEqual(before)
    await store.update('goal', { supervisorSessionId: 'next-owner' })
    const handedOff = await store.snapshot()
    expect((await store.prepareDelegationAttention('goal', task.operationId, attention)).replayed).toBe(true)
    await expect(store.prepareDelegationAttention('goal', task.operationId, { ...attention, supervisorAgentSessionId: 'next-owner', supervisorRunId: 'next-owner-run' })).rejects.toThrow(/frozen/u)
    expect(await store.snapshot()).toEqual(handedOff)
    expect((await store.inspectDelegation('goal', task.operationId))!.attention).toMatchObject(attention)
  })

  it('marks one attempt before actual Core submission and never clears or repeats its original attempt on an unknown receipt', async () => {
    await store.linkDelegation('goal', task.operationId, task.sourceMessageId, 'owner')
    const before = await store.snapshot()
    await expect(store.markDelegationAttentionAttempt('goal', task.operationId, attention.operationId)).rejects.toThrow(/exact original prepared/u)
    expect(await store.snapshot()).toEqual(before)
    await store.prepareDelegationAttention('goal', task.operationId, attention)
    const prepared = await store.snapshot()
    await expect(store.markDelegationAttentionAttempt('goal', task.operationId, 'wrong-notice')).rejects.toThrow(/exact original prepared/u)
    expect(await store.snapshot()).toEqual(prepared)
    const first = await store.markDelegationAttentionAttempt('goal', task.operationId, attention.operationId)
    expect(first.demand.delegations![0]!.attention!.attemptedAt).toBeGreaterThan(0)
    const attempted = await store.snapshot()
    expect((await store.markDelegationAttentionAttempt('goal', task.operationId, attention.operationId)).replayed).toBe(true)
    expect(await store.snapshot()).toEqual(attempted)
    const modulePath = new URL('../dist/src/demand-store.js', import.meta.url).href
    const script = `import { openDemandStore } from ${JSON.stringify(modulePath)}; process.stdout.write(JSON.stringify(await openDemandStore({root:${JSON.stringify(root)}}).inspectDelegation('goal','delegation')))`
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script])
    expect(JSON.parse(stdout).attention).toEqual(first.demand.delegations![0]!.attention)
  })

  it('does not create a new notice for an already collected report and preserves an earlier notice as history', async () => {
    await store.linkDelegation('goal', task.operationId, task.sourceMessageId, 'owner')
    const report = { operationId: 'report', replyMessageId: 'reply', authorAgentSessionId: 'worker', grounding: { alignmentRevision: 1, summary: 'Result', checks: [{ criterionId: 'AC', outcome: 'met' as const, evidence: ['evidence/result.log:7'], note: '' }] } }
    await store.submitDelegationReport('goal', task.operationId, report, 'worker')
    await store.collectDelegationReport('goal', task.operationId, { operationId: 'collect', replyMessageId: 'reply' }, { kind: 'agent', id: 'owner' })
    const before = await store.snapshot()
    await expect(store.prepareDelegationAttention('goal', task.operationId, attention)).rejects.toThrow(/awaiting collection/u)
    expect(await store.snapshot()).toEqual(before)
  })

  it.each(['prepare', 'attempt'] as const)('confirms the original attention %s after post-replacement EIO without another identity or attempt', async phase => {
    await store.linkDelegation('goal', task.operationId, task.sourceMessageId, 'owner')
    if (phase === 'attempt') await store.prepareDelegationAttention('goal', task.operationId, attention)
    const originalOpen = fs.open.bind(fs); let injected = 0
    const fault = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      if (args[0] === root && injected === 0) { injected++; vi.spyOn(handle, 'sync').mockRejectedValueOnce(Object.assign(new Error('isolated attention fsync EIO'), { code: 'EIO' })) }
      return handle
    })
    const action = () => phase === 'prepare' ? store.prepareDelegationAttention('goal', task.operationId, attention) : store.markDelegationAttentionAttempt('goal', task.operationId, attention.operationId)
    await expect(action()).rejects.toMatchObject({ code: 'WRITE_FAILED', phase: 'write', replacementApplied: true })
    expect(injected).toBe(1); fault.mockRestore()
    const original = (await store.inspectDelegation('goal', task.operationId))!.attention!
    expect(original).toMatchObject(attention)
    const saved = await store.snapshot()
    expect((await action()).replayed).toBe(true)
    expect(await store.snapshot()).toEqual(saved)
    if (phase === 'attempt') expect(original.attemptedAt).toBeGreaterThan(0)
  })
})
