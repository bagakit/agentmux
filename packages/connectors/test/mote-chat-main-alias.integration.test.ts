import { expect, it, vi } from 'vitest'
import { moteChatJourneyFixture as journey } from './fixtures/mote-chat-journey.js'
const fixture = () => journey(4, 60_000, 'headless', false, 'grok', undefined, 'bound', 'signed-room')
async function delivered(f: Awaited<ReturnType<typeof fixture>>, ingressId: string) {
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId })).inputReceipt?.status).toBe('terminal-confirmed'), { timeout: 4_000 })
}

it('retains an original Main admission after selecting a same-application alias and replies only through its original Connection', async () => {
  const f = await fixture()
  expect(await f.wire.post(f.message('alias-main-original'))).toBe(202)
  const source = await f.claimed('alias-main-original')
  await delivered(f, source.ingressId)
  const author = source.input!.author, original = (await f.services.connections.inspect({ connectionId: source.connectionId })).connection!
  const relation = () => f.sdk.call('connection.binding.inspect', { bindingId: author.bindingId, revision: author.bindingRevision })
  const alias = { ...original.config, connectionId: 'same-application-main-alias' }
  await f.sdk.call('connection.configure', { operationId: 'save-main-alias', expectedRevision: null, connection: alias })
  const configuration = (await f.sdk.call('space.mote.chat.inspect', { target: f.target })).configuration!
  await f.sdk.call('space.mote.chat.configure', { operationId: 'select-main-alias', target: f.target, expectedRevision: configuration.revision, expectedConnectionRevision: 1,
    values: { ...configuration.values, connection: { connectionId: alias.connectionId, application: alias.application } } })
  expect(await relation()).toMatchObject({ binding: { state: 'active', connectionId: source.connectionId, agentSessionId: source.input!.agentSessionId }, grants: [{ state: 'active', actor: source.actor }] })
  expect((await f.sdk.call('connection.binding.inspect', { bindingId: 'wrong-binding' })).binding).toBeNull()
  expect(await f.sdk.call('connection.ingress.authority', { operationId: source.input!.operationId })).toMatchObject({ authority: 'current', ingress: { input: source.input } })
  const dispatch = vi.spyOn(f.wire.adapter.publication!, 'dispatch'), credentials = f.credentials(0)
  const wrongActor = await f.cliRaw('reply', { operationId: 'wrong-caller-after-main-alias', ingressId: source.ingressId, body: 'Must remain unsent' })
  expect(wrongActor.code).not.toBe(0); expect(wrongActor.stdout + wrongActor.stderr).toContain('CONTROL_PERMISSION_DENIED')
  const reply = await f.cli('reply', { operationId: 'reply-after-main-alias', ingressId: source.ingressId, body: 'Reply to the original Main person through original A' }, credentials)
  expect(reply.operation.binding.connectionId).toBe(source.connectionId)
  await vi.waitFor(() => expect(f.wire.effects).toHaveLength(1))
  expect(dispatch.mock.calls[0]![1]).toMatchObject({ connectionId: source.connectionId, externalConversationId: source.externalConversationId })
  await f.services.connections.configure({ operationId: 'disable-original-main-connection', expectedRevision: 1, connection: { ...original.config, enabled: false } })
  expect(await relation()).toMatchObject({ current: { state: 'paused' }, grants: [{ state: 'revoked' }] })
  const denied = await f.cliRaw('reply', { operationId: 'cannot-reply-after-original-disable', ingressId: source.ingressId, body: 'Must remain unsent' }, credentials)
  expect(denied.code).not.toBe(0); expect(denied.stdout + denied.stderr).toContain('MOTE_CHAT_REPLY_SOURCE_UNCONFIRMED')
  await f.services.connections.configure({ operationId: 'restore-original-main-connection', expectedRevision: 2, connection: original.config })
  expect(await relation()).toMatchObject({ binding: { state: 'active' }, grants: [{ state: 'active' }] })
  await expect(f.services.connections.configure({ operationId: 'change-original-main-application', expectedRevision: 3, connection: { ...original.config, application: { ...original.config.application, appId: 'different-application' } } })).rejects.toMatchObject({ code: 'CONNECTION_IDENTITY_CONFLICT' })
  expect(await relation()).toMatchObject({ current: { state: 'active' }, grants: [{ state: 'active' }] })
  const other = { ...alias, connectionId: 'different-application-connection', application: { ...alias.application, appId: 'different-application' } }
  await f.sdk.call('connection.configure', { operationId: 'save-different-main-application', expectedRevision: null, connection: other })
  const beforeOther = (await f.sdk.call('space.mote.chat.inspect', { target: f.target })).configuration!
  await f.sdk.call('space.mote.chat.configure', { operationId: 'select-different-main-application', target: f.target, expectedRevision: beforeOther.revision, expectedConnectionRevision: 1,
    values: { ...beforeOther.values, connection: { connectionId: other.connectionId, application: other.application } } })
  expect(await relation()).toMatchObject({ current: { state: 'paused' }, grants: [{ state: 'revoked' }] })
  vi.spyOn(f.adapter.profile!, 'get').mockResolvedValue({ connectionId: alias.connectionId, connectionRevision: 1, application: alias.application, language: null, state: 'observed',
    profile: null, metadata: null, creator: { idType: f.guest.idType, userId: f.guest.userId }, botId: null, onlineVersionId: null, reviewingVersionId: null, version: null })
  const current = (await f.sdk.call('space.mote.chat.inspect', { target: f.target })).configuration!
  await f.sdk.call('space.mote.chat.configure', { operationId: 'confirm-different-main-creator', target: f.target, expectedRevision: current.revision, expectedConnectionRevision: 1,
    values: { ...current.values, connection: { connectionId: alias.connectionId, application: alias.application } }, refreshCreator: true })
  expect(await relation()).toMatchObject({ current: { state: 'paused' }, grants: [{ state: 'revoked' }] })
  expect(f.wire.effects).toHaveLength(1)
}, 25_000)
