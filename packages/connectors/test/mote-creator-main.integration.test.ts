import { expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxError, DurableAgentMuxMessageQueue, connectAgentMuxRpc } from '@agentmux/core'
import { MoteChatStore } from '../src/mote-chat-store.js'
import { moteChatJourneyFixture as journey } from './fixtures/mote-chat-journey.js'

const fixture = (bound = true) => journey(4, 60_000, 'headless', false, 'grok', undefined, bound ? 'bound' : 'unbound')

it('delivers the authenticated creator to the original logical Main once and keeps Main internal', async () => {
  const f = await fixture()
  expect(f.start).toHaveBeenCalledOnce()
  expect(await f.wire.post(f.message('creator-main'))).toBe(202)
  const record = await f.claimed('creator-main')
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: record.ingressId })).inputReceipt?.status,
    JSON.stringify(f.submissionErrors)).toBe('terminal-confirmed'))
  expect(record.input).toMatchObject({ agentSessionId: 'original-main', expectedRun: { runId: 'native-run-1' },
    author: { kind: 'external', actor: f.creator, externalConversationId: f.message('creator-main').roomKey } })
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.start).toHaveBeenCalledOnce()
  const main = await f.sdk.call('space.mote.dialogue.read', { target: f.target })
  expect(main.main.current?.sessionId).toBe('original-main')
  const original = await new DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath()).readByOperationId(record.input!.operationId)
  expect(original?.envelope.sender).toMatchObject({ kind: 'external', actor: f.creator })
  const page = await f.client.readAgentConversation({ hostId: 'local', agentSessionId: main.main.current!.sessionId, limit: 100 })
  expect(JSON.stringify(page.items)).toContain(record.externalMessageId)
  expect(JSON.stringify(page.items)).toContain(f.creator.userId)
  const relation = await f.sdk.call('connection.binding.inspect', { bindingId: record.input!.author.bindingId })
  expect(relation).toMatchObject({ inputOnly: true, binding: { inputOnly: true }, grants: [{ capabilities: ['input'] }] })
  expect((await f.sdk.call('connection.binding.ls', { agentSessionId: 'original-main', executionHostId: 'local' })).bindings).toEqual([])
  expect((await f.sdk.call('connection.api.identities', { agentSessionId: 'original-main' })).identities).toEqual([])
  await expect(f.sdk.call('connection.api.request', { operationId: 'main-has-no-api-identity',
    identity: { bindingId: record.input!.author.bindingId, bindingRevision: 1, connectionId: record.connectionId, connectionRevision: 1 },
    request: { method: 'GET', path: '/open-apis/im/v1/messages' } })).rejects.toMatchObject({ code: 'CONNECTION_API_IDENTITY_UNAVAILABLE' })
  await expect(f.sdk.call('connection.bind', { operationId: 'cannot-self-authorize-only-input', bindingId: 'forged-main-input',
    connectionId: record.connectionId, expectedConnectionRevision: 1, externalConversationId: record.externalConversationId,
    executionHostId: 'local', agentSessionId: 'original-main', scope: relation.binding!.scope,
    expectedSource: { providerId: 'grok', nativeSessionId: 'native-chat-1' }, inputOnly: true } as never)).rejects.toMatchObject({ code: 'INVALID_ROOM_BINDING_DATA' })
  const credentials = f.credentials(0)
  const events = await f.cli('events', { target: f.target, order: 'recent', limit: 5 }, credentials)
  expect(events.events).toMatchObject([{ handledBy: { executionHostId: 'local', agentSessionId: 'original-main' } }])
  expect((await f.cli('review', { target: f.target, through: events.events[0].sequence }, credentials)).reviewed.through).toBe(events.events[0].sequence)
  await f.reply('original-main', 'unrelated-main-reply', 'This internal work must stay in the App')
  await f.services.publication!.refresh()
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(f.feishu!.messageCalls()).toEqual([])
  expect(await f.wire.post(f.message('creator-main'))).toBe(202)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect((await f.records())).toHaveLength(1)
})

it('starts one Main for concurrent original creator messages and skips a missing first Executor', async () => {
  const f = await fixture(false)
  await writeFile(join(f.topic.physicalDirectoryPath!, 'MOTE.md'), '---\nversion: 1\ndefaults:\n  executorId: removed-executor\n  fallbackExecutorIds: [saved-chat]\n---\n')
  expect(await Promise.all([f.wire.post(f.message('first-dm-1')), f.wire.post(f.message('first-dm-2'))])).toEqual([202, 202])
  const first = await f.claimed('first-dm-1'), second = await f.claimed('first-dm-2')
  const main = (await f.sdk.call('space.mote.dialogue.read', { target: f.target })).main.current!
  expect(first.input).toMatchObject({ agentSessionId: main.sessionId, author: { kind: 'external', actor: f.creator } })
  expect(second.input).toMatchObject({ agentSessionId: main.sessionId, author: { kind: 'external', actor: f.creator } })
  expect(first.input!.operationId).not.toBe(second.input!.operationId)
  expect((await f.client.readAgentSession(main.sessionId))?.executorId).toBe('saved-chat')
  const inventory = await f.client.listHostExecutors()
  const fallback = inventory.executors.find(executor => executor.executorId === 'saved-chat')!
  const restored = vi.spyOn(f.client, 'listHostExecutors').mockResolvedValue({
    ...inventory, executors: [{ ...fallback, executorId: 'removed-executor', availability: 'available' }, ...inventory.executors]
  })
  expect(await f.wire.post(f.message('after-first-executor-returns'))).toBe(202)
  expect((await f.claimed('after-first-executor-returns')).input?.agentSessionId).toBe(main.sessionId)
  expect(f.start).toHaveBeenCalledOnce()
  expect(f.prepare).not.toHaveBeenCalled()
  restored.mockRestore()
})

it('recovers retained creator intake after a Host restart without another platform delivery', async () => {
  const f = await fixture(false), path = join(f.topic.physicalDirectoryPath!, 'MOTE.md')
  await writeFile(path, '---\nversion: 1\n---\n')
  const messages = ['retained-first', 'retained-second'].map(id => f.message(id))
  for (const message of messages) expect(await f.wire.post(message)).toBe(202)
  await vi.waitFor(async () => {
    expect(await f.records()).toMatchObject([
      { state: 'received', code: 'MOTE_CHAT_EXECUTOR_REQUIRED' },
      { state: 'received', code: 'MOTE_CHAT_EXECUTOR_REQUIRED' }
    ])
  })
  const original = await f.records()
  expect(f.start).not.toHaveBeenCalled()
  for (const record of original) {
    expect(record.input).toBeUndefined()
    // Model the persisted code from an older Host while retaining the verified original intake.
    f.services.database!.prepare("UPDATE connection_ingress_message SET record_json=json_set(record_json,'$.code',?) WHERE ingress_id=?")
      .run('MOTE_CHAT_MAIN_REQUIRED', record.ingressId)
  }

  await f.restart(() => writeFile(path, '---\nversion: 1\ndefaults:\n  executorId: saved-chat\n---\n'))

  const inspections = () => Promise.all(original.map(record => f.services.ingress!.inspect({ ingressId: record.ingressId })))
  await vi.waitFor(async () => expect((await inspections()).map(result => result.inputReceipt?.status))
    .toEqual(['terminal-confirmed', 'terminal-confirmed']), { timeout: 8000 })
  const main = (await f.sdk.call('space.mote.dialogue.read', { target: f.target })).main.current!
  const queue = new DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath())
  const delivered = await inspections()
  for (const [index, before] of original.entries()) {
    const { ingress } = delivered[index]!
    expect(ingress).toMatchObject({ ingressId: before.ingressId, externalMessageId: before.externalMessageId,
      externalConversationId: before.externalConversationId, actor: before.actor, body: before.body, state: 'claimed',
      input: { agentSessionId: main.sessionId, author: { kind: 'external', actor: f.creator } } })
    expect(ingress!.code).toBeUndefined()
    const receipt = await queue.readByOperationId(ingress!.input!.operationId)
    expect(receipt?.envelope.sender).toMatchObject({ kind: 'external', actor: f.creator,
      externalMessageId: before.externalMessageId, externalConversationId: before.externalConversationId })
  }
  expect(f.start).toHaveBeenCalledOnce()
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(messages.length)
  expect(f.prepare).not.toHaveBeenCalled()
  expect(await f.records()).toHaveLength(messages.length)
})

it('freezes old Main inputs through an unknown Core result, role replacement and service restart', async () => {
  const f = await fixture(), submit = f.client.submitAgentMessage.bind(f.client)
  let unavailable = true
  const hold = vi.spyOn(f.client, 'submitAgentMessage').mockImplementation(async (...args) => {
    if (unavailable) throw new Error('Original Core reply is unknown')
    return await submit(...args)
  })
  expect(await f.wire.post(f.message('old-main'))).toBe(202)
  const old = await f.claimed('old-main')
  expect(old.input!.agentSessionId).toBe('original-main')
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  const frozen = structuredClone(old.input)
  await f.bindMain('replacement-main')
  unavailable = false
  await f.restart()
  await f.services.ingress!.dispatch(old.ingressId)
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: old.ingressId })).inputReceipt?.status).toBe('terminal-confirmed'))
  expect((await f.services.ingress!.inspect({ ingressId: old.ingressId })).ingress).toMatchObject({ input: frozen })
  expect(await f.wire.post(f.message('new-main'))).toBe(202)
  const current = await f.claimed('new-main')
  expect(current.input!.agentSessionId).toBe('replacement-main')
  expect(current.input!.operationId).not.toBe(old.input!.operationId)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledTimes(2))
  expect(await f.wire.post({ ...f.message('old-main'), deliveryKey: 'redelivered-after-rollover' })).toBe(202)
  expect((await f.records()).find(row => row.ingressId === old.ingressId)!.input).toEqual(frozen)
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.start).toHaveBeenCalledTimes(2)
  hold.mockRestore()
})

it('revalidates the exact role before freezing a creator input and preserves the received message on conflict', async () => {
  const f = await fixture(), read = f.client.readAgentSession.bind(f.client)
  let changed = false
  const location = join(f.topic.physicalDirectoryPath!, 'MOTE.md')
  vi.spyOn(f.client, 'readAgentSession').mockImplementation(async (...args) => {
    const session = await read(...args)
    if (args[0] === 'original-main' && !changed) {
      changed = true
      await writeFile(location, (await readFile(location, 'utf8')).replace('role-original-main', 'role-concurrent-writer'))
    }
    return session
  })
  expect(await f.wire.post(f.message('role-conflict'))).toBe(202)
  await vi.waitFor(async () => expect((await f.records())[0]).toMatchObject({ state: 'received', code: 'MOTE_MAIN_CHANGED' }))
  expect(new MoteChatStore(f.services.database!).admissionByIngress((await f.records())[0]!.ingressId)).toBeNull()
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled(); expect(f.start).toHaveBeenCalledOnce()
})

it('keeps a guest in an isolated original generation while the creator uses Main', async () => {
  const f = await fixture()
  expect(await f.wire.post(f.message('guest', f.guest))).toBe(202)
  const guest = await f.claimed('guest')
  expect(guest.input!.agentSessionId).toMatch(/^mote-chat-/u)
  expect(guest.input!.agentSessionId).not.toBe('original-main')
  expect(f.prepare).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledTimes(2)
  expect((await f.services.moteChat!.audience({ target: f.target })).people).toMatchObject([{ creator: false, total: 4, used: 1, remaining: 3 }])
  await f.reply(guest.input!.agentSessionId, 'guest-reply', 'Answer for this exact guest')
  await vi.waitFor(() => expect(f.feishu!.messageCalls().some(call => call.body.includes('Answer for this exact guest'))).toBe(true), { timeout: 4000 })
  expect(f.feishu!.messageCalls().filter(call => call.body.includes('Answer for this exact guest'))[0]!.body).toContain(f.message('guest', f.guest).roomKey)
  expect(await f.wire.post(f.message('creator'))).toBe(202)
  expect((await f.claimed('creator')).input!.agentSessionId).toBe('original-main')
})

it('recovers an ended Main in the same native conversation before freezing the new input Run', async () => {
  const f = await fixture()
  const original = (await f.client.readAgentSession('original-main'))!
  f.endRun(original.run.runId)
  const ensure = f.client.ensureAgentContinuity.bind(f.client)
  vi.spyOn(f.client, 'ensureAgentContinuity').mockImplementationOnce(async (...args) => {
    const missing = vi.spyOn(f.inner.kernel, 'status').mockRejectedValue(new Error('Original Runtime observation is temporarily unavailable'))
    try { return await ensure(...args) } finally { missing.mockRestore() }
  })
  expect(await f.wire.post(f.message('after-run-ended'))).toBe(202)
  await vi.waitFor(async () => expect((await f.records())[0]).toMatchObject({ state: 'received', code: 'INGRESS_RECOVERY_PENDING' }))
  expect(f.start).toHaveBeenCalledOnce(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect((await f.client.readAgentSession('original-main'))!.run).toEqual(original.run)
  const ingressId = (await f.records())[0]!.ingressId
  await f.services.ingress!.dispatch(ingressId)
  const record = await f.claimed('after-run-ended')
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: record.ingressId })).inputReceipt?.status,
    JSON.stringify(f.submissionErrors)).toBe('terminal-confirmed'))
  const recovered = (await f.client.readAgentSession('original-main'))!
  expect(recovered.agentSessionId).toBe(original.agentSessionId)
  expect(recovered.nativeHandle).toMatchObject({ sessionId: original.nativeHandle!.sessionId })
  expect(recovered.run.runId).not.toBe(original.run.runId)
  expect(record.input).toMatchObject({ agentSessionId: original.agentSessionId, expectedRun: recovered.run })
  expect(f.start).toHaveBeenCalledTimes(2); expect(f.prepare).not.toHaveBeenCalled()
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  await f.restart()
  expect(await f.wire.post({ ...f.message('after-run-ended'), deliveryKey: 'after-resume-redelivery' })).toBe(202)
  expect((await f.records())[0]!.input).toEqual(record.input)
  expect(f.start).toHaveBeenCalledTimes(2); expect(f.inner.kernel.input).toHaveBeenCalledOnce()
})


it('claims the original message once after another owner resumes the same native Main', async () => {
  const f = await fixture()
  const original = (await f.client.readAgentSession('original-main'))!
  f.endRun(original.run.runId)
  const ensure = f.client.ensureAgentContinuity.bind(f.client)
  vi.spyOn(f.client, 'ensureAgentContinuity').mockImplementationOnce(async (...args) => {
    const missing = vi.spyOn(f.inner.kernel, 'status').mockRejectedValue(new Error('Original Runtime observation is temporarily unavailable'))
    try { return await ensure(...args) } finally { missing.mockRestore() }
  })
  expect(await f.wire.post(f.message('independent-resume'))).toBe(202)
  await vi.waitFor(async () => expect((await f.records())[0]).toMatchObject({ state: 'received', code: 'INGRESS_RECOVERY_PENDING' }))
  const intake = (await f.records())[0]!
  const pending = (await f.client.readAgentSession('original-main'))!.continuity!
  expect(pending).toMatchObject({ kind: 'pending', previousRun: original.run })
  expect(intake.input).toBeUndefined()

  const resumed = await f.client.ensureAgentContinuity({ agentSessionId: original.agentSessionId, expectedRun: original.run,
    operationId: 'independent-session-recovery', trigger: 'manual', policy: { continuationEnabled: false, reminderMode: 'off' } })
  expect(resumed).toMatchObject({ kind: 'resumed', session: { agentSessionId: original.agentSessionId }, previousRun: original.run })
  const current = (await f.client.readAgentSession('original-main'))!
  expect(current.nativeHandle?.sessionId).toBe(original.nativeHandle?.sessionId)
  expect(current.run).toEqual(resumed.continuity?.newRun)
  expect(current.continuityOperations?.[pending.operationId]).toEqual(pending)

  const read = f.client.readAgentSession.bind(f.client)
  const hideLineage = vi.spyOn(f.client, 'readAgentSession').mockImplementation(async (...args) => {
    const session = await read(...args)
    return session?.agentSessionId === original.agentSessionId ? { ...session, continuity: pending,
      continuityOperations: { [pending.operationId]: pending } } : session
  })
  await expect(f.services.ingress!.dispatch(intake.ingressId)).rejects.toMatchObject({ code: 'INGRESS_RECOVERY_PENDING' })
  expect((await f.records())[0]?.input).toBeUndefined()
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  hideLineage.mockRestore()

  await f.services.ingress!.dispatch(intake.ingressId)
  const claimed = await f.claimed('independent-resume')
  expect(claimed).toMatchObject({ ingressId: intake.ingressId, externalMessageId: intake.externalMessageId,
    input: { agentSessionId: original.agentSessionId, expectedRun: current.run } })
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: intake.ingressId })).inputReceipt?.status).toBe('terminal-confirmed'))
  expect(f.start).toHaveBeenCalledTimes(2)
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
})

it('reports the native input wait for the original creator message through the public CLI', async () => {
  const f = await fixture()
  const plan = vi.mocked(f.client.providers.get('grok').planPromptInput)
  const normal = plan.getMockImplementation()!
  const privateError = 'Original native queue observation detail'
  plan.mockImplementation(() => { throw new AgentMuxError(privateError, 'AGENT_NATIVE_INPUT_UNAVAILABLE') })
  expect(await f.wire.post(f.message('native-input-wait'))).toBe(202)
  const record = await f.claimed('native-input-wait')
  const inspect = () => f.services.ingress!.inspect({ ingressId: record.ingressId })
  await vi.waitFor(async () => expect((await inspect()).inputReceipt).toMatchObject({ status: 'waiting',
    control: { waiting: { phase: 'input-environment', failure: { code: 'AGENT_NATIVE_INPUT_UNAVAILABLE' } } } }))
  const before = (await inspect()).inputReceipt!
  const diagnosis = await f.cli('diagnose', { target: f.target }, f.credentials(0))
  expect(diagnosis.incoming.rows[0]).toMatchObject({ state: 'claimed', code: null, input: {
    status: 'waiting', failureCode: 'AGENT_NATIVE_INPUT_UNAVAILABLE', runtime: { target: 'original', state: 'running' },
    waiting: { phase: 'input-environment', reason: 'original-input-unconfirmed', wake: 'explicit-rejoin' } } })
  for (const privateValue of [privateError, record.ingressId, record.body, f.creator.userId])
    expect(JSON.stringify(diagnosis)).not.toContain(privateValue)
  expect(f.inner.kernel.input).not.toHaveBeenCalled()

  plan.mockImplementation(normal)
  await vi.waitFor(async () => expect((await inspect()).inputReceipt).toMatchObject({ key: before.key, status: 'terminal-confirmed' }), { timeout: 12_000 })
  expect((await inspect()).ingress?.input).toEqual(record.input)
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  expect(f.start).toHaveBeenCalledOnce()
}, 25_000)

it('keeps a remote Main input healthy while retaining an explicit unconfirmed reply route', async () => {
  const f = await journey(4, 60_000, 'headless', false, 'grok', undefined, 'bound', 'signed-room', 'remote')
  const main = (await f.client.readAgentSession('original-main'))!
  expect(await f.wire.post(f.message('remote-main-input'))).toBe(202)
  const record = await f.claimed('remote-main-input')
  expect(record).toMatchObject({ state: 'claimed', input: { hostId: 'original-execution', agentSessionId: main.agentSessionId,
    expectedRun: main.run, author: { kind: 'external', actor: f.creator, authoritySource: { hostingRuntimeId: 'fixture-hosting-runtime', executionRuntimeId: 'fixture-execution-runtime' } } } })
  expect(record.code).toBeUndefined()
  await vi.waitFor(async () => {
    const inspection = await f.services.ingress!.inspect({ ingressId: record.ingressId })
    expect(inspection.inputReceipt?.status, JSON.stringify({ inspection, submissionErrors: f.submissionErrors, trace: f.wire.trace })).toBe('terminal-confirmed')
  }, { timeout: 4000 })
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  const wire = vi.mocked(f.inner.kernel.input).mock.calls[0]![1].data
  expect(wire).toContain(record.ingressId); expect(wire).toContain('reply route from this execution endpoint')
  expect(wire).not.toContain('space mote chat reply')
  const source = await f.main!.readCurrentMoteMain(f.target)
  expect(source.current).toMatchObject({ hostId: 'original-execution', sessionId: main.agentSessionId })
  expect((await f.client.runtimeSubject({ kind: 'terminal-run', runId: main.run.runId })).run.state).toBe('running')
  const report = await f.sdk.call('space.mote.chat.diagnose', { target: f.target })
  expect(report.incoming!.rows[0]).toMatchObject({ state: 'claimed', code: null, codeRecorded: false, noticeCode: 'MOTE_CHAT_REPLY_ROUTE_UNCONFIRMED', input: { status: 'terminal-confirmed' } })
  const input = { operationId: 'remote-explicit-original-owner', ingressId: record.ingressId, body: 'Explicit reply through the original hosting owner' }
  const execution = await connectAgentMuxRpc({ endpoint: f.executionEndpoint!, credentials: f.credentials(0) })
  try { await expect(execution.call('space.mote.chat.reply', input)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' }) } finally { await execution.dispose() }
  expect(f.wire.effects).toHaveLength(0)
  const reply = await f.cli('reply', input, f.credentials(0))
  expect(reply.operation.ingressId).toBe(record.ingressId)
  await vi.waitFor(() => expect(f.wire.effects).toHaveLength(1))
  expect(f.wire.effects[0]!.room).toBe(record.externalConversationId)
  expect(f.wire.effects[0]!.text).toBe(input.body)
  expect(f.start).toHaveBeenCalledOnce(); expect(f.prepare).not.toHaveBeenCalled()
  expect((await f.client.readAgentSession(main.agentSessionId))!.run).toEqual(main.run)
})

it.each(['active', 'paused'] as const)('preserves the incoming message when this owner already shares Main through an %s relationship', async state => {
  const f = await journey(4, 60_000, 'headless', false, 'grok', undefined, 'bound', 'signed-room')
  let binding = await f.shareMain('existing-' + state)
  if (state === 'paused') {
    const paused = await f.sdk.call('connection.binding.pause', { operationId: 'pause-existing', bindingId: binding.bindingId, expectedRevision: binding.revision })
    if (paused.state !== 'applied') throw Error('Original sharing pause not applied')
    binding = paused.binding
  }
  const main = (await f.client.readAgentSession('original-main'))!
  expect(await f.wire.post(f.message('private-with-sharing'))).toBe(202)
  await vi.waitFor(async () => expect((await f.records())[0]).toMatchObject({ state: 'received', code: 'MOTE_CHAT_MAIN_EXTERNAL_AUDIENCE' }))
  const original = (await f.records())[0]!
  expect((await f.sdk.call('connection.binding.inspect', { bindingId: binding.bindingId })).current?.state).toBe(state)
  expect((await f.client.runtimeSubject({ kind: 'terminal-run', runId: main.run.runId })).run.state).toBe('running')
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.start).toHaveBeenCalledOnce(); expect(f.prepare).not.toHaveBeenCalled()
  const report = await f.sdk.call('space.mote.chat.diagnose', { target: f.target })
  expect(report.incoming!.rows[0]).toMatchObject({ state: 'received', code: 'MOTE_CHAT_MAIN_EXTERNAL_AUDIENCE' })
  const detached = await f.sdk.call('connection.binding.detach', { operationId: 'explicit-original-detach', bindingId: binding.bindingId, expectedRevision: binding.revision })
  expect(detached.state).toBe('applied')
  await f.services.ingress!.dispatch(original.ingressId)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect((await f.records())[0]!.ingressId).toBe(original.ingressId)
  expect(f.wire.effects).toHaveLength(0)
})

it.each(['local', 'remote'] as const)('revalidates this owner’s audience at the original Core claim on %s execution when sharing appears after Main admission', async execution => {
  const f = await journey(4, 60_000, 'headless', false, 'grok', undefined, 'bound', 'signed-room', execution), submit = f.client.submitAgentMessage.bind(f.client)
  let binding: Awaited<ReturnType<typeof f.shareMain>> | undefined
  vi.spyOn(f.client, 'submitAgentMessage').mockImplementationOnce(async (...args) => { binding = await f.shareMain('racing-sharing'); return await submit(...args) })
  expect(await f.wire.post(f.message('private-sharing-race'))).toBe(202)
  const original = await f.claimed('private-sharing-race')
  await vi.waitFor(() => expect(binding).toBeDefined(), { timeout: 4000 })
  await vi.waitFor(() => expect(f.submissionErrors).toContainEqual(expect.objectContaining({ code: execution === 'local' ? 'MOTE_CHAT_MAIN_EXTERNAL_AUDIENCE' : 'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED' })), { timeout: 4000 })
  expect(await f.sdk.call('connection.ingress.authority', { operationId: original.input!.operationId })).toMatchObject({ authority: 'refused', code: 'INGRESS_INPUT_OUTSIDE_SCOPE' })
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect((await f.services.ingress!.inspect({ ingressId: original.ingressId })).inputReceipt).toBeNull()
  const events = await f.sdk.call('space.mote.chat.events', { target: f.target, order: 'recent' })
  expect(events.events[0]).toMatchObject({ state: 'claimed', code: null, noticeCode: 'MOTE_CHAT_MAIN_EXTERNAL_AUDIENCE' })
  await f.sdk.call('connection.binding.detach', { operationId: 'explicit-detach-after-race', bindingId: binding!.bindingId, expectedRevision: binding!.revision })
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce(), { timeout: 12000 })
  expect((await f.records())[0]!.input).toEqual(original.input)
  expect(f.start).toHaveBeenCalledOnce(); expect(f.prepare).not.toHaveBeenCalled()
})

it('discovers the readable exact remote Session before requiring cached Runtime owner metadata', async () => {
  const f = await journey(4, 60_000, 'headless', false, 'grok', undefined, 'bound', 'signed-room', 'remote')
  const observation = f.coldExecutionOwnerObservation()
  expect(observation.owner()).toBeNull()
  expect(await f.wire.post(f.message('cold-owner-main'))).toBe(202)
  const record = await f.claimed('cold-owner-main')
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: record.ingressId })).inputReceipt?.status).toBe('terminal-confirmed'))
  expect(observation.read).toHaveBeenCalled()
  expect(observation.owner()).toMatchObject({ runtimeId: 'fixture-execution-runtime' })
  expect(new MoteChatStore(f.services.database!).admissionByIngress(record.ingressId)).toMatchObject({ kind: 'main', binding: { executionRuntimeId: 'fixture-execution-runtime' } })
  expect(f.inner.kernel.input).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce(); expect(f.prepare).not.toHaveBeenCalled()
})

it('retains a creator input when the selected Main is this owner’s original guest lane', async () => {
  const f = await journey(4, 60_000, 'headless', false, 'grok', undefined, 'bound', 'signed-room')
  expect(await f.wire.post(f.message('guest-before-main', f.guest))).toBe(202)
  const guest = await f.claimed('guest-before-main')
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: guest.ingressId })).inputReceipt?.status).toBe('terminal-confirmed'))
  const session = (await f.client.readAgentSession(guest.input!.agentSessionId))!
  await f.bindMain(session.agentSessionId, session)
  expect(await f.wire.post(f.message('creator-with-guest-main'))).toBe(202)
  await vi.waitFor(async () => expect((await f.records()).find(record => record.externalMessageId === 'message/creator-with-guest-main')).toMatchObject({ state: 'received', code: 'MOTE_CHAT_MAIN_EXTERNAL_AUDIENCE' }))
  expect(f.inner.kernel.input).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledTimes(2); expect(f.prepare).toHaveBeenCalledOnce()
  expect((await f.client.readAgentSession(session.agentSessionId))!.run).toEqual(session.run)
  expect((await f.client.runtimeSubject({ kind: 'terminal-run', runId: session.run.runId })).run.state).toBe('running')
  expect(f.wire.effects).toHaveLength(0)
})

it('matches this owner’s existing publication through a different Host alias by the exact Runtime and Session', async () => {
  const f = await journey(4, 60_000, 'headless', false, 'grok', undefined, 'bound', 'signed-room', 'remote')
  const binding = await f.shareMain('same-runtime-existing', 'same-runtime-alias')
  expect(binding).toMatchObject({ executionHostId: 'same-runtime-alias', executionRuntimeId: 'fixture-execution-runtime', agentSessionId: 'original-main' })
  expect(await f.wire.post(f.message('alias-private-main'))).toBe(202)
  await vi.waitFor(async () => expect((await f.records())[0]).toMatchObject({ state: 'received', code: 'MOTE_CHAT_MAIN_EXTERNAL_AUDIENCE' }))
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.start).toHaveBeenCalledOnce(); expect(f.prepare).not.toHaveBeenCalled()
  expect((await f.client.runtimeSubject({ kind: 'terminal-run', runId: 'native-run-1' })).run.state).toBe('running')
})

it('keeps the original confirmed input and recorded code separate from a later current audience notice', async () => {
  const f = await journey(4, 60_000, 'headless', false, 'grok', undefined, 'bound', 'signed-room')
  expect(await f.wire.post(f.message('confirmed-before-sharing'))).toBe(202)
  const original = await f.claimed('confirmed-before-sharing')
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: original.ingressId })).inputReceipt?.status).toBe('terminal-confirmed'))
  await f.shareMain('later-current-audience')
  const report = await f.sdk.call('space.mote.chat.diagnose', { target: f.target })
  expect(report.incoming!.rows[0]).toMatchObject({ state: 'claimed', code: null, codeRecorded: false, noticeCode: 'MOTE_CHAT_MAIN_EXTERNAL_AUDIENCE', input: { status: 'terminal-confirmed' } })
  const page = await f.sdk.call('space.mote.chat.events', { target: f.target, order: 'recent' })
  expect(page.events[0]).toMatchObject({ state: 'claimed', code: null, noticeCode: 'MOTE_CHAT_MAIN_EXTERNAL_AUDIENCE', handledBy: { agentSessionId: 'original-main' } })
  expect((await f.services.ingress!.inspect({ ingressId: original.ingressId })).ingress).toEqual(original)
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
})
