import { afterEach, expect, it, vi } from 'vitest'
import { parseRoomBinding, parseRoomBindingParams, parseRoomBindingResult, roomPublicationReference } from '@agentmux/core/connections'
import { roomBindingFixture, context } from './fixtures/room-binding.js'
import { ingressFixture } from './fixtures/ingress.js'
import { config } from './fixtures/room-binding.js'
import { RoomBindingHost } from '../src/room-binding.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('an active trigger-only configuration directly retains the original boundary and original member head', async () => {
  const f = await roomBindingFixture(); cleanup.push(f.close)
  const first = await f.bindings.bind(f.input, context)
  expect(first.state).toBe('applied'); if (first.state !== 'applied') throw Error('Original Binding absent')
  const actor = { application: first.binding.application, idType: 'account_id', userId: 'original-member' }
  const original = await f.bindings.grant({ operationId: 'member-original', bindingId: first.binding.bindingId, expectedBindingRevision: 1,
    grantId: 'member', expectedRevision: null, actor, state: 'active', capabilities: ['input', 'answer', 'permission'] }, context)
  expect(original.state).toBe('applied'); if (original.state !== 'applied') throw Error('Original member absent')
  const cut = vi.spyOn(f.client, 'conversationCheckpoint')
  for (const [index, input] of ['all-messages', 'mentions-and-replies'].entries()) {
    const next = await f.bindings.relink({ ...f.input, operationId: 'trigger-' + index, expectedRevision: index + 1,
      scope: { input: input as 'all-messages' | 'mentions-and-replies', publication: 'future-shared-conversation' } }, context)
    expect(next.state).toBe('applied'); if (next.state !== 'applied') throw Error('Configuration absent')
    expect(next.binding.publicationBoundary).toEqual({ revision: 1 })
    expect(roomPublicationReference(next.binding)).toEqual({ bindingId: first.binding.bindingId, revision: 1 })
    expect(next.binding.sourceFrontier).toEqual(first.binding.sourceFrontier)
    expect(f.bindings.readGrant('member')).toEqual(original.grant)
    expect(f.bindings.publicationAuthority(first.binding.bindingId, 1).authorized).toBe(true)
    expect(f.bindings.effectiveGrant(first.binding.bindingId, index + 2, actor)?.state).toBe('active')
    const inspection = await f.bindings.inspect({ bindingId: first.binding.bindingId })
    expect(parseRoomBindingResult('connection.binding.inspect', inspection, { bindingId: first.binding.bindingId }).grants).toEqual([original.grant])
  }
  expect(cut).toHaveBeenCalledTimes(2)
  expect(() => parseRoomBindingParams('connection.binding.relink', { ...f.input, expectedRevision: 3, publicationBoundary: { revision: 1 } })).toThrow()
  expect(() => parseRoomBinding({ ...first.binding, publicationBoundary: { revision: 1 } })).toThrow()
  expect(() => parseRoomBinding({ ...first.binding, revision: 2, publicationOrigin: { createOperationId: 'private' }, publicationBoundary: { revision: 1 } })).toThrow()
  const revoked = await f.bindings.grant({ operationId: 'revoke-member', bindingId: first.binding.bindingId, expectedBindingRevision: 3,
    grantId: 'member', expectedRevision: 1, actor, state: 'revoked', capabilities: [] }, context)
  expect(revoked.state).toBe('applied')
  expect(f.bindings.effectiveGrant(first.binding.bindingId, 3, actor)?.state).toBe('revoked')
})

it('a real audience change and a paused interval establish independent publication cuts', async () => {
  const f = await roomBindingFixture(); cleanup.push(f.close)
  const first = await f.bindings.bind(f.input, context)
  expect(first.state).toBe('applied')
  const trigger = await f.bindings.relink({ ...f.input, operationId: 'trigger-only', expectedRevision: 1,
    scope: { input: 'all-messages', publication: 'future-shared-conversation' } }, context)
  expect(trigger.state).toBe('applied')
  const changed = await f.bindings.relink({ ...f.input, operationId: 'new-audience', expectedRevision: 2, externalConversationId: 'another-group' }, context)
  expect(changed.state).toBe('applied'); if (changed.state !== 'applied') throw Error('Changed Binding absent')
  expect(changed.binding.publicationBoundary).toBeUndefined()
  expect(f.bindings.publicationAuthority(f.input.bindingId, 1).authorized).toBe(false)
  const paused = await f.bindings.pause({ operationId: 'pause', bindingId: f.input.bindingId, expectedRevision: 3 }, context)
  expect(paused.state).toBe('applied')
  const resumed = await f.bindings.resume({ operationId: 'resume', bindingId: f.input.bindingId, expectedRevision: 4 }, context)
  expect(resumed.state).toBe('applied'); if (resumed.state !== 'applied') throw Error('Resumed Binding absent')
  expect(resumed.binding.publicationBoundary).toBeUndefined()
  expect(f.bindings.publicationAuthority(f.input.bindingId, 3).authorized).toBe(false)
})

it('an unchanged caller source cannot substitute for the current native owner observation', async () => {
  const f = await roomBindingFixture(true, { retired: false }); cleanup.push(f.close)
  expect(await f.bindings.bind(f.input, context)).toMatchObject({ state: 'applied' })
  const original = (await f.store.readMetadata(f.session.agentSessionId))!
  await f.store.compareAndSwapMetadata(original, { ...original, nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'changed-native', transcriptPath: f.transcript } })
  expect(await f.bindings.relink({ ...f.input, operationId: 'stale-source-trigger', expectedRevision: 1,
    scope: { input: 'all-messages', publication: 'future-shared-conversation' } }, context)).toMatchObject({ state: 'refused', code: 'ROOM_BINDING_SOURCE_CHANGED' })
  expect(f.bindings.readCurrent(f.input.bindingId)?.revision).toBe(1)
  expect(f.bindings.publicationAuthority(f.input.bindingId, 1).authorized).toBe(true)
})

it('missing Runtime observation retains the original relationship while a confirmed Runtime change takes a new boundary', async () => {
  const f = await roomBindingFixture(); cleanup.push(f.close)
  let runtime: string | undefined = 'original-runtime'
  const bindings = new RoomBindingHost({ connections: f.connections, spatial: f.spatial, checkpoint: f.checkpoint, executionRuntimeId: () => runtime })
  f.connections.bindings = bindings
  expect(await bindings.bind(f.input, context)).toMatchObject({ state: 'applied', binding: { executionRuntimeId: runtime } })
  runtime = undefined
  expect(await bindings.relink({ ...f.input, operationId: 'unobserved-runtime', expectedRevision: 1 }, context)).toMatchObject({ state: 'refused', code: 'ROOM_BINDING_TARGET_UNCONFIRMED' })
  expect(bindings.readCurrent(f.input.bindingId)?.revision).toBe(1)
  expect(bindings.publicationAuthority(f.input.bindingId, 1).authorized).toBe(true)
  runtime = 'confirmed-other-runtime'
  expect(await bindings.relink({ ...f.input, operationId: 'confirmed-runtime-change', expectedRevision: 1 }, context)).toMatchObject({ state: 'applied', binding: { revision: 2, executionRuntimeId: runtime } })
  expect(bindings.readCurrent(f.input.bindingId)?.publicationBoundary).toBeUndefined()
  expect(bindings.publicationAuthority(f.input.bindingId, 1).authorized).toBe(false)
})

it.each([false, true])('an established original input survives only unchanged current authorization (revoke=%s)', async revoke => {
  const f = await ingressFixture(true, config, undefined, { publication: 'future-shared-conversation' }); cleanup.push(f.close)
  const submit = f.client.submitAgentMessage.bind(f.client)
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const intercepted = vi.spyOn(f.client, 'submitAgentMessage').mockImplementation(async (...args) => { await waiting; return await submit(...args) })
  const received = await f.receive(), delivery = f.ingress.dispatch(received.ingress.ingressId)
  await vi.waitFor(() => expect(intercepted).toHaveBeenCalledOnce())
  const original = (await f.ingress.inspect({ ingressId: received.ingress.ingressId })).ingress!.input!
  expect(original.author.bindingRevision).toBe(1)
  expect(await f.bindings.relink({ ...f.input, operationId: 'trigger-change', expectedRevision: 1,
    scope: { input: 'all-messages', publication: 'future-shared-conversation' } }, context)).toMatchObject({ state: 'applied' })
  if (revoke) expect(await f.bindings.grant({ ...f.grant, operationId: 'revoke-before-core', expectedBindingRevision: 2, expectedRevision: 1, state: 'revoked' }, context)).toMatchObject({ state: 'applied' })
  release()
  const settled = await delivery
  expect(settled.ingress!.input).toEqual(original)
  if (revoke) {
    expect(f.inner.kernel.input).not.toHaveBeenCalled()
    expect((await f.ingress.authority({ operationId: original.operationId })).authority).not.toBe('current')
  } else {
    await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key: { kind: 'message', agentSessionId: original.agentSessionId, expectedRun: original.expectedRun, messageId: original.messageId } }))?.status).toBe('terminal-confirmed'), { timeout: 4_000 })
    expect(f.inner.kernel.input).toHaveBeenCalledOnce()
    expect((await f.ingress.authority({ operationId: original.operationId })).authority).toBe('current')
  }
})

it('a recorded but unclaimed intake cannot acquire authority from an input-trigger edit', async () => {
  const f = await ingressFixture(true, config, undefined, { publication: 'future-shared-conversation' }); cleanup.push(f.close)
  const received = await f.receive({ conversationKind: 'group' })
  expect(await f.bindings.relink({ ...f.input, operationId: 'new-trigger', expectedRevision: 1,
    scope: { input: 'all-messages', publication: 'future-shared-conversation' } }, context)).toMatchObject({ state: 'applied' })
  const settled = await f.ingress.dispatch(received.ingress.ingressId)
  expect(settled.ingress).toMatchObject({ state: 'refused', code: 'INGRESS_BINDING_UNAVAILABLE' })
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  const fresh = await f.receive({ eventId: 'fresh-event', messageId: 'fresh-message', conversationKind: 'group', selection: 'message' })
  await f.ingress.dispatch(fresh.ingress.ingressId)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce(), { timeout: 4_000 })
})
