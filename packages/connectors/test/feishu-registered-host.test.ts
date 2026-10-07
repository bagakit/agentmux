// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import * as core from '../../core/dist/index.js'
import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { externalIngressMailbox } from '../../../apps/desktop/test/helpers/external-ingress-mailbox.js'
import { ingressFixture } from './fixtures/ingress.js'
import { feishuConfig, feishuPayload, feishuSdkTransport } from './fixtures/feishu.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'

const mailbox = externalIngressMailbox(), cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

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
  const record = timeline.items.find(item => item.id === `prompt:${input.messageId}`)!, rendered = await mailbox(original.session, timeline, record.id)
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
