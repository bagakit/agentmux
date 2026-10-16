import { afterEach, expect, it, vi } from 'vitest'
import { createFeishuEnrollment, FEISHU_ENROLLMENT_PROTOCOL } from '../src/adapters/feishu/enrollment.js'
import type { EnrollmentAdapterInput, EnrollmentAuthenticationReceipt, EnrollmentUploadReceipt, EnrollmentCreateReceipt, EnrollmentCredentialReceipt } from '../src/connection-enrollment-adapter.js'

const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
const preset = { name: 'Original bot 群', description: 'Original requested description' }
const application = { domain: 'open.feishu.cn', appId: 'cli_original_app' }
const icon = 'https://images.example.test/original.png?upload=private-icon-reference'
const input = (): EnrollmentAdapterInput => ({ operationId: 'original-enrollment', connectionId: 'original-connection', attemptId: 'original-native-attempt', domain: 'open.feishu.cn', label: 'Original bot', assertCurrent: vi.fn() })
afterEach(() => {
  const errors: unknown[] = []
  try { vi.unstubAllGlobals() } catch (error) { errors.push(error) }
  finally { try { vi.restoreAllMocks() } catch (error) { errors.push(error) } }
  if (errors.length) throw new AggregateError(errors, 'Feishu enrollment native test cleanup failed')
})
type Remote = Response | Error | (() => Promise<Response>)
function remote(...queue: Remote[]) {
  const calls: Array<{ url: string; options: RequestInit }> = []
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    calls.push({ url, options })
    const next = queue.shift()
    if (!next) throw new Error('Unexpected extra native request')
    if (next instanceof Error) throw next
    return typeof next === 'function' ? await next() : next
  })
  vi.stubGlobal('fetch', fetch)
  return { calls, fetch, queue }
}
function authentication(receipt: EnrollmentAuthenticationReceipt) {
  expect(receipt.kind).toBe('authentication')
  if (receipt.kind !== 'authentication') throw new Error('Original account progress was not confirmed')
  return receipt
}
it.each([
  ['unknown-step', 'another-step', 1, null],
  ['unknown-status', 'qr_login_polling', 3, null],
  ['init-status-on-poll', 'qr_login_polling', 0, null],
  ['string-status', 'qr_login_polling', '1', null],
  ['missing-status', 'qr_login_polling', undefined, null],
  ['native-polling-expired', 'qr_login_polling', 5, 'expired'],
  ['foreign-step-expiry', 'another-step', 5, null],
  ['string-expiry-status', 'qr_login_polling', '5', null],
  ['original-waiting', null, 1, 'waiting'],
  ['original-scanned', null, 2, 'scanned'],
  ['original-expired', null, 5, 'expired']
] as const)('keeps exact pending protocol boundaries: %s', async (_name, nextStep, status, stage) => {
  const network = remote(
    Response.json({ code: 0, data: { step_info: { token: 'private-pending-qr' } } }, { headers: { 'x-flow-key': 'private-pending-flow' } }),
    Response.json({ code: 0, data: { next_step: nextStep, step_info: { status } } })
  )
  const original = input(), adapter = createFeishuEnrollment(), initial = authentication(await adapter.begin(original))
  const result = await adapter.advance({ ...original, privateState: initial.privateState })
  expect(result).toMatchObject(stage ? { kind: 'authentication', stage, challenge: stage === 'expired' ? null : { qrPayload: initial.challenge!.qrPayload }, account: null } : { kind: 'unknown', diagnostic: { stage: 'authentication', code: 'native-unconfirmed' } })
  expect(network.calls).toHaveLength(2)
})
it.each([{}, { status: null }, { status: 0 }, { status: 2 }])('uses enter_app handoff fields independently of polling status: %j', async fields => {
  const network = remote(
    Response.json({ code: 0, data: { step_info: { token: 'private-handoff-qr' } } }, { headers: { 'x-flow-key': 'private-handoff-flow' } }),
    Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { ...fields, cross_login_uri: 'https://accounts.feishu.cn/cross' } } })
  )
  const original = input(), adapter = createFeishuEnrollment(), initial = authentication(await adapter.begin(original))
  const result = authentication(await adapter.advance({ ...original, privateState: initial.privateState }))
  expect(result).toMatchObject({ stage: 'handoff', challenge: null, account: null })
  expect(JSON.parse(result.privateState).authentication.phase).toBe('cross-login')
  expect(network.calls).toHaveLength(2)
})
it.each([undefined, 'http://accounts.feishu.cn/cross', 'https://foreign.example/cross', 'https://user@accounts.feishu.cn/cross', 'https://accounts.feishu.cn/cross#fragment'])('keeps an unqualified handoff unknown without following its URL: %s', async crossLoginUri => {
  const network = remote(
    Response.json({ code: 0, data: { step_info: { token: 'private-handoff-qr' } } }, { headers: { 'x-flow-key': 'private-handoff-flow' } }),
    Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { cross_login_uri: crossLoginUri } } })
  )
  const original = input(), adapter = createFeishuEnrollment(), initial = authentication(await adapter.begin(original))
  expect(await adapter.advance({ ...original, privateState: initial.privateState })).toMatchObject({ kind: 'unknown', diagnostic: { stage: 'authentication', step: 'poll', httpStatus: 200 } })
  expect(network.calls).toHaveLength(2)
})
function uploaded(receipt: EnrollmentUploadReceipt) {
  expect(receipt.kind).toBe('uploaded')
  if (receipt.kind !== 'uploaded') throw new Error('Original icon upload was not confirmed')
  return receipt
}
function created(receipt: EnrollmentCreateReceipt) {
  expect(receipt.kind).toBe('created')
  if (receipt.kind !== 'created') throw new Error('Original ordinary application was not confirmed')
  return receipt
}
function credential(receipt: EnrollmentCredentialReceipt) {
  expect(receipt.kind).toBe('credential')
  if (receipt.kind !== 'credential') throw new Error('Original application credential was not confirmed')
  return receipt
}
function html(user: object = { id: 'original-user', tenantId: 'original-tenant', name: 'Original user', tenantName: 'Original enterprise' }) {
  // Synthetic native literals; unrelated metadata is not account authority.
  return '<script>(function(){window.nonce="synthetic";window.user=' + JSON.stringify(user) + ';window.features=[];window.csrfToken="private-csrf";window.unit="cn";window.unitType=0;window.isOversea=false;window.env="test";window.outDomain={};window.resource={};window.domainBrand="feishu";window.seoType=0;})();</script>'
}
async function signedIn(origin = 'https://open.feishu.cn', document = html()) {
  const initialHeaders = new Headers({ 'x-flow-key': 'private-flow' })
  initialHeaders.append('set-cookie', 'shared=private-shared; Domain=.feishu.cn; Path=/; Secure')
  initialHeaders.append('set-cookie', 'accounts-only=private-accounts; Path=/accounts; Secure')
  const consoleHeaders = new Headers({ 'content-type': 'text/html' })
  consoleHeaders.append('set-cookie', 'console=private-console; Path=/developers/v1; Secure')
  const responses: Remote[] = [
    Response.json({ code: 0, data: { step_info: { token: 'private-qr-token' } } }, { headers: initialHeaders }),
    Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { cross_login_uri: 'https://accounts.feishu.cn/cross' } } }),
    new Response(null, { status: 302, headers: { location: 'https://ask.feishu.cn/' } }),
    new Response('landing', { headers: { 'content-type': 'text/html' } }),
    ...(origin === 'https://open.feishu.cn' ? [] : [new Response(null, { status: 302, headers: { location: origin + '/app' } })]),
    new Response(document, { headers: consoleHeaders })
  ]
  const network = remote(...responses), original = input(), adapter = createFeishuEnrollment()
  let view = authentication(await adapter.begin(original))
  expect(network.calls).toHaveLength(1)
  for (let index = 0; index < responses.length - 1; index++) {
    const before = network.calls.length
    view = authentication(await adapter.advance({ ...original, privateState: view.privateState }))
    expect(network.calls).toHaveLength(before + 1)
  }
  expect(view).toMatchObject({ stage: 'account', challenge: null, account: { userId: 'original-user', tenantId: 'original-tenant' } })
  expect(network.calls.map(call => { const u = new URL(call.url); return u.origin + u.pathname })).toEqual([
    'https://accounts.feishu.cn/accounts/qrlogin/init', 'https://accounts.feishu.cn/accounts/qrlogin/polling',
    'https://accounts.feishu.cn/cross', 'https://ask.feishu.cn/', 'https://open.feishu.cn/app',
    ...(origin === 'https://open.feishu.cn' ? [] : [origin + '/app'])
  ])
  return { original, adapter, network, privateState: view.privateState, view }
}
it.each([
  ['extra-metadata', html().replace('window.features=[];', 'window.features=[];window.newMetadata={"flag":true};')],
  ['local-window', html() + '<script>function unrelated(){let window={};window={"user":null};return window;}</script>'],
  ['empty-labels', html({ id: 'original-user', tenantId: 'original-tenant', name: '', tenantName: null })],
  ['conflicting-labels', html({ id: 'original-user', tenantId: 'original-tenant', name: 'First label', userName: 'Other label', tenantName: 'First tenant', tenant_name: 'Other tenant' })]
])('retains native identity independently of optional page fields: %s', async (_name, document) => {
  const f = await signedIn('https://open.feishu.cn', document)
  expect(f.view.account).toMatchObject({ userId: 'original-user', tenantId: 'original-tenant' })
  if (_name.endsWith('labels')) expect(f.view.account).toEqual({ userId: 'original-user', tenantId: 'original-tenant' })
})
async function withIcon() {
  const f = await signedIn()
  f.network.queue.push(Response.json({ code: 0, data: { url: icon } }))
  const value = uploaded(await f.adapter.upload({ ...f.original, privateState: f.privateState, pngDataUrl }))
  return { ...f, privateState: value.privateState }
}
async function withApplication() {
  const f = await withIcon()
  f.network.queue.push(Response.json({ code: 0, data: { ClientID: application.appId } }))
  const value = created(await f.adapter.create({ ...f.original, privateState: f.privateState, preset }))
  return { ...f, privateState: value.privateState }
}

it('uses the original target-free account leaf and keeps authentication separate from application creation', async () => {
  const f = await signedIn()
  expect(f.adapter.domains).toEqual([{ domain: 'open.feishu.cn', label: 'Feishu' }])
  const initial = f.network.calls[0]!
  expect(initial.options).toMatchObject({ method: 'POST', redirect: 'manual', headers: { 'x-app-id': '12', 'x-api-version': '1.0.28' } })
  expect(JSON.parse(initial.options.body as string)).toEqual({ biz_type: null, redirect_uri: 'https://ask.feishu.cn/' })
  const state = JSON.parse(f.privateState)
  expect(Object.keys(state)).toEqual(['version', 'authentication'])
  expect(state.authentication).toMatchObject({ phase: 'account', csrf: 'private-csrf', consoleOrigin: 'https://open.feishu.cn' })
  for (const field of ['operationId', 'connectionId', 'attemptId', 'application']) expect(state.authentication).not.toHaveProperty(field)
  expect(f.original.assertCurrent).toHaveBeenCalledTimes(5)
  expect(f.network.queue).toEqual([])
  for (const call of f.network.calls) expect(new Headers(call.options.headers).get('user-agent')).toContain('Chrome/145.0.0.0')
  for (const call of f.network.calls.slice(0, 2)) expect(new URL(call.url).search).toMatch(/^\?_r\d+=\d+$/u)
  expect(new Headers(f.network.calls[3]!.options.headers).get('referer')).toBe('https://accounts.feishu.cn/cross')
  expect(new Headers(f.network.calls[4]!.options.headers).get('referer')).toBe('https://ask.feishu.cn/')
})

it.each(['ClientID', 'clientID', 'clientId', 'appId'] as const)('creates through the frozen developer-console template and accepts its exact %s receipt', async key => {
  const f = await withIcon(), before = f.network.calls.length
  expect(f.adapter.protocolId).toBe(FEISHU_ENROLLMENT_PROTOCOL)
  f.network.queue.push(Response.json({ code: 0, data: { [key]: application.appId } }))
  const receipt = created(await f.adapter.create({ ...f.original, protocolId: FEISHU_ENROLLMENT_PROTOCOL, privateState: f.privateState, preset }))
  expect(receipt.application).toEqual(application)
  expect(f.network.calls).toHaveLength(before + 1)
  const call = f.network.calls.at(-1)!
  expect(call.url).toBe('https://open.feishu.cn/developers/v1/manifest/upsert_by_template')
  expect(JSON.parse(call.options.body as string)).toEqual({
    appManifestTemplateID: 'developer_console',
    createAppUserCustomField: { i18n: { zh_cn: preset }, avatar: icon, primaryLang: 'zh_cn' },
    cid: f.original.attemptId, HTTPHead: {}
  })
  expect(new Headers(call.options.headers).get('user-agent')).toContain('Chrome/145.0.0.0')
})

it.each([
  () => Response.json({ code: 0, data: {} }),
  () => Response.json({ code: 0, data: { ClientID: application.appId, clientId: 'cli_conflicting' } }),
  () => Response.json({ code: 17, message: 'private-tenant-message' }),
  () => new Response(null, { status: 502 }),
  () => { throw new TypeError('private-lost-response') }
])('never crosses to ordinary creation after a template failure or unconfirmed result, case %#', async response => {
  const f = await withIcon(), before = f.network.calls.length
  f.network.queue.push(async () => response())
  const result = await f.adapter.create({ ...f.original, protocolId: FEISHU_ENROLLMENT_PROTOCOL, privateState: f.privateState, preset })
  expect(result.kind).toBe('unknown')
  expect(f.network.calls.slice(before).map(call => call.url)).toEqual(['https://open.feishu.cn/developers/v1/manifest/upsert_by_template'])
  expect(JSON.stringify(result)).not.toContain('private-')
})

it.each([
  [() => new Response(null, { status: 503 }), { step: 'initialize', failure: 'http-status', httpStatus: 503 }],
  [() => Response.json({ code: 901, message: 'private-native-error' }), { step: 'initialize', failure: 'platform-error', httpStatus: 200, nativeCode: 901 }],
  [() => Response.json({ code: 0, data: {} }), { step: 'initialize', failure: 'invalid-response', httpStatus: 200 }],
  [() => { throw new TypeError('private-native-network') }, { step: 'initialize', failure: 'transport-unconfirmed' }]
] as const)('reports safe native initialization facts without private material, case %#', async (response, diagnostic) => {
  remote(async () => response())
  const result = await createFeishuEnrollment().begin(input())
  expect(result).toEqual({ kind: 'unknown', diagnostic: { stage: 'authentication', code: 'native-unconfirmed', ...diagnostic } })
  expect(JSON.stringify(result)).not.toContain('private-')
})

it('uploads the exact PNG and creates one ordinary self-built application before reading its exact nonrotating credential', async () => {
  const f = await signedIn(), writes = f.network.calls.length
  f.network.queue.push(Response.json({ code: 0, data: { url: icon } }, { headers: { 'set-cookie': 'upload=private-upload; Path=/developers/v1; Secure' } }))
  const image = uploaded(await f.adapter.upload({ ...f.original, privateState: f.privateState, pngDataUrl }))
  const upload = f.network.calls[writes]!, form = upload.options.body as FormData, file = form.get('file') as File
  expect(upload.url).toBe('https://open.feishu.cn/developers/v1/app/upload/image')
  expect([...form.keys()]).toEqual(['file', 'uploadType', 'isIsv', 'scale'])
  expect(file.type).toBe('image/png'); expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from(pngDataUrl.slice(22), 'base64'))
  expect([form.get('uploadType'), form.get('isIsv'), form.get('scale')]).toEqual(['4', 'false', '{"width":1,"height":1}'])
  const uploadHeaders = new Headers(upload.options.headers)
  expect(uploadHeaders.has('content-type')).toBe(false)
  expect(uploadHeaders.get('cookie')?.split('; ').sort()).toEqual(['console=private-console', 'shared=private-shared'])
  expect(uploadHeaders.get('origin')).toBe('https://open.feishu.cn')
  expect(uploadHeaders.get('referer')).toBe('https://open.feishu.cn/app')
  expect(uploadHeaders.get('x-csrf-token')).toBe('private-csrf')
  expect(uploadHeaders.get('X-Timezone-Offset')).toBe(String(new Date().getTimezoneOffset()))
  expect(uploadHeaders.has('X-AppPlatform-RequestFrom')).toBe(false)
  expect(upload.options.redirect).toBe('manual')
  f.network.queue.push(Response.json({ code: 0, data: { ClientID: application.appId } }))
  const app = created(await createFeishuEnrollment().create({ ...f.original, privateState: image.privateState, preset }))
  expect(app.application).toEqual(application)
  expect(JSON.parse(f.network.calls[writes + 1]!.options.body as string)).toEqual({ appSceneType: 0, name: preset.name, desc: preset.description, avatar: icon, i18n: { zh_cn: { name: preset.name, description: preset.description } }, primaryLang: 'zh_cn' })
  expect(new Headers(f.network.calls[writes + 1]!.options.headers).get('cookie')).toContain('upload=private-upload')
  expect(JSON.parse(app.privateState)).toMatchObject({ avatar: { url: icon, width: 1, height: 1 }, appId: application.appId })
  f.network.queue.push(Response.json({ code: 0, data: { secret: 'private-original-secret' } }))
  const secret = credential(await createFeishuEnrollment().credential({ ...f.original, privateState: app.privateState, application }))
  expect(secret.secret).toBe('private-original-secret')
  expect(f.network.calls.slice(writes).map(call => [call.url, call.options.method])).toEqual([
    ['https://open.feishu.cn/developers/v1/app/upload/image', 'POST'], ['https://open.feishu.cn/developers/v1/app/create', 'POST'],
    ['https://open.feishu.cn/developers/v1/secret/' + application.appId, 'POST']
  ])
  expect(f.network.calls[writes + 2]!.options.body).toBe('{}')
  expect(f.network.calls).toHaveLength(writes + 3)
  const { privateState, ...publicCreated } = app
  expect(JSON.stringify(publicCreated)).not.toContain(icon)
  expect(JSON.stringify(publicCreated)).not.toContain('private-csrf')
  expect(JSON.parse(secret.privateState)).toMatchObject({ appId: application.appId, avatar: { url: icon } })
  expect(f.network.queue).toEqual([])
})

it('keeps absent requested description empty rather than inventing metadata or capabilities', async () => {
  const f = await withIcon()
  f.network.queue.push(Response.json({ code: 0, data: { ClientID: application.appId } }))
  created(await f.adapter.create({ ...f.original, privateState: f.privateState, preset: { name: preset.name } }))
  expect(JSON.parse(f.network.calls.at(-1)!.options.body as string)).toEqual({ appSceneType: 0, name: preset.name, desc: '', avatar: icon, i18n: { zh_cn: { name: preset.name, description: '' } }, primaryLang: 'zh_cn' })
})

it('does not turn a qualified authentication alias into Feishu creation authority', async () => {
  const f = await signedIn('https://open.larkoffice.com'), before = f.network.calls.length
  expect(await f.adapter.upload({ ...f.original, privateState: f.privateState, pngDataUrl })).toEqual({ kind: 'unknown', diagnostic: { stage: 'preparation', code: 'invalid-state' } })
  expect(f.network.calls).toHaveLength(before)
  expect(f.view.account).toMatchObject({ userId: 'original-user', tenantId: 'original-tenant' })
})

it('rejects unsupported issuers and malformed native state without dispatch or borrowed business bindings', async () => {
  const network = remote(), adapter = createFeishuEnrollment(), original = input()
  expect(await adapter.begin({ ...original, domain: 'open.larksuite.com' })).toEqual({ kind: 'unknown', diagnostic: { stage: 'preparation', code: 'unsupported-domain' } })
  expect(await adapter.advance({ ...original, privateState: '{"operationId":"borrowed","authentication":{}}' })).toEqual({ kind: 'unknown', diagnostic: { stage: 'preparation', code: 'invalid-state' } })
  expect(await adapter.upload({ ...original, privateState: '{}', pngDataUrl })).toEqual({ kind: 'unknown', diagnostic: { stage: 'preparation', code: 'invalid-state' } })
  expect(network.calls).toEqual([])
})

it('rejects malformed PNG bytes and missing native upload facts before creating anything', async () => {
  const f = await signedIn(), before = f.network.calls.length
  for (const image of ['data:image/png;base64,YmFk', pngDataUrl + '=', pngDataUrl.replace('image/png', 'image/jpeg')]) {
    expect(await f.adapter.upload({ ...f.original, privateState: f.privateState, pngDataUrl: image })).toEqual({ kind: 'unknown', diagnostic: { stage: 'preparation', code: 'invalid-image' } })
  }
  expect(await f.adapter.create({ ...f.original, privateState: f.privateState, preset })).toEqual({ kind: 'unknown', diagnostic: { stage: 'preparation', code: 'invalid-state' } })
  expect(f.network.calls).toHaveLength(before)
})

it.each([
  { body: { code: 0, data: {} } }, { body: { code: 0, data: { ClientID: ['cli_foreign'] } } },
  { body: { code: 0, data: { clientId: application.appId } } }, { body: { code: 0, data: { ClientID: 'other_app' } } },
  { body: { code: 0, data: { ClientID: 'cli_/foreign' } } }, { body: { code: '0', data: { ClientID: application.appId } } },
  { body: { code: 0, data: [] } }
])('keeps a create response without the exact ClientID unknown with no fallback: %j', async response => {
  const f = await withIcon(), before = f.network.calls.length
  f.network.queue.push(Response.json(response.body))
  expect(await f.adapter.create({ ...f.original, privateState: f.privateState, preset })).toEqual({ kind: 'unknown', diagnostic: { stage: 'response', code: 'invalid-response', httpStatus: 200 } })
  expect(f.network.calls).toHaveLength(before + 1)
  expect(f.network.calls.at(-1)!.url).toBe('https://open.feishu.cn/developers/v1/app/create')
})

it.each([
  [{ code: 0, data: { secret: 'private-data-secret' } }, 'private-data-secret'],
  [{ code: 0, secret: 'private-root-secret' }, 'private-root-secret'],
  [{ code: 0, data: null, secret: 'private-root-secret' }, 'private-root-secret'],
  [{ code: 0, data: { secret: 'private-same-secret' }, secret: 'private-same-secret' }, 'private-same-secret']
] as const)('reads only the original application secret envelope, case %#', async (body, expected) => {
  const f = await withApplication(), before = f.network.calls.length
  f.network.queue.push(Response.json(body))
  expect(credential(await f.adapter.credential({ ...f.original, privateState: f.privateState, application })).secret).toBe(expected)
  expect(f.network.calls).toHaveLength(before + 1)
  expect(f.network.calls.at(-1)!.url).toBe('https://open.feishu.cn/developers/v1/secret/' + application.appId)
})

it('refuses another application before HTTP, retains the original created app and will not create it again', async () => {
  const f = await withApplication(), before = f.network.calls.length
  f.network.queue.push(Response.json({ code: 0, data: { secret: 'private-recovered-secret' } }))
  expect(await f.adapter.credential({ ...f.original, privateState: f.privateState, application: { ...application, appId: 'cli_another_app' } })).toEqual({ kind: 'unknown', diagnostic: { stage: 'preparation', code: 'invalid-application' } })
  expect(await f.adapter.create({ ...f.original, privateState: f.privateState, preset })).toEqual({ kind: 'unknown', diagnostic: { stage: 'preparation', code: 'invalid-state' } })
  expect(await f.adapter.upload({ ...f.original, privateState: f.privateState, pngDataUrl })).toEqual({ kind: 'unknown', diagnostic: { stage: 'preparation', code: 'invalid-state' } })
  expect(f.network.calls).toHaveLength(before)
  expect(f.network.queue).toHaveLength(1)
  expect(credential(await f.adapter.credential({ ...f.original, privateState: f.privateState, application })).secret).toBe('private-recovered-secret')
})

it('uses the original Host known app after its created snapshot was not secured, without another create', async () => {
  const f = await withIcon(), before = f.network.calls.length
  expect(JSON.parse(f.privateState)).not.toHaveProperty('appId')
  f.network.queue.push(Response.json({ code: 0, data: { secret: 'private-known-app-secret' } }))
  const value = credential(await f.adapter.credential({ ...f.original, privateState: f.privateState, application }))
  expect(value.secret).toBe('private-known-app-secret')
  expect(JSON.parse(value.privateState).appId).toBe(application.appId)
  expect(f.network.calls.slice(before).map(call => [call.url, call.options.body])).toEqual([['https://open.feishu.cn/developers/v1/secret/' + application.appId, '{}']])
})

it.each([
  { code: 0, data: {} }, { code: 0, data: { secret: ['private-secret'] } },
  { code: 0, data: { secret: 'private-first' }, secret: 'private-second' }, { code: 0, data: [], secret: 'private-root' }
])('does not rotate or retry after an unconfirmed credential response, case %#', async body => {
  const f = await withApplication(), before = f.network.calls.length
  f.network.queue.push(Response.json(body))
  expect(await f.adapter.credential({ ...f.original, privateState: f.privateState, application })).toEqual({ kind: 'unknown', diagnostic: { stage: 'response', code: 'invalid-response', httpStatus: 200 } })
  expect(f.network.calls).toHaveLength(before + 1)
  expect(JSON.parse(f.privateState).appId).toBe(application.appId)
})

it('reports only observed response categories, never native text or a guessed not-applied result', async () => {
  const f = await withIcon(), original = { ...f.original, privateState: f.privateState, preset }, before = f.network.calls.length
  const cases: Array<[Response | Error, unknown]> = [
    [new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/' } }), { stage: 'response', code: 'http-status', httpStatus: 302 }],
    [Response.json({ code: 17, message: 'private-platform-detail' }, { status: 403 }), { stage: 'response', code: 'http-status', httpStatus: 403 }],
    [Response.json({ code: 17, message: 'private-platform-detail' }), { stage: 'response', code: 'platform-error', httpStatus: 200 }],
    [new Response('private-non-json', { headers: { 'content-type': 'application/json' } }), { stage: 'response', code: 'invalid-json', httpStatus: 200 }],
    [new TypeError('private-transport-detail'), { stage: 'request', code: 'transport-unconfirmed' }]
  ]
  for (const [response, diagnostic] of cases) {
    f.network.queue.push(response)
    expect(await f.adapter.create(original)).toEqual({ kind: 'unknown', diagnostic })
  }
  expect(f.network.calls).toHaveLength(before + cases.length)
})

it('checks the original Host synchronously before dispatch and leaves authority failures to that owner', async () => {
  const f = await withIcon(), before = f.network.calls.length, authority = new Error('Original authority is no longer current')
  const assertCurrent = vi.fn(() => { throw authority })
  await expect(f.adapter.create({ ...f.original, assertCurrent, privateState: f.privateState, preset })).rejects.toBe(authority)
  expect(assertCurrent).toHaveBeenCalledOnce()
  expect(f.network.calls).toHaveLength(before)
})

it('keeps cancelled requests separate from an original late, validated creation receipt', async () => {
  const f = await withIcon(), controller = new AbortController(), before = f.network.calls.length
  controller.abort()
  expect(await f.adapter.create({ ...f.original, privateState: f.privateState, preset }, controller.signal)).toEqual({ kind: 'unknown', diagnostic: { stage: 'request', code: 'cancelled' } })
  expect(f.network.calls).toHaveLength(before)
  const active = new AbortController()
  let deliver!: (response: Response) => void
  f.network.queue.push(() => new Promise<Response>(resolve => { deliver = resolve }))
  const work = f.adapter.create({ ...f.original, privateState: f.privateState, preset }, active.signal)
  expect(f.network.calls).toHaveLength(before + 1)
  active.abort(); deliver(Response.json({ code: 0, data: { ClientID: application.appId } }))
  expect(created(await work).application).toEqual(application)
  expect(f.network.calls).toHaveLength(before + 1)
})

it('keeps opaque authentication failure named without inventing a response status', async () => {
  const network = remote(new TypeError('private-auth-detail'))
  expect(await createFeishuEnrollment().begin(input())).toMatchObject({ kind: 'unknown', diagnostic: { stage: 'authentication', code: 'native-unconfirmed', step: 'initialize' } })
  expect(network.calls).toHaveLength(1)
})
