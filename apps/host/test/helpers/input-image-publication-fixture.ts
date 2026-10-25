import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { afterEach, expect, vi } from 'vitest'
import { DefaultRestOptions } from '@discordjs/rest'
import * as core from '@agentmux/core'
import * as connectors from '@agentmux/connectors'
import { fileUploadRevision } from '@agentmux/core/files'
import { rpcOwnerFixture } from '../../../../packages/core/test/helpers/public-rpc-owner.js'
import { feishuConfig, feishuSdkTransport } from '../../../../packages/connectors/test/fixtures/feishu.js'
import { feishuMediaPlatform } from '../../../../packages/connectors/test/fixtures/feishu-media-platform.js'
import { discordConfig, discordTransport } from '../../../../packages/connectors/test/fixtures/discord.js'
import { startAgentMuxHost } from '../../src/host.js'
const privateHome = vi.hoisted(() => ({ directory: undefined as string | undefined }))
vi.mock('node:os', async load => { const original = await load<typeof import('node:os')>(); return { ...original, homedir: () => privateHome.directory ?? original.homedir() } })
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close() } finally { vi.restoreAllMocks(); vi.unstubAllEnvs() } })
export const png = process.env.AGENTMUX_TEST_IMAGE_VISUAL === '1' ? readFileSync(new URL('../../../desktop/resources/settings-banner.png', import.meta.url)) : Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
export async function inputImagePublicationFixture() {
  const original = await rpcOwnerFixture(['image-agent'], core, root => ({ providerId: 'claude', executorId: 'claude', nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'image-native', transcriptPath: join(root, 'native.jsonl') } })); cleanup.push(original.close)
  privateHome.directory = original.root
  await writeFile(join(original.root, 'native.jsonl'), JSON.stringify({ type: 'user', sessionId: 'image-native', uuid: 'before-binding', message: { role: 'user', content: 'Earlier private input' } }) + '\n')
  await original.client.dispose(); feishuSdkTransport()
  const feishu = await feishuMediaPlatform(), discord = await discordTransport(); cleanup.push(feishu.close, discord.close)
  vi.spyOn(DefaultRestOptions, 'makeRequest').mockImplementation(discord.http.makeRequest)
  const factory = connectors.createConnectionServices, opened: connectors.ConnectionServices[] = []
  vi.spyOn(connectors, 'createConnectionServices').mockImplementation(async options => { const service = await factory(options); opened.push(service); return service })
  let host: Awaited<ReturnType<typeof startAgentMuxHost>> | undefined
  const socketPath = join(original.root, 'image-publication.sock')
  const start = async () => {
    const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
      const inner = this as unknown as typeof original.inner; await inner.registry.load('local'); inner.connected = true; inner.kernel.isConnected = () => false
    })
    try { host = await startAgentMuxHost({ store: original.store, socketPath, desktopSocketPath: join(original.root, 'absent-desktop.sock'), mobileBuildDirectory: join(original.root, 'absent-mobile'), connections: { directory: join(original.root, 'connections') } }) }
    finally { connect.mockRestore() }
  }
  const stop = async () => { const current = host; host = undefined; await current?.dispose() }; cleanup.push(stop)
  await start(); let rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); cleanup.push(() => rpc.dispose())
  const owner = (await rpc.call('runtime.owner.identity', {})).owner
  for (const config of [feishuConfig, discordConfig]) {
    const secret = await rpc.call('connection.credential.store', { operationId: config.adapterId + '-secret', secret: 'synthetic-original-image-credential' }, { runtimeFence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } })
    await rpc.call('connection.configure', { operationId: config.adapterId + '-configure', expectedRevision: null, connection: { ...config, credentialRef: secret.credentialRef } })
    expect(await rpc.call('connection.bind', { operationId: config.adapterId + '-bind', bindingId: config.adapterId + '-binding', connectionId: config.connectionId, expectedConnectionRevision: 1,
      executionHostId: 'local', agentSessionId: 'image-agent', externalConversationId: config.adapterId === 'discord' ? '300' : 'original-room', expectedSource: { providerId: 'claude', nativeSessionId: 'image-native' }, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } })).toMatchObject({ state: 'applied' })
  }
  const upload = (id: string) => ({ hostId: 'local', agentSessionId: 'image-agent', expectedRun: { runId: 'run-image-agent' }, operationId: id, name: 'image', mimeType: 'image/png', byteLength: png.length, revision: fileUploadRevision(png) })
  const source = join(original.root, '.agentmux', 'pasted', 'a'.repeat(64) + '.png')
  const send = async (prompt: string, inputImages?: core.AgentInputImageReference[], operationId = 'original-selected-input', authorProfile?: core.AgentPreparedAuthorProfile) => {
    await host!.client.submitAgentPrompt({ agentSessionId: 'image-agent', expectedRun: { runId: 'run-image-agent' }, operationId, prompt, ...(inputImages ? { inputImages } : {}), ...(authorProfile ? { authorProfile } : {}), authorHuman: true, sourceChannel: 'message-tool', admissionIntent: { kind: 'manual-actor' }, execution: 'immediate' })
    opened.at(-1)!.publication!.refresh()
  }
  const operations = () => ['feishu-binding', 'discord-binding'].flatMap(bindingId => opened.at(-1)!.publication!.store.list({ bindingId, revision: 1 })).filter(operation => operation.payload.kind !== 'binding-lifecycle')
  return { socketPath, original, feishu, discord, upload, source, send, get rpc() { return rpc }, operations, services: () => opened.at(-1)!, conversation: () => host!.client.readAgentConversation({ hostId: 'local', agentSessionId: 'image-agent' }), async restart() { await rpc.dispose(); await stop(); await start(); rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }) } }
}
