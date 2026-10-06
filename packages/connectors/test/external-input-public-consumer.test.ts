// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import * as core from '../../core/dist/index.js'
import { ingressFixture } from './fixtures/ingress.js'
import { config, context } from './fixtures/room-binding.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { conversationAxis, speaksAsHuman } from '../../../apps/desktop/src/renderer/src/lib/conversation-axis.js'
import { externalIngressMailbox } from '../../../apps/desktop/test/helpers/external-ingress-mailbox.js'

const mountedMailbox = externalIngressMailbox(), cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs() })

it('public Host admission uses the original Core queue and Desktop reader with structured external attribution', async () => {
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const f = await ingressFixture(true); cleanup.push(() => f.close())
  // rpcOwnerFixture clears transport environment; restore the compiled binary override for happy-dom.
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const accepted = await f.receive(), dispatched = await f.ingress.dispatch(accepted.ingress.ingressId), input = dispatched.ingress!.input!
  let timeline = await f.client.sessionTimeline(f.input.agentSessionId)
  await vi.waitFor(async () => {
    timeline = await f.client.sessionTimeline(f.input.agentSessionId)
    expect(timeline.items.find(item => item.id === `prompt:${input.messageId}`)?.authorExternal).toEqual(input.author)
  }, { timeout: 4000 })
  const original = await new core.DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath()).readByOperationId(input.operationId)
  expect(original!.envelope.sender).toEqual(input.author)
  expect(original!.envelope.body).toBe(f.event().body)
  expect(original!.envelope.senderSessionId).toBeNull(); expect(original!.envelope.senderRunId).toBeNull()
  expect((await new core.DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath()).inspectInput({ kind: 'message-control', originalControlOperationId: input.operationId }))!.intent.source).toEqual({ kind: 'message', messageId: input.messageId, originalControlOperationId: input.operationId })
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  const recorded = timeline.items.find(item => item.id === `prompt:${input.messageId}`)!
  expect(conversationAxis(timeline.items, speaksAsHuman).map(mark => mark.item)).toContain(recorded)
  expect(recorded.authorHuman).toBeUndefined(); expect(recorded.authorAgentSessionId).toBeUndefined()
  const read = await mountedMailbox(f.client.agentSession(f.input.agentSessionId), timeline, recorded.id)
  expect(read.detail.dataset.speakerRole).toBe('external')
  expect(read.detail.textContent).toContain(f.actor.userId)
  for (const fact of [config.application.domain, config.application.appId, f.actor.idType, f.input.externalConversationId, f.event().messageId, f.input.bindingId, f.grant.grantId]) expect(read.detail.textContent).toContain(fact)
  expect(read.detail.dataset.conversationItemRef).toBe(JSON.stringify({ hostId: 'local', agentSessionId: f.input.agentSessionId, source: { kind: 'captured', recordId: recorded.id } }))
  await read.copyOriginal(); expect(read.copy).toHaveBeenCalledWith(recorded.content)
  expect(recorded.content).toContain(f.event().body)
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'ingress.sock'), connections: f.connections, coreClients: f.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const submissions = vi.spyOn(f.client, 'submitAgentMessage')
  const env = objectCliEnvironment(f.root), cli = (args: string[]) => runCompiledObjectCli(['--endpoint', 'unix:' + server.path, ...args], env)
  const list = await cli(['connection', 'ingress', 'ls', '--connection', config.connectionId, '--limit', '1'])
  expect(list.code, list.stderr).toBe(0)
  const found = JSON.parse(list.stdout).result.ingresses[0]
  expect(found.ingressId).toBe(accepted.ingress.ingressId)
  const detail = await cli(['connection', 'ingress', 'inspect', '--ingress', found.ingressId])
  expect(detail.code, detail.stderr).toBe(0)
  const receipt = JSON.parse(detail.stdout).result
  expect(receipt.ingress.input).toEqual(input); expect(receipt.inputReceipt.originalControlOperationId).toBe(input.operationId)
  expect(receipt.ingress.body).toBe(f.event().body); expect(JSON.stringify(receipt)).not.toContain('adapter-private-witness')
  const history = await cli(['agent', 'history', '--host', 'local', '--session', f.input.agentSessionId, '--source', 'captured', '--kind', 'user-message'])
  expect(history.code, history.stderr).toBe(0)
  expect(JSON.parse(history.stdout).result.userMessages.find((message: { rawId: string }) => message.rawId === recorded.id).author).toEqual(input.author)
  const sdk = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => sdk.dispose())
  for (const field of ['sender', 'externalAuthor', 'authenticated']) await expect(sdk.call('agent.send', { target: { kind: 'agent-session', agentSessionId: f.input.agentSessionId }, text: 'Payload cannot authenticate itself', operationId: 'forged-' + field, [field]: field === 'authenticated' ? true : input.author } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect(submissions).not.toHaveBeenCalled()
  const originalWrites = (f.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls.length
  await f.bindings.grant({ ...f.grant, operationId: 'revoke-public', expectedRevision: 1, state: 'revoked' }, context)
  const rejected = await f.receive({ eventId: 'after-revoke', messageId: 'after-revoke' })
  expect((await f.ingress.dispatch(rejected.ingress.ingressId)).ingress).toMatchObject({ state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED' })
  // Refusing this actor does not remove the original local Agent input capability.
  const local = await cli(['agent', 'send', '--to-session', f.input.agentSessionId, '--text', 'Original local input remains available', '--execution', 'immediate', '--operation-id', 'healthy-local-operation'])
  expect(local.code, local.stderr).toBe(0)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledTimes(originalWrites + 1))
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled()
  const help = await runCompiledObjectCli(['connection', 'ingress', 'inspect', '--help'], env)
  expect(help.code).toBe(0); expect(help.stdout).toContain('--ingress')
  const skill = await runCompiledObjectCli(['--skill'], env)
  expect(skill.code).toBe(0); expect(skill.stdout).toContain('connection ingress ls')
}, 20_000)

it('the original SDK refuses external author data without the live exact Host context', async () => {
  const f = await ingressFixture(); cleanup.push(() => f.close())
  const accepted = await f.receive(), first = await f.ingress.dispatch(accepted.ingress.ingressId), input = first.ingress!.input!
  const original = await new core.DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath()).readByOperationId(input.operationId)
  const body = { agentSessionId: f.input.agentSessionId, envelope: { ...original!.envelope, operationId: 'untrusted-operation', messageId: 'untrusted-message' }, admissionIntent: { kind: 'manual-actor' as const, expectedRun: input.expectedRun }, execution: 'immediate' as const }
  await expect(f.client.submitAgentMessage(body)).rejects.toMatchObject({ code: 'EXTERNAL_AUTHOR_REQUIRED' })
  await expect(f.client.submitAgentMessage(body, { externalAuthor: { identity: { ...input.author, actor: { ...input.author.actor, idType: 'union_id' } }, assertCurrent: vi.fn() } })).rejects.toMatchObject({ code: 'EXTERNAL_AUTHOR_REQUIRED' })
  expect(await f.client.inspectAgentInput({ kind: 'message-control', originalControlOperationId: 'untrusted-operation' })).toBeNull()
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'untrusted-rejoin.sock'), coreClients: f.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const sdk = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => sdk.dispose())
  await expect(sdk.call('agent.input.rejoin', { ref: first.inputReceipt!.ref })).rejects.toMatchObject({ code: 'EXTERNAL_AUTHOR_REQUIRED' })
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('revocation while original Core is preparing input prevents that dispatch and preserves ordinary input', async () => {
  const f = await ingressFixture(true); cleanup.push(() => f.close())
  let release!: () => void, entered!: () => void
  const paused = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  f.inner.kernel.status = vi.fn(async (runId: string) => { entered(); await paused; return f.run(runId) })
  const accepted = await f.receive(), first = await f.ingress.dispatch(accepted.ingress.ingressId)
  await started
  await f.bindings.grant({ ...f.grant, operationId: 'revoke-during-prepare', expectedRevision: 1, state: 'revoked' }, context)
  release()
  await vi.waitFor(async () => expect((await f.ingress.inspect({ ingressId: accepted.ingress.ingressId })).inputReceipt?.control.waiting?.phase).toBe('authorization'))
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect((await f.ingress.inspect({ ingressId: accepted.ingress.ingressId })).ingress!.input).toEqual(first.ingress!.input)
  await f.client.submitAgentPrompt({ agentSessionId: f.input.agentSessionId, expectedRun: f.session.run, operationId: 'local-after-revoked-preparation', prompt: 'Original local input', admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', authorHuman: true })
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 10_000)

it.each(['recipient', 'body', 'operation'] as const)('a trusted Host context refuses a changed actual %s before the original Core queue', async changed => {
  const f = await ingressFixture(); cleanup.push(() => f.close())
  const original = f.client.submitAgentMessage.bind(f.client)
  const submit = vi.spyOn(f.client, 'submitAgentMessage').mockImplementationOnce((input, context) => {
    const envelope = { ...input.envelope, ...(changed === 'body' ? { body: 'Cannot replace authenticated body' } : changed === 'operation' ? { operationId: 'replacement-operation', messageId: 'replacement-message' } : { recipient: { kind: 'agent-session' as const, agentSessionId: 'different-session' }, recipientSessionId: 'different-session' }) }
    return original({ ...input, envelope, ...(changed === 'recipient' ? { agentSessionId: 'different-session' } : {}) }, context)
  })
  const accepted = await f.receive(), result = await f.ingress.dispatch(accepted.ingress.ingressId)
  expect(result.ingress!.state).toBe('claimed'); expect(result.inputReceipt).toBeNull()
  expect(await new core.DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath()).listAfter(0)).toEqual([])
  expect(submit).toHaveBeenCalledOnce()
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
