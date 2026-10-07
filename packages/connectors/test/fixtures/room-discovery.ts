import { fixtureEpoch as _newTailFixtureEpoch } from "../../../../test/fixture-values.mjs"
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { vi } from 'vitest'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { createDesktopConnections } from '../../../../apps/desktop/src/main/connector-host.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../core/test/helpers/object-cli-rpc.js'
import { feishuConfig } from './feishu.js'

export type RoomReadWire = { url?: string; method?: string; params?: Record<string, unknown>; data?: Record<string, unknown>; signal?: AbortSignal }
export async function roomDiscoveryFixture(effect?: (request: RoomReadWire) => Promise<unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'rd-')), calls: RoomReadWire[] = []
  let server: AgentMuxControlServer | undefined
  let services: Awaited<ReturnType<typeof createDesktopConnections>>
  let sdk: Awaited<ReturnType<typeof connectAgentMuxRpc>>
  const directory = join(root, 'original-connections'), socketPath = join(root, 'rooms.sock')
  const native = async (request: RoomReadWire) => {
    if (request.url?.includes('/auth/v3/')) return { code: 0, tenant_access_token: 'fixture-tenant-token', app_access_token: 'fixture-app-token', expire: 3600 }
    calls.push({ url: request.url, method: request.method, params: request.params, data: request.data, signal: request.signal })
    if (effect) return await effect(request)
    if (request.url?.endsWith('/members')) return { code: 0, data: { items: [{ member_id_type: 'open_id', member_id: 'ou_original', name: 'Original member' }], has_more: false } }
    if (request.url?.endsWith('/link')) return { code: 0, data: { share_link: 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=fixture-join', expire_time: String(_newTailFixtureEpoch(2) / 1_000), is_permanent: false } }
    if (request.url?.endsWith('/chats') || request.url?.endsWith('/chats/search')) return { code: 0, data: { items: [{ chat_id: 'oc_original', name: 'Original group', chat_status: 'normal' }], has_more: true, page_token: 'original-native-page' } }
    return { code: 0, data: { name: 'Original group', chat_status: 'normal', chat_mode: 'group', membership_approval: 'approval_required' } }
  }
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(native as typeof defaultHttpInstance.request)
  const open = async () => {
    // No adapters, spatial state, Binding or Runtime injected: use production default registration.
    services = await createDesktopConnections({ directory, encryption: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } })
    server = new AgentMuxControlServer({ socketPath, connections: services.connections, coreClients: () => [] })
    await server.start(); sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  }
  const closeOwner = async () => { sdk?.dispose(); await server?.stop(); server = undefined; services?.close() }
  const close = async () => { await closeOwner(); await rm(root, { recursive: true, force: true }) }
  try {
    await open()
    const credential = await services!.secrets.store({ operationId: 'original-room-credential', secret: 'fixture-private-credential' })
    const config = { ...feishuConfig, credentialRef: credential.credentialRef }
    await sdk!.call('connection.configure', { operationId: 'configure-original-rooms', expectedRevision: null, connection: config })
    const cli = async (args: string[], input?: unknown) => {
      const output = await runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', 'room', ...args], objectCliEnvironment(root), input === undefined ? '' : JSON.stringify(input))
      return { ...output, receipt: output.code === 0 ? JSON.parse(output.stdout).result : null }
    }
    return { root, directory, config, calls, scope: { connectionId: config.connectionId, expectedConnectionRevision: 1 }, target: { connectionId: config.connectionId, expectedConnectionRevision: 1, externalConversationId: 'oc_original' },
      get services() { return services! }, get sdk() { return sdk! }, cli, closeOwner, reopen: open, close }
  } catch (error) { await close(); throw error }
}
