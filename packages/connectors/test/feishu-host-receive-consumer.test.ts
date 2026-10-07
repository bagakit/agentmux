// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { DurableIngressHost } from '../dist/index.js'
import { FeishuAdapter } from '@agentmux/connectors/adapters/feishu'
import * as core from '../../core/dist/index.js'
import { ingressFixture } from './fixtures/ingress.js'
import { feishuConfig, feishuPayload, feishuSdkTransport } from './fixtures/feishu.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { externalIngressMailbox } from '../../../apps/desktop/test/helpers/external-ingress-mailbox.js'

const mountedMailbox = externalIngressMailbox(), cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('the actual SDK callback joins original durable intake, Core queue, mounted Mailbox and public CLI receipts', async () => {
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const f = await ingressFixture(true, feishuConfig); cleanup.push(() => f.close())
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const transport = feishuSdkTransport(), adapter = new FeishuAdapter({ connections: f.connections, http: transport.http })
  const ingress = new DurableIngressHost({ ...f.options, authenticators: [adapter] }); f.connections.ingress = ingress
  const receiver = await adapter.openReceiver(feishuConfig, 'fixture-credential', ingress); cleanup.push(() => receiver.close())
  await vi.waitFor(() => expect(receiver.observation().transport.state).toBe('ready'))
  const payload = feishuPayload({ thread_id: 'platform-thread', content: JSON.stringify({ text: '群里的原始消息\nContinue in the original Session.' }) })
  await transport.receive(payload)
  expect(transport.ack()).toEqual([{ code: 200 }])
  const [received] = (await ingress.list({ connectionId: feishuConfig.connectionId })).ingresses
  expect(received!.state).toBe('received')
  const dispatched = await ingress.dispatch(received!.ingressId), input = dispatched.ingress!.input!
  expect(input.agentSessionId).toBe(f.input.agentSessionId); expect(input.expectedRun).toEqual(f.session.run)
  const original = await new core.DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath()).readByOperationId(input.operationId)
  expect(original!.envelope.sender).toEqual(input.author)
  expect(original!.envelope.body).toBe(JSON.parse(payload.event.message.content).text)
  expect(original!.envelope.senderSessionId).toBeNull()
  let timeline = await f.client.sessionTimeline(f.input.agentSessionId)
  await vi.waitFor(async () => {
    timeline = await f.client.sessionTimeline(f.input.agentSessionId)
    expect(timeline.items.find(item => item.id === `prompt:${input.messageId}`)?.authorExternal).toEqual(input.author)
  })
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  const recorded = timeline.items.find(item => item.id === `prompt:${input.messageId}`)!
  const read = await mountedMailbox(f.session, timeline, recorded.id)
  expect(read.detail.dataset.speakerRole).toBe('external')
  for (const fact of [feishuConfig.application.domain, feishuConfig.application.appId, 'open_id', 'original-external-user', 'original-room', 'platform-message']) expect(read.detail.textContent).toContain(fact)
  await read.copyOriginal(); expect(read.copy).toHaveBeenCalledWith(recorded.content)
  expect(recorded.content).toContain(original!.envelope.body)
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'feishu.sock'), connections: f.connections, coreClients: f.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const env = objectCliEnvironment(f.root)
  const cli = (args: string[]) => runCompiledObjectCli(['--endpoint', 'unix:' + server.path, ...args], env)
  const listed = await cli(['connection', 'ingress', 'ls', '--connection', feishuConfig.connectionId, '--limit', '1'])
  expect(listed.code, listed.stderr).toBe(0)
  const found = JSON.parse(listed.stdout).result.ingresses[0]
  expect(found.ingressId).toBe(received!.ingressId)
  const inspected = await cli(['connection', 'ingress', 'inspect', '--ingress', found.ingressId])
  expect(inspected.code, inspected.stderr).toBe(0)
  const result = JSON.parse(inspected.stdout).result
  expect(result.ingress.input).toEqual(input); expect(result.inputReceipt.originalControlOperationId).toBe(input.operationId)
  expect(JSON.stringify(result)).not.toContain('fixture-credential'); expect(JSON.stringify(result)).not.toContain('transportProof')
  expect((await f.client.readAgentSessions()).map(session => session.agentSessionId)).toEqual([f.input.agentSessionId])
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled()
  const evidence = resolve('.bagakit/evidence/feishu-adapter')
  await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, 'actual-call-chain.json'), JSON.stringify({
    transport: 'Pinned SDK with controlled HTTP and WebSocket I/O; no real platform credentials or live Run',
    calls: [
      { owner: 'SDK WebSocket event handler', input: { eventId: payload.header.event_id, appId: payload.header.app_id, externalMessageId: payload.event.message.message_id, externalConversationId: payload.event.message.chat_id }, result: transport.ack() },
      { owner: 'connection.ingress.ls', params: { connectionId: feishuConfig.connectionId, limit: 1 }, result: JSON.parse(listed.stdout).result },
      { owner: 'connection.ingress.inspect', params: { ingressId: found.ingressId }, result }
    ],
    originalCoreInput: { operationId: input.operationId, messageId: input.messageId, agentSessionId: input.agentSessionId, expectedRun: input.expectedRun, author: input.author, body: original!.envelope.body },
    originalDesktop: { consumer: 'mounted SessionMailbox', speaker: read.detail.dataset.speakerRole, recordId: recorded.id, author: recorded.authorExternal, copiedCompleteBody: true }
  }, null, 2) + '\n')
}, 20_000)
