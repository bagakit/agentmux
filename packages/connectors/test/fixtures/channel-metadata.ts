import { expect, vi } from 'vitest'
import { join } from 'node:path'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import * as core from '../../../core/dist/index.js'
import type { ChannelMetadataChange, ChannelMetadataSubject } from '@agentmux/core/connections'
import { createConnectionServices } from '../../src/connection-services.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../core/test/helpers/object-cli-rpc.js'
import { ingressFixture } from './ingress.js'
import { feishuConfig, feishuPayload, feishuSdkTransport } from './feishu.js'

export const actor = { application: feishuConfig.application, idType: 'open_id', userId: 'original-external-user' }
export const actorSubject: ChannelMetadataSubject = { kind: 'actor', actor }
export const groupSubject: ChannelMetadataSubject = { kind: 'conversation', externalConversationId: 'original-room' }
export async function channelMetadataFixture(cleanup: Array<() => void | Promise<void>>, authoritySource?: { hostingRuntimeId: string; executionRuntimeId: string }) {
  const f = await ingressFixture(true, feishuConfig); cleanup.push(f.close)
  const transport = feishuSdkTransport(), fallback = transport.request.getMockImplementation()!
  let actorName = 'Original native person', groupName = 'Original native group', failure = false
  transport.request.mockImplementation(async input => {
    if (input.url?.includes('/contact/v3/users/')) {
      if (failure) throw Error('Private lookup failure and credential details')
      return { code: 0, data: { user: { open_id: actor.userId, name: actorName, avatar: { avatar_240: 'https://cdn.example/person.png' }, email: 'private-field@example.test' } } }
    }
    if (input.url?.includes('/im/v1/chats/')) {
      if (failure) throw Error('Private native group failure')
      return { code: 0, data: { name: groupName, avatar: 'https://cdn.example/group.png' } }
    }
    return await fallback(input)
  })
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(input => {
    const { params, ...options } = input
    if (params === undefined) return transport.request(options)
    if (params === null || typeof params !== 'object' || Array.isArray(params)) throw Error('Fixture expects the original SDK query parameter object')
    return transport.request({ ...options, params })
  })
  const directory = join(f.root, 'desktop-metadata'), changes: ChannelMetadataChange[] = []
  const open = async () => {
    // Default registry, original private Connection owner and actual receiver lifecycle.
    const services = await createConnectionServices({ directory, bindings: { spatial: f.spatial, checkpoint: ref => f.client.conversationCheckpoint(ref) }, ingress: { core: hostId => hostId === 'local' ? f.client : undefined,
      ...(authoritySource ? { authoritySource: () => authoritySource } : {}) } })
    cleanup.push(() => services.close())
    services.onChannelMetadataChanged(change => changes.push(change))
    const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'metadata.sock'), connections: services.connections, spatialState: f.spatial, coreClients: f.coreClients })
    await server.start(); cleanup.push(() => server.stop())
    const sdk = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => sdk.dispose())
    const cli = async (args: string[], input?: unknown) => {
      const output = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'metadata', ...args], objectCliEnvironment(f.root), input === undefined ? '' : JSON.stringify(input))
      expect(output.code, output.stdout + output.stderr).toBe(0)
      return JSON.parse(output.stdout).result
    }
    return { services, server, sdk, cli }
  }
  const opened = await open(), credential = await opened.services.secrets.store({ operationId: 'metadata-credential', secret: 'private-fixture-credential' })
  const config = { ...feishuConfig, credentialRef: credential.credentialRef }
  await opened.sdk.call('connection.configure', { operationId: 'metadata-configure', expectedRevision: null, connection: config })
  expect(await opened.sdk.call('connection.bind', f.input)).toMatchObject({ state: 'applied' })
  expect(await opened.sdk.call('connection.grant', f.grant)).toMatchObject({ state: 'applied' })
  await vi.waitFor(() => expect(transport.sockets).toHaveLength(1), { timeout: 5000 })
  const get = (subject = actorSubject) => opened.sdk.call('connection.metadata.get', { connectionId: config.connectionId, subject })
  const submit = async (suffix: string) => {
    const payload = feishuPayload({ message_id: 'metadata-message-' + suffix }); payload.header.event_id = 'metadata-event-' + suffix
    await transport.receive(payload)
    expect(transport.ack().at(-1)).toEqual({ code: 200 })
  }
  return { ...f, ...opened, config, transport, changes, get, open, submit,
    source: (person: string, group: string, fail = false) => { actorName = person; groupName = group; failure = fail },
    requests: () => transport.request.mock.calls.filter(([request]) => /\/(contact\/v3\/users|im\/v1\/chats)\//.test(request.url ?? '')) }
}

