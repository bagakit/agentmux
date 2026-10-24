import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { FeishuAdapter } from '../src/adapters/feishu/index.js'
import { DiscordAdapter } from '../src/adapters/discord/index.js'
import { CONNECTION_API_LIMITS, type ConnectionApiRequest } from '@agentmux/core/connections'
import { feishuConfig } from './fixtures/feishu.js'
import { discordConfig } from './fixtures/discord.js'

const clean: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); vi.restoreAllMocks() })
type Call = { path: string; method: string; bytes: Buffer; type: string; authorization: string }
async function platform(reply: (call: Call, response: ServerResponse, request: IncomingMessage) => unknown | Promise<unknown>) {
  const calls: Call[] = []
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const call = { path: request.url!, method: request.method!, bytes: Buffer.concat(chunks), type: String(request.headers['content-type'] ?? ''), authorization: String(request.headers.authorization ?? '') }
      calls.push(call); await reply(call, response, request)
    } catch { response.destroy() }
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  clean.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) })
  return { calls, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` }
}
const json = (response: ServerResponse, value: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
const token = 'synthetic-native-access', credential = 'synthetic-original-secret'
async function feishu(reply: Parameters<typeof platform>[0], authenticate?: Parameters<typeof platform>[0]) {
  const remote = await platform((call, response, request) => call.path.includes('/auth/v3/')
    ? authenticate ? authenticate(call, response, request) : json(response, { code: 0, tenant_access_token: token, expire: 3600 }) : reply(call, response, request))
  const original = defaultHttpInstance.request.bind(defaultHttpInstance), wire: unknown[] = []
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(async options => {
    const url = new URL(options.url!)
    expect(['https://open.feishu.cn', 'https://open.larksuite.com']).toContain(url.origin)
    wire.push({ url: url.pathname, responseType: options.responseType, maxRedirects: options.maxRedirects })
    return await original({ ...options, url: remote.origin + url.pathname + url.search, proxy: false, adapter: 'http' })
  })
  const adapter = new FeishuAdapter(); clean.push(() => adapter.close())
  const protectedValues = new Set<string>(), call = (request: ConnectionApiRequest) => adapter.api.request(feishuConfig, credential, request, { protect: value => { protectedValues.add(value) } })
  return { ...remote, adapter, call, protectedValues, wire }
}
async function discord(reply: Parameters<typeof platform>[0]) {
  const remote = await platform(reply), wire: unknown[] = []
  const adapter = new DiscordAdapter({ http: { makeRequest: async (url, init) => {
    const parsed = new URL(url); expect(parsed.origin).toBe('https://discord.com')
    wire.push({ path: parsed.pathname, redirect: init.redirect })
    return await fetch(remote.origin + parsed.pathname + parsed.search, init as RequestInit)
  } } }); clean.push(() => adapter.close())
  const protectedValues = new Set<string>(), call = (request: ConnectionApiRequest) => adapter.api.request(discordConfig, credential, request, { protect: value => { protectedValues.add(value) } })
  return { ...remote, adapter, call, wire, protectedValues }
}

it('Feishu preserves JSON arrays, null and multipart bytes through the original SDK wire', async () => {
  const f = await feishu((call, response) => json(response, { code: 0, data: { wire: call.type.includes('multipart/') ? 'upload' : JSON.parse(call.bytes.toString()) } }))
  const array = [{ text: 'Original JSON' }, null, 3]
  const result = await f.call({ method: 'POST', path: '/open-apis/example/v1/items', body: array })
  expect(result).toMatchObject({ status: 200, body: { format: 'json', value: { data: { wire: array } } } })
  expect(await f.call({ method: 'POST', path: '/open-apis/example/v1/items', body: null })).toMatchObject({ body: { value: { data: { wire: null } } } })
  const bytes = Buffer.from([0, 4, 128, 255, 10])
  expect(await f.call({ method: 'POST', path: '/open-apis/im/v1/images', body: { image_type: 'message' }, files: [{ field: 'image', name: 'portrait.png', contentType: 'image/png', base64: bytes.toString('base64') }] })).toMatchObject({ status: 200, body: { value: { data: { wire: 'upload' } } } })
  const upload = f.calls.at(-1)!
  expect(upload.type).toMatch(/^multipart\/form-data; boundary=/u)
  expect(upload.bytes.includes(bytes)).toBe(true); expect(upload.bytes.toString()).toContain('name="image_type"\r\n\r\nmessage')
  expect(upload.bytes.toString()).toContain('name="image"; filename="portrait.png"')
  expect(f.calls.filter(call => call.path.includes('/auth/v3/'))).toHaveLength(1)
  expect(f.protectedValues.has(token)).toBe(true); expect(f.protectedValues.has('Bearer ' + token)).toBe(true)
})

it('Feishu returns real HTTP/native errors and explicit empty, unsupported, too-large and unreadable bodies', async () => {
  const f = await feishu((call, response) => {
    if (call.path.endsWith('/business-error')) return json(response, { code: 230002, msg: 'Not a successful business operation' })
    if (call.path.endsWith('/http-error')) return json(response, { code: 99991403 }, 403)
    if (call.path.endsWith('/empty')) { response.writeHead(204); response.end(); return }
    if (call.path.endsWith('/text')) { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('Opaque platform body'); return }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(call.path.endsWith('/large') ? ' '.repeat(CONNECTION_API_LIMITS.responseBytes + 1) : '{invalid')
  })
  const read = (name: string) => f.call({ method: 'GET', path: '/open-apis/example/v1/' + name })
  expect(await read('business-error')).toMatchObject({ status: 200, body: { format: 'json', value: { code: 230002 } } })
  expect(await read('http-error')).toMatchObject({ status: 403, body: { format: 'json', value: { code: 99991403 } } })
  expect(await read('empty')).toEqual({ status: 204, body: { format: 'empty' } })
  for (const [name, reason] of [['text', 'unsupported-format'], ['large', 'too-large'], ['malformed', 'unreadable']])
    expect(await read(name!)).toEqual({ status: 200, body: { format: 'unavailable', reason } })
})

it('Feishu refuses canonical path escapes and credential planes before SDK dispatch', async () => {
  const f = await feishu((_call, response) => json(response, { code: 0 }))
  for (const path of ['https://outside.test/native', '//outside.test/native', '/open-apis/im/../auth/v3/tenant_access_token/internal',
    '/open-apis/%61uth/v3/tenant_access_token/internal', '/open-apis/auth/v3/tenant_access_token/internal', '/open-apis/authen/v1/access_token',
    '/open-apis/passport/v1/password', '/open-apis/admin/v1/password/reset', '/open-apis/im%2Fauth/v1/messages', '/open-apis/im/v1/messages?token=caller', '/open-apis/im//v1/messages'])
    await expect(f.call({ method: 'POST', path, body: {} })).rejects.toBeDefined()
  for (const path of ['/open-apis/application/v6/applications', '/open-apis/application/v6/applications/original-app', '/open-apis/application/v6/applications/underauditlist', '/open-apis/application/v7/applications/original-app/config'])
    await expect(f.call({ method: 'GET', path })).rejects.toMatchObject({ code: 'CONNECTION_API_ENDPOINT_UNAVAILABLE' })
  expect(f.calls).toHaveLength(0); expect(f.protectedValues.size).toBe(0)
  expect(await f.call({ method: 'POST', path: '/open-apis/application/v6/applications/original-app/app_usage/overview', body: { cycle_type: 1 } })).toMatchObject({ status: 200 })
})

it('Feishu refuses a redirect during native token acquisition before any business dispatch', async () => {
  let foreign = 0
  const outside = await platform((_call, response) => { foreign++; json(response, { code: 0 }) })
  const f = await feishu((_call, response) => json(response, { code: 0 }), (_call, response) => {
    response.writeHead(307, { location: outside.origin + '/foreign-auth' }); response.end()
  })
  await expect(f.call({ method: 'POST', path: '/open-apis/im/v1/messages', body: {} })).rejects.toMatchObject({ code: 'FEISHU_SDK_REQUEST_FAILED' })
  expect(f.calls).toHaveLength(1); expect(foreign).toBe(0)
})

it('Feishu does not follow authenticated redirects or replay a lost business response', async () => {
  let foreign = 0
  const outside = await platform((_call, response) => { foreign++; json(response, { code: 0 }) })
  const f = await feishu((call, response, request) => {
    if (call.path.endsWith('/lost')) { request.socket.destroy(); return }
    response.writeHead(302, { location: outside.origin + '/foreign' }); response.end()
  })
  expect(await f.call({ method: 'POST', path: '/open-apis/example/v1/redirect', body: {} })).toEqual({ status: 302, body: { format: 'empty' } })
  await expect(f.call({ method: 'POST', path: '/open-apis/example/v1/lost', body: {} })).rejects.toMatchObject({ code: 'FEISHU_SDK_REQUEST_FAILED' })
  expect(f.calls.filter(call => call.path.endsWith('/lost'))).toHaveLength(1); expect(foreign).toBe(0)
  expect(f.wire.every(row => (row as { maxRedirects?: number }).maxRedirects === 0)).toBe(true)
})

it('Feishu API scope does not change a concurrent original SDK request', async () => {
  let release!: () => void, reached!: () => void
  const held = new Promise<void>(done => { release = done }), entered = new Promise<void>(done => { reached = done })
  const f = await feishu(async (call, response) => { if (call.path.endsWith('/held')) { reached(); await held }; json(response, { code: 0, data: { kept: 'Original object' } }) })
  const api = f.call({ method: 'POST', path: '/open-apis/example/v1/held', body: ['Original API array'] })
  try {
    await entered
    const normal = await f.adapter.withClient(feishuConfig, credential, client => client.request({ url: '/open-apis/example/v1/normal', method: 'POST', data: { preserved: true } }))
    expect(normal).toEqual({ code: 0, data: { kept: 'Original object' } })
    expect(f.wire.find(row => (row as { url: string }).url.endsWith('/normal'))).toMatchObject({ responseType: undefined, maxRedirects: undefined })
    expect(JSON.parse(f.calls.find(call => call.path.endsWith('/normal'))!.bytes.toString())).toEqual({ preserved: true })
  } finally { release() }
  expect(await api).toMatchObject({ status: 200 })
})

it('Discord preserves JSON and multipart through the shared native REST queue', async () => {
  const f = await discord((call, response) => json(response, { wire: call.type.includes('multipart/') ? 'upload' : JSON.parse(call.bytes.toString()) }))
  expect(await f.call({ method: 'POST', path: '/channels/300/messages', body: [{ content: 'Original array' }, null] })).toMatchObject({ status: 200, body: { value: { wire: [{ content: 'Original array' }, null] } } })
  expect(await f.call({ method: 'POST', path: '/channels/300/messages', body: null })).toMatchObject({ body: { value: { wire: null } } })
  const bytes = Buffer.from([0, 2, 128, 255])
  expect(await f.call({ method: 'POST', path: '/channels/300/messages', body: { content: 'Original file' }, files: [{ field: 'files[0]', name: 'attachment.bin', contentType: 'application/octet-stream', base64: bytes.toString('base64') }] })).toMatchObject({ body: { value: { wire: 'upload' } } })
  const upload = f.calls.at(-1)!
  expect(upload.bytes.toString()).toContain('name="payload_json"\r\n\r\n{"content":"Original file"}')
  expect(upload.bytes.toString()).toContain('name="files[0]"; filename="attachment.bin"'); expect(upload.bytes.includes(bytes)).toBe(true)
  expect(f.protectedValues.has(credential)).toBe(true); expect(f.protectedValues.has('Bot ' + credential)).toBe(true)
})

it('Discord API 401 leaves the original shared Client token and concurrent ordinary request intact', async () => {
  let release!: () => void, reached!: () => void
  const held = new Promise<void>(done => { release = done }), entered = new Promise<void>(done => { reached = done })
  const f = await discord(async (call, response) => {
    if (call.path.endsWith('/held')) { reached(); await held; return json(response, { content: 'Original held API reply' }) }
    json(response, call.path.endsWith('/api-only') ? { code: 0, message: 'Unauthorized API' } : { content: 'Original ordinary reply' }, call.path.endsWith('/api-only') ? 401 : 200)
  })
  const original = f.adapter.clients.rest(discordConfig, credential)
  expect(await f.call({ method: 'POST', path: '/channels/300/api-only', body: {} })).toMatchObject({ status: 401, body: { value: { message: 'Unauthorized API' } } })
  expect(f.adapter.clients.rest(discordConfig, credential)).toBe(original)
  expect(await original.post('/channels/300/messages', { body: { content: 'Original body' } })).toEqual({ content: 'Original ordinary reply' })
  expect(f.calls.at(-1)?.authorization).toBe('Bot ' + credential)
  expect(f.wire.at(-1)).toMatchObject({ redirect: undefined })
  const api = f.call({ method: 'POST', path: '/channels/301/held', body: {} })
  try {
    await entered
    expect(await original.post('/channels/302/messages', { body: { content: 'Concurrent ordinary body' } })).toEqual({ content: 'Original ordinary reply' })
    expect(f.wire.at(-1)).toMatchObject({ redirect: undefined })
  } finally { release() }
  expect(await api).toMatchObject({ status: 200, body: { value: { content: 'Original held API reply' } } })
})

it('Discord bounds native response streams and distinguishes empty from unavailable bodies', async () => {
  const f = await discord((call, response) => {
    if (call.path.endsWith('/empty')) { response.writeHead(204); response.end(); return }
    if (call.path.endsWith('/text')) { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<body>Native page</body>'); return }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(call.path.endsWith('/large') ? ' '.repeat(CONNECTION_API_LIMITS.responseBytes + 1) : '{invalid')
  })
  const read = (name: string) => f.call({ method: 'GET', path: '/channels/300/' + name })
  expect(await read('empty')).toEqual({ status: 204, body: { format: 'empty' } })
  for (const [name, reason] of [['text', 'unsupported-format'], ['large', 'too-large'], ['malformed', 'unreadable']])
    expect(await read(name!)).toEqual({ status: 200, body: { format: 'unavailable', reason } })
})

it('Discord keeps HTTP/native errors, safe rate-limit waiting and unknown network effects distinct', async () => {
  let rate = 0, lostRate = 0
  const f = await discord((call, response, request) => {
    if (call.path.endsWith('/lost') || call.path.endsWith('/rate-lost') && ++lostRate > 1) { request.socket.destroy(); return }
    if (call.path.endsWith('/rate-lost') || call.path.endsWith('/rate') && ++rate === 1) { response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0.001', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '0.001' }); response.end(JSON.stringify({ retry_after: 0.001 })); return }
    json(response, call.path.endsWith('/error') ? { code: 50035, message: 'Invalid form' } : { id: 'native-message' }, call.path.endsWith('/error') ? 400 : call.path.endsWith('/server') ? 503 : 200)
  })
  const post = (name: string) => f.call({ method: 'POST', path: '/channels/300/' + name, body: {} })
  expect(await post('error')).toMatchObject({ status: 400, body: { value: { code: 50035 } } })
  expect(await post('server')).toMatchObject({ status: 503, body: { value: { id: 'native-message' } } })
  expect(f.calls.filter(call => call.path.endsWith('/server'))).toHaveLength(1)
  expect(await post('rate')).toMatchObject({ status: 200, body: { value: { id: 'native-message' } } }); expect(rate).toBe(2)
  await expect(post('lost')).rejects.toMatchObject({ code: 'CONNECTION_API_REQUEST_UNCONFIRMED' })
  expect(f.calls.filter(call => call.path.endsWith('/lost'))).toHaveLength(1)
  await expect(post('rate-lost')).rejects.toMatchObject({ code: 'CONNECTION_API_REQUEST_UNCONFIRMED' })
  expect(lostRate).toBe(2)
})

it('Discord refuses alternate credential identities and does not follow authenticated redirects', async () => {
  let foreign = 0
  const outside = await platform((_call, response) => { foreign++; json(response, {}) })
  const f = await discord((_call, response) => { response.writeHead(302, { location: outside.origin + '/foreign' }); response.end() })
  for (const path of ['/oauth2/token', '/channels/300/webhooks', '/guilds/500/webhooks', '/webhooks/300/another-token',
    '/applications/100/bot/reset', '/users/@me/sessions', '/Channels/300/Webhooks', '/OAuth2/token', 'https://outside.test/native', '/channels/%2Fwebhooks', '/channels/300/../webhooks'])
    await expect(f.call({ method: 'POST', path, body: {} })).rejects.toBeDefined()
  expect(f.calls).toHaveLength(0)
  expect(await f.call({ method: 'POST', path: '/channels/300/messages', body: {} })).toEqual({ status: 302, body: { format: 'empty' } })
  expect(foreign).toBe(0); expect(f.wire).toEqual([{ path: '/api/v10/channels/300/messages', redirect: 'manual' }])
})
