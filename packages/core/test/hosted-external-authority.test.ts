import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import * as core from '../dist/index.js'
import { connectHostedAgentMux } from '../dist/hosted.js'
import { AgentMuxHostedRuntimeService } from '../dist/hosted-runtime-service.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture() {
  const f = await rpcOwnerFixture(['recipient'], core, () => ({ providerId: 'claude', executorId: 'claude' }))
  cleanup.push(() => f.close())
  vi.spyOn(f.client, 'connect').mockResolvedValue()
  const provider = (f.client as unknown as { providers: { get(id: string): { planPromptInput(text: string): unknown } } }).providers.get('claude')
  vi.spyOn(provider, 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  const author: core.AgentExternalMessageAuthor = {
    kind: 'external', connectionId: 'original-connection', actor: { application: { domain: 'chat.example', appId: 'original-app' }, idType: 'user_id', userId: 'original-user' },
    externalConversationId: 'original-room', externalMessageId: 'original-external-message', bindingId: 'original-binding', bindingRevision: 1, grantId: 'original-grant', grantRevision: 1
  }
  const intent: core.AgentExternalInputIntent = { agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, operationId: 'original-operation', messageId: 'original-message', body: 'Original full external body\nSecond line' }
  let current = true
  // This trusted process port models a read from the original claim owner, never wire-supplied permission.
  const assertCurrent = vi.fn(async (actualAuthor, actualIntent) => {
    if (!current || JSON.stringify(actualAuthor) !== JSON.stringify(author) || JSON.stringify(actualIntent) !== JSON.stringify(intent)) throw new core.AgentMuxError('The original external claim or current authority is unavailable.', 'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED')
  })
  const service = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => hostedTestOwner(f.client), undefined, { assertCurrent })
  cleanup.push(() => service.dispose())
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'hosted-external.sock'), coreClients: f.coreClients, hostedRuntime: () => service })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const client = await connectHostedAgentMux({ rpc }); cleanup.push(() => client.dispose())
  const message: Parameters<typeof client.submitAgentMessage>[0] = {
    agentSessionId: intent.agentSessionId, admissionIntent: { kind: 'manual-actor', expectedRun: intent.expectedRun }, execution: 'immediate', sourceChannel: 'agent-message',
    envelope: { schema: 'agentmux.a2a.v1', createdAt: Date.now(), operationId: intent.operationId, messageId: intent.messageId,
      sender: author, recipient: { kind: 'agent-session', agentSessionId: intent.agentSessionId }, recipientSessionId: intent.agentSessionId, recipientRunId: intent.expectedRun.runId,
      senderSessionId: null, senderRunId: null, threadId: 'original-thread', correlationId: 'original-correlation', replyTo: null, workspaceId: null, body: intent.body }
  }
  return { ...f, client, rpc, message, author, intent, assertCurrent, setCurrent(value: boolean) { current = value } }
}

it('the real Hosted transport borrows only the installed current-authority port for the original external input', async () => {
  const f = await fixture()
  await expect(f.client.submitAgentMessage(f.message)).resolves.toMatchObject({ key: { kind: 'message', messageId: f.intent.messageId } })
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect(f.assertCurrent).toHaveBeenCalledWith(f.author, f.intent)
  const original = await new core.DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath()).readByOperationId(f.intent.operationId)
  expect(original!.envelope.sender).toEqual(f.author); expect(original!.envelope.body).toBe(f.intent.body)
  await f.client.submitAgentMessage(f.message)
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  const owner = f.client.runtimeOwnerIdentity()!
  await expect(f.rpc.call('runtime.invoke', { consumerId: 'forged-context', fence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }, invocation: { method: 'submitAgentMessage', args: [f.message, { externalAuthor: f.author, authenticated: true }] } } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(f.rpc.call('agent.send', { target: { kind: 'agent-session', agentSessionId: 'recipient' }, text: f.intent.body, externalAuthor: f.author } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
})

it('Hosted rejoin takes its external author from the original Core journal and rechecks the current owner', async () => {
  const f = await fixture()
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), paused = new Promise<void>(resolve => { release = resolve })
  f.inner.kernel.status = vi.fn(async (runId: string) => { entered(); await paused; return f.run(runId) })
  await f.client.submitAgentMessage(f.message)
  await started; f.setCurrent(false); release()
  let receipt: core.AgentInputSubmissionReceipt | null = null
  await vi.waitFor(async () => {
    receipt = await f.client.inspectAgentInput({ kind: 'message-control', originalControlOperationId: f.intent.operationId })
    expect(receipt?.control.waiting?.phase).toBe('authorization')
  })
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  f.setCurrent(true)
  await f.client.rejoinAgentInputWaiting({ ref: receipt!.ref })
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect(f.assertCurrent).toHaveBeenLastCalledWith(f.author, f.intent)
  expect((await f.client.inspectAgentInput({ key: receipt!.key }))?.originalControlOperationId).toBe(f.intent.operationId)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('ordinary Hosted message rejoin remains usable while the connector authority port is unavailable', async () => {
  const f = await fixture(); f.setCurrent(false)
  f.inner.connected = false; f.inner.kernel.isConnected = () => false
  const local = { ...f.message, envelope: { ...f.message.envelope, operationId: 'local-operation', messageId: 'local-message', sender: { kind: 'human' as const, principal: 'local-cli' as const }, body: 'Original local input' } }
  await f.client.submitAgentMessage(local)
  const receipt = await f.client.inspectAgentInput({ kind: 'message-control', originalControlOperationId: 'local-operation' })
  expect(receipt?.control.state).toBe('enabled'); expect(f.assertCurrent).not.toHaveBeenCalled()
  f.inner.connected = true; f.inner.kernel.isConnected = () => true
  await f.client.rejoinAgentInputWaiting({ ref: receipt!.ref })
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect(f.assertCurrent).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each(['body', 'operation', 'recipient'] as const)('the original Hosted owner refuses a changed %s before queue or input', async changed => {
  const f = await fixture()
  const message = { ...f.message, envelope: { ...f.message.envelope,
    ...(changed === 'body' ? { body: 'Untrusted replacement' } : changed === 'operation' ? { operationId: 'different-operation' } : { recipient: { kind: 'agent-session' as const, agentSessionId: 'different-recipient' }, recipientSessionId: 'different-recipient' }) },
    ...(changed === 'recipient' ? { agentSessionId: 'different-recipient' } : {}) }
  await expect(f.client.submitAgentMessage(message)).rejects.toBeInstanceOf(Error)
  expect(await new core.DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath()).listAfter()).toEqual([])
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
