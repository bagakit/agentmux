import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { ConnectionHost } from '../src/connection-host.js'
import { ConnectionApiHost } from '../src/connection-api.js'
import type { ConnectionApiAdapter } from '../src/connection-api-adapter.js'
import type { ConnectionApiCallContext, ConnectionApiRequestInput, RoomBinding } from '@agentmux/core/connections'

const clean: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const credential = 'original-private-credential', token = 'original-sdk-derived-token'
const actor: ConnectionApiCallContext = { actor: { kind: 'agent', id: 'self' }, session: { hostId: 'local', agentSessionId: 'self' } }
const binding: RoomBinding = { bindingId: 'original-group', revision: 1, connectionId: 'original-bot', application: { domain: 'chat.example', appId: 'original-app' }, externalConversationId: 'original-room', executionHostId: 'local', agentSessionId: 'self', scope: { input: 'all-messages', publication: 'future-shared-conversation' }, sourceCheckpoints: [], state: 'active', authorizedBy: { kind: 'user', id: 'original-person' } }
const request: ConnectionApiRequestInput = { operationId: 'original-call', identity: { bindingId: binding.bindingId, bindingRevision: 1, connectionId: binding.connectionId, connectionRevision: 1 }, request: { method: 'POST', path: '/native/messages', body: { content: 'private-original-body' } } }
async function fixture(perform?: ConnectionApiAdapter['request']) {
  const directory = await mkdtemp(join(tmpdir(), 'amux-native-api-')); clean.push(() => rm(directory, { recursive: true, force: true }))
  const state = { binding: structuredClone(binding) as RoomBinding | null }
  const calls = vi.fn(perform ?? (async () => ({ status: 200, body: { format: 'json' as const, value: { code: 230002, message: 'not in chat' } } })))
  const adapter: ConnectionApiAdapter = { description: { documentationUrl: 'https://chat.example/native-api', requestFormats: ['json', 'multipart'], responseFormats: ['json', 'empty'] }, validate: vi.fn(), request: calls }
  const resolve = vi.fn(async () => credential)
  const options = { databasePath: join(directory, 'connections.sqlite'), secrets: { resolve }, adapters: [{ adapterId: 'native-chat', api: adapter, test: async () => ({ authentication: { state: 'ready' as const }, transport: { state: 'ready' as const }, intake: { state: 'ready' as const }, delivery: { state: 'ready' as const } }) }] }
  let connections = new ConnectionHost(options)
  const owner = { list: async () => ({ bindings: state.binding ? [state.binding] : [] }), current: () => state.binding }
  let api = new ConnectionApiHost(connections, owner)
  await connections.configure({ operationId: 'save-bot', expectedRevision: null, connection: { connectionId: binding.connectionId, adapterId: 'native-chat', application: binding.application, label: 'Original bot', enabled: true, credentialRef: 'opaque-original-reference' } })
  clean.push(() => connections.close())
  return { state, adapter, resolve, calls, get connections() { return connections }, get api() { return api },
    reopen() { connections.close(); connections = new ConnectionHost(options); api = new ConnectionApiHost(connections, owner) } }
}
it('uses exact self binding authority independently of enrollment and automatic-sync policy', async () => {
  const f = await fixture()
  expect(await f.api.identities({ agentSessionId: 'self' }, actor)).toMatchObject({ identities: [{ bindingId: binding.bindingId, label: 'Original bot', agentSessionId: 'self' }] })
  expect(f.resolve).not.toHaveBeenCalled()
  await expect(f.api.identities({ agentSessionId: 'another' }, actor)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  f.state.binding = { ...binding, agentSessionId: 'another' }
  await expect(f.api.request(request, actor)).rejects.toMatchObject({ code: 'CONNECTION_API_IDENTITY_UNAVAILABLE' })
  f.state.binding = { ...binding, executionHostId: 'another-host' }
  await expect(f.api.request(request, actor)).rejects.toMatchObject({ code: 'CONNECTION_API_IDENTITY_UNAVAILABLE' })
  f.state.binding = { ...binding, state: 'paused' }
  await f.connections.service.configure({ operationId: 'pause-automatic-sync', expectedRevision: 0, service: { enabled: false } })
  expect(await f.api.request(request, actor)).toMatchObject({ state: 'responded', response: { status: 200, body: { format: 'json', value: { code: 230002 } } } })
  expect(f.calls).toHaveBeenCalledTimes(1)
  expect(f.calls.mock.calls[0]?.[0]).toMatchObject({ connectionId: binding.connectionId, application: binding.application })
  f.state.binding = { ...binding, state: 'detached' }
  expect(await f.api.inspect({ operationId: request.operationId }, actor)).toMatchObject({ operation: { state: 'responded' } })
  await expect(f.api.request({ ...request, operationId: 'new-detached' }, actor)).rejects.toMatchObject({ code: 'CONNECTION_API_IDENTITY_UNAVAILABLE' })
  expect(f.calls).toHaveBeenCalledTimes(1)
})
it('claims once across concurrent calls, late results, detach and reopen without storing private request bodies', async () => {
  let release!: () => void, reached!: () => void
  const entered = new Promise<void>(resolve => { reached = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(async () => { reached(); await held; return { status: 201, body: { format: 'json', value: { id: 'native-message' } } } })
  const work = f.api.request(request, actor)
  try {
    await entered
    expect(await f.api.request(request, actor)).toMatchObject({ state: 'unknown' })
    expect(await f.api.inspect({ operationId: request.operationId }, actor)).toMatchObject({ operation: { state: 'unknown' } })
    f.state.binding = { ...binding, state: 'detached' }
  } finally { release() }
  const completed = await work
  expect(completed).toMatchObject({ state: 'responded', response: { status: 201 } })
  expect(f.calls).toHaveBeenCalledTimes(1)
  const rows = JSON.stringify(f.connections.database.prepare('SELECT * FROM connection_api_operation').all())
  for (const privateValue of [credential, 'private-original-body', 'opaque-original-reference']) expect(rows).not.toContain(privateValue)
  f.reopen()
  expect(await f.api.request(request, actor)).toEqual(completed)
  await expect(f.api.request({ ...request, request: { ...request.request, body: 'changed' } }, actor)).rejects.toMatchObject({ code: 'CONNECTION_API_OPERATION_CONFLICT' })
  await expect(f.api.inspect({ operationId: request.operationId }, { actor: { kind: 'user', id: 'another-actor' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(f.calls).toHaveBeenCalledTimes(1)
})
it('removes original and derived credentials, native secret fields and encoded reflection before receipt persistence', async () => {
  const nativeSecret = 'native-webhook-secret/a?b'
  const f = await fixture(async (_config, _credential, _request, context) => {
    context.protect(token)
    return { status: 200, body: { format: 'json', value: { code: 0, id: 'kept-message', token: nativeSecret, encryption_key: 'native-encryption-secret', repeatedEncryption: 'native-encryption-secret', data: { access_token: token, note: credential, url: 'https://chat.example/webhooks/' + nativeSecret, mixed: 'https://chat.example/' + encodeURIComponent(nativeSecret).replace('%2F', '%2f'), double: encodeURIComponent(encodeURIComponent(nativeSecret)).replace('252F', '252f'), encoded: encodeURIComponent(credential), b64: Buffer.from(token).toString('base64') } } } }
  })
  const operation = await f.api.request(request, actor)
  expect(operation).toMatchObject({ state: 'responded', response: { redacted: true, body: { value: { code: 0, id: 'kept-message', token: '[redacted]' } } } })
  const serialized = JSON.stringify([operation, await f.api.inspect({ operationId: request.operationId }, actor), f.connections.database.prepare('SELECT * FROM connection_api_operation').all()])
  for (const secret of [credential, token, nativeSecret, 'native-encryption-secret', Buffer.from(token).toString('base64'), encodeURIComponent(nativeSecret).replace('%2F', '%2f'), encodeURIComponent(encodeURIComponent(nativeSecret)).replace('252F', '252f')]) expect(serialized).not.toContain(secret)
})
it('keeps ambiguous original failures inspect-only and rechecks authority after credential resolution', async () => {
  const f = await fixture(async () => { throw new Error(credential + token) })
  expect(await f.api.request(request, actor)).toMatchObject({ state: 'unknown', code: 'CONNECTION_API_OUTCOME_UNKNOWN' })
  f.reopen()
  expect(await f.api.request(request, actor)).toMatchObject({ state: 'unknown' })
  expect(f.calls).toHaveBeenCalledTimes(1)
  let checks = 0
  await expect(f.api.request({ ...request, operationId: 'revoked-before-admission' }, { ...actor, assertCurrent: () => { if (++checks === 2) throw Object.assign(new Error('Original authority revoked'), { code: 'CONTROL_PERMISSION_DENIED' }) } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(await f.api.inspect({ operationId: 'revoked-before-admission' }, actor)).toEqual({ operation: null })
  expect(f.calls).toHaveBeenCalledTimes(1)
  await expect(f.api.request({ ...request, operationId: 'wrong-revision', identity: { ...request.identity, connectionRevision: 2 } }, actor)).rejects.toMatchObject({ code: 'CONNECTION_API_IDENTITY_CHANGED' })
  expect((await f.connections.test({ connectionId: binding.connectionId })).observation.authentication.state).toBe('ready')
})
