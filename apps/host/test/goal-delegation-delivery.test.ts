import { afterEach, expect, it, vi } from 'vitest'
import { crossHostOwner, type CrossHostCleanup } from './helpers/goal-cross-host-fixture.js'

// Each case drives real Hosts through separate public CLI processes.
vi.setConfig({ testTimeout: 60_000 })
const cleanup: CrossHostCleanup = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
type Owner = Awaited<ReturnType<typeof crossHostOwner>>
async function pin(source: Owner, target: Owner) {
  const a = await source.call(null, ['settings', 'hosts', 'message-trusted-sources', '--host', 'local'])
  const b = await target.call(null, ['settings', 'hosts', 'message-trusted-sources', '--host', 'local'])
  await target.call(null, ['settings', 'hosts', 'trust-message-source', '--host', 'local', '--input', '-'], {
    sourceRuntimeId: a.authority.runtimeId, publicKey: a.authority.publicKey,
    targetRuntimeId: b.authority.runtimeId, targetKeyFingerprint: b.authority.fingerprint
  })
}
async function fixture() {
  const a = await crossHostOwner(cleanup, 'delivery-owner', ['same-session'])
  const b = await crossHostOwner(cleanup, 'delivery-worker', ['same-session'])
  const goalId = (await a.call('same-session', ['goal', 'create', '--title', 'Deliver exactly once', '--session', 'same-session', '--assignees', '["same-session"]',
    '--supervisor', 'same-session', '--risk', 'low', '--confirm', 'user', '--operation-id', 'create-delivery-goal'])).goal.id
  const criteria = [{ id: 'delivery-criterion', text: 'Retain original work and verify target receipt.' }]
  const aligned = await a.call(null, ['goal', 'update', '--goal', goalId, '--alignment', JSON.stringify({ summary: 'Original delivery target', criteria, openQuestions: [] })])
  a.routes([{ hostId: 'worker-host', client: b.reader }]); b.routes([])
  const published = await a.call('same-session', ['goal', 'plan', 'revise', '--input', '-'], { goalId, revision: { operationId: 'delivery-plan', expectedRevision: 0,
    alignmentRevision: aligned.goal.alignment.revision, nodes: [{ id: 'first', title: 'Original work', outcome: 'One received source', dependsOn: [],
      criterionIds: ['delivery-criterion'], check: 'node --test checks/delivery.test.mjs', executor: { hostId: 'worker-host', agentSessionId: 'same-session' } }] } })
  const intent = { operationId: 'delivery-operation', sourceMessageId: 'delivery-source', hostId: 'local', workerHostId: 'worker-host',
    ownerAgentSessionId: 'same-session', workerAgentSessionId: 'same-session', ownerRunId: 'run-same-session', workerRunId: 'run-same-session',
    threadId: 'delivery-thread', text: 'Deliver this original task once.', alignmentRevision: aligned.goal.alignment.revision, criterionIds: ['delivery-criterion'], planNodeId: published.plan.nodes[0].id as string }
  const input = { goalId, intent }
  const read = () => a.call('same-session', ['goal', 'delegations', '--goal', goalId])
  const incoming = () => b.call('same-session', ['message', 'read', '--host', 'local', '--message-id', intent.sourceMessageId])
  // Observe the real first-save notification hook; do not replace the Core intake owner.
  const notifications = vi.spyOn((b.client() as unknown as { messageNotifications: { saved(id: string): void } }).messageNotifications, 'saved')
  return { a, b, goalId, criteria, input, intent, read, incoming, notifications }
}

it('retries only an explicit original delegation after missing trust and lost target ACK without accepting an outbox or duplicating the B input', async () => {
  const f = await fixture()
  const denied = await f.a.cli('same-session', ['goal', 'delegate', '--input', '-'], f.input)
  expect(denied.code).toBe(1); expect(denied.stderr).toContain('TRUST')
  const outbox = await f.a.call('same-session', ['message', 'read', '--host', 'local', '--message-id', f.intent.sourceMessageId])
  expect(outbox.message).toMatchObject({ deliveryMode: 'outbox', transport: { state: 'outbox', targetRuntimeId: f.b.identity.runtimeId } })
  expect((await f.incoming()).message).toBeNull()
  expect((await f.read()).delegations[0]).not.toHaveProperty('linkedAt')
  const attempts = f.b.forwarded.filter(row => row.method === 'message.federation.intake').length
  await pin(f.a, f.b)
  // Read/observe never replays the source, even after trust becomes available.
  expect((await f.read()).delegations[0]).not.toHaveProperty('linkedAt')
  expect((await f.incoming()).message).toBeNull()
  expect(f.b.forwarded.filter(row => row.method === 'message.federation.intake')).toHaveLength(attempts)
  f.b.loseNextIntakeAck()
  const lost = await f.a.cli('same-session', ['goal', 'delegate', '--input', '-'], f.input)
  expect(lost.code).toBe(1); expect(lost.stderr).toContain('CONTROL_UNAVAILABLE')
  const received = (await f.incoming()).message
  expect(received).toMatchObject({ envelope: { messageId: f.intent.sourceMessageId, operationId: f.intent.operationId }, transport: { state: 'received' } })
  expect((await f.read()).delegations[0]).not.toHaveProperty('linkedAt')
  const notificationCount = f.notifications.mock.calls.length
  // Challenge the Host's success boundary with an outbox-shaped intake response.
  const forward = f.b.reader.forwardRpc!.bind(f.b.reader)
  const responseFault = vi.spyOn(f.b.reader, 'forwardRpc').mockImplementation(async (method, params, context, owner) => {
    const result = await forward(method, params, context, owner)
    return (method === 'message.federation.intake' ? { ...(result as object), deliveryMode: 'outbox',
      transport: { state: 'outbox', targetRuntimeId: f.b.identity.runtimeId } } : result) as never
  })
  const unconfirmed = await f.a.cli('same-session', ['goal', 'delegate', '--input', '-'], f.input)
  responseFault.mockRestore()
  expect(unconfirmed.code).toBe(1); expect(unconfirmed.stderr).toContain('CONTROL_UNAVAILABLE')
  expect((await f.read()).delegations[0]).not.toHaveProperty('linkedAt')
  const confirmed = await f.a.call('same-session', ['goal', 'delegate', '--input', '-'], f.input)
  expect(confirmed.delegations[0]).toMatchObject({ operationId: f.intent.operationId, sourceMessageId: f.intent.sourceMessageId, linkedAt: expect.any(Number),
    runtimeIdentity: { ownerRuntimeId: f.a.identity.runtimeId, workerRuntimeId: f.b.identity.runtimeId } })
  expect((await f.incoming()).message).toEqual(received)
  expect(f.notifications.mock.calls).toHaveLength(notificationCount)
  const inbox = await f.b.call('same-session', ['message', 'ls', '--direction', 'incoming', '--host', 'local'])
  expect(inbox.messages.map((message: { envelope: { messageId: string } }) => message.envelope.messageId)).toEqual([f.intent.sourceMessageId])
  f.a.routes([])
  const retained = await f.a.call('same-session', ['goal', 'delegate', '--input', '-'], f.input)
  expect(retained.delegations[0].linkedAt).toBe(confirmed.delegations[0].linkedAt)
  expect(retained.observations[0].unknown).toContain('unconfirmed')
  expect(f.a.native.stop).not.toHaveBeenCalled(); expect(f.b.native.stop).not.toHaveBeenCalled()
})

it('the public plan reader names why a node needs reconciliation: an unconfirmed link, then criteria changed after the attempt was sent', async () => {
  const f = await fixture(), read = () => f.a.call('same-session', ['goal', 'plan', '--goal', f.goalId]), plan = async () => (await read()).planState
  const saved = (await read()).plan
  const revised = await f.a.call('same-session', ['goal', 'plan', 'revise', '--input', '-'], { goalId: f.goalId, revision: { operationId: 'delivery-plan-dependent',
    expectedRevision: saved.revision, alignmentRevision: saved.alignmentRevision, nodes: [...saved.nodes, { id: 'second', title: 'Dependent work',
      outcome: 'Builds on the received source', dependsOn: [f.intent.planNodeId], criterionIds: ['delivery-criterion'], check: 'node --test checks/second.test.mjs', executor: null }] } })
  const attempt = { delegationOperationId: f.intent.operationId, sourceMessageId: f.intent.sourceMessageId, threadId: f.intent.threadId,
    workerHostId: 'worker-host', workerAgentSessionId: 'same-session', reported: false }
  const second = { id: revised.plan.nodes[1].id, state: 'waiting', column: 1, unknown: [], attempt: null }
  expect(await plan()).toMatchObject({ revision: 2, done: 0, total: 2, next: [f.intent.planNodeId], nodes: [{ id: f.intent.planNodeId, state: 'ready', column: 0, unknown: [], attempt: null }, second] })
  expect((await f.a.cli('same-session', ['goal', 'delegate', '--input', '-'], f.input)).code).toBe(1)
  expect(await plan()).toMatchObject({ next: [], nodes: [{ id: f.intent.planNodeId, state: 'unknown', unknown: ['dispatch-link'], attempts: 1, attempt }, second] })
  await pin(f.a, f.b)
  await f.a.call('same-session', ['goal', 'delegate', '--input', '-'], f.input)
  expect((await plan()).nodes).toMatchObject([{ id: f.intent.planNodeId, state: 'working', unknown: [], attempts: 1, attempt }, second])
  const criteria = [{ ...f.criteria[0]!, text: 'Retain original work and verify the signed target receipt.' }]
  await f.a.call(null, ['goal', 'update', '--goal', f.goalId, '--alignment', JSON.stringify({ summary: 'Original delivery target', criteria, openQuestions: [] })])
  expect((await plan()).nodes).toMatchObject([{ id: f.intent.planNodeId, state: 'unknown', unknown: ['criteria'], staleCriteria: ['delivery-criterion'], attempt }, second])
})

it('binds an existing cross-Host source only after the worker exact read proves receipt and never sends from bind', async () => {
  const f = await fixture(), application = { schema: 'agentmux.goal-delegation.v1', data: { goalId: f.goalId,
    delegationOperationId: f.intent.operationId, alignmentRevision: f.intent.alignmentRevision, criteria: f.criteria, planNodeId: f.intent.planNodeId } }
  const send = { target: { kind: 'agent-session', hostId: 'worker-host', agentSessionId: 'same-session' }, operationId: f.intent.operationId,
    messageId: f.intent.sourceMessageId, threadId: f.intent.threadId, correlationId: f.intent.sourceMessageId, text: f.intent.text,
    application, expectedRun: { runId: f.intent.workerRunId } }
  expect((await f.a.cli('same-session', ['agent', 'send', '--input', '-'], send)).code).toBe(1)
  const attempts = f.b.forwarded.filter(row => row.method === 'message.federation.intake').length
  expect((await f.a.cli('same-session', ['goal', 'delegation', 'bind', '--input', '-'], f.input)).code).toBe(1)
  await pin(f.a, f.b)
  const absent = await f.a.cli('same-session', ['goal', 'delegation', 'bind', '--input', '-'], f.input)
  expect(absent.code).toBe(1); expect(absent.stderr).toContain('MESSAGE_NOT_FOUND')
  expect((await f.read()).delegations[0]).not.toHaveProperty('linkedAt')
  expect((await f.incoming()).message).toBeNull()
  expect(f.b.forwarded.filter(row => row.method === 'message.federation.intake')).toHaveLength(attempts)
  await f.a.call('same-session', ['agent', 'send', '--input', '-'], send)
  const afterSend = f.b.forwarded.filter(row => row.method === 'message.federation.intake').length
  const notificationCount = f.notifications.mock.calls.length
  const forward = f.b.reader.forwardRpc!.bind(f.b.reader)
  const receiptFault = vi.spyOn(f.b.reader, 'forwardRpc').mockImplementation(async (method, params, context, owner) => {
    const result = await forward(method, params, context, owner)
    return (method === 'message.federation.export' ? { ...(result as object), sourceReceipt: {
      ...(result as { sourceReceipt: object }).sourceReceipt, keyFingerprint: '0'.repeat(64) } } : result) as never
  })
  const wrongKey = await f.a.cli('same-session', ['goal', 'delegation', 'bind', '--input', '-'], f.input)
  receiptFault.mockRestore()
  expect(wrongKey.code).toBe(1); expect(wrongKey.stderr).toContain('AGENT_MESSAGE_AUTHORITY_INVALID')
  expect((await f.read()).delegations[0]).not.toHaveProperty('linkedAt')
  const bound = await f.a.call('same-session', ['goal', 'delegation', 'bind', '--input', '-'], f.input)
  expect(bound.delegations[0]).toMatchObject({ operationId: f.intent.operationId, sourceMessageId: f.intent.sourceMessageId, linkedAt: expect.any(Number) })
  expect(f.b.forwarded.filter(row => row.method === 'message.federation.intake')).toHaveLength(afterSend)
  expect(f.notifications.mock.calls).toHaveLength(notificationCount)
})
