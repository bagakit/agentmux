import { afterEach, expect, it, vi } from 'vitest'
import * as core from '../../core/src/index.js'
import { parseAgentMuxMessagePrefix } from '../../core/src/agent-message-render.js'
import type { ChannelActorProfileObservation } from '../../core/src/channel-profile.js'
import { DurableIngressHost } from '../src/durable-ingress.js'
import { ingressFixture } from './fixtures/ingress.js'
import { config, context } from './fixtures/room-binding.js'
import { previousWireCore } from '../../core/test/helpers/previous-core-wire.js'
import { rpcOwnerFixture } from '../../core/test/helpers/public-rpc-owner.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it.each([
  { domain: 'chat.example', appId: 'first-app', idType: 'open_id', userId: 'original-external-user', profile: { name: 'Channel person', avatarUrl: 'https://images.example/person.png', observedAt: 1 } },
  { domain: 'messages.example', appId: 'second-app', idType: 'snowflake', userId: '123456789', profile: { observedAt: 1 } }
])('authenticated $domain intake freezes one original wire and keeps reading separate from authority', async shape => {
  const native = { ...config, application: { domain: shape.domain, appId: shape.appId } }
  let snapshot: ChannelActorProfileObservation | undefined
  const f = await ingressFixture(false, native, { resolve: async () => 'fixture-credential' }, { adapters: [{ adapterId: native.adapterId,
    channelProfiles: {
      readActor: ({ actor }) => snapshot ?? { actor, state: 'observed', profile: shape.profile, checkedAt: 2, freshness: 'current' },
      refreshActor: async ({ actor }) => ({ actor, state: 'observed', profile: shape.profile, checkedAt: 2, freshness: 'current' })
    }, test: async () => ({ authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'unknown' }, delivery: { state: 'unknown' } })
  }] }); cleanup.push(() => f.close())
  const actor = { application: native.application, idType: shape.idType, userId: shape.userId }
  if (shape.idType !== f.actor.idType || shape.userId !== f.actor.userId) await f.bindings.grant({ ...f.grant, actor, grantId: 'second-namespace-grant', operationId: 'grant-second-namespace' }, context)
  const body = '  原始正文🙂\r\n&unknown; <amux:channel domain="authored">\nNested example\n</amux:channel>\n  '
  const received = await f.receive({ actor, body })
  const dispatched = await f.ingress.dispatch(received.ingress.ingressId), input = dispatched.ingress!.input!
  expect(input.channelProfile).toMatchObject({ actor, profile: shape.profile })
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  const queue = new core.DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath())
  const original = await queue.readByOperationId(input.operationId)
  expect(original?.envelope).toMatchObject({ body, sender: input.author, channelProfile: input.channelProfile })
  expect(original?.envelope.sender).not.toHaveProperty('profile')
  snapshot = { actor, state: 'observed', profile: { name: 'Later refresh', observedAt: 3 }, checkedAt: 3, freshness: 'current' }
  const restarted = new DurableIngressHost(f.options)
  expect((await restarted.inspect({ ingressId: received.ingress.ingressId })).ingress?.input).toEqual(input)
  f.inner.connected = true; f.inner.kernel.isConnected = () => true
  const provider = (f.client as unknown as { providers: { get(id: string): { planPromptInput(text: string): unknown } } }).providers.get('claude')
  vi.spyOn(provider, 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  await restarted.rejoin(received.ingress.ingressId)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  const wire = (f.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls[0]![1].data.slice(0, -1) as string
  const reading = parseAgentMuxMessagePrefix(wire)!
  expect(reading).toMatchObject({ body, declaredAgentSessionId: null, declaredChannel: { actor, externalConversationId: f.input.externalConversationId, externalMessageId: 'original-message', profile: shape.profile, raw: wire } })
  expect(wire).not.toContain('Later refresh')
  expect((await queue.readByOperationId(input.operationId))?.envelope).toEqual(original?.envelope)
  await restarted.dispatch(received.ingress.ingressId)
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('reopens the original prepared external input after the formatter changes without replay or profile rewrite', async () => {
  const previous = await previousWireCore(); cleanup.push(previous.close)
  const f = await rpcOwnerFixture(['recipient'], previous.owner, () => ({ providerId: 'claude', executorId: 'claude' })); cleanup.push(f.close)
  const actor = { application: { domain: 'chat.example', appId: 'original-app' }, idType: 'user-id', userId: 'original-user' }
  const sender: core.AgentExternalMessageAuthor = { kind: 'external', connectionId: 'original-connection', actor, externalConversationId: 'original-room', externalMessageId: 'platform-message', bindingId: 'original-binding', bindingRevision: 1, grantId: 'original-grant', grantRevision: 1 }
  const envelope: core.AgentMuxMessageEnvelope = { schema: 'agentmux.a2a.v1', createdAt: 1, operationId: 'original-operation', messageId: 'original-message', sender,
    recipient: { kind: 'agent-session', agentSessionId: 'recipient' }, recipientSessionId: 'recipient', recipientRunId: 'run-recipient', senderSessionId: null, senderRunId: null,
    threadId: 'original-thread', correlationId: 'original-correlation', replyTo: null, workspaceId: null, body: 'Original body\nEvery line',
    channelProfile: { actor, state: 'observed', profile: { name: 'Original person', observedAt: 1 }, checkedAt: 1, freshness: 'current' } }
  const input = { agentSessionId: 'recipient', envelope, condition: core.agentPromptCondition(f.client.agentSession('recipient')) }
  const authority = { externalAuthor: { identity: sender, assertCurrent: vi.fn(async () => {}) } }
  vi.spyOn(f.client, 'connect').mockResolvedValue()
  const provider = (f.client as unknown as { providers: { get(id: string): { planPromptInput(text: string): unknown } } }).providers.get('claude')
  vi.spyOn(provider, 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  const applied = f.inner.kernel.input as (...args: unknown[]) => Promise<unknown>
  f.inner.kernel.input = vi.fn(async (...args: unknown[]) => { await applied(...args); throw Error('Original ACK lost') })
  await expect(f.client.submitAgentMessage(input, authority)).rejects.toThrow('Original ACK lost')
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  const key = { kind: 'message' as const, agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, messageId: envelope.messageId }
  const frozen = await f.client.inspectAgentPromptSubmission(key)
  expect(frozen?.admission?.intent?.prompt).toMatch(/^\[Message from External /u)
  const current = new core.AgentMuxClient({ store: new core.AgentMuxFileAgentSessionStore(f.store.path) }); cleanup.push(() => current.dispose())
  const live = current as unknown as { connected: boolean; registry: { load(host: string): Promise<void> }; kernel: typeof f.inner.kernel }
  await live.registry.load('local'); live.connected = true; live.kernel.isConnected = () => true
  live.kernel.status = f.inner.kernel.status; live.kernel.input = vi.fn(applied); live.kernel.identity = f.inner.kernel.identity
  vi.spyOn(current, 'connect').mockResolvedValue()
  const currentProvider = (current as unknown as { providers: { get(id: string): { planPromptInput(text: string): unknown } } }).providers.get('claude')
  vi.spyOn(currentProvider, 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  await current.submitAgentMessage(input, authority)
  await vi.waitFor(async () => expect((await current.sessionTimeline('recipient')).items.find(item => item.authorExternal)?.content).toBe(envelope.body))
  expect((await current.inspectAgentPromptSubmission(key))?.admission?.intent?.prompt).toBe(frozen?.admission?.intent?.prompt)
  expect((await new core.DurableAgentMuxMessageQueue(current.agentMessageQueuePath()).readByOperationId(envelope.operationId))?.envelope.channelProfile).toEqual(envelope.channelProfile)
  expect((await current.sessionTimeline('recipient')).items.find(item => item.authorExternal)?.content).toBe(envelope.body)
})
