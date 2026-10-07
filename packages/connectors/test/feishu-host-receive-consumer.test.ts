// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { DurableIngressHost } from '../dist/index.js'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { FeishuAdapter } from '@agentmux/connectors/adapters/feishu'
import * as core from '../../core/dist/index.js'
import { ingressFixture } from './fixtures/ingress.js'
import { feishuConfig, feishuPayload, feishuSdkTransport, startFeishuTransport } from './fixtures/feishu.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { externalIngressMailbox } from '../../../apps/desktop/test/helpers/external-ingress-mailbox.js'

const mountedMailbox = externalIngressMailbox(), cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('the actual SDK callback joins original durable intake, Core queue, mounted Mailbox and public CLI receipts', async () => {
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const f = await ingressFixture(true, feishuConfig); cleanup.push(() => f.close())
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const transport = feishuSdkTransport(), adapter = new FeishuAdapter({ http: transport.http })
  const ingress = new DurableIngressHost({ ...f.options, authenticators: [adapter] }); f.connections.ingress = ingress
  const receiver = await startFeishuTransport(adapter.transport, feishuConfig, ingress); cleanup.push(() => receiver.close())
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
  const evidence = resolve('.bagakit/evidence/feishu-transport')
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

it('a saved SDK parent stays unknown until its exact application author is readable, then uses the same original intake and Core queue', async () => {
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const f = await ingressFixture(true, feishuConfig, { resolve: async () => 'fixture-credential' }); cleanup.push(() => f.close())
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const transport = feishuSdkTransport(), adapter = new FeishuAdapter({ http: transport.http })
  const ingress = new DurableIngressHost({ ...f.options, authenticators: [adapter] }); f.connections.ingress = ingress
  const receiver = await startFeishuTransport(adapter.transport, feishuConfig, ingress); cleanup.push(() => receiver.close())
  await vi.waitFor(() => expect(receiver.observation().transport.state).toBe('ready'))
  const payload = feishuPayload({ parent_id: 'original-bot-parent', mentions: [], content: JSON.stringify({ text: 'Reply in the existing Session\n完整原文' }) })
  const request = transport.request.getMockImplementation()!
  let readable = false
  transport.request.mockImplementation(async input => {
    if (!input.url?.endsWith('/messages/original-bot-parent')) return request(input)
    if (!readable) throw new Error('Private original lookup is unavailable')
    return { code: 0, data: { items: [{ message_id: 'original-bot-parent', chat_id: 'original-room', deleted: false, sender: { id: feishuConfig.application.appId, id_type: 'app_id', sender_type: 'app' } }] } }
  })
  await transport.receive(payload)
  expect(transport.request.mock.calls.some(([input]) => input.url?.includes('/messages/'))).toBe(false)
  expect(transport.ack()).toEqual([{ code: 200 }])
  const [saved] = (await ingress.list({ connectionId: feishuConfig.connectionId })).ingresses
  const unknown = await ingress.dispatch(saved!.ingressId)
  expect(unknown.ingress).toMatchObject({ state: 'received', body: JSON.parse(payload.event.message.content).text, addressing: { state: 'unknown', reason: 'reply-unconfirmed', replyToMessageId: 'original-bot-parent' } })
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'feishu-parent.sock'), connections: f.connections, coreClients: f.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const env = objectCliEnvironment(f.root), cli = () => runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'ingress', 'inspect', '--ingress', saved!.ingressId], env)
  const observed = await cli()
  expect(observed.code, observed.stderr).toBe(0)
  expect(JSON.parse(observed.stdout).result).toMatchObject({ ingress: unknown.ingress, inputReceipt: null, observation: 'not-started' })
  readable = true
  const resumed = await ingress.dispatch(saved!.ingressId), input = resumed.ingress!.input!
  expect(resumed.ingress).toMatchObject({ ingressId: saved!.ingressId, state: 'claimed', addressing: { state: 'confirmed', selection: 'reply', replyToMessageId: 'original-bot-parent' } })
  expect(input.agentSessionId).toBe(f.input.agentSessionId); expect(input.expectedRun).toEqual(f.session.run)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  const original = await new core.DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath()).readByOperationId(input.operationId)
  expect(original!.envelope.body).toBe(JSON.parse(payload.event.message.content).text)
  expect(original!.envelope.sender).toEqual(input.author)
  await transport.receive(payload)
  expect((await ingress.list({ connectionId: feishuConfig.connectionId })).ingresses).toHaveLength(1)
  expect((await ingress.inspect({ ingressId: saved!.ingressId })).ingress!.input).toEqual(input)
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  const row = f.connections.database.prepare('SELECT event_json,raw_payload FROM connection_ingress_event').get()!
  expect(JSON.parse(String(row.event_json))).toMatchObject({ selection: 'message', replyToMessageId: 'original-bot-parent' })
  expect(JSON.parse(String(row.raw_payload))).toEqual(payload)
  const final = await cli()
  expect(final.code, final.stderr).toBe(0)
  expect(JSON.parse(final.stdout).result.ingress.input).toEqual(input)
  expect(JSON.stringify(JSON.parse(final.stdout))).not.toContain('fixture-credential')
  const readParent = transport.request.getMockImplementation()!
  transport.request.mockImplementation(async request => request.url?.endsWith('/messages/foreign-app-parent')
    ? { code: 0, data: { items: [{ message_id: 'foreign-app-parent', chat_id: 'original-room', sender: { id: 'another-application', id_type: 'app_id', sender_type: 'app' } }] } }
    : readParent(request))
  const foreign = feishuPayload({ message_id: 'foreign-parent-message', parent_id: 'foreign-app-parent', mentions: [] })
  foreign.header.event_id = 'foreign-parent-event'
  await transport.receive(foreign)
  const other = (await ingress.list({ connectionId: feishuConfig.connectionId })).ingresses.find(record => record.externalMessageId === 'foreign-parent-message')!
  expect((await ingress.dispatch(other.ingressId)).ingress).toMatchObject({ state: 'refused', code: 'INGRESS_INPUT_OUTSIDE_SCOPE', addressing: { state: 'confirmed', selection: 'message' } })
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it('Desktop default registration receives an exact SDK reply after durable ACK through original Core, Mailbox and compiled CLI', async () => {
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const original = await ingressFixture(true, feishuConfig); cleanup.push(() => original.close())
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const sdk = feishuSdkTransport(), request = sdk.request.getMockImplementation()!
  sdk.request.mockImplementation(async input => {
    if (!input.url?.endsWith('/messages/original-parent')) return request(input)
    expect(sdk.ack()).toContainEqual({ code: 200 })
    return { code: 0, data: { items: [{ message_id: 'original-parent', chat_id: 'original-room', sender: { sender_type: 'app', id_type: 'app_id', id: feishuConfig.application.appId } }] } }
  })
  // Only platform network I/O is controlled. The original default adapter registry and Host composition are used.
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(sdk.http.request)
  const services = await createDesktopConnections({ directory: join(original.root, 'desktop-feishu'),
    encryption: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
    bindings: { spatial: original.spatial, checkpoint: async ref => ({ ...ref, checkpoint: await original.client.conversationCheckpoint(ref.agentSessionId) }) },
    ingress: { core: hostId => hostId === 'local' ? original.client : undefined } })
  cleanup.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'feishu-credential', secret: 'fixture-credential' })
  const config = { ...feishuConfig, credentialRef: credential.credentialRef }
  const server = new core.AgentMuxControlServer({ socketPath: join(original.root, 'registered-feishu.sock'), connections: services.connections,
    spatialState: original.spatial, coreClients: original.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const env = objectCliEnvironment(original.root), cli = async (args: string[], input?: unknown) => {
    const output = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', ...args], env, input === undefined ? '' : JSON.stringify(input))
    expect(output.code, output.stdout + output.stderr).toBe(0)
    return JSON.parse(output.stdout).result
  }
  await cli(['configure', '--input', '-'], { operationId: 'disabled-feishu', expectedRevision: null, connection: { ...config, enabled: false } })
  expect((await cli(['test', '--connection', config.connectionId])).observation.authentication.state).toBe('disabled')
  expect(sdk.request).not.toHaveBeenCalled()
  await cli(['configure', '--input', '-'], { operationId: 'enable-feishu', expectedRevision: 1, connection: config })
  await vi.waitFor(() => expect(sdk.sockets).toHaveLength(1))
  expect((await cli(['test', '--connection', config.connectionId])).observation.authentication.state).toBe('ready')
  const bound = await cli(['bind', '--input', '-'], { ...original.input, expectedConnectionRevision: 2 })
  expect(bound.state).toBe('applied')
  expect((await cli(['grant', '--input', '-'], original.grant)).state).toBe('applied')
  const payload = feishuPayload({ parent_id: 'original-parent', mentions: [], content: JSON.stringify({ text: 'Reply from the original group\n完整原文' }) })
  await sdk.receive(payload)
  expect(sdk.ack()).toEqual([{ code: 200 }])
  await vi.waitFor(() => expect(original.inner.kernel.input).toHaveBeenCalledOnce())
  const listed = await cli(['ingress', 'ls', '--connection', config.connectionId, '--limit', '1'])
  const found = listed.ingresses[0]
  expect(found).toMatchObject({ state: 'claimed', addressing: { replyToMessageId: 'original-parent', state: 'confirmed', selection: 'reply' } })
  const inspected = await cli(['ingress', 'inspect', '--ingress', found.ingressId]), input = inspected.ingress.input
  expect(input.agentSessionId).toBe(original.session.agentSessionId); expect(input.expectedRun).toEqual(original.session.run)
  expect(inspected.inputReceipt.originalControlOperationId).toBe(input.operationId)
  const queue = await new core.DurableAgentMuxMessageQueue(original.client.agentMessageQueuePath()).readByOperationId(input.operationId)
  expect(queue!.envelope.body).toBe(JSON.parse(payload.event.message.content).text)
  expect(queue!.envelope.sender).toEqual(input.author)
  let timeline = await original.client.sessionTimeline(original.session.agentSessionId)
  await vi.waitFor(async () => {
    timeline = await original.client.sessionTimeline(original.session.agentSessionId)
    expect(timeline.items.find(item => item.id === `prompt:${input.messageId}`)?.authorExternal).toEqual(input.author)
  })
  const record = timeline.items.find(item => item.id === `prompt:${input.messageId}`)!, rendered = await mountedMailbox(original.session, timeline, record.id)
  expect(rendered.detail.dataset.speakerRole).toBe('external')
  expect(rendered.detail.textContent).toContain(feishuConfig.application.appId)
  await rendered.copyOriginal(); expect(rendered.copy).toHaveBeenCalledWith(record.content)
  const row = services.database!.prepare('SELECT raw_payload,event_json FROM connection_ingress_event').get()!
  expect(JSON.parse(String(row.raw_payload))).toEqual(payload)
  expect(JSON.parse(String(row.event_json))).toMatchObject({ selection: 'message', replyToMessageId: 'original-parent' })
  await sdk.receive(payload)
  expect(original.inner.kernel.input).toHaveBeenCalledOnce()
  expect((await cli(['ingress', 'ls', '--connection', config.connectionId])).ingresses).toHaveLength(1)
  const unsupported = feishuPayload({ message_id: 'unsupported-message', message_type: 'image', content: JSON.stringify({ image_key: 'complete-original-image' }) })
  unsupported.header.event_id = 'unsupported-event'
  await sdk.receive(unsupported)
  const retained = (await cli(['ingress', 'ls', '--connection', config.connectionId])).ingresses
  expect(retained.find((record: { externalMessageId: string }) => record.externalMessageId === 'unsupported-message')).toMatchObject({ state: 'refused', code: 'INGRESS_CONTENT_UNSUPPORTED', body: '' })
  expect(original.inner.kernel.input).toHaveBeenCalledOnce()
  const old = sdk.sockets[0]!
  await cli(['configure', '--input', '-'], { operationId: 'stop-feishu', expectedRevision: 2, connection: { ...config, enabled: false } })
  await sdk.receive(feishuPayload({ message_id: 'obsolete-message' }), old)
  expect((await cli(['ingress', 'ls', '--connection', config.connectionId])).ingresses).toHaveLength(2)
  expect(original.inner.kernel.input).toHaveBeenCalledOnce()
  expect(original.inner.kernel.stop).not.toHaveBeenCalled(); expect(original.inner.kernel.attach).not.toHaveBeenCalled()
  expect((await original.client.readAgentSessions()).map(session => session.agentSessionId)).toEqual([original.session.agentSessionId])
  expect(JSON.stringify(inspected)).not.toMatch(/fixture-credential|transportProof|raw_payload/)
  const evidence = resolve('.bagakit/evidence/feishu-transport'); await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, 'registered-call-chain.json'), JSON.stringify({
    scope: 'Original Desktop default registry and Core client with controlled pinned SDK I/O; not a live platform or Hosted authority claim',
    publicCalls: { configure: config.connectionId, binding: bound, ingressList: listed, ingressInspect: inspected },
    sdkAck: sdk.ack(), originalCore: { input, body: queue!.envelope.body },
    originalDesktop: { consumer: 'mounted SessionMailbox', recordId: record.id, speaker: rendered.detail.dataset.speakerRole, copiedCompleteContent: true },
    retainedUnsupported: retained, originalSessionPreserved: true
  }, null, 2) + '\n')
}, 25_000)
