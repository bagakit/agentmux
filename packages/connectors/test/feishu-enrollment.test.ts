import { gunzipSync } from 'node:zlib'
import { afterEach, expect, it, vi } from 'vitest'
import { createFeishuEnrollment } from '../src/adapters/feishu/enrollment.js'
import type { EnrollmentAdapterInput, EnrollmentBeginReceipt, EnrollmentPollReceipt } from '../src/connection-enrollment-adapter.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const input: EnrollmentAdapterInput = { operationId: 'original-enrollment', connectionId: 'original-connection', attemptId: 'original-begin', domain: 'open.feishu.cn', label: 'My AgentMux bot' }
const initial = { device_code: 'private-device-code', user_code: 'public-user-code', verification_uri: 'https://open.feishu.cn/page/cli',
  verification_uri_complete: 'https://open.feishu.cn/page/cli?user_code=public-user-code&original=retained', interval: 5, expires_in: 600 }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
function remote(...responses: Array<{ body: unknown; status?: number }>) {
  const calls: Array<{ url: string; options: RequestInit }> = []
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    calls.push({ url, options })
    const next = responses.shift()
    if (!next) throw new Error('Unexpected extra registration request')
    return Response.json(next.body, { status: next.status ?? 200 })
  })
  vi.stubGlobal('fetch', fetch)
  return { calls, fetch }
}
function challenge(receipt: EnrollmentBeginReceipt | EnrollmentPollReceipt) {
  expect(receipt.kind).toBe('pending')
  if (receipt.kind !== 'pending') throw new Error('Original challenge was not confirmed')
  return receipt
}
async function started(next: unknown = { error: 'authorization_pending' }, status = 400) {
  const network = remote({ body: initial }, { body: next, status })
  const adapter = createFeishuEnrollment(), pending = challenge(await adapter.begin(input))
  return { network, adapter, pending, poll: { ...input, attemptId: 'original-poll', privateState: pending.privateState } }
}

it('uses the published SDK form wire once and returns the original honest create-only public challenge', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(_historyFixtureEpoch(0, 100, 0))
  const network = remote({ body: initial }), controller = new AbortController(), adapter = createFeishuEnrollment()
  expect(adapter.domains).toEqual([{ domain: 'open.feishu.cn', label: 'Feishu' }, { domain: 'open.larksuite.com', label: 'Lark' }])
  const pending = challenge(await adapter.begin(input, controller.signal)), call = network.calls[0]!
  expect(network.calls).toHaveLength(1)
  expect(call.url).toBe('https://accounts.feishu.cn/oauth/v1/app/registration')
  expect(call.options).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'error', signal: controller.signal })
  expect(call.options.body).toBe('action=begin&archetype=PersonalAgent&auth_method=client_secret&request_user_info=open_id')
  const url = new URL(pending.verificationUrl)
  expect(url.origin + url.pathname).toBe('https://open.feishu.cn/page/cli')
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ user_code: 'public-user-code', original: 'retained', from: 'sdk', source: 'node-sdk/agentmux', tp: 'sdk', createOnly: 'true', name: input.label })
  expect(url.searchParams.has('clientID')).toBe(false)
  const addons = JSON.parse(gunzipSync(Buffer.from(url.searchParams.get('addons')!, 'base64url')).toString())
  expect(addons).toEqual({ preset: false, scopes: { tenant: ['im:message:send_as_bot', 'im:message:readonly', 'im:message.group_msg', 'im:chat:create', 'im:chat:read', 'im:chat.members:write_only', 'im:chat.members:read'] }, events: { items: { tenant: ['im.message.receive_v1'] } } })
  expect(pending).toMatchObject({ kind: 'pending', userCode: 'public-user-code', expiresInMs: 600_000, pollIntervalMs: 5_000 })
  const { privateState, ...publicChallenge } = pending
  expect(JSON.stringify(publicChallenge)).not.toContain(initial.device_code)
  expect(JSON.parse(privateState)).toMatchObject({ operationId: input.operationId, connectionId: input.connectionId, domain: input.domain, deadline: 700_000 })
})

it('polls the exact private device code once and keeps the original lifetime across pending, slowdown and factory reopen', async () => {
  let now = _historyFixtureEpoch(0, 100, 0)
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const network = remote({ body: initial }, { body: { error: 'authorization_pending' }, status: 400 }, { body: { error: 'slow_down' }, status: 400 }, { body: { error: 'authorization_pending' }, status: 400 })
  const pending = challenge(await createFeishuEnrollment().begin(input))
  now += 10_000
  const next = challenge(await createFeishuEnrollment().poll({ ...input, attemptId: 'first-poll', privateState: pending.privateState }))
  expect(next.expiresInMs).toBe(590_000); expect(next.pollIntervalMs).toBe(5_000)
  now += 5_000
  const slow = challenge(await createFeishuEnrollment().poll({ ...input, attemptId: 'next-poll', privateState: next.privateState }))
  expect(slow.expiresInMs).toBe(585_000); expect(slow.pollIntervalMs).toBe(10_000)
  now += 10_000
  const resumed = challenge(await createFeishuEnrollment().poll({ ...input, attemptId: 'reopened-poll', privateState: slow.privateState }))
  expect(resumed.expiresInMs).toBe(575_000); expect(resumed.pollIntervalMs).toBe(10_000)
  expect(network.calls).toHaveLength(4)
  for (const call of network.calls.slice(1)) expect(call.options.body).toBe('action=poll&device_code=private-device-code')
})

it.each(['open.feishu.cn', 'open.larksuite.com'] as const)('returns credentials only for the exact original issuer: %s', async domain => {
  const lark = domain === 'open.larksuite.com', scope = { ...input, domain }
  const network = remote({ body: { ...initial, verification_uri_complete: `https://${domain}/page/cli?user_code=public-user-code` } },
    { body: { client_id: 'cli_original_application', client_secret: 'private-original-secret', user_info: { tenant_brand: lark ? 'lark' : 'feishu' } } })
  const pending = challenge(await createFeishuEnrollment().begin(scope))
  expect(await createFeishuEnrollment().poll({ ...scope, privateState: pending.privateState })).toEqual({ kind: 'authorized', application: { domain, appId: 'cli_original_application' }, secret: 'private-original-secret' })
  expect(network.calls.map(call => new URL(call.url).hostname)).toEqual(Array(2).fill(lark ? 'accounts.larksuite.com' : 'accounts.feishu.cn'))
})

it.each([
  [{ error: 'access_denied' }, 'denied'], [{ error: 'expired_token' }, 'expired'],
  [{ error: 'authorization_pending' }, 'pending'], [{ error: 'slow_down' }, 'pending'],
  [{ error: 'server_error', error_description: 'private-platform-debug' }, 'unknown'],
  [{}, 'unknown'], [[], 'unknown'], [null, 'unknown'], [{ error: ['access_denied'] }, 'unknown'],
  [{ client_id: ['cli_original'], client_secret: 'secret' }, 'unknown'],
  [{ client_id: 'cli original', client_secret: 'secret' }, 'unknown'],
  [{ client_id: 'cli/original', client_secret: 'secret' }, 'unknown'],
  [{ client_id: 'cli_original', client_secret: null }, 'unknown'],
  [{ client_id: 'cli_original', client_secret: 'secret', error: 'authorization_pending' }, 'unknown'],
  [{ client_id: 'cli_original', client_secret: 'secret', user_info: [] }, 'unknown'],
  [{ client_id: 'cli_original', client_secret: 'secret', user_info: { tenant_brand: ['feishu'] } }, 'unknown']
] as const)('uses literal OAuth facts without replay, coercion or secret diagnostics: %j', async (response, kind) => {
  const f = await started(response, Object.hasOwn(response ?? {}, 'client_id') ? 200 : 400)
  const result = await f.adapter.poll(f.poll)
  expect(result.kind).toBe(kind)
  expect(f.network.calls).toHaveLength(2)
  if (kind === 'unknown') expect(result).toEqual({ kind: 'unknown' })
})

it('keeps brand mismatch unknown without a second HTTP request or replacing the frozen domain', async () => {
  const f = await started({ client_id: 'cli_remote', client_secret: 'private-original-secret', user_info: { tenant_brand: 'lark' } }, 200)
  expect(await f.adapter.poll(f.poll)).toEqual({ kind: 'unknown' })
  expect(f.network.calls).toHaveLength(2)
  expect(new Set(f.network.calls.map(call => new URL(call.url).hostname))).toEqual(new Set(['accounts.feishu.cn']))
})

it.each([
  { verification_uri_complete: 'http://open.feishu.cn/page/cli' },
  { verification_uri_complete: 'https://open.feishu.cn.attacker.invalid/page/cli' },
  { verification_uri_complete: 'https://open.larksuite.com/page/cli' },
  { verification_uri_complete: 'https://name:secret@open.feishu.cn/page/cli' },
  { verification_uri_complete: 'https://open.feishu.cn/page/cli#secret' },
  { verification_uri_complete: 'https://open.feishu.cn/page/cli?device_code=private-device-code' },
  { verification_uri_complete: 'https://open.feishu.cn/page/cli?user_code=private-device-code' },
  { verification_uri_complete: 'https://open.feishu.cn/page/cli?public=prefix-private-device-code-suffix' },
  { verification_uri_complete: 'https://open.feishu.cn/page/cli?public=prefix-private%2Ddevice%2Dcode-suffix' },
  { verification_uri_complete: 'https://open.feishu.cn/prefix-private%2Ddevice%2Dcode-suffix?user_code=public' },
  { device_code: ['device'] }, { device_code: 'agentmux' }, { user_code: null }, { user_code: 'prefix-private-device-code-suffix' }, { interval: '5' }, { interval: 0 },
  { expires_in: '600' }, { expires_in: null }, { expires_in: [] }, { expires_in: -1 }, { expires_in: 600, expire_in: 601 }
])('does not publish a malformed or wrong-issuer challenge: %j', async override => {
  const network = remote({ body: { ...initial, ...override } })
  expect(await createFeishuEnrollment().begin(input)).toEqual({ kind: 'unknown' })
  expect(network.calls).toHaveLength(1)
})

it('preserves the older documented expiry spelling and leaves absent expiry unknown', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(_historyFixtureEpoch(0, 100, 0))
  const { expires_in, ...withoutExpiry } = initial
  remote({ body: { ...withoutExpiry, expire_in: expires_in } }, { body: withoutExpiry })
  expect(challenge(await createFeishuEnrollment().begin(input)).expiresInMs).toBe(600_000)
  expect(challenge(await createFeishuEnrollment().begin({ ...input, operationId: 'different-original-operation' })).expiresInMs).toBeNull()
})

it('does not invent a length budget for original device codes, application IDs or opaque secrets', async () => {
  const deviceCode = 'device-'.repeat(3_000), appId = 'cli_' + 'a'.repeat(20_000), secret = 'opaque-'.repeat(3_000)
  const network = remote({ body: { ...initial, device_code: deviceCode } }, { body: { client_id: appId, client_secret: secret } })
  const adapter = createFeishuEnrollment(), pending = challenge(await adapter.begin(input))
  expect(await adapter.poll({ ...input, privateState: pending.privateState })).toEqual({ kind: 'authorized', application: { domain: input.domain, appId }, secret })
  expect(network.calls).toHaveLength(2)
  expect(new URLSearchParams(network.calls[1]!.options.body as string).get('device_code')).toBe(deviceCode)
})

it.each(['operationId', 'connectionId', 'domain', 'label'] as const)('does not consume a private state for another original %s', async field => {
  const f = await started()
  expect(await f.adapter.poll({ ...f.poll, [field]: field === 'domain' ? 'open.larksuite.com' : 'another-original-target' })).toEqual({ kind: 'unknown' })
  expect(f.network.calls).toHaveLength(1)
})

it('does not turn a local deadline or malformed saved state into a platform-expired receipt', async () => {
  let now = _historyFixtureEpoch(0, 100, 0)
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const f = await started()
  now += 600_000
  expect(await f.adapter.poll(f.poll)).toEqual({ kind: 'unknown' })
  expect(await f.adapter.poll({ ...f.poll, privateState: '{}' })).toEqual({ kind: 'unknown' })
  expect(f.network.calls).toHaveLength(1)
})

it('forwards cancellation, keeps unknown HTTP delivery unknown and retains a late validated credential receipt', async () => {
  const f = await started(), controller = new AbortController()
  let deliver!: (response: Response) => void
  const fetch = vi.fn((_url: string, options: RequestInit) => {
    expect(options.signal).toBe(controller.signal)
    return new Promise<Response>(resolve => { deliver = resolve })
  })
  vi.stubGlobal('fetch', fetch)
  const original = f.adapter.poll(f.poll, controller.signal)
  controller.abort()
  deliver(Response.json({ client_id: 'cli_original_application', client_secret: 'private-original-secret' }))
  expect(await original).toEqual({ kind: 'authorized', application: { domain: input.domain, appId: 'cli_original_application' }, secret: 'private-original-secret' })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(await f.adapter.poll(f.poll, controller.signal)).toEqual({ kind: 'unknown' })
  expect(fetch).toHaveBeenCalledTimes(1)
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('device-code secret and raw private diagnostic') }))
  expect(await f.adapter.poll(f.poll)).toEqual({ kind: 'unknown' })
})

it.each([302, 429, 500])('does not follow redirects, retry or confirm error-status credentials: %s', async status => {
  const f = await started({ client_id: 'cli_original_application', client_secret: 'private-original-secret' }, status)
  expect(await f.adapter.poll(f.poll)).toEqual({ kind: 'unknown' })
  expect(f.network.calls).toHaveLength(2)
})
