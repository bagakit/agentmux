import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createMoteConversationStartFixture } from './helpers/mote-conversation-start-fixture.js'
import { moteQuickBaseline } from '../../../packages/core/src/mote/preferences.js'
import { moteMainBaseline } from '../../../packages/core/src/spatial-graph.js'
import { parseMoteMainRolloverDecision } from '../../../packages/core/src/mote/main-period.js'
import { parseMoteDialogueResult } from '../../../packages/core/src/mote/dialogue-contract.js'
import { runSourceObjectCli } from '../../../packages/core/test/helpers/source-object-cli.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture() {
  const f = await createMoteConversationStartFixture(); closes.push(f.close)
  const configPath = join(f.h.root, 'configuration.json'), config = JSON.parse(await readFile(configPath, 'utf8'))
  config.executors.second = { ...config.executors.saved, label: 'Another Executor of the same Provider', env: { SECOND_EXECUTOR: 'exact-original-choice' } }
  config.executors.third = { ...config.executors.saved, label: 'Later explicit choice' }
  await writeFile(configPath, JSON.stringify(config))
  await f.start('original-main', 'Original human Query'); const original = await f.setup('original-main')
  expect(original.binding, original.issue ?? '').toBe('confirmed')
  const main = await f.main.readCurrentMoteMain(f.target), ref = main.current!, session = (await f.h.client.readAgentSession(ref.sessionId))!
  const choose = async (executorId: string) => {
    const read = await f.quick.read({ kind: 'quick', target: f.target }), baseline = moteQuickBaseline(read)!
    const saved = await f.rpc.call('space.mote.preferences.save', { kind: 'quick', target: f.target, operationId: 'choose-' + executorId,
      baseline, values: { ...baseline.defaults, executorId, conversationRollover: { kind: 'keep-current' } },
      destination: { kind: 'occurrence', displayWorkspaceId: ref.displayWorkspaceId, groupId: ref.groupId, tabId: ref.tabId, regionId: ref.regionId } })
    expect(saved.status, saved.message ?? '').toBe('saved')
  }
  const query = (operationId: string) => ({ target: f.target, expectedRoleRevision: main.roleRevision!, input: {
    agentSessionId: ref.sessionId, expectedRun: session.run, operationId, prompt: 'New human Query ' + operationId,
    admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const } })
  return { ...f, original, main, ref, session, choose, query }
}

it('changing default Executor lazily rotates the next new Query through original Core setup even under keep-current idle policy', async () => {
  const f = await fixture(), writes = f.h.inner.kernel.input.mock.calls.length
  await f.choose('second')
  await f.rpc.call('space.mote.dialogue.read', { target: f.target, kind: 'main' })
  expect(f.h.started).toHaveLength(1); expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(writes)
  const input = f.query('next-with-second'), due = await f.rpc.call('space.mote.dialogue.input.submit', input)
  expect(due.disposition).toBe('rollover-required'); expect(due.route).toBeNull()
  const decision = due.rollover!.decision!
  expect(decision).toMatchObject({ reference: f.ref, expectedRoleRevision: f.main.roleRevision, queryOperationId: input.input.operationId,
    policy: { kind: 'executor-change', previousExecutorId: 'saved', executorId: 'second' } })
  expect(decision.activity).toBeUndefined()
  expect(parseMoteMainRolloverDecision(decision)).toEqual(decision)
  expect(() => parseMoteDialogueResult('space.mote.dialogue.input.submit', { ...due, rollover: { ...due.rollover,
    decision: { ...decision, queryInputKey: { ...decision.queryInputKey, expectedRun: { runId: 'another-original-run' } } } } }, input))
    .toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  for (const code of ['CONTROL_PROTOCOL_ERROR', 'INVALID_CLI_ARGUMENT'] as const) {
    expect(() => parseMoteMainRolloverDecision({ ...decision, queryInputKey: { ...decision.queryInputKey, expectedRun: null } }, code)).toThrow(expect.objectContaining({ code }))
    expect(() => parseMoteMainRolloverDecision({ ...decision, policy: { ...decision.policy, previousExecutorId: 'second' } }, code)).toThrow(expect.objectContaining({ code }))
  }
  expect(f.h.started).toHaveLength(1); expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(writes)
  const repeated = await f.rpc.call('space.mote.dialogue.input.submit', input)
  expect(repeated.rollover?.decision?.creationOperationId).toBe(decision.creationOperationId)
  const read = await f.quick.read({ kind: 'quick', target: f.target })
  const opened = await f.rpc.call('agent.open', { operationId: decision.creationOperationId, content: { kind: 'new-agent', executorId: 'second' },
    destination: { spaceId: f.target.spaceId, zoneId: f.target.zoneId, newTab: true }, focus: false,
    moteMain: { target: f.target, baseline: moteMainBaseline(moteQuickBaseline(read)!), expectedRoleRevision: f.main.roleRevision,
      sourceOperationId: decision.creationOperationId + ':source', bindOperationId: decision.creationOperationId + ':bind',
      handover: true, rollover: decision, deferredInput: { operationId: input.input.operationId, prompt: input.input.prompt } } })
  expect(opened.outcome, JSON.stringify(opened.issues)).toBe('opened')
  const settled = await f.setup(decision.creationOperationId)
  expect(settled.binding, settled.issue ?? '').toBe('confirmed')
  expect(settled.reference?.sessionId).not.toBe(f.ref.sessionId)
  expect((await f.h.client.readAgentSession(settled.reference!.sessionId))?.executorId).toBe('second')
  expect(f.h.started[1].env).toMatchObject({ SECOND_EXECUTOR: 'exact-original-choice' })
  expect(settled.deferredInput?.route?.key.submissionId).toBe(input.input.operationId)
  const after = f.h.inner.kernel.input.mock.calls.length
  await f.setup(decision.creationOperationId)
  expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(after)
  const retained = await f.rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: 'original-main_query' })
  expect(retained.route).toEqual(f.original.deferredInput!.route)
  expect(await f.h.client.readAgentSession(f.ref.sessionId)).toBeTruthy()
  const periods = (await f.rpc.call('space.mote.dialogue.read', { target: f.target, kind: 'main' })).links.flatMap(l => l.kind === 'main' && l.period ? [l.period] : [])
  expect(periods.find(p => p.roleRevision === f.main.roleRevision)?.end).toMatchObject({ kind: 'automatic', decision: { policy: { kind: 'executor-change', executorId: 'second' } } })
  expect(f.h.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.h.started).toHaveLength(2)
}, 45_000)

it('the original input route stays on its admitted Executor after settings change while a separate CLI Query receives the new decision', async () => {
  const f = await fixture(), input = f.query('admitted-before-change'), admitted = await f.rpc.call('space.mote.dialogue.input.submit', input)
  const originalWrites = () => f.h.inner.kernel.input.mock.calls.filter(call => String(call[1]?.data).includes(input.input.prompt))
  await vi.waitFor(() => expect(originalWrites()).toHaveLength(1))
  await f.choose('second')
  const same = await f.rpc.call('space.mote.dialogue.input.submit', input)
  expect(same.route).toEqual(admitted.route); expect(same.rollover).toEqual(admitted.rollover)
  expect(originalWrites()).toHaveLength(1)
  const fresh = f.query('new-cli-query'), cli = await runSourceObjectCli(['--endpoint', 'unix:' + f.server.path,
    'space', 'mote', 'dialogue', 'input', 'submit', '--input', '-'], objectCliEnvironment(f.h.root), JSON.stringify(fresh), 30_000)
  expect(cli.code, cli.stderr || cli.stdout).toBe(0)
  expect(JSON.parse(cli.stdout).result.rollover.decision.policy).toEqual({ kind: 'executor-change', previousExecutorId: 'saved', executorId: 'second' })
  expect(f.h.started).toHaveLength(1); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)

it('a Query already owned by the original input producer cannot become a new Executor-change Query', async () => {
  const f = await fixture(), request = f.query('original-producer-input')
  await f.h.client.submitAgentPrompt(request.input)
  await f.choose('second')
  await expect(f.rpc.call('space.mote.dialogue.input.submit', request)).rejects.toMatchObject({ code: 'MOTE_MAIN_INPUT_PREEXISTING' })
  const key = { kind: 'prompt' as const, agentSessionId: f.ref.sessionId, expectedRun: f.session.run, submissionId: request.input.operationId }
  expect(await f.h.client.inspectAgentInput({ key })).toMatchObject({ key, persistence: 'confirmed' })
  expect(f.h.inner.kernel.input.mock.calls.filter((call: any[]) => String(call[1]?.data).includes(request.input.prompt)).length).toBeLessThanOrEqual(1)
  expect(f.h.started).toHaveLength(1); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)

it('a later default choice refuses a stale Executor-change creation and retains the original Main and unsent Query', async () => {
  const f = await fixture(); await f.choose('second')
  const request = f.query('stale-executor-choice'), due = await f.rpc.call('space.mote.dialogue.input.submit', request), decision = due.rollover!.decision!
  const read = await f.quick.read({ kind: 'quick', target: f.target })
  await f.choose('third')
  await expect(f.rpc.call('agent.open', { operationId: decision.creationOperationId, content: { kind: 'new-agent', executorId: 'second' },
    destination: { spaceId: f.target.spaceId, zoneId: f.target.zoneId, newTab: true }, focus: false,
    moteMain: { target: f.target, baseline: moteMainBaseline(moteQuickBaseline(read)!), expectedRoleRevision: f.main.roleRevision,
      sourceOperationId: 'stale-source', bindOperationId: 'stale-bind', rollover: decision,
      deferredInput: { operationId: request.input.operationId, prompt: request.input.prompt } } })).rejects.toMatchObject({ code: 'MOTE_MAIN_CHANGED' })
  expect(f.h.started).toHaveLength(1); expect((await f.rpc.call('space.mote.dialogue.read', { target: f.target, kind: 'main' })).main.current).toEqual(f.ref)
  expect((await f.rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: request.input.operationId })).route).toBeNull()
  expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)

it.each(['missing-executor', 'read-failed'] as const)('an %s original Executor comparison retains the new Query rather than dispatching it to the old Main', async failure => {
  const f = await fixture(); await f.choose('second')
  const read = f.h.client.readAgentSession.bind(f.h.client)
  vi.spyOn(f.h.client, 'readAgentSession').mockImplementation(async id => {
    const original = await read(id)
    if (id !== f.ref.sessionId || !original) return original
    if (failure === 'read-failed') throw Error('Original Executor metadata unavailable')
    return { ...original, executorId: '' }
  })
  const request = f.query('unknown-original-executor-' + failure)
  const submit = vi.spyOn(f.h.client, 'submitAgentPrompt')
  await expect(f.rpc.call('space.mote.dialogue.input.submit', request)).rejects.toMatchObject({ code: 'MOTE_CHAT_EXECUTOR_UNCONFIRMED' })
  expect(submit).not.toHaveBeenCalled()
  expect((await f.rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: request.input.operationId })).route).toBeNull()
  expect((await f.rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: 'original-main_query' })).route?.reference).toEqual(f.ref)
  expect(f.h.started).toHaveLength(1); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)

it('a Query accepted by its original producer after the rollover reading cannot authorize a new Main at agent.open', async () => {
  const f = await fixture(); await f.choose('second')
  const request = f.query('accepted-after-decision'), due = await f.rpc.call('space.mote.dialogue.input.submit', request), decision = due.rollover!.decision!
  expect(decision.queryInputKey).toEqual({ kind: 'prompt', agentSessionId: f.ref.sessionId, expectedRun: f.session.run, submissionId: request.input.operationId })
  await f.h.client.submitAgentPrompt(request.input)
  const read = await f.quick.read({ kind: 'quick', target: f.target })
  await expect(f.rpc.call('agent.open', { operationId: decision.creationOperationId, content: { kind: 'new-agent', executorId: 'second' },
    destination: { spaceId: f.target.spaceId, zoneId: f.target.zoneId, newTab: true }, focus: false,
    moteMain: { target: f.target, baseline: moteMainBaseline(moteQuickBaseline(read)!), expectedRoleRevision: f.main.roleRevision,
      sourceOperationId: 'late-source', bindOperationId: 'late-bind', rollover: decision,
      deferredInput: { operationId: request.input.operationId, prompt: request.input.prompt } } })).rejects.toMatchObject({ code: 'MOTE_MAIN_INPUT_PREEXISTING' })
  expect(f.h.started).toHaveLength(1); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)

it('a stale original Run cannot bypass its input key by requesting Executor rollover', async () => {
  const f = await fixture(); await f.choose('second')
  const request = f.query('stale-run-query')
  request.input.expectedRun = { runId: 'earlier-unrelated-run' }
  const submit = vi.spyOn(f.h.client, 'submitAgentPrompt')
  await expect(f.rpc.call('space.mote.dialogue.input.submit', request)).rejects.toMatchObject({ code: 'MOTE_MAIN_CHANGED' })
  expect(submit).not.toHaveBeenCalled(); expect(f.h.started).toHaveLength(1); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)

it.each(['catalog', 'executors'] as const)('an unavailable %s observation retains the saved Executor choice from its original MOTE rather than sending to the old Main', async port => {
  const f = await fixture(); await f.choose('second')
  const fault = vi.spyOn(f.quickPorts, port).mockRejectedValue(Error('Original ' + port + ' observation unavailable'))
  const preference = await f.quick.read({ kind: 'quick', target: f.target })
  expect(preference.status).toBe('ready'); expect(preference.defaults?.executorId).toBe('second')
  expect(preference.choices?.issues?.[port === 'catalog' ? 'locations' : 'executors']).toContain('Original ' + port + ' observation unavailable')
  const request = f.query('choice-known-observation-failed-' + port), submit = vi.spyOn(f.h.client, 'submitAgentPrompt')
  const due = await f.rpc.call('space.mote.dialogue.input.submit', request)
  expect(due.disposition).toBe('rollover-required'); expect(due.rollover?.decision?.policy).toMatchObject({ kind: 'executor-change', executorId: 'second' })
  expect(due.route).toBeNull(); expect(submit).not.toHaveBeenCalled()
  expect((await f.rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: 'original-main_query' })).route?.reference).toEqual(f.ref)
  fault.mockRestore()
  const retry = await f.rpc.call('space.mote.dialogue.input.submit', request)
  expect(retry.rollover?.decision?.creationOperationId).toBe(due.rollover?.decision?.creationOperationId)
  expect(f.h.started).toHaveLength(1); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)

it('an unavailable preference read retains the exact new Query until its original saved Executor choice is known', async () => {
  const f = await fixture(); await f.choose('second')
  const fault = vi.spyOn(f.quick, 'read').mockRejectedValue(Error('Original settings observation unavailable'))
  const request = f.query('preference-unavailable'), submit = vi.spyOn(f.h.client, 'submitAgentPrompt')
  await expect(f.rpc.call('space.mote.dialogue.input.submit', request)).rejects.toMatchObject({ code: 'MOTE_CHAT_EXECUTOR_UNCONFIRMED' })
  expect(submit).not.toHaveBeenCalled()
  expect((await f.rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: request.input.operationId })).route).toBeNull()
  expect((await f.rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: 'original-main_query' })).route?.reference).toEqual(f.ref)
  fault.mockRestore()
  expect((await f.rpc.call('space.mote.dialogue.input.submit', request)).rollover?.decision?.policy).toMatchObject({ kind: 'executor-change', executorId: 'second' })
  expect(f.h.started).toHaveLength(1); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)
