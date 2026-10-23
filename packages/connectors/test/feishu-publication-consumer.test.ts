// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import * as core from '../../core/dist/index.js'
import { createPublicationConversationPort } from '../dist/index.js'
import { createConnectionServices } from '../src/connection-services.js'
import { connectorScopeSettings } from '../../../apps/desktop/test/helpers/connector-scope-settings.js'
import { externalIngressMailbox } from '../../../apps/desktop/test/helpers/external-ingress-mailbox.js'
import { ingressFixture } from './fixtures/ingress.js'
import { feishuConfig, feishuPayload, feishuSdkTransport } from './fixtures/feishu.js'
import { feishuPublicationHttp, type FeishuHttpCall, type FeishuHttpResponse } from './fixtures/feishu-publication.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'

const mailbox = externalIngressMailbox(), settings = connectorScopeSettings(), cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const row = (id: string, text: string) => JSON.stringify({ sessionId: 'ingress-native', uuid: id, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
async function fixture(override?: (call: FeishuHttpCall) => FeishuHttpResponse | undefined) {
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const original = await ingressFixture(true, feishuConfig); cleanup.push(() => original.close())
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const remote = await feishuPublicationHttp(override); cleanup.push(() => remote.close())
  const sdk = feishuSdkTransport()
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(remote.http.request)
  const services = await createConnectionServices({ directory: join(original.root, 'feishu-bidirectional'),
    bindings: { spatial: original.spatial, checkpoint: async ref => await original.client.conversationCheckpoint(ref) },
    publication: createPublicationConversationPort(original.coreClients), ingress: { core: hostId => hostId === 'local' ? original.client : undefined } })
  cleanup.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'sender-credential', secret: 'fixture-credential' }), config = { ...feishuConfig, credentialRef: credential.credentialRef }
  const server = new core.AgentMuxControlServer({ socketPath: join(original.root, 'feishu-publication.sock'), connections: services.connections, spatialState: original.spatial, coreClients: original.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const env = objectCliEnvironment(original.root), cli = async (args: string[], input?: unknown) => {
    const output = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', ...args], env, input === undefined ? '' : JSON.stringify(input))
    expect(output.code, output.stdout + output.stderr).toBe(0); return JSON.parse(output.stdout).result
  }
  await cli(['configure', '--input', '-'], { operationId: 'sender-configure', expectedRevision: null, connection: config })
  await vi.waitFor(() => expect(sdk.sockets).toHaveLength(1))
  const bound = await cli(['bind', '--input', '-'], original.input); expect(bound.state).toBe('applied')
  expect((await cli(['grant', '--input', '-'], original.grant)).state).toBe('applied')
  const deliveries = async () => {
    const result = await cli(['delivery', 'ls', '--connection', config.connectionId, '--binding', original.input.bindingId, '--binding-revision', '1'])
    return { ...result, deliveries: result.deliveries.filter((delivery: core.ConnectionDelivery) => delivery.reference.source.kind !== 'binding-operation') }
  }
  const contentEffects = () => remote.messageCalls().filter(call => services.publication!.store.list(bound.binding).some(operation =>
    operation.reference.source.kind !== 'binding-operation' && operation.prepared?.request.method === call.method &&
    operation.prepared.request.path === call.path && (operation.prepared.request.body === undefined || operation.prepared.request.body === call.body)))
  return { ...original, remote, sdk, services, server, config, bound, cli, deliveries, contentEffects }
}

it('default Desktop Host joins SDK intake, original Core and Mailbox, then automatically publishes, updates and withdraws exact fragments', async () => {
  const f = await fixture(), payload = feishuPayload()
  await f.sdk.receive(payload)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  const [incoming] = (await f.services.ingress!.list({ connectionId: f.config.connectionId })).ingresses
  const input = incoming!.input!
  const isOriginalInput = (item: core.AgentTimelineItem) => item.inputRef?.kind === 'message' && item.inputRef.messageId === input.messageId
  let timeline: Awaited<ReturnType<typeof f.client.sessionTimeline>>
  await vi.waitFor(async () => {
    timeline = await f.client.sessionTimeline(f.session.agentSessionId)
    expect(timeline.items.some(isOriginalInput)).toBe(true)
  })
  const nativeInput = timeline!.items.find(isOriginalInput)!
  const read = await mailbox(f.session, f.client, nativeInput.inputRef!, timeline!)
  expect(read.detail.dataset.speakerRole).toBe('external'); await read.copyOriginal(); expect(read.copy).toHaveBeenCalledWith(read.original.admission!.intent!.prompt)
  const text = 'Original public reply 中文🙂\n'.repeat(300)
  await appendFile(f.transcript, row('original-public-speech', text))
  await vi.waitFor(() => expect(f.contentEffects().filter(call => call.method === 'POST').length).toBeGreaterThan(1), { timeout: 5_000 })
  let published = await f.deliveries()
  await vi.waitFor(async () => { published = await f.deliveries(); expect(published.deliveries.length).toBeGreaterThan(1); expect(published.deliveries.every((item: { state: string }) => item.state === 'confirmed')).toBe(true) }, { timeout: 5_000 })
  const creates = f.contentEffects().filter(call => call.method === 'POST'), originals = published.deliveries
  expect(new Set(creates.map(call => JSON.parse(call.body).uuid)).size).toBe(creates.length)
  expect(creates.map(call => JSON.parse(JSON.parse(call.body).content).elements[0].text.content).join('')).toBe(text)
  expect(originals.map((item: { fragment: { ordinal: number } }) => item.fragment.ordinal)).toEqual(creates.map((_call, index) => index))
  for (const delivery of originals) {
    expect(delivery.reference.source.recordId).toBe('original-public-speech')
    expect(delivery.target.externalConversationId).toBe(f.input.externalConversationId)
    expect(delivery.mapping.threadId).toBe('original-platform-thread')
    expect(f.services.publication!.store.inspect(delivery.operationId)!.prepared!.request.body).toBe(creates[delivery.fragment.ordinal]!.body)
  }
  const short = 'Updated original public reply\n完整短正文'
  await appendFile(f.transcript, row('original-public-speech', short))
  await vi.waitFor(async () => {
    published = await f.deliveries()
    expect(published.deliveries).toHaveLength(originals.length * 2)
    expect(published.deliveries.every((item: { state: string }) => item.state === 'confirmed')).toBe(true)
  }, { timeout: 5_000 })
  const effects = f.contentEffects()
  expect(effects.slice(creates.length).map(call => call.method)).toEqual(['PATCH', ...originals.slice(1).map(() => 'DELETE')])
  expect(effects[creates.length]!.path).toBe('/open-apis/im/v1/messages/' + originals[0].mapping.messageId)
  const updates = published.deliveries.slice(originals.length)
  expect(updates[0].mapping).toEqual(originals[0].mapping)
  expect(updates.slice(1).map((item: { mapping: unknown }) => item.mapping)).toEqual(originals.slice(1).map((item: { mapping: unknown }) => item.mapping))
  const inspected = await f.cli(['delivery', 'inspect', '--operation-id', updates[0].operationId])
  expect(inspected.delivery).toEqual(updates[0])
  expect(JSON.stringify(inspected)).not.toMatch(/fixture-credential|prepared|Updated original public reply/)
  const next = feishuPayload({ message_id: 'following-input', content: JSON.stringify({ text: 'Continue in the same original Session' }) }); next.header.event_id = 'following-event'
  await f.sdk.receive(next); await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledTimes(2))
  expect(f.remote.calls.filter(call => call.path.includes('/auth/v3/'))).toHaveLength(1)
  const shown = await settings({ socketPath: f.server.path, secrets: f.services.secrets, connectionId: f.config.connectionId })
  const scope = await f.cli(['inspect', '--connection', f.config.connectionId])
  expect(scope.connection.observation.delivery.state).toBe('unknown')
  expect(shown.groupDeliveryText).toBe('View delivery in each Agent’s Shared group details')
  expect((await f.client.readAgentSessions()).map(session => session.agentSessionId)).toEqual([f.session.agentSessionId])
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled()
  const evidence = join('.bagakit', 'evidence', 'feishu-publication'); await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, 'sender-call-chain.json'), JSON.stringify({
    scope: 'Actual SDK/Axios loopback HTTP, original default Desktop Host and Core native reader; not a live platform or Hosted-authority claim',
    sdkAck: f.sdk.ack(), originalInput: input, originalDesktop: { mailboxRecordId: nativeInput.id, copiedCompleteContent: true, connectionScope: scope.connection.observation },
    effects, publicCall: { method: 'connection.delivery.inspect', params: { operationId: updates[0].operationId }, result: inspected }, published,
    originalSessionPreserved: true, originalClientAuthenticationRequests: 1
  }, null, 2) + '\n')
}, 30_000)

it('unknown create remains inspect-only while independent speech and authenticated input continue in the original Session', async () => {
  const f = await fixture(call => call.method === 'POST' && call.path === '/open-apis/im/v1/messages' && call.body.includes('Original unknown effect') ? { status: 200, body: { code: 0, data: {} } } : undefined)
  const speech = async () => (await f.deliveries()).deliveries.filter((delivery: core.ConnectionDelivery) => delivery.reference.source.kind !== 'binding-operation')
  await appendFile(f.transcript, row('unknown-create', 'Original unknown effect'))
  await vi.waitFor(async () => expect((await speech())[0]?.state).toBe('unknown'), { timeout: 5_000 })
  const original = (await speech())[0]
  await appendFile(f.transcript, row('following-speech', 'A separate original speech'))
  f.services.publication!.refresh()
  await vi.waitFor(async () => expect(await speech()).toHaveLength(2), { timeout: 5_000 })
  await vi.waitFor(async () => expect((await speech())[1].state).toBe('confirmed'))
  expect(f.remote.messageCalls().filter(call => call.method === 'POST' && call.body.includes('Original unknown effect'))).toHaveLength(1)
  expect(f.remote.messageCalls().filter(call => call.method === 'POST' && call.body.includes('A separate original speech'))).toHaveLength(1)
  expect((await f.cli(['delivery', 'inspect', '--operation-id', original.operationId])).delivery).toEqual(original)
  await f.sdk.receive(feishuPayload())
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect((await f.client.readAgentSessions()).map(session => session.agentSessionId)).toEqual([f.session.agentSessionId])
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled()
  expect(f.remote.messageCalls().filter(call => call.method === 'POST' && call.body.includes('Original unknown effect'))).toHaveLength(1)
}, 25_000)
