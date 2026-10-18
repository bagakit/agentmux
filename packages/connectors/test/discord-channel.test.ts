import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { appendFile, writeFile } from 'node:fs/promises'
import { DefaultRestOptions } from '@discordjs/rest'
import * as core from '../../core/src/index.js'
import { createWorkspaceLayout } from '../../core/src/spatial-layout.js'
import { rpcOwnerFixture } from '../../core/test/helpers/public-rpc-owner.js'
import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import { createBuiltinConnectionAdapters } from '../src/platform-adapters.js'
import { context } from './fixtures/room-binding.js'
import { discordTransport, discordConfig, discordRoomId } from './fixtures/discord.js'
import { DiscordAdapter } from '../src/adapters/discord/index.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture() {
  const wire = await discordTransport(); cleanup.push(wire.close)
  vi.spyOn(DefaultRestOptions, 'makeRequest').mockImplementation(wire.http.makeRequest)
  const f = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId: 'claude', executorId: 'claude', nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'original-native', transcriptPath: join(root, 'native.jsonl') } })); cleanup.push(f.close)
  const transcript = join(f.root, 'native.jsonl'); await writeFile(transcript, '')
  const provider = (f.client as unknown as { providers: { get(id: string): { planPromptInput(text: string): unknown } } }).providers.get('claude')
  vi.spyOn(provider, 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  const spatial = new core.AgentMuxSpatialStateStore(join(f.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'space', kind: 'topic', name: 'Team', hostId: 'local', directoryPath: f.root, projectId: 'project' }],
    zones: [{ zoneId: 'zone', workspaceId: 'resource', kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'resource', name: null, regionIds: ['region'] }],
    regions: [{ regionId: 'region', tabId: 'tab', kind: 'agent', agentSessionId: 'original-agent', runId: null, execution: { hostId: 'local', cwd: f.root } }],
    bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { resource: createWorkspaceLayout('group', ['tab']) },
    tabLayouts: { tab: { root: { type: 'leaf', regionId: 'region' }, activeRegionId: 'region' } }, resources: {}
  } })
  const services = await createDesktopConnections({ directory: join(f.root, 'connections'), encryption: {
    isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async text => Buffer.from(text), decryptStringAsync: async bytes => ({ result: bytes.toString(), shouldReEncrypt: false })
  }, bindings: { spatial, checkpoint: input => f.client.conversationCheckpoint(input) }, ingress: { core: host => host === 'local' ? f.client : undefined }, publication: createPublicationConversationPort(f.coreClients) }); cleanup.push(services.close)
  expect(createBuiltinConnectionAdapters().map(adapter => adapter.adapterId)).toContain('discord')
  const credential = await services.secrets.store({ operationId: 'discord-secret', secret: 'fixture-bot-token' })
  await services.connections.configure({ operationId: 'discord-config', expectedRevision: null, connection: { ...discordConfig, credentialRef: credential.credentialRef } })
  await vi.waitFor(async () => expect((await services.connections.test({ connectionId: discordConfig.connectionId })).observation.authentication.state).toBe('ready'))
  const result = await services.connections.bindings!.bind({ operationId: 'discord-bind', bindingId: 'discord-binding', connectionId: discordConfig.connectionId, expectedConnectionRevision: 1,
    executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'region' }, externalConversationId: discordRoomId,
    expectedSource: { providerId: 'claude', nativeSessionId: 'original-native' }, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } }, context)
  expect(result.state).toBe('applied')
  await services.connections.bindings!.grant({ operationId: 'discord-grant', bindingId: 'discord-binding', expectedBindingRevision: 1, grantId: 'discord-user-grant', expectedRevision: null,
    actor: { application: discordConfig.application, idType: 'snowflake', userId: '400' }, capabilities: ['input'], state: 'active' }, context)
  await vi.waitFor(() => expect(wire.sessions.length).toBeGreaterThan(0))
  return { ...f, wire, transcript, services }
}

it('default Desktop registration carries authenticated Gateway input through Core and public replies through native REST', async () => {
  const f = await fixture(), message = f.wire.message()
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  const input = (await f.services.ingress!.list({ connectionId: discordConfig.connectionId })).ingresses.find(item => item.externalMessageId === message.id)!
  expect(input.input?.author.actor).toEqual({ application: discordConfig.application, idType: 'snowflake', userId: '400' })
  const data = (f.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls[0]![1].data as string
  expect(data).toContain('<amux:channel domain="discord.com" app-id="100" id-type="snowflake" user-id="400"')
  expect(data).toContain(message.content)
  f.wire.message()
  await new Promise(resolve => setTimeout(resolve, 40)); expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  await appendFile(f.transcript, JSON.stringify({ type: 'assistant', sessionId: 'original-native', uuid: 'public-reply', message: { role: 'assistant', content: [{ type: 'text', text: 'Original public reply' }] } }) + '\n')
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.wire.calls.some(call => call.method === 'POST' && call.body.includes('Original public reply'))).toBe(true))
  const posts = f.wire.calls.filter(call => call.path === `/channels/${discordRoomId}/messages` && call.method === 'POST')
  expect(posts.some(call => call.body.includes('Original Discord input'))).toBe(false)
  expect(posts.every(call => JSON.parse(call.body).nonce.length <= 25 && JSON.parse(call.body).enforce_nonce === true)).toBe(true)
  expect((await f.services.ingress!.list({ connectionId: discordConfig.connectionId })).ingresses).toHaveLength(1)
  const adapter = new DiscordAdapter()
  await expect(adapter.verify(discordConfig, JSON.stringify({ t: 'MESSAGE_CREATE', d: message }), { authenticated: true })).rejects.toMatchObject({ code: 'DISCORD_TRANSPORT_PROOF_REQUIRED' })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
