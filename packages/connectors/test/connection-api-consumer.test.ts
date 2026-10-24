import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { DefaultRestOptions } from '@discordjs/rest'
import { AgentMuxControlServer } from '../../core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../core/src/public-rpc-client.js'
import { rpcOwnerFixture } from '../../core/test/helpers/public-rpc-owner.js'
import { runCompiledObjectCli, objectCliEnvironment } from '../../core/test/helpers/object-cli-rpc.js'
import { createConnectionServices } from '../src/connection-services.js'
import type { ConnectionApiIdentity, ConnectionApiOperation, ConnectionApiRequest, ConnectionApiRequestInput } from '@agentmux/core/connections'

const clean: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const secret = 'private-original-bot-secret', derived = 'private-original-derived-token', returned = 'native-returned-secret/a?b'
type Wire = { path: string; data: Buffer; contentType: string }
async function fixture(platform: 'feishu' | 'discord') {
  const owner = await rpcOwnerFixture(['original-agent'], undefined, root => {
    const path = join(root, 'original-native.jsonl')
    writeFileSync(path, JSON.stringify({ sessionId: 'original-native', uuid: 'original-message', type: 'user', message: { role: 'user', content: 'Original native task' } }) + '\n')
    return { providerId: 'claude', executorId: 'claude', nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'original-native', transcriptPath: path } }
  }); clean.push(owner.close)
  const saved = (await owner.store.readMetadata('original-agent'))!
  const path = join(owner.root, 'foreign-native.jsonl')
  writeFileSync(path, JSON.stringify({ sessionId: 'foreign-native', uuid: 'foreign-message', type: 'user', message: { role: 'user', content: 'Foreign native task' } }) + '\n')
  await owner.store.compareAndSwap(null, { ...saved, agentSessionId: 'foreign-agent', run: { runId: 'run-foreign-agent' }, nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'foreign-native', transcriptPath: path } })
  await owner.inner.registry.load('local')
  const wire: Wire[] = []
  let effect: (path: string) => unknown | Promise<unknown> = async () => ({ code: 0, id: 'native-message', app_token: 'native-resource-identifier', token: returned, reflected: { raw: secret, bearer: platform === 'feishu' ? derived : secret, mixed: encodeURIComponent(returned).replace('%2F', '%2f'), double: encodeURIComponent(encodeURIComponent(returned)).replace('252F', '252f') } })
  const nativeOrigin = platform === 'feishu' ? 'https://open.feishu.cn' : 'https://discord.com'
  const remote = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      if (request.url!.includes('/auth/')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code: 0, expire: 7200, tenant_access_token: derived })); return }
      wire.push({ path: nativeOrigin + request.url, data: body, contentType: String(request.headers['content-type'] ?? '') })
      const value = await effect(request.url!)
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value))
    } catch { response.destroy() }
  })
  await new Promise<void>(done => remote.listen(0, '127.0.0.1', done))
  clean.push(async () => { remote.closeAllConnections(); await new Promise<void>(done => remote.close(() => done())) })
  const localOrigin = `http://127.0.0.1:${(remote.address() as { port: number }).port}`
  if (platform === 'feishu') {
    const native = defaultHttpInstance.request.bind(defaultHttpInstance)
    vi.spyOn(defaultHttpInstance, 'request').mockImplementation(options => {
      const target = new URL(options.url!)
      expect(target.origin).toBe(nativeOrigin)
      return native({ ...options, url: localOrigin + target.pathname + target.search, proxy: false, adapter: 'http' })
    })
  } else {
    const native = DefaultRestOptions.makeRequest
    vi.spyOn(DefaultRestOptions, 'makeRequest').mockImplementation((url, options) => {
      const target = new URL(url)
      expect(target.origin).toBe(nativeOrigin)
      return native(localOrigin + target.pathname + target.search, options)
    })
  }
  const directory = join(owner.root, 'connections'), bindingOptions = { spatial: { read: async () => null }, session: async (ref: { hostId: string; agentSessionId: string }) => await owner.client.readAgentSession(ref.agentSessionId), checkpoint: owner.client.conversationCheckpoint.bind(owner.client) }
  let services = await createConnectionServices({ directory, bindings: bindingOptions })
  clean.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'original-credential', secret })
  const config = { connectionId: 'original-connection', adapterId: platform, application: platform === 'feishu' ? { domain: 'open.feishu.cn', appId: 'cli_original' } : { domain: 'discord.com', appId: '100000000000000001' }, label: 'Original bot', enabled: true, credentialRef: credential.credentialRef }
  await services.connections.configure({ operationId: 'original-configure', expectedRevision: null, connection: config })
  const bind = async (session: string, id: string) => {
    const result = await services.connections.bindings!.bind({ operationId: 'bind-' + id, bindingId: id, connectionId: config.connectionId, expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: session, externalConversationId: platform === 'feishu' ? 'oc_' + id : id === 'self-binding' ? '100000000000000002' : '100000000000000003', scope: { input: 'all-messages', publication: 'future-shared-conversation' }, expectedSource: { providerId: 'claude', nativeSessionId: session === 'original-agent' ? 'original-native' : 'foreign-native' } }, { actor: { kind: 'user', id: 'original-person' } })
    expect(result.state).toBe('applied')
  }
  await bind('original-agent', 'self-binding'); await bind('foreign-agent', 'foreign-binding')
  const server = new AgentMuxControlServer({ socketPath: join(owner.root, 'native.sock'), coreClients: owner.coreClients,
    connections: new Proxy({} as typeof services.connections, { get(_target, property) { return Reflect.get(services.connections, property) } }) })
  await server.start(); clean.push(() => server.stop())
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: owner.credentials }); clean.push(() => sdk.dispose())
  const env = objectCliEnvironment(owner.root, { AGENTMUX_AGENT_SESSION_ID: owner.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: owner.credentials.capability })
  const cli = async (args: string[], input?: unknown) => {
    const output = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'api', ...args], env, input === undefined ? '' : JSON.stringify(input))
    expect(output.code, output.stdout + output.stderr).toBe(0)
    return JSON.parse(output.stdout).result
  }
  const identities = await cli(['identities', '--session', 'original-agent'])
  expect(identities.identities).toHaveLength(1)
  const identity: ConnectionApiIdentity = identities.identities[0]
  expect(identity).toMatchObject({ connectionId: config.connectionId, bindingId: 'self-binding', agentSessionId: 'original-agent', application: config.application })
  expect(JSON.stringify(identities)).not.toContain(credential.credentialRef)
  const request = (operationId: string, body: ConnectionApiRequest): ConnectionApiRequestInput => ({ operationId, identity: { bindingId: identity.bindingId, bindingRevision: identity.bindingRevision, connectionId: identity.connectionId, connectionRevision: identity.connectionRevision }, request: body })
  return { ...owner, wire, cli, sdk, request, identity, config,
    get services() { return services }, setEffect(next: typeof effect) { effect = next },
    async reopen() { await services.close(); services = await createConnectionServices({ directory, bindings: bindingOptions }) }
  }
}
const nativePath = (platform: 'feishu' | 'discord') => platform === 'feishu' ? '/open-apis/im/v1/messages' : '/channels/100000000000000002/messages'
it.each(['feishu', 'discord'] as const)('actual managed CLI -> default Host -> %s SDK preserves original identity, response, upload and sealed credentials', async platform => {
  const f = await fixture(platform), input = f.request('native-business', { method: 'POST', path: nativePath(platform), query: { marker: 'original' }, body: [{ text: 'Original array is not object-merged' }] })
  const result: ConnectionApiOperation = await f.cli(['request', '--input', '-'], input)
  expect(JSON.stringify(result)).not.toContain(secret)
  expect(result).toMatchObject({ state: 'responded', response: { status: 200, redacted: true, body: { format: 'json', value: { code: 0, id: 'native-message', app_token: 'native-resource-identifier', token: '[redacted]' } } } })
  expect(f.wire).toHaveLength(1)
  const sent = f.wire[0]!
  expect(sent.path).toContain(platform === 'feishu' ? 'https://open.feishu.cn/open-apis/' : 'https://discord.com/api/v10/')
  expect(sent.data.toString()).toBe(JSON.stringify(input.request.body))
  const upload = f.request('native-upload', { method: 'POST', path: platform === 'feishu' ? '/open-apis/im/v1/images' : nativePath(platform), body: platform === 'feishu' ? { image_type: 'message' } : { content: 'Original upload' }, files: [{ field: platform === 'feishu' ? 'image' : 'files[0]', name: 'original.png', contentType: 'image/png', base64: Buffer.from('caller-transmitted-image-bytes').toString('base64') }] })
  const uploaded = await f.cli(['request', '--input', '-'], upload)
  expect(uploaded.state).toBe('responded'); expect(f.wire).toHaveLength(2)
  expect(f.wire[1]!.contentType).toMatch(/^multipart\/form-data; boundary=/u)
  expect(f.wire[1]!.data.includes(Buffer.from('caller-transmitted-image-bytes'))).toBe(true)
  expect(f.wire[1]!.data.toString()).toContain('filename="original.png"')
  const inspected = await f.cli(['inspect', '--operation-id', input.operationId])
  expect(inspected.operation).toEqual(result)
  const persisted = JSON.stringify(f.services.database!.prepare('SELECT * FROM connection_api_operation').all())
  for (const secretValue of [secret, ...(platform === 'feishu' ? [derived] : []), returned, encodeURIComponent(returned).replace('%2F', '%2f'), encodeURIComponent(encodeURIComponent(returned)).replace('252F', '252f')]) expect(JSON.stringify([result, uploaded, inspected, persisted])).not.toContain(secretValue)
  expect(persisted).not.toContain('caller-transmitted-image-bytes')
  await f.reopen()
  expect((await f.cli(['inspect', '--operation-id', input.operationId])).operation).toEqual(result)
  expect(await f.cli(['request', '--input', '-'], input)).toEqual(result)
  expect(f.wire).toHaveLength(2)
}, 25_000)
it('real managed request cannot borrow another Session binding or invoke credential endpoints and preserves healthy input', async () => {
  const f = await fixture('feishu'), input = f.request('foreign-attempt', { method: 'GET', path: '/open-apis/im/v1/messages' })
  await expect(f.sdk.call('connection.api.request', { ...input, identity: { ...input.identity, bindingId: 'foreign-binding' } })).rejects.toMatchObject({ code: 'CONNECTION_API_IDENTITY_UNAVAILABLE' })
  await expect(f.sdk.call('connection.api.request', { ...input, operationId: 'auth-exchange', request: { method: 'POST', path: '/open-apis/auth/v3/tenant_access_token/internal', body: {} } })).rejects.toMatchObject({ code: 'CONNECTION_API_ENDPOINT_UNAVAILABLE' })
  await expect(f.sdk.call('connection.api.request', { ...input, operationId: 'host-path', request: { ...input.request, files: [{ field: 'image', name: 'original.png', contentType: 'image/png', path: join(f.root, 'host-file') }] } } as never)).rejects.toMatchObject({ code: 'INVALID_CONNECTION_API_DATA' })
  expect(f.wire).toEqual([])
  expect(f.services.database!.prepare('SELECT COUNT(*) AS n FROM connection_api_operation').get()!.n).toBe(0)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  expect((await f.client.readAgentSession('original-agent'))!.run.runId).toBe('run-original-agent')
}, 20_000)
it('native HTTP200 refusal and original ambiguous effect are useful, independent, inspectable and never replayed', async () => {
  const f = await fixture('feishu')
  f.setEffect(async () => ({ code: 230002, msg: 'Bot is not in this chat' }))
  expect(await f.cli(['request', '--input', '-'], f.request('native-refusal', { method: 'POST', path: nativePath('feishu'), body: {} }))).toMatchObject({ state: 'responded', response: { status: 200, body: { value: { code: 230002 } } } })
  f.setEffect(async () => { throw Error(secret + derived) })
  const unknown = f.request('unknown-original', { method: 'POST', path: nativePath('feishu'), body: {} })
  expect(await f.cli(['request', '--input', '-'], unknown)).toMatchObject({ state: 'unknown', code: 'CONNECTION_API_OUTCOME_UNKNOWN' })
  expect(f.wire).toHaveLength(2)
  await f.reopen()
  expect(await f.cli(['request', '--input', '-'], unknown)).toMatchObject({ state: 'unknown' })
  expect(f.wire).toHaveLength(2)
}, 20_000)
