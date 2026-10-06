import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDemandStore } from '../src/demand-store.js'
import type { DemandDelegationIntent, DemandDelegationReportInput } from '../src/delegations.js'

let root: string, store: ReturnType<typeof openDemandStore>
const execute = promisify(execFile)
const criteria = [{ id: 'AC-01', text: 'Original intent survives' }, { id: 'AC-02', text: 'Report is collected' }]
const collector = { kind: 'agent' as const, id: 'owner' }
function intent(worker = 'worker-a', criterionIds = ['AC-01']): DemandDelegationIntent {
  return { operationId: `delegate-${worker}`, sourceMessageId: `source-${worker}`, hostId: 'host', ownerAgentSessionId: 'owner', workerAgentSessionId: worker,
    ownerRunId: 'owner-run', workerRunId: `${worker}-run`, threadId: 'thread', text: ' Original task body\n with exact whitespace ', requestText: ' Original request\n before material ', alignmentRevision: 1, criterionIds,
    context: [{ kind: 'file', source: 'materials/original.md', revision: 'sha256:original', scope: 'goal/original', availability: 'available' }] }
}
function report(task: DemandDelegationIntent, outcome: 'met' | 'gap' | 'unknown' = 'met'): DemandDelegationReportInput {
  return { operationId: `report-${task.workerAgentSessionId}`, replyMessageId: `reply-${task.workerAgentSessionId}`, authorAgentSessionId: task.workerAgentSessionId,
    grounding: { alignmentRevision: task.alignmentRevision, summary: `Result from ${task.workerAgentSessionId}`, checks: task.criterionIds.map(criterionId => ({ criterionId, outcome,
      evidence: [`evidence/${task.workerAgentSessionId}.log:12`], note: outcome === 'gap' ? 'Original work is still missing' : '' })) } }
}
async function submitted(task: DemandDelegationIntent) {
  await store.prepareDelegation('goal', task, 'owner')
  await store.linkDelegation('goal', task.operationId, task.sourceMessageId, 'owner')
  const result = report(task)
  await store.submitDelegationReport('goal', task.operationId, result, task.workerAgentSessionId)
  return result
}
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'demand-delegation-'))
  store = openDemandStore({ root })
  await store.create({ id: 'goal', title: 'Original Goal', description: 'Original human wording\nkept verbatim', status: 'in_progress',
    assigneeSessionIds: ['owner', 'worker-a', 'worker-b'], supervisorSessionId: 'owner' })
  await store.proposeAlignment('goal', { summary: 'Original standards', criteria, openQuestions: [] })
})
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }) })

describe('Goal delegation responsibility, source and result collection', () => {
  it('freezes exact intent and source identities without changing human fields, and reconciles the original after handoff', async () => {
    const task = intent(), prepared = await store.prepareDelegation('goal', task, 'owner')
    expect(prepared.demand.delegations).toHaveLength(1)
    expect(prepared.demand.delegations![0]).toMatchObject(task)
    expect(prepared.demand.delegations![0]!.capturedCriteria).toEqual([criteria[0]])
    expect(prepared.demand).toMatchObject({ supervisorSessionId: 'owner', status: 'in_progress', description: 'Original human wording\nkept verbatim', alignment: { confirmedAt: null } })
    const frozen = await store.snapshot()
    expect((await store.prepareDelegation('goal', structuredClone(task), 'owner')).replayed).toBe(true)
    await expect(store.prepareDelegation('goal', { ...task, text: task.text.trim() }, 'owner')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(store.prepareDelegation('goal', { ...task, operationId: 'new-operation' }, 'owner')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(store.prepareDelegation('goal', { ...task, workerRunId: 'different-run' }, 'owner')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(store.prepareDelegation('goal', { ...task, requestText: 'different request' }, 'owner')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(store.prepareDelegation('goal', task, 'worker-b')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(await store.snapshot()).toEqual(frozen)
    await store.update('goal', { supervisorSessionId: 'worker-b', assigneeSessionIds: ['worker-b'] })
    await store.proposeAlignment('goal', { summary: 'Changed standards', criteria: [{ id: 'new-AC', text: 'New target' }], openQuestions: [] })
    expect((await store.prepareDelegation('goal', task, 'owner')).replayed).toBe(true)
    expect(await store.inspectDelegation('goal', task.operationId)).toEqual(prepared.demand.delegations![0])
    await expect(store.prepareDelegation('goal', intent('worker-b'), 'owner')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect((await store.get('goal'))!.sessionIds).toEqual(['owner', 'worker-a', 'worker-b'])
  })

  it('rejects wrong target, authority, version and criteria only for that operation while valid original work remains usable', async () => {
    const task = intent(), result = report(task)
    await store.prepareDelegation('goal', task, 'owner')
    const before = await store.snapshot()
    await expect(store.linkDelegation('goal', task.operationId, 'wrong-source', 'owner')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(store.linkDelegation('goal', task.operationId, task.sourceMessageId, 'worker-b')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(store.submitDelegationReport('goal', task.operationId, result, 'worker-a')).rejects.toThrow(/association/u)
    expect(await store.snapshot()).toEqual(before)
    await store.linkDelegation('goal', task.operationId, task.sourceMessageId, 'owner')
    const linked = await store.snapshot()
    await expect(store.submitDelegationReport('goal', task.operationId, result, 'worker-b')).rejects.toThrow(/authenticated worker/u)
    await expect(store.submitDelegationReport('goal', task.operationId, { ...result, grounding: { ...result.grounding, alignmentRevision: 2 } }, 'worker-a')).rejects.toThrow(/version/u)
    await expect(store.submitDelegationReport('goal', task.operationId, { ...result, grounding: { ...result.grounding, checks: [] } }, 'worker-a')).rejects.toThrow(/every delegated/u)
    await expect(store.submitDelegationReport('goal', task.operationId, { ...result, grounding: { ...result.grounding, checks: [{ ...result.grounding.checks[0]!, criterionId: 'AC-02' }] } }, 'worker-a')).rejects.toThrow(/every delegated/u)
    expect(await store.snapshot()).toEqual(linked)
    await store.submitDelegationReport('goal', task.operationId, result, 'worker-a')
    const saved = await store.snapshot()
    expect((await store.submitDelegationReport('goal', task.operationId, result, 'worker-a')).replayed).toBe(true)
    await expect(store.submitDelegationReport('goal', task.operationId, { ...result, grounding: { ...result.grounding, summary: 'A late replacement' } }, 'worker-a')).rejects.toThrow(/frozen/u)
    expect(await store.snapshot()).toEqual(saved)
    expect((await store.get('goal'))!.grounding).toBeUndefined()
  })

  it('explicitly collects two sources into the same current Goal, keeps gaps visible and cannot infer acceptance or done', async () => {
    const a = intent(), b = intent('worker-b', ['AC-02'])
    const first = await submitted(a), second = await submitted(b)
    const before = await store.snapshot()
    await expect(store.collectDelegationReport('goal', a.operationId, { operationId: 'collect-a', replyMessageId: first.replyMessageId }, { kind: 'agent', id: 'worker-b' })).rejects.toThrow(/Supervisor/u)
    await expect(store.collectDelegationReport('goal', a.operationId, { operationId: 'collect-a', replyMessageId: second.replyMessageId }, collector)).rejects.toThrow(/exact original/u)
    expect(await store.snapshot()).toEqual(before)
    const collectedA = await store.collectDelegationReport('goal', a.operationId, { operationId: 'collect-a', replyMessageId: first.replyMessageId }, collector)
    expect(collectedA.demand.grounding!.checks).toEqual([first.grounding.checks[0], { criterionId: 'AC-02', outcome: 'unknown', evidence: [], note: 'No collected report for this current success criterion.' }])
    expect(collectedA.demand.delegations![1]!.collection).toBeUndefined()
    const collectedB = await store.collectDelegationReport('goal', b.operationId, { operationId: 'collect-b', replyMessageId: second.replyMessageId }, collector)
    expect(collectedB.demand.grounding!.checks).toEqual([...first.grounding.checks, ...second.grounding.checks])
    expect(collectedB.demand.grounding!.summary).toContain(a.sourceMessageId)
    expect(collectedB.demand.grounding!.summary).toContain(b.sourceMessageId)
    expect(collectedB.demand.grounding!.acceptedAt).toBeNull()
    expect(collectedB.demand.alignment!.confirmedAt).toBeNull()
    expect(collectedB.demand.status).toBe('in_progress')
    expect(collectedB.demand.supervisorSessionId).toBe('owner')
    expect(collectedB.demand.delegations).toHaveLength(2)
    expect(collectedB.demand.delegations![1]!.collection!.groundingSubmissionId).toBe(collectedB.demand.grounding!.submissionId)
    const frozen = await store.snapshot()
    expect((await store.collectDelegationReport('goal', a.operationId, { operationId: 'collect-a', replyMessageId: first.replyMessageId }, collector)).replayed).toBe(true)
    expect(await store.snapshot()).toEqual(frozen)
    await expect(store.collectDelegationReport('goal', a.operationId, { operationId: 'new-collect', replyMessageId: first.replyMessageId }, collector)).rejects.toThrow(/already collected/u)
    expect(await store.snapshot()).toEqual(frozen)
  })

  it('retains conflicting source evidence as unknown instead of guessing a newer or successful report', async () => {
    const a = intent(), b = intent('worker-b', ['AC-01'])
    await submitted(a)
    await store.prepareDelegation('goal', b, 'owner'); await store.linkDelegation('goal', b.operationId, b.sourceMessageId, 'owner')
    const second = report(b, 'gap'); await store.submitDelegationReport('goal', b.operationId, second, 'worker-b')
    await store.collectDelegationReport('goal', a.operationId, { operationId: 'collect-a', replyMessageId: report(a).replyMessageId }, collector)
    const result = await store.collectDelegationReport('goal', b.operationId, { operationId: 'collect-b', replyMessageId: second.replyMessageId }, { kind: 'user', id: 'trusted-person' })
    expect(result.demand.grounding!.checks).toHaveLength(2)
    expect(result.demand.grounding!.checks[0]).toEqual({ criterionId: 'AC-01', outcome: 'unknown', evidence: [...report(a).grounding.checks[0]!.evidence, ...second.grounding.checks[0]!.evidence],
      note: 'Conflicting reports: reply-worker-a, reply-worker-b. Review the original reports.' })
    expect(result.demand.delegations![1]!.collection!.collector).toEqual({ kind: 'user', id: 'trusted-person' })
    await store.confirmAlignment('goal', 1)
    await expect(store.acceptGrounding('goal', 1, result.demand.grounding!.submissionId, true)).rejects.toThrow(/unknown/u)
  })

  it('keeps late reports grounded in their captured old standards and never overwrites current human acceptance', async () => {
    const a = intent(), first = await submitted(a)
    await store.proposeAlignment('goal', { summary: 'Revised', criteria, openQuestions: [] })
    await store.collectDelegationReport('goal', a.operationId, { operationId: 'old-collect', replyMessageId: first.replyMessageId }, collector)
    expect((await store.get('goal'))!.grounding).toBeUndefined()
    expect((await store.inspectDelegation('goal', a.operationId))!.capturedCriteria).toEqual([criteria[0]])
    const b = { ...intent('worker-b', ['AC-01', 'AC-02']), alignmentRevision: 2 }
    const second = await submitted(b)
    await store.confirmAlignment('goal', 2)
    const acceptedProposal = await store.proposeGrounding('goal', second.grounding)
    const accepted = (await store.acceptGrounding('goal', 2, acceptedProposal.demand.grounding!.submissionId)).demand.grounding!
    await store.collectDelegationReport('goal', b.operationId, { operationId: 'late-collect', replyMessageId: second.replyMessageId }, collector)
    expect((await store.get('goal'))!.grounding).toEqual(accepted)
    const collected = (await store.inspectDelegation('goal', b.operationId))!.collection!
    expect(collected.groundingSubmissionId).toBeUndefined()
    expect(collected.replyMessageId).toBe(second.replyMessageId)
  })

  it('reads the actual persisted responsibility and report from a new process without reseeding', async () => {
    const a = intent('worker-a', ['AC-01', 'AC-02']), first = await submitted(a)
    await store.collectDelegationReport('goal', a.operationId, { operationId: 'collect-a', replyMessageId: first.replyMessageId }, collector)
    const expected = await store.get('goal')
    const modulePath = new URL('../dist/src/demand-store.js', import.meta.url).href
    const script = `import { openDemandStore } from ${JSON.stringify(modulePath)}; process.stdout.write(JSON.stringify(await openDemandStore({ root: ${JSON.stringify(root)} }).get('goal')))`
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script])
    expect(JSON.parse(stdout)).toEqual(expected)
  })

  it.each(['prepare', 'report', 'recover', 'collect'] as const)('reconciles the original %s after snapshot replacement but before a durable receipt, without duplicate work', async phase => {
    const a = intent('worker-a', ['AC-01', 'AC-02']), first = report(a)
    if (phase !== 'prepare') { await store.prepareDelegation('goal', a, 'owner'); await store.linkDelegation('goal', a.operationId, a.sourceMessageId, 'owner') }
    if (phase === 'collect') await store.submitDelegationReport('goal', a.operationId, first, 'worker-a')
    const originalOpen = fs.open.bind(fs)
    let injected = 0
    const failure = Object.assign(new Error('isolated directory sync EIO'), { code: 'EIO' })
    const fault = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      if (args[0] === root && injected === 0) { injected++; vi.spyOn(handle, 'sync').mockRejectedValueOnce(failure) }
      return handle
    })
    const perform = () => phase === 'prepare' ? store.prepareDelegation('goal', a, 'owner') : phase === 'report' ? store.submitDelegationReport('goal', a.operationId, first, 'worker-a') :
      phase === 'recover' ? store.recoverDelegationReport('goal', a.operationId, first, collector) :
      store.collectDelegationReport('goal', a.operationId, { operationId: 'collect-a', replyMessageId: first.replyMessageId }, collector)
    await expect(perform()).rejects.toMatchObject({ code: 'WRITE_FAILED', phase: 'write', replacementApplied: true })
    expect(injected).toBe(1); fault.mockRestore()
    const observed = await store.inspectDelegation('goal', a.operationId)
    expect(observed).toMatchObject(a)
    const persisted = await store.snapshot(), reconciled = await perform()
    expect(reconciled.replayed).toBe(true)
    expect(await store.snapshot()).toEqual(persisted)
    expect(reconciled.demand.delegations).toHaveLength(1)
    if (phase !== 'prepare') expect(observed!.report).toMatchObject(first)
    if (phase === 'collect') expect(observed!.collection).toMatchObject({ operationId: 'collect-a', replyMessageId: first.replyMessageId })
    expect(reconciled.demand.supervisorSessionId).toBe('owner')
    expect(reconciled.demand.status).toBe('in_progress')
  })

  it('rejects business payload provenance and forgery without losing original responsibility', async () => {
    await store.prepareDelegation('goal', intent(), 'owner')
    const before = await store.snapshot()
    await expect(store.update('goal', { delegations: [] } as any)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(store.prepareDelegation('goal', { ...intent('worker-b'), preparedAt: _reshape_fixtureEpoch(0, 0, 1) } as any, 'owner')).rejects.toThrow(/unsupported/u)
    await expect(store.submitDelegationReport('goal', intent().operationId, { ...report(intent()), acceptedAt: _reshape_fixtureEpoch(0, 0, 1) } as any, 'worker-a')).rejects.toThrow(/unsupported/u)
    await expect(store.collectDelegationReport('goal', intent().operationId, { operationId: 'collect', replyMessageId: 'reply', groundingSubmissionId: 'forged' } as any, collector)).rejects.toThrow(/unsupported/u)
    expect(await store.snapshot()).toEqual(before)
  })

  it('recovers Main-verified original worker evidence with the actual collector after the worker can no longer report', async () => {
    const a = intent('worker-a', ['AC-01', 'AC-02']), first = report(a)
    await store.prepareDelegation('goal', a, 'owner'); await store.linkDelegation('goal', a.operationId, a.sourceMessageId, 'owner')
    const before = await store.snapshot()
    await expect(store.recoverDelegationReport('goal', a.operationId, first, { kind: 'agent', id: 'worker-b' })).rejects.toThrow(/recover the verified/u)
    await expect(store.recoverDelegationReport('goal', a.operationId, first, { kind: 'agent', id: 'worker-a' })).rejects.toThrow(/recover the verified/u)
    await expect(store.recoverDelegationReport('goal', a.operationId, { ...first, authorAgentSessionId: 'owner' }, collector)).rejects.toThrow(/original worker/u)
    expect(await store.snapshot()).toEqual(before)
    const recovered = await store.recoverDelegationReport('goal', a.operationId, first, collector)
    const restored = recovered.demand.delegations![0]!.report!
    expect(restored).toMatchObject({ ...first, recovery: { collector } })
    expect(restored.recovery!.recoveredAt).toBeGreaterThan(0)
    expect(restored.authorAgentSessionId).toBe('worker-a')
    expect(recovered.demand.grounding).toBeUndefined()
    const saved = await store.snapshot()
    expect((await store.recoverDelegationReport('goal', a.operationId, first, { kind: 'user', id: 'person' })).replayed).toBe(true)
    expect((await store.submitDelegationReport('goal', a.operationId, first, 'worker-a')).replayed).toBe(true)
    expect(await store.snapshot()).toEqual(saved)
    await expect(store.recoverDelegationReport('goal', a.operationId, { ...first, grounding: { ...first.grounding, summary: 'Different claim' } }, collector)).rejects.toThrow(/frozen/u)
    expect(await store.snapshot()).toEqual(saved)
    const collected = await store.collectDelegationReport('goal', a.operationId, { operationId: 'collect-recovered', replyMessageId: first.replyMessageId }, collector)
    expect(collected.demand.grounding!.checks).toEqual(first.grounding.checks)
    expect(collected.demand.grounding!.acceptedAt).toBeNull()
    expect(collected.demand.delegations![0]!.report).toEqual(restored)
    expect(collected.demand.status).toBe('in_progress')
  })

  it('admits the explicitly handed-off current Supervisor to recover old-version evidence without changing the original author or acceptance', async () => {
    const a = intent(), first = report(a)
    await store.prepareDelegation('goal', a, 'owner'); await store.linkDelegation('goal', a.operationId, a.sourceMessageId, 'owner')
    await store.update('goal', { supervisorSessionId: 'worker-b' })
    await store.proposeAlignment('goal', { summary: 'Changed target', criteria, openQuestions: [] })
    const recovered = await store.recoverDelegationReport('goal', a.operationId, first, { kind: 'agent', id: 'worker-b' })
    expect(recovered.demand.delegations![0]!.report).toMatchObject({ authorAgentSessionId: 'worker-a', grounding: { alignmentRevision: 1 }, recovery: { collector: { kind: 'agent', id: 'worker-b' } } })
    const collected = await store.collectDelegationReport('goal', a.operationId, { operationId: 'handoff-collect', replyMessageId: first.replyMessageId }, { kind: 'agent', id: 'worker-b' })
    expect(collected.demand.supervisorSessionId).toBe('worker-b')
    expect(collected.demand.grounding).toBeUndefined()
    expect(collected.demand.alignment!.confirmedAt).toBeNull()
  })

  it('does not let an original source or reply identity be reassigned to another Goal or delegation', async () => {
    const a = intent(), first = await submitted(a)
    await store.create({ id: 'other-goal', title: 'Other Goal', assigneeSessionIds: ['owner', 'worker-a', 'worker-b'], supervisorSessionId: 'owner' })
    await store.proposeAlignment('other-goal', { summary: 'Other standards', criteria, openQuestions: [] })
    const before = await store.snapshot()
    await expect(store.prepareDelegation('other-goal', a, 'owner')).rejects.toThrow(/different Goal/u)
    await expect(store.prepareDelegation('other-goal', { ...a, operationId: 'new-operation' }, 'owner')).rejects.toThrow(/different Goal/u)
    expect(await store.snapshot()).toEqual(before)
    const b = intent('worker-b')
    await store.prepareDelegation('other-goal', b, 'owner'); await store.linkDelegation('other-goal', b.operationId, b.sourceMessageId, 'owner')
    const saved = await store.snapshot()
    await expect(store.submitDelegationReport('other-goal', b.operationId, { ...report(b), operationId: first.operationId }, 'worker-b')).rejects.toThrow(/another delegation/u)
    await expect(store.submitDelegationReport('other-goal', b.operationId, { ...report(b), replyMessageId: first.replyMessageId }, 'worker-b')).rejects.toThrow(/another delegation/u)
    expect(await store.snapshot()).toEqual(saved)
    await store.submitDelegationReport('other-goal', b.operationId, report(b), 'worker-b')
    await store.collectDelegationReport('goal', a.operationId, { operationId: 'collect-a', replyMessageId: first.replyMessageId }, collector)
    const collected = await store.snapshot()
    await expect(store.collectDelegationReport('other-goal', b.operationId, { operationId: 'collect-a', replyMessageId: report(b).replyMessageId }, collector)).rejects.toThrow(/another delegation/u)
    expect(await store.snapshot()).toEqual(collected)
  })
})
