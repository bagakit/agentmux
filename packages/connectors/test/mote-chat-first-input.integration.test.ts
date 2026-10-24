import { expect, it, vi } from 'vitest'
import { AgentMuxError } from '@agentmux/core'
import { parseRoomBinding, parseRoomBindingParams, parseRoomBindingResult } from '@agentmux/core/connections'
import { MoteChatStore } from '../src/mote-chat-store.js'
import { PublicationStore } from '../src/publication-store.js'
import { moteChatJourneyFixture as fixture } from './fixtures/mote-chat-journey.js'

it('submits the original private input before native history exists and publishes its already-written first reply once', async () => {
  const f = await fixture(1, 60_000, 'headless', true)
  const create = vi.spyOn(f.client, 'createHostAgentWithDelivery')
  expect(await f.wire.post(f.message('first', f.guest))).toBe(202)
  const record = await f.claimed('first')
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect(create).toHaveBeenCalledOnce()
  const store = new MoteChatStore(f.services.database!)
  const admission = store.admissionByIngress(record.ingressId)!
  const generation = store.generation(admission.generationId)!
  expect(generation.binding).toMatchObject({ agentSessionId: record.input!.agentSessionId, sourceCheckpoints: [],
    publicationOrigin: { createOperationId: generation.generation.createOperationId } })
  const binding = generation.binding!
  expect(() => parseRoomBinding({ ...binding, publicationOrigin: undefined })).toThrow()
  const groupInput = { operationId: 'group-bind', bindingId: binding.bindingId, connectionId: binding.connectionId, expectedConnectionRevision: 1,
    externalConversationId: binding.externalConversationId, executionHostId: binding.executionHostId, agentSessionId: binding.agentSessionId,
    scope: binding.scope, expectedSource: { providerId: 'claude', nativeSessionId: 'existing-source' } }
  expect(() => parseRoomBindingParams('connection.bind', { ...groupInput, publicationOrigin: binding.publicationOrigin })).toThrow()
  expect(() => parseRoomBindingResult('connection.bind', { operationId: groupInput.operationId, action: 'bind', state: 'applied', binding }, groupInput)).toThrow()
  await vi.waitFor(() => expect(f.wire.effects).toHaveLength(1), { timeout: 8_000 })
  expect(f.wire.effects[0]).toMatchObject({ room: f.message('first', f.guest).roomKey, text: 'First reply created with the original input' })
  const frontier = new PublicationStore(f.services.database!).retainedCheckpoint(generation.binding!)
  expect(frontier?.frontier.cuts).toHaveLength(1)
  expect(frontier!.frontier.cuts[0]!.kind).toBe('native')
  await f.restart()
  expect(await f.wire.post({ ...f.message('first', f.guest), deliveryKey: 'redelivered-first' })).toBe(202)
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce())
  expect((await f.records())[0]!.input).toEqual(record.input)
  expect(new PublicationStore(f.services.database!).retainedCheckpoint(generation.binding!)).toEqual(frontier)
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  expect(f.wire.effects).toHaveLength(1)
  expect((await f.services.moteChat!.audience({ target: f.target })).people).toMatchObject([{ used: 1, remaining: 0 }])
}, 20_000)

it('keeps publication failure independent of input and automatically recovers the first reply from the original beginning', async () => {
  const f = await fixture(1, 60_000, 'headless')
  const original = f.client.conversationCheckpoint.bind(f.client)
  let unavailable = true
  vi.spyOn(f.client, 'conversationCheckpoint').mockImplementation(async (...args) => {
    if (unavailable) throw new AgentMuxError('Native history is temporarily unavailable.', 'AGENT_CONVERSATION_SOURCE_UNAVAILABLE')
    return await original(...args)
  })
  expect(await f.wire.post(f.message('waiting'))).toBe(202)
  const record = await f.claimed('waiting')
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  const store = new MoteChatStore(f.services.database!)
  const generation = store.generation(store.admissionByIngress(record.ingressId)!.generationId)!
  expect(new PublicationStore(f.services.database!).retainedCheckpoint(generation.binding!)).toBeNull()
  await f.reply(record.input!.agentSessionId, 'first-answer', 'Original answer survives late source reading')
  unavailable = false
  await vi.waitFor(() => expect(f.wire.effects).toHaveLength(1), { timeout: 8_000 })
  expect(f.wire.effects[0]!.text).toBe('Original answer survives late source reading')
  expect(f.start).toHaveBeenCalledOnce()
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
}, 15_000)

it('does not turn an imported prepared conversation into a new private-chat publication origin', async () => {
  const f = await fixture(1, 60_000, 'headless')
  const prepare = f.agents.prepare
  f.agents.prepare = async input => {
    const prepared = await prepare(input)
    return { ...prepared, input: { ...prepared.input,
      nativeResumeSource: { hostId: 'local', nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'existing-private-source' } } } } as never
  }
  expect(await f.wire.post(f.message('foreign'))).toBe(202)
  await vi.waitFor(async () => expect((await f.records())[0]).toMatchObject({ state: 'received', code: 'MOTE_CHAT_CREATE_MISMATCH' }))
  expect(f.start).not.toHaveBeenCalled()
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(f.wire.effects).toHaveLength(0)
})
