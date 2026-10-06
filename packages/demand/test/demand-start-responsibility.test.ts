import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDemandStore } from '../src/demand-store.js'
import { parseDemandDispatch, type DemandDispatchIntent } from '../src/dispatch.js'
import type { DemandDelegationAttentionInput } from '../src/delegations.js'

let root: string, store: ReturnType<typeof openDemandStore>
const start: DemandDispatchIntent = { operationId: 'original-start', agentSessionId: 'worker', hostId: 'host', runId: 'worker-run', execution: 'finite', prompt: ' Original task\n with exact body. ' }
const notice: DemandDelegationAttentionInput = { operationId: 'start-notice', intentId: 'start-notice-intent', hostId: 'host', supervisorAgentSessionId: 'owner', supervisorRunId: 'owner-run', occurrenceAt: _reshape_fixtureEpoch(0, 0, 100), agentMuxNote: ' Original finite Start needs responsibility review. ' }
const proposal = { alignmentRevision: 1, summary: 'Goal-level result', checks: [{ criterionId: 'AC', outcome: 'met' as const, evidence: ['evidence/original.log:7'], note: '' }] }
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'goal-start-domain-')); store = openDemandStore({ root })
  await store.create({ id: 'goal', title: 'Original Goal', status: 'in_progress', assigneeSessionIds: ['owner', 'worker', 'next-owner'], supervisorSessionId: 'owner' })
  await store.proposeAlignment('goal', { summary: 'Original target', criteria: [{ id: 'AC', text: 'Original result' }], openQuestions: [] })
})
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }) })

describe('original finite Goal Start responsibility provenance', () => {
  it('captures the owner result basis once and keeps the exact Start frozen through later Goal results and alignment changes', async () => {
    await store.proposeGrounding('goal', proposal)
    const previous = (await store.get('goal'))!.grounding!
    await store.prepareDispatch('goal', start)
    const original = (await store.inspectDispatch('goal', start.operationId))!
    expect(original.resultBasis).toEqual({ alignmentRevision: 1, criteria: [{ id: 'AC', text: 'Original result' }], groundingSubmissionId: previous.submissionId })
    await store.proposeGrounding('goal', { ...proposal, summary: 'A later Goal result' })
    await store.proposeAlignment('goal', { summary: 'New target', criteria: [{ id: 'next', text: 'Changed result' }], openQuestions: [] })
    const snapshot = await store.snapshot()
    expect((await store.prepareDispatch('goal', start)).replayed).toBe(true)
    expect(await store.snapshot()).toEqual(snapshot)
    expect(await store.inspectDispatch('goal', start.operationId)).toEqual(original)
    await expect(store.prepareDispatch('goal', { ...start, prompt: start.prompt.trim() })).rejects.toThrow(/original Start/u)
    await expect(store.prepareDispatch('goal', { ...start, resultBasis: original.resultBasis } as never)).rejects.toThrow(/unknown fields/u)
    expect((await store.get('goal'))!.alignment!.confirmedAt).toBeNull()
    expect((await store.get('goal'))!.grounding).toMatchObject({ alignmentRevision: 1, summary: 'A later Goal result', acceptedAt: null })
  })

  it('retains legacy Starts without inventing a result basis, and does not add finite responsibility to continued work', async () => {
    const old = parseDemandDispatch({ ...start, stage: 'prepared', preparedAt: _reshape_fixtureEpoch(0, 0, 100) })
    expect(old.resultBasis).toBeUndefined(); expect(old.attention).toBeUndefined()
    await store.prepareDispatch('goal', start)
    const file = join(root, 'store.json'), legacy = JSON.parse(await fs.readFile(file, 'utf8'))
    delete legacy.demands[0].dispatches[0].resultBasis
    await fs.writeFile(file, JSON.stringify(legacy) + '\n')
    const retained = await openDemandStore({ root }).inspectDispatch('goal', start.operationId)
    expect(retained).toMatchObject(start); expect(retained!.resultBasis).toBeUndefined()
    expect((await store.prepareDispatch('goal', start)).replayed).toBe(true)
    expect(await store.inspectDispatch('goal', start.operationId)).toEqual(retained)
    await store.prepareDispatch('goal', { ...start, operationId: 'continued', execution: 'continue', loopId: 'loop', alignmentRevision: 1 })
    expect((await store.inspectDispatch('goal', 'continued'))!.resultBasis).toBeUndefined()
    await expect(store.prepareDispatchAttention('goal', 'continued', notice)).rejects.toThrow(/original Host/u)
    expect((await store.get('goal'))!.dispatches).toHaveLength(2)
  })

  it('freezes one exact original Host and current Supervisor notice and preserves its reference after handoff', async () => {
    await store.prepareDispatch('goal', start)
    const before = await store.snapshot()
    await expect(store.prepareDispatchAttention('goal', start.operationId, { ...notice, hostId: 'other-host' })).rejects.toThrow(/original Host/u)
    await expect(store.prepareDispatchAttention('goal', start.operationId, { ...notice, supervisorAgentSessionId: 'worker' })).rejects.toThrow(/current Supervisor/u)
    expect(await store.snapshot()).toEqual(before)
    await store.prepareDispatchAttention('goal', start.operationId, notice)
    const frozen = (await store.inspectDispatch('goal', start.operationId))!
    for (const change of [{ agentMuxNote: notice.agentMuxNote.trim() }, { supervisorRunId: 'other-run' }, { operationId: 'other-op' }, { intentId: 'other-intent' }])
      await expect(store.prepareDispatchAttention('goal', start.operationId, { ...notice, ...change })).rejects.toThrow(/frozen/u)
    await store.update('goal', { supervisorSessionId: 'next-owner' })
    expect((await store.prepareDispatchAttention('goal', start.operationId, notice)).replayed).toBe(true)
    await expect(store.prepareDispatchAttention('goal', start.operationId, { ...notice, supervisorAgentSessionId: 'next-owner' })).rejects.toThrow(/frozen/u)
    expect(await store.inspectDispatch('goal', start.operationId)).toEqual(frozen)
    expect((await store.get('goal'))!).toMatchObject({ status: 'in_progress', alignment: { confirmedAt: null } })
    expect((await store.get('goal'))!.delegations).toBeUndefined()
  })

  it('does not share an original Core notice across different Start or A2A sources, even when business operation names coincide', async () => {
    await store.prepareDispatch('goal', start); await store.prepareDispatchAttention('goal', start.operationId, notice)
    await store.prepareDispatch('goal', { ...start, operationId: 'second-start' })
    await expect(store.prepareDispatchAttention('goal', 'second-start', notice)).rejects.toThrow(/another business source/u)
    const task = { operationId: start.operationId, sourceMessageId: 'source', hostId: 'host', ownerAgentSessionId: 'owner', workerAgentSessionId: 'worker', ownerRunId: 'owner-run', workerRunId: 'worker-run', threadId: 'thread', text: 'Task', alignmentRevision: 1, criterionIds: ['AC'] }
    await store.prepareDelegation('goal', task, 'owner'); await store.linkDelegation('goal', task.operationId, task.sourceMessageId, 'owner')
    await expect(store.prepareDelegationAttention('goal', task.operationId, notice)).rejects.toThrow(/another delegation/u)
    const another = { ...notice, operationId: 'a2a-notice', intentId: 'a2a-intent' }
    await store.prepareDelegationAttention('goal', task.operationId, another)
    await expect(store.prepareDispatchAttention('goal', 'second-start', another)).rejects.toThrow(/another business source/u)
  })

  it.each(['prepare', 'attempt'] as const)('keeps original identities after %s fsync uncertainty and reconciles without repeating the attempt', async phase => {
    await store.prepareDispatch('goal', start)
    if (phase === 'attempt') await store.prepareDispatchAttention('goal', start.operationId, notice)
    const originalOpen = fs.open.bind(fs); let injected = 0
    const fault = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      if (args[0] === root && injected === 0) { injected++; vi.spyOn(handle, 'sync').mockRejectedValueOnce(Object.assign(new Error('isolated Start fsync EIO'), { code: 'EIO' })) }
      return handle
    })
    const action = () => phase === 'prepare' ? store.prepareDispatchAttention('goal', start.operationId, notice) : store.markDispatchAttentionAttempt('goal', start.operationId, notice.operationId)
    await expect(action()).rejects.toMatchObject({ code: 'WRITE_FAILED', replacementApplied: true })
    expect(injected).toBe(1); fault.mockRestore()
    const frozen = (await store.inspectDispatch('goal', start.operationId))!
    expect(frozen.attention).toMatchObject(notice)
    if (phase === 'attempt') expect(frozen.attention!.attemptedAt).toBeGreaterThan(0)
    const before = await store.snapshot()
    expect((await action()).replayed).toBe(true)
    expect(await store.snapshot()).toEqual(before)
    expect((await openDemandStore({ root }).inspectDispatch('goal', start.operationId))!).toEqual(frozen)
    await expect(store.markDispatchAttentionAttempt('goal', start.operationId, 'wrong-op')).rejects.toThrow(/exact original/u)
  })
})
