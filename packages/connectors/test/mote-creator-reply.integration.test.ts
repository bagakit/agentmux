import { expect, it, vi } from 'vitest'
import { connectAgentMuxRpc } from '@agentmux/core'
import { moteChatJourneyFixture as journey } from './fixtures/mote-chat-journey.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'

const fixture = (protocol: 'feishu' | 'signed-room' = 'feishu') => journey(4, 60_000, 'headless', false, 'grok', undefined, 'bound', protocol)

async function delivered(f: Awaited<ReturnType<typeof fixture>>, ingressId: string) {
  const transitions: unknown[] = []
  await vi.waitFor(async () => {
    const receipt = (await f.services.ingress!.inspect({ ingressId })).inputReceipt
    const observation = { status: receipt?.status, control: receipt?.control, observation: receipt?.observation }
    if (JSON.stringify(transitions.at(-1)) !== JSON.stringify(observation)) transitions.push(observation)
    expect(receipt?.status, JSON.stringify({ transitions, submissionErrors: f.submissionErrors })).toBe('terminal-confirmed')
  }, { timeout: 4000 })
}

it('discovers the exact reply capability in trusted input and sends through the real compiled CLI and original Outbox', async () => {
  const f = await fixture()
  expect(await f.wire.post(f.message('original-question'))).toBe(202)
  const source = await f.claimed('original-question'), credentials = f.credentials(0)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  const wire = vi.mocked(f.inner.kernel.input).mock.calls[0]![1].data
  expect(wire).toContain('space mote chat reply')
  expect(wire).toContain(source.ingressId)
  expect(wire).not.toContain('For reactions,')
  await f.reply('original-main', 'private-internal-result', 'Internal Main work stays private')
  await f.services.publication!.refresh()
  expect(f.feishu!.messageCalls()).toEqual([])
  const input = { operationId: 'original-exact-reply', ingressId: source.ingressId, body: 'Answer only this original person' }
  const reply = await f.cli('reply', input, credentials)
  expect(reply.operation).toMatchObject({ action: 'reply', ingressId: source.ingressId })
  await vi.waitFor(() => expect(f.feishu!.messageCalls()).toHaveLength(1))
  expect(f.feishu!.messageCalls()[0]!.body).toContain(source.externalConversationId)
  expect(f.feishu!.messageCalls()[0]!.body).toContain(input.body)
  expect(f.feishu!.messageCalls()[0]!.body).not.toContain('Internal Main work')
  let inspection: Awaited<ReturnType<typeof f.cli>>
  await vi.waitFor(async () => { inspection = await f.cli('inspect', { operationId: input.operationId }, credentials); expect(inspection.deliveries).toMatchObject([{ state: 'confirmed' }]) })
  expect(inspection!.configuration).toBeNull()
  expect(inspection!.operation).not.toHaveProperty('configuration')
  expect(inspection!.operation.deliveryOperationIds).toEqual(reply.operation.deliveryOperationIds)
  expect(inspection!.deliveries[0].reference.source).toEqual({ kind: 'mote-chat-reply', operationId: input.operationId, ingressId: source.ingressId })
  await f.restart()
  expect((await f.cli('reply', input, credentials)).operation).toEqual(reply.operation)
  const changed = await f.cliRaw('reply', { ...input, body: 'Changed intent cannot reuse the operation' }, credentials)
  expect(changed.code).not.toBe(0); expect(changed.stdout + changed.stderr).toContain('MOTE_CHAT_OPERATION_CONFLICT')
  expect(f.feishu!.messageCalls()).toHaveLength(1)
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
})

it('uses the execution CLI to reply and read the same operation at the original Connector', async () => {
  const f = await journey(4, 60_000, 'headless', false, 'grok', undefined, 'bound', 'signed-room', 'remote')
  expect(await f.wire.post(f.message('original-remote-question'))).toBe(202)
  const original = await f.claimed('original-remote-question')
  await delivered(f, original.ingressId)
  expect(await f.wire.post(f.message('another-remote-question'))).toBe(202)
  const other = await f.claimed('another-remote-question')
  await delivered(f, other.ingressId)
  f.setExecutionReplyRoute(true)
  const credentials = f.credentials(0)
  const cli = async (action: 'reply' | 'inspect', input: object) => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + f.executionEndpoint!.path, 'space', 'mote', 'chat', action, '--input', '-'],
      objectCliEnvironment(f.root, { AGENTMUX_AGENT_SESSION_ID: credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: credentials.capability, NODE_NO_WARNINGS: '1' }), JSON.stringify(input))
    return JSON.parse(result.code === 0 ? result.stdout : result.stderr)
  }
  const input = { operationId: 'original-routed-reply', ingressId: original.ingressId, body: 'Replies use the original conversation', sourceMessageId: original.input!.messageId }
  expect(await cli('reply', { ...input, ingressId: other.ingressId })).toMatchObject({ ok: false, error: { code: 'CONTROL_PERMISSION_DENIED' } })
  expect(f.wire.effects).toHaveLength(0)
  const saved = await cli('reply', input)
  expect(saved).toMatchObject({ ok: true, result: { operation: { operationId: input.operationId, ingressId: original.ingressId } } })
  await vi.waitFor(() => expect(f.wire.effects).toEqual([expect.objectContaining({ room: original.externalConversationId, text: input.body })]))
  const selector = { operationId: input.operationId, sourceMessageId: input.sourceMessageId }
  f.setExecutionReplyRoute(false)
  expect(await cli('inspect', selector)).toMatchObject({ ok: false, error: { code: 'MOTE_CHAT_REPLY_ROUTE_UNCONFIRMED' } })
  f.setExecutionReplyRoute(true)
  expect(await cli('inspect', selector)).toMatchObject({ ok: true, result: { operation: saved.result.operation } })
  expect(await cli('reply', input)).toMatchObject({ ok: true, result: { operation: saved.result.operation } })
  expect(f.wire.effects).toHaveLength(1)
  expect(f.start).toHaveBeenCalledOnce()
}, 40_000)

it('uses a second wire protocol and preserves every long reply fragment without sharing other Main output', async () => {
  const f = await fixture('signed-room')
  expect(await f.wire.post(f.message('fragment-source'))).toBe(202)
  const source = await f.claimed('fragment-source'), body = 'Complete authored answer. '.repeat(1000)
  await delivered(f, source.ingressId)
  const sdk = await connectAgentMuxRpc({ endpoint: f.endpoint, credentials: f.credentials(0) })
  try {
    const reply = await sdk.call('space.mote.chat.reply', { operationId: 'fragmented-reply', ingressId: source.ingressId, body })
    expect(reply.operation.deliveryOperationIds.length).toBeGreaterThan(1)
    await vi.waitFor(() => expect(f.wire.effects).toHaveLength(reply.operation.deliveryOperationIds.length))
    expect(f.wire.effects.map(effect => effect.text).join('')).toBe(body)
    expect(f.wire.effects.every(effect => effect.room === source.externalConversationId)).toBe(true)
    await f.reply('original-main', 'unrelated-private-result', 'Do not include this unrelated private text')
    await f.services.publication!.refresh()
    expect(f.wire.effects.map(effect => effect.text).join('')).toBe(body)
  } finally { await sdk.dispose() }
})

it('requires the original claim and recipient while allowing its exact native semantic recovery', async () => {
  const f = await fixture('signed-room')
  expect(await f.wire.post(f.message('before-recovery'))).toBe(202)
  const source = await f.claimed('before-recovery'), original = (await f.client.readAgentSession('original-main'))!
  await delivered(f, source.ingressId)
  await f.bindMain('replacement-main')
  const wrong = await f.cliRaw('reply', { operationId: 'wrong-recipient', ingressId: source.ingressId, body: 'Wrong recipient must not send' }, f.credentials(1))
  expect(wrong.code).not.toBe(0); expect(wrong.stdout + wrong.stderr).toContain('CONTROL_PERMISSION_DENIED')
  const missing = await f.cliRaw('reply', { operationId: 'no-claim', ingressId: 'absent-original-claim', body: 'Missing source' }, f.credentials(0))
  expect(missing.code).not.toBe(0); expect(missing.stdout + missing.stderr).toContain('MOTE_CHAT_REPLY_SOURCE_UNCONFIRMED')
  f.endRun(original.run.runId)
  const recovery = await f.client.ensureAgentContinuity({ agentSessionId: original.agentSessionId, expectedRun: original.run,
    operationId: 'original-recipient-recovery', trigger: 'input', policy: { continuationEnabled: false, reminderMode: 'off' } })
  expect(recovery.kind).toBe('resumed')
  const resumed = await f.cli('reply', { operationId: 'reply-from-resumed-original', ingressId: source.ingressId, body: 'Original recipient after native recovery' }, f.credentials(2))
  await vi.waitFor(() => expect(f.wire.effects).toHaveLength(1))
  expect(f.wire.effects[0]!.room).toBe(source.externalConversationId)
  const otherInspect = await f.cliRaw('inspect', { operationId: resumed.operation.operationId }, f.credentials(1))
  expect(otherInspect.code).not.toBe(0); expect(otherInspect.stdout + otherInspect.stderr).toContain('CONTROL_PERMISSION_DENIED')
  expect(f.wire.effects).toHaveLength(1)
})

it('keeps an applied reply with lost ACK inspect-only across owner restart without repeating its dispatch', async () => {
  const f = await fixture('signed-room')
  expect(await f.wire.post(f.message('unknown-reply'))).toBe(202)
  const source = await f.claimed('unknown-reply'), adapter = f.wire.adapter.publication!, dispatch = adapter.dispatch.bind(adapter), inspect = adapter.inspect!.bind(adapter)
  await delivered(f, source.ingressId)
  let readable = false
  const effects = vi.spyOn(adapter, 'dispatch').mockImplementation(async (...args) => { await dispatch(...args); throw new Error('Original platform ACK lost') })
  const observations = vi.spyOn(adapter, 'inspect').mockImplementation(async (...args) => readable ? await inspect(...args) : null)
  const input = { operationId: 'original-unknown-reply', ingressId: source.ingressId, body: 'One original external effect' }
  const reply = await f.cli('reply', input, f.credentials(0))
  await vi.waitFor(() => expect(f.wire.effects).toHaveLength(1))
  await vi.waitFor(async () => expect((await f.cli('inspect', { operationId: input.operationId }, f.credentials(0))).deliveries).toMatchObject([{ state: 'unknown' }]))
  await f.restart()
  expect((await f.cli('reply', input, f.credentials(0))).operation).toEqual(reply.operation)
  expect(effects).toHaveBeenCalledOnce()
  readable = true; f.services.publication!.refresh()
  await vi.waitFor(async () => expect((await f.cli('inspect', { operationId: input.operationId }, f.credentials(0))).deliveries).toMatchObject([{ state: 'confirmed' }]))
  expect(effects).toHaveBeenCalledOnce(); expect(f.wire.effects).toHaveLength(1)
  expect(observations).toHaveBeenCalled()
  expect(observations.mock.calls.every(([prepared]) => reply.operation.deliveryOperationIds.includes(prepared.requestKey))).toBe(true)
})

it('does not turn a retained claim into reply authority before the original Core input is delivered', async () => {
  const f = await fixture('signed-room'), submit = f.client.submitAgentMessage.bind(f.client)
  let blocked = true
  vi.spyOn(f.client, 'submitAgentMessage').mockImplementation(async (...args) => {
    if (blocked) throw new Error('Original input has not reached Core')
    return await submit(...args)
  })
  expect(await f.wire.post(f.message('claimed-only'))).toBe(202)
  const source = await f.claimed('claimed-only'), input = { operationId: 'wait-for-original-delivery', ingressId: source.ingressId, body: 'Only after original delivery' }
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  const before = await f.cliRaw('reply', input, f.credentials(0))
  expect(before.code).not.toBe(0); expect(before.stdout + before.stderr).toContain('MOTE_CHAT_REPLY_INPUT_UNDELIVERED')
  expect(f.wire.effects).toHaveLength(0)
  expect((await f.cli('inspect', { operationId: input.operationId })).operation).toBeNull()
  blocked = false
  await f.services.ingress!.dispatch(source.ingressId)
  await delivered(f, source.ingressId)
  await f.cli('reply', input, f.credentials(0))
  await vi.waitFor(() => expect(f.wire.effects).toHaveLength(1))
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
})

it.each(['audience', 'binding', 'ingress', 'ordinal', 'count', 'duplicate'] as const)('rejects a wrong %s delivery DTO at the real public reply consumer while preserving its original operation', async fault => {
  const f = await fixture('signed-room')
  expect(await f.wire.post(f.message('codec-source'))).toBe(202)
  const source = await f.claimed('codec-source'), reply = f.services.moteChat!.reply.bind(f.services.moteChat!)
  await delivered(f, source.ingressId)
  const corrupt = vi.spyOn(f.services.moteChat!, 'reply').mockImplementationOnce(async (...args) => {
    const value = await reply(...args)
    return { ...value, deliveries: fault === 'duplicate' ? [...value.deliveries, ...value.deliveries] : value.deliveries.map(delivery => fault === 'audience'
      ? { ...delivery, target: { ...delivery.target, externalConversationId: 'another-private-person' } }
      : fault === 'binding' ? { ...delivery, bindingId: 'another-original-binding' }
      : fault === 'ingress' && delivery.reference.source.kind === 'mote-chat-reply' ? { ...delivery, reference: { ...delivery.reference, source: { ...delivery.reference.source, ingressId: 'another-original-ingress' } } }
      : { ...delivery, fragment: { ...delivery.fragment, ...(fault === 'ordinal' ? { ordinal: 1, count: 2 } : { count: delivery.fragment.count + 1 }) } }) }

  })
  const input = { operationId: 'codec-original-reply', ingressId: source.ingressId, body: 'Original audience survives malformed response' }
  const sdk = await connectAgentMuxRpc({ endpoint: f.endpoint, credentials: f.credentials(0) })
  try { await expect(sdk.call('space.mote.chat.reply', input)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' }) } finally { await sdk.dispose() }
  corrupt.mockRestore()
  await vi.waitFor(() => expect(f.wire.effects).toHaveLength(1))
  const inspected = await f.cli('inspect', { operationId: input.operationId }, f.credentials(0))
  expect(inspected.operation.ingressId).toBe(source.ingressId)
  expect(inspected.deliveries[0].target.externalConversationId).toBe(source.externalConversationId)
  expect(f.wire.effects[0]!.room).toBe(source.externalConversationId)
})

it('pauses a prepared reply on exact chat policy change while keeping its original receipt readable', async () => {
  const f = await fixture('signed-room')
  expect(await f.wire.post(f.message('paused-original'))).toBe(202)
  const source = await f.claimed('paused-original')
  await delivered(f, source.ingressId)
  const owner = Reflect.get(f.services.publication!, 'options').connections
  const resolve = owner.resolveCredential.bind(owner)
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(done => { release = done }), arrived = new Promise<void>(done => { entered = done })
  const credential = vi.spyOn(owner, 'resolveCredential').mockImplementation(async (...args) => { entered(); await held; return await resolve(...args) })
  const input = { operationId: 'paused-reply', ingressId: source.ingressId, body: 'Retain this exact pending answer' }
  const original = await f.cli('reply', input, f.credentials(0))
  await arrived
  const configuration = (await f.sdk.call('space.mote.chat.inspect', { target: f.target })).configuration!
  const disabled = await f.sdk.call('space.mote.chat.configure', { operationId: 'pause-exact-chat', target: f.target, expectedRevision: configuration.revision,
    expectedConnectionRevision: 1, values: { ...configuration.values, enabled: false } })
  release(); credential.mockRestore()
  const inspection = await f.cli('inspect', { operationId: input.operationId }, f.credentials(0))
  expect(inspection.operation).toEqual(original.operation)
  expect(inspection.configuration).toBeNull()
  expect(inspection.deliveries).toMatchObject([{ state: 'pending' }])
  expect(f.wire.effects).toHaveLength(0)
  expect((await f.client.runtimeSubject({ kind: 'terminal-run', runId: source.input!.expectedRun.runId })).run.state).toBe('running')
  await f.sdk.call('space.mote.chat.configure', { operationId: 'resume-exact-chat', target: f.target, expectedRevision: disabled.configuration.revision,
    expectedConnectionRevision: 1, values: configuration.values })
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.wire.effects).toHaveLength(1))
  expect((await f.cli('inspect', { operationId: input.operationId }, f.credentials(0))).operation).toEqual(original.operation)
})

it('preserves a legitimately saved original reply when this owner later shares the Session', async () => {
  const f = await fixture('signed-room')
  expect(await f.wire.post(f.message('reply-before-sharing'))).toBe(202)
  const source = await f.claimed('reply-before-sharing'); await delivered(f, source.ingressId)
  const owner = Reflect.get(f.services.publication!, 'options').connections, resolve = owner.resolveCredential.bind(owner)
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(done => { release = done }), arrived = new Promise<void>(done => { entered = done })
  const credential = vi.spyOn(owner, 'resolveCredential').mockImplementation(async (...args) => { entered(); await held; return await resolve(...args) })
  const input = { operationId: 'legal-original-reply', ingressId: source.ingressId, body: 'Original person’s saved answer' }
  const reply = await f.cli('reply', input, f.credentials(0)); await arrived
  await f.shareMain('sharing-after-reply-admission')
  release(); credential.mockRestore()
  await vi.waitFor(() => expect(f.wire.effects.some(effect => effect.room === source.externalConversationId && effect.text === input.body)).toBe(true))
  const inspected = await f.cli('inspect', { operationId: input.operationId }, f.credentials(0))
  expect(inspected.operation).toEqual(reply.operation)
  expect(inspected.deliveries).toMatchObject([{ state: 'confirmed' }])
  expect((await f.cli('reply', input, f.credentials(0))).operation).toEqual(reply.operation)
  expect(f.wire.effects.filter(effect => effect.room === source.externalConversationId)).toHaveLength(1)
})

it.each([{ runtimeId: 'another-hosting-runtime', ownerInstanceId: 'fixture-instance' }, { runtimeId: 'fixture-original-core', ownerInstanceId: 'old-hosting-owner' }])('honors an explicit wrong or old hosting fence $runtimeId/$ownerInstanceId', async runtimeFence => {
  const f = await fixture('signed-room')
  expect(await f.wire.post(f.message('fenced-original'))).toBe(202)
  const source = await f.claimed('fenced-original'); await delivered(f, source.ingressId)
  const sdk = await connectAgentMuxRpc({ endpoint: f.endpoint, credentials: f.credentials(0) })
  const input = { operationId: 'wrong-hosting-fence-reply', ingressId: source.ingressId, body: 'No wrong owner effect' }
  try {
    await expect(sdk.call('space.mote.chat.reply', input, { runtimeFence })).rejects.toMatchObject({ code: runtimeFence.runtimeId === 'fixture-original-core' ? 'RUNTIME_OWNER_CHANGED' : 'RUNTIME_OWNER_MISMATCH' })
    await expect(sdk.call('space.mote.chat.inspect', { operationId: input.operationId }, { runtimeFence })).rejects.toMatchObject({ code: runtimeFence.runtimeId === 'fixture-original-core' ? 'RUNTIME_OWNER_CHANGED' : 'RUNTIME_OWNER_MISMATCH' })
    expect((await f.sdk.call('space.mote.chat.inspect', { operationId: input.operationId })).operation).toBeNull()
    expect(f.wire.effects).toHaveLength(0)
    await sdk.call('space.mote.chat.reply', input)
    await vi.waitFor(() => expect(f.wire.effects).toHaveLength(1))
  } finally { await sdk.dispose() }
})

it('rechecks the hosting fence after original Core proof and retains the request for its current owner', async () => {
  const f = await fixture('signed-room')
  expect(await f.wire.post(f.message('owner-changed-during-proof'))).toBe(202)
  const source = await f.claimed('owner-changed-during-proof'); await delivered(f, source.ingressId)
  const read = f.services.ingress!.inspect.bind(f.services.ingress!)
  const proof = vi.spyOn(f.services.ingress!, 'inspect').mockImplementationOnce(async (...args) => { const result = await read(...args); f.replaceHostingOwner(); return result })
  const sdk = await connectAgentMuxRpc({ endpoint: f.endpoint, credentials: f.credentials(0) })
  const input = { operationId: 'original-proof-fence', ingressId: source.ingressId, body: 'One reply at the correct owner' }
  try {
    await expect(sdk.call('space.mote.chat.reply', input, { runtimeFence: { runtimeId: 'fixture-original-core', ownerInstanceId: 'fixture-instance' } })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
    expect(f.wire.effects).toHaveLength(0); proof.mockRestore()
    expect((await f.sdk.call('space.mote.chat.inspect', { operationId: input.operationId })).operation).toBeNull()
    await sdk.call('space.mote.chat.reply', input)
    await vi.waitFor(() => expect(f.wire.effects).toHaveLength(1))
  } finally { await sdk.dispose() }
})
