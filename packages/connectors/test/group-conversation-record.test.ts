import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { appendFile } from 'node:fs/promises'
import * as core from '@agentmux/core'
import { cleanup, groupConversationFixture as fixture } from './helpers/group-conversation-fixture.js'
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('real Main receiver and Hosted Core record ordinary group messages once without an input grant or live Run', async () => {
  const f = await fixture(), submit = vi.spyOn(f.client, 'submitAgentMessage'), before = await f.store.readMetadata('original-agent'), received = await f.receive()
  await vi.waitFor(async () => expect(await f.captured()).toHaveLength(1))
  const [captured] = await f.captured()
  expect(captured!.item).toMatchObject({ content: 'Original group message', publicContent: 'confirmed', authorExternal: { actor: f.actor } })
  expect(captured!.item.authorExternal).not.toHaveProperty('grantId'); expect(captured!.item.inputRef).toBeUndefined()
  expect(submit).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(await f.store.readMetadata('original-agent')).toEqual(before)
  expect((await f.cli(['connection', 'ingress', 'ls', '--connection', f.config.connectionId, '--binding', f.binding.bindingId])).ingresses).toHaveLength(1)
  const page = await f.cli(['agent', 'conversation', 'inspect', '--host', 'local', '--session', 'original-agent'])
  expect(JSON.stringify(page)).toContain('Original group message')
  expect(page.items.flatMap((row: {kind:string;item:{records:unknown[]}}) => row.kind === 'item' ? row.item.records : []).find((row: {original:{kind:string}}) => row.original.kind === 'captured').original.item.externalInput).toMatchObject({ ingressId: received.ingressId, state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED' })
  const receipt = await f.cli(['agent', 'conversation', 'record', '--host', 'local', '--session', 'original-agent', '--ingress', received.ingressId])
  expect(receipt.record.source.recordId).toBe(captured!.item.id)
  const diagnosis = await f.cli(['connection', 'diagnose', '--host', 'local', '--session', 'original-agent', '--binding', f.binding.bindingId])
  expect(diagnosis.groups.value.items[0].incoming.value.rows).toContainEqual(expect.objectContaining({ ingressId: received.ingressId, scope: 'current-binding', bindingId: f.binding.bindingId, recording: { state: 'recorded' }, inputOperationId: null, coreStatus: null }))
  expect(JSON.stringify(diagnosis)).not.toContain('Original group message'); expect(JSON.stringify(diagnosis)).not.toContain(f.actor.userId)
  await f.receive({ deliveryKey: 'redelivery' }); await f.reopen()
  await f.services.ingress!.dispatch(received.ingressId)
  expect(await f.captured()).toHaveLength(1)
  expect(submit).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  await vi.waitFor(async () => expect((await f.services.publication!.list({ connectionId: f.config.connectionId, bindingId: f.binding.bindingId, bindingRevision: 1 })).coverage?.origins).toHaveLength(1))
  expect(f.wire.effects).toHaveLength(0)
  await f.receive({ deliveryKey: 'distinct-event', recordKey: 'distinct-message' })
  await vi.waitFor(async () => expect(await f.captured()).toHaveLength(2))
  expect(submit).not.toHaveBeenCalled()
})

it('authorized group processing enriches the same captured record and retains an independent original input receipt', async () => {
  const f = await fixture(true)
  await f.rpc.call('connection.grant', { operationId: 'grant-member', bindingId: f.binding.bindingId, expectedBindingRevision: 1, grantId: 'member-grant', expectedRevision: null, actor: f.actor, capabilities: ['input'], state: 'active' })
  const received = await f.receive({ addressing: 'response' })
  await vi.waitFor(async () => expect((await f.captured())[0]?.item.inputRef?.kind).toBe('message'))
  const [record] = await f.captured()
  expect(await f.captured()).toHaveLength(1); expect(record!.item.content).toBe('Original group message')
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: received.ingressId })).inputReceipt?.status).toBe('terminal-confirmed'))
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  const inspection = await f.services.ingress!.inspect({ ingressId: received.ingressId })
  expect(inspection.ingress?.input?.messageId).toBe(record!.item.inputRef?.kind === 'message' ? record!.item.inputRef.messageId : null)
  await vi.waitFor(async () => expect((await f.captured())[0]?.item.externalInput?.state).toBe('claimed'))
  await f.services.ingress!.dispatch(received.ingressId)
  await vi.waitFor(async () => expect((await f.captured())[0]?.item.inputSubmission).toEqual({ status: 'terminal-confirmed', observation: 'closed' }))
  await f.services.ingress!.dispatch(received.ingressId)
  const apply = vi.spyOn(f.store, 'applyTimelineMutation'), write = vi.spyOn(f.services.ingress! as never, 'write' as never)
  const beforeNoop = (await f.captured())[0]!
  const revision = beforeNoop.revision
  await f.services.ingress!.dispatch(received.ingressId)
  expect((await f.captured())[0]!.revision, JSON.stringify({before:beforeNoop,after:(await f.captured())[0],writes:apply.mock.calls})).toBe(revision)
  expect(apply).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
  apply.mockRestore(); write.mockRestore()
  await f.receive({ deliveryKey: 'second-event', addressing: 'response' })
  expect(await f.captured()).toHaveLength(1); expect(f.inner.kernel.input).toHaveBeenCalledOnce()
})

it('an ACK freezes the exact group relationship and cannot target a resumed or replacement binding', async () => {
  const f = await fixture(), native = f.message(), encoded = f.wire.encode(native)
  const received = await f.services.ingress!.receive({ connectionId: f.config.connectionId, ...encoded }, async () => {
    expect(await f.rpc.call('connection.binding.pause', { operationId: 'pause-original', bindingId: f.binding.bindingId, expectedRevision: 1 })).toMatchObject({ state: 'applied' })
    expect(await f.rpc.call('connection.binding.resume', { operationId: 'resume-original', bindingId: f.binding.bindingId, expectedRevision: 2 })).toMatchObject({ state: 'applied' })
  })
  expect(received.ingress.kind).toBeUndefined()
  const result = await f.services.ingress!.dispatch(received.ingress.ingressId)
  expect(result.ingress).toMatchObject({ state: 'refused', group: { target: { bindingRevision: 1 }, recording: { state: 'refused' } } })
  expect(await f.captured()).toHaveLength(0); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  const unlinked = await f.services.ingress!.receive({ connectionId: f.config.connectionId, ...f.wire.encode(f.message({ recordKey: 'unlinked-message', deliveryKey: 'unlinked-event', roomKey: 'unlinked-group' })) }, () => {})
  expect(unlinked.ingress).toMatchObject({ group: { target: null } })
  await f.rpc.call('connection.bind', { ...f.binding, operationId: 'link-later', bindingId: 'later-binding', externalConversationId: 'unlinked-group' })
  await f.services.ingress!.dispatch(unlinked.ingress.ingressId)
  expect(await f.captured()).toHaveLength(0)
})

it('wire callers cannot inject a body, author or record resolver and original source conflicts retain local capability', async () => {
  const f = await fixture(), received = await f.receive()
  await vi.waitFor(async () => expect(await f.captured()).toHaveLength(1))
  const input = { agentSessionId: 'original-agent', ingressId: received.ingressId }, identity = f.hosted.runtimeOwnerIdentity()!
  await expect(f.rpc.call('agent.conversation.record', { hostId: 'local', ...input, body: 'Injected body' } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(f.rpc.call('agent.conversation.record', { hostId: 'local', ...input, inputMetadata: { ingressId: received.ingressId, state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED' } } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(f.hostRpc.call('runtime.invoke', { consumerId: 'forged-record', fence: { runtimeId: identity.runtimeId, ownerInstanceId: identity.ownerInstanceId }, invocation: { method: 'recordExternalConversationMessage', args: [input, { resolveConversationMessage: true }] } } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(f.rpc.call('agent.conversation.record', { hostId: 'local', ...input, agentSessionId: 'other-agent' })).rejects.toMatchObject({ code: 'EXTERNAL_RECORD_TARGET_UNCONFIRMED' })
  expect(await f.captured()).toHaveLength(1); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('concurrent public records commit one original capture and return the same receipt', async () => {
  const f = await fixture(), received = await f.services.ingress!.receive({ connectionId: f.config.connectionId, ...f.wire.encode(f.message()) }, () => {})
  const apply = f.store.applyTimelineMutation.bind(f.store)
  let arrivals = 0, release!: () => void
  const both = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(f.store, 'applyTimelineMutation').mockImplementation(async (mutation, signal) => {
    if (mutation.type === 'append' && mutation.item.authorExternal) { ++arrivals; await both }
    return apply(mutation, signal)
  })
  const input = { hostId: 'local', agentSessionId: 'original-agent', ingressId: received.ingress.ingressId }
  const pending = Promise.all([f.rpc.call('agent.conversation.record', input), f.rpc.call('agent.conversation.record', input)])
  await vi.waitFor(() => expect(arrivals).toBe(1)); release()
  const receipts = await pending
  expect(arrivals).toBe(1); expect(receipts[0]).toEqual(receipts[1]); expect(await f.captured()).toHaveLength(1)
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('recording failures cannot suppress authorized input and recover onto its original capture', async () => {
  const f = await fixture(true)
  await f.rpc.call('connection.grant', { operationId: 'grant-member', bindingId: f.binding.bindingId, expectedBindingRevision: 1, grantId: 'member-grant', expectedRevision: null, actor: f.actor, capabilities: ['input'], state: 'active' })
  const record = vi.spyOn(f.client, 'recordExternalConversationMessage').mockRejectedValue(new core.AgentMuxError('Original record owner unavailable', 'EXTERNAL_RECORD_AUTHORITY_UNAVAILABLE'))
  const received = await f.receive({ addressing: 'response' })
  await vi.waitFor(async () => expect((await f.captured())[0]?.item.inputRef?.kind).toBe('message'))
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: received.ingressId })).inputReceipt?.status).toBe('terminal-confirmed'))
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  expect((await f.services.ingress!.inspect({ ingressId: received.ingressId })).ingress).toMatchObject({ group: { recording: { state: 'unavailable' } } })
  const diagnosis = await f.cli(['connection', 'diagnose', '--host', 'local', '--session', 'original-agent', '--binding', f.binding.bindingId])
  expect(diagnosis.groups.value.items[0].incoming.value.rows).toContainEqual(expect.objectContaining({ ingressId: received.ingressId, recording: { state: 'unavailable', code: expect.stringMatching(/^EXTERNAL_RECORD_/) }, coreStatus: 'terminal-confirmed' }))
  record.mockRestore()
  await f.services.ingress!.dispatch(received.ingressId)
  expect((await f.services.ingress!.inspect({ ingressId: received.ingressId })).ingress).toMatchObject({ group: { recorded: { ingressId: received.ingressId } } })
  expect(await f.captured()).toHaveLength(1); expect(f.inner.kernel.input).toHaveBeenCalledOnce()
})

it('failed capture enrichment reports an observation error without replacing the real input receipt', async () => {
  const f = await fixture(true), errors: string[] = []
  const subscription = f.client.onEvent(event => { if (event.type === 'agent-error') errors.push(event.code) }); cleanup.push(subscription)
  await f.rpc.call('connection.grant', { operationId: 'grant-member', bindingId: f.binding.bindingId, expectedBindingRevision: 1, grantId: 'member-grant', expectedRevision: null, actor: f.actor, capabilities: ['input'], state: 'active' })
  const apply = f.store.applyTimelineMutation.bind(f.store)
  vi.spyOn(f.store, 'applyTimelineMutation').mockImplementation(async (mutation, signal) => {
    if (mutation.type === 'upsert' && mutation.item.authorExternal) throw new Error('Capture unavailable after input')
    return apply(mutation, signal)
  })
  const received = await f.receive({ addressing: 'response' })
  await vi.waitFor(() => expect(errors).toContain('AGENT_INPUT_CONVERSATION_UNCONFIRMED'))
  await f.services.ingress!.dispatch(received.ingressId)
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: received.ingressId })).inputReceipt?.status).toBe('terminal-confirmed'))
  const inspection = await f.services.ingress!.inspect({ ingressId: received.ingressId })
  expect(inspection.inputReceipt?.status, JSON.stringify(inspection)).toBe('terminal-confirmed')
  expect(inspection.ingress).toMatchObject({ group: { recorded: expect.any(Object), recording: { state: 'unavailable' } } })
  expect(await f.captured()).toHaveLength(1); expect(f.inner.kernel.input).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a receiver alias for the same native application cannot create a second record or a publication echo', async () => {
  const f = await fixture()
  await f.rpc.call('connection.configure', { operationId: 'configure-alias', expectedRevision: null, connection: { ...f.config, connectionId: 'receiver-alias' } })
  const received = await f.services.ingress!.receive({ connectionId: 'receiver-alias', ...f.wire.encode(f.message()) }, () => {})
  await f.services.ingress!.dispatch(received.ingress.ingressId)
  expect((await f.captured())[0]?.item.authorExternal).toMatchObject({ connectionId: f.config.connectionId, bindingId: f.binding.bindingId })
  const duplicate = await f.services.ingress!.receive({ connectionId: f.config.connectionId, ...f.wire.encode(f.message({ deliveryKey: 'alias-redelivery' })) }, () => {})
  expect(duplicate.ingress.ingressId).toBe(received.ingress.ingressId)
  await f.services.ingress!.dispatch(duplicate.ingress.ingressId)
  expect(await f.captured()).toHaveLength(1)
  await vi.waitFor(async () => expect((await f.services.publication!.list({ connectionId: f.config.connectionId, bindingId: f.binding.bindingId, bindingRevision: 1 })).coverage?.origins).toHaveLength(1))
  expect(f.wire.effects).toHaveLength(0)
})

it('a visible message and a non-input member grant never authorize Agent execution', async () => {
  const f = await fixture(true)
  await f.rpc.call('connection.grant', { operationId: 'grant-member', bindingId: f.binding.bindingId, expectedBindingRevision: 1, grantId: 'member-grant', expectedRevision: null, actor: f.actor, capabilities: ['answer'], state: 'active' })
  const received = await f.receive({ addressing: 'response' })
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: received.ingressId })).ingress?.state).toBe('refused'))
  expect(await f.captured()).toHaveLength(1); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect((await f.services.ingress!.inspect({ ingressId: received.ingressId })).ingress?.code).toBe('INGRESS_ACTOR_NOT_AUTHORIZED')
})


it('messages received during a pause stay outside the resumed conversation', async () => {
  const f = await fixture()
  await f.rpc.call('connection.binding.pause', { operationId: 'pause', bindingId: f.binding.bindingId, expectedRevision: 1 })
  const received = await f.services.ingress!.receive({ connectionId: f.config.connectionId, ...f.wire.encode(f.message()) }, () => {})
  expect(received.ingress).toMatchObject({ group: { target: null } })
  await f.rpc.call('connection.binding.resume', { operationId: 'resume', bindingId: f.binding.bindingId, expectedRevision: 2 })
  await f.services.ingress!.dispatch(received.ingress.ingressId)
  await f.reopen()
  await f.services.ingress!.dispatch(received.ingress.ingressId)
  expect(await f.captured()).toHaveLength(0); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})


it('an input grant does not turn an ordinary unaddressed group message into an Agent request', async () => {
  const f = await fixture(true)
  await f.rpc.call('connection.grant', { operationId: 'grant-member', bindingId: f.binding.bindingId, expectedBindingRevision: 1, grantId: 'member-grant', expectedRevision: null, actor: f.actor, capabilities: ['input'], state: 'active' })
  const received = await f.receive()
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: received.ingressId })).ingress?.state).toBe('refused'))
  expect(await f.captured()).toHaveLength(1); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect((await f.services.ingress!.inspect({ ingressId: received.ingressId })).ingress?.code).toBe('INGRESS_INPUT_OUTSIDE_SCOPE')
})


it('joined group conversation records once, reaches the original Agent and shares new speech with independent audiences without origin echoes', async () => {
  const f = await fixture(true, true)
  const second = { ...f.binding, operationId: 'join-second-group', bindingId: 'second-binding', externalConversationId: 'second-group' }
  // The original owner permits one audience per bot/Agent mapping; use an exact independent identity for the second group.
  const alias = { ...f.config, connectionId: 'second-bot' }
  expect(await f.rpc.call('connection.configure', { operationId: 'configure-second-bot', expectedRevision: null, connection: alias })).toMatchObject({ status: 'configured' })
  expect(await f.rpc.call('connection.bind', { ...second, connectionId: alias.connectionId })).toMatchObject({ state: 'applied' })
  expect(await f.rpc.call('connection.grant', { operationId: 'join-authorize', bindingId: f.binding.bindingId, expectedBindingRevision: 1, grantId: 'join-member', expectedRevision: null, actor: f.actor, capabilities: ['input'], state: 'active' })).toMatchObject({ state: 'applied' })
  const receive = async (deliveryKey: string) => {
    const intake = await f.services.ingress!.receive({ connectionId: f.config.connectionId, ...f.wire.encode(f.message({ deliveryKey, addressing: 'response' })) }, async () => {})
    await f.services.ingress!.dispatch(intake.ingress.ingressId)
  }
  await receive('join-original')
  await vi.waitFor(async () => expect((await f.captured())[0]?.item.inputRef?.kind).toBe('message'), { timeout: 5000 })
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  const native = (id: string, text: string) => JSON.stringify({ type: 'assistant', sessionId: 'group-native', uuid: id, message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
  await appendFile(join(f.root, 'native.jsonl'), native('joint-reply', 'Public answer from original Agent'))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.wire.effects.filter(effect => effect.text.includes('Public answer from original Agent')).map(effect => effect.room).sort(), JSON.stringify({ operations: f.services.publication!.store.list({ bindingId: second.bindingId, revision: 1 }), coverage: f.services.publication!.store.coverage({ bindingId: second.bindingId, revision: 1 }), observation: f.services.publication!.observation(second.bindingId, 1) })).toEqual(['native-group', 'second-group']), { timeout: 5000 })
  expect(f.wire.effects.filter(effect => effect.room === 'native-group' && effect.text.includes('Original group message'))).toHaveLength(0)
  expect(f.wire.effects.filter(effect => effect.room === 'second-group' && effect.text.includes('Original group message'))).toHaveLength(1)
  await f.client.submitAgentPrompt({ agentSessionId: 'original-agent', ...core.agentPromptCondition((await f.client.readAgentSession('original-agent'))!), operationId: 'join-local-human', prompt: 'Local human conversation', authorHuman: true, allowUncertainTurn: true })
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.wire.effects.filter(effect => effect.text.includes('Local human conversation')).map(effect => effect.room).sort()).toEqual(['native-group', 'second-group']))
  expect(await f.captured()).toHaveLength(1)
  await receive('join-duplicate')
  expect(await f.captured()).toHaveLength(1)
  expect(f.wire.effects.filter(effect => effect.text.includes('Public answer from original Agent'))).toHaveLength(2)
  const detached = await f.rpc.call('connection.binding.detach', { operationId: 'join-detach-one', bindingId: f.binding.bindingId, expectedRevision: 1 })
  expect(detached).toMatchObject({ state: 'applied', binding: { state: 'detached' } })
  await appendFile(join(f.root, 'native.jsonl'), native('independent-reply', 'Other group keeps working'))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.wire.effects.filter(effect => effect.text.includes('Other group keeps working')).map(effect => effect.room)).toEqual(['second-group']))
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  await f.reopen()
  expect(await f.captured()).toHaveLength(1)
  await vi.waitFor(() => expect(f.wire.effects.filter(effect => effect.text.includes('Public answer from original Agent'))).toHaveLength(2))
}, 30_000)
