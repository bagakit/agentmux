// @vitest-environment happy-dom
import { act } from 'react'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { moteBotUi } from './fixtures/mote-bot-ui'
import { confirmAndCreateMote } from './fixtures/mote-connection-owner'
import { moteProfileWeb } from './fixtures/mote-profile-web'
import { moteConnectionBaseline } from '@agentmux/core/mote-preferences'
import { imagePng } from './fixtures/mote-identity-image'
import { api } from '../src/renderer/src/lib/api'

let f: Awaited<ReturnType<typeof moteBotUi>>, native: ReturnType<typeof moteProfileWeb>
beforeEach(async () => { native = moteProfileWeb(); f = await moteBotUi({ native }) })
afterEach(async () => { await f?.close() })
async function ready() {
  const input = await f.input('profile-source')
  await f.client.call('space.mote.connection.create', input)
  await confirmAndCreateMote(f, input.operationId)
  native.requests.splice(0)
  await f.open()
  await vi.waitFor(() => expect(document.body.textContent).toContain('Sync Mote profile'))
}
const progress = () => {
  const node = document.querySelector('[data-console-profile-progress]')
  expect(node, 'The current profile task uses its Console progress from preparation onward').not.toBeNull()
  return node!
}
async function signIn() {
  await f.click('Sync Mote profile')
  await vi.waitFor(() => expect(document.querySelector('[data-console-profile-task]')).not.toBeNull())
  const request = f.parentCalls.mock.calls.find(([method]) => method === 'space.mote.connection.sync')![1] as { operationId: string }
  await vi.waitFor(() => expect(document.querySelector('[data-mote-profile-action="confirm-account"]')).not.toBeNull(), { timeout: 15_000 })
  expect(native.requests).toEqual([])
  await f.click('Use this account & update bot')
  return request.operationId
}
const currentStep = () => progress().querySelector('[aria-current="step"]')?.getAttribute('data-step')
async function trace() {
  await act(async () => { const detail = document.querySelector<HTMLDetailsElement>('[data-connection-request-trace]') ?? document.querySelector<HTMLDetailsElement>('.connector-request-trace'); expect(detail).not.toBeNull(); detail!.open = true; detail!.dispatchEvent(new Event('toggle')) })
  await vi.waitFor(() => expect(document.querySelector('.connector-request-trace table')).not.toBeNull())
}

it('updates the original profile before an incomplete publication audience stops publishing with its exact issue', async () => {
  await ready()
  const transport = f.registration.getMockImplementation()!
  f.registration.mockImplementation(async (url, input) => {
    const response = await transport(url, input)
    return new URL(url instanceof Request ? url.url : String(url)).pathname.includes('/visible/online/')
      ? Response.json({ code: 0, data: { whiteList: native.audience } })
      : response
  })
  await signIn()
  await vi.waitFor(() => expect(native.written, 'Future publication metadata cannot prevent the authorized profile write').toBe(true), { timeout: 15_000 })
  await vi.waitFor(() => {
    expect(currentStep()).toBe('4')
    expect(progress().textContent).toContain('Needs attention')
    expect(document.querySelector('[data-step="3"]')?.textContent).toContain('Confirmed')
    expect(document.querySelector('[data-console-profile-task]')?.textContent).toContain('Both complete current visibility ranges are required')
  })
  expect(native.requests.filter(request => request.path.includes('/base_info/'))).toHaveLength(1)
  expect(native.requests.some(request => request.path.includes('/app_version/create/') || request.path.includes('/publish/commit/'))).toBe(false)
  expect(native.current.name).toBe('Saved public name')
  expect(f.creationCount).toBe(1)
}, 30_000)

it('publishes the saved profile with native version labels and current entries without unrelated manual form metadata', async () => {
  await ready()
  const transport = f.registration.getMockImplementation()!
  f.registration.mockImplementation(async (url, input) => {
    const response = await transport(url, input)
    const path = new URL(url instanceof Request ? url.url : String(url)).pathname
    if (!path.includes('/app_version/list/') && !path.includes('/app_version/change/')) return response
    const payload = await response.json()
    if (path.includes('/app_version/list/')) payload.data.versions = payload.data.versions.map((version: any) => {
      if (version.versionId !== 'original-online') return version
      const { versionId, ...original } = version
      return original
    })
    else {
      delete payload.data.pcDefaultAbilityList
      delete payload.data.mobileDefaultAbilityList
      delete payload.data.applyReasonConfig
    }
    return Response.json(payload)
  })
  await signIn()
  await vi.waitFor(() => expect(progress().textContent).toContain('original profile version is approved'), { timeout: 15_000 })
  const create = native.requests.filter(request => request.path.includes('/app_version/create/'))
  expect(create).toHaveLength(1)
  expect(create[0]!.body).toMatchObject({ appVersion: '1.0.1', pcDefaultAbility: 'bot', mobileDefaultAbility: 'bot' })
  expect(create[0]!.body.applyReasonConfig).toBeUndefined()
  expect(native.requests.filter(request => request.path.includes('/base_info/'))).toHaveLength(1)
  expect(native.submitted).toBe(true)
  expect(f.creationCount).toBe(1)
}, 30_000)

it.each([1, 2])('keeps the original QR mounted while a status %s poll is pending across local progress inspections', async status => {
  await ready()
  const transport = f.registration.getMockImplementation()!
  let polling = 0, arrive!: () => void, release!: () => void
  const arrived = new Promise<void>(resolve => { arrive = resolve }), held = new Promise<void>(resolve => { release = resolve })
  f.registration.mockImplementation(async (url, input) => {
    const target = new URL(url instanceof Request ? url.url : String(url))
    if (target.pathname === '/accounts/qrlogin/polling') {
      polling++
      if (polling === 1) return Response.json({ code: 0, data: { next_step: 'qr_login_polling', step_info: { status } } })
      if (polling === 2) { arrive(); await held }
    }
    return transport(url, input)
  })
  await f.click('Sync Mote profile')
  await vi.waitFor(() => expect(document.querySelector('[data-mote-profile-code] svg')).not.toBeNull())
  const qr = document.querySelector('[data-mote-profile-code] svg')
  try {
    await arrived
    const reads = f.connectionCalls.mock.calls.filter(([method]) => method === 'connection.setup.inspect').length
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2200)) })
    expect(f.connectionCalls.mock.calls.filter(([method]) => method === 'connection.setup.inspect').length).toBeGreaterThan(reads + 1)
    expect(document.querySelector('[data-mote-profile-code] svg'), 'A pending poll cannot unmount the original scannable QR').toBe(qr)
    expect(native.requests).toEqual([])
    expect(f.creationCount).toBe(1)
  } finally { await act(async () => release()) }
  await vi.waitFor(() => expect(document.querySelector('[data-mote-profile-action="confirm-account"]')).not.toBeNull(), { timeout: 10_000 })
  expect(document.querySelector('[data-mote-profile-code]')).toBeNull()
}, 30_000)

it('withdraws a known expired QR even while the following local progress read is pending', async () => {
  await ready()
  const transport = f.registration.getMockImplementation()!, read = f.connectionCalls.getMockImplementation()!
  let expired = false, arrive!: () => void, release!: () => void
  const arrived = new Promise<void>(resolve => { arrive = resolve }), held = new Promise<void>(resolve => { release = resolve })
  f.registration.mockImplementation(async (url, input) => new URL(url instanceof Request ? url.url : String(url)).pathname === '/accounts/qrlogin/polling'
    ? Response.json({ code: 0, data: { next_step: 'qr_login_polling', step_info: { status: 5 } } }) : transport(url, input))
  f.parentCalls.mockImplementation(async (method, input) => {
    const result = await f.forward(method, input)
    if (result.setup?.authentication?.stage === 'expired') expired = true
    return result
  })
  f.connectionCalls.mockImplementation(async (method, input) => {
    if (method === 'connection.setup.inspect' && expired) { arrive(); await held }
    return read(method, input)
  })
  await f.click('Sync Mote profile')
  await vi.waitFor(() => expect(document.querySelector('[data-mote-profile-code] svg')).not.toBeNull())
  try {
    await arrived
    await vi.waitFor(() => expect(document.querySelector('[data-mote-profile-code]')).toBeNull())
    expect(native.requests).toEqual([])
  } finally { await act(async () => release()) }
  await vi.waitFor(() => expect(document.querySelector('[data-mote-profile-action="renew"]')).not.toBeNull())
}, 30_000)

it('updates and publishes the exact saved bot through Settings IPC, Console and the public owner without another bot or SDK write', async () => {
  await ready()
  expect(currentStep()).toBe('1')
  const parentId = await signIn()
  await vi.waitFor(() => expect(progress().textContent).toContain('original profile version is approved'), { timeout: 15_000 }).catch(async error => {
    const parent = (await f.client.call('space.mote.connection.inspect', { operationId: parentId })).operation!
    const view = await f.client.call('connection.setup.inspect', { operationId: parent.setupOperationId!, applicationConfiguration: { effect: 'submit-application-version', draft: { kind: 'submit-version', versionId: 'profile-version', fullRelease: false } } })
    throw new Error(JSON.stringify({ progress: view.profileUpdate, configuration: view.applicationConfiguration, paths: native.requests.map(item => item.path) }), { cause: error })
  })
  const parent = (await f.client.call('space.mote.connection.inspect', { operationId: parentId })).operation!
  expect(parent.profileOperationId).toBeNull(); expect(parent.profile).toBeNull()
  expect(parent.setup?.goal).toMatchObject({ kind: 'profile-update', desired: { name: 'Saved public name', description: 'Saved public summary.', avatarSha256: createHash('sha256').update(imagePng()).digest('hex') } })
  expect(JSON.stringify(parent.setup)).not.toMatch(/pngDataUrl|base64|private-mote|csrf/)
  expect(native.current.name).toBe('Saved public name')
  expect(native.current.desc).toBe('Saved public summary.')
  expect(native.current.i18n.en_us.description).toBe('Keep translation')
  expect(native.current.i18n.zh_cn.help).toBe('keep')
  expect(native.current.avatar).toBe('https://images.example.invalid/profile-upload.png')
  const writes = native.requests.filter(request => /\/app\/upload\/image$|\/base_info\/|\/app_version\/create\/|\/publish\/commit\//u.test(request.path))
  expect(writes.map(request => request.path)).toEqual(['/developers/v1/app/upload/image', '/developers/v1/base_info/cli_mote_1', '/developers/v1/app_version/create/cli_mote_1', '/developers/v1/publish/commit/cli_mote_1/profile-version'])
  const file = writes[0]!.body.get('file') as Blob
  expect(Buffer.from(await file.arrayBuffer())).toEqual(imagePng())
  expect(writes[2]!.body.visibleSuggest).toEqual({ isAll: 0, departments: ['original-department'], members: ['original-member'], groups: ['original-group'] })
  expect(writes[2]!.body.blackVisibleSuggest).toEqual({ isAll: 0, departments: ['excluded-department'], members: [], groups: [] })
  expect(writes[3]!.body).toEqual({ clientId: 'cli_mote_1' })
  expect(f.creationCount).toBe(1)
  expect(f.calls.some(call => call.method === 'PATCH' || call.url?.endsWith('/app_avatar/upload'))).toBe(false)
  expect((await f.cli('inspect', { operationId: parentId })).operation).toEqual(parent)
  await trace()
  expect(document.querySelector('.connector-request-trace')?.textContent).not.toContain('No request yet')
}, 30_000)

it.each(['/app/upload/image', '/base_info/'])('keeps an unknown Console %s at its exact stage and local trace reads do not replay it', async failed => {
  await ready(); native.fail(failed)
  const parentId = await signIn()
  await vi.waitFor(() => { expect(currentStep()).toBe('3'); expect(progress().textContent).toContain('Needs attention') }, { timeout: 15_000 })
  expect(currentStep()).toBe('3')
  expect(progress().querySelector('[data-step="2"]')?.getAttribute('data-state')).toBe('recorded')
  expect(native.submitted).toBe(false)
  const writes = native.requests.filter(request => request.path.includes(failed))
  expect(writes).toHaveLength(1)
  await trace()
  await vi.waitFor(() => expect(document.querySelector('.connector-request-trace')?.textContent).toContain('HTTP 502'))
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await f.click('Copy diagnosis')
  const diagnosis = JSON.parse(copy.mock.calls[0]![0])
  expect(diagnosis.entries.some((entry: any) => entry.request === 'unknown' && entry.diagnostic?.httpStatus === 502)).toBe(true)
  expect(diagnosis.entries.every((entry: any) => entry.network === null)).toBe(true)
  expect(JSON.stringify(diagnosis)).not.toMatch(/pngDataUrl|base64|csrf|cookie|controlled-tenant-access|private-mote|https?:\/\//iu)
  const before = native.requests.length
  await f.click('View saved progress')
  await f.cli('inspect', { operationId: parentId })
  expect(native.requests).toHaveLength(before)
  expect(document.querySelector('[data-mote-profile-action="continue-profile-update"]')).toBeNull()
  expect(f.creationCount).toBe(1)
}, 30_000)

it('shows the held write and keeps prior confirmed steps while the original reply is pending', async () => {
  await ready()
  const held = native.hold('/base_info/')
  try {
    await signIn()
    await held.arrived
    await vi.waitFor(() => expect(progress().textContent).toContain('Updating this bot’s profile'), { timeout: 10_000 })
    expect(currentStep()).toBe('3')
    expect(progress().querySelector('[data-step="2"]')?.getAttribute('data-state')).toBe('recorded')
    expect(native.submitted).toBe(false)
  } finally { await act(async () => held.release()) }
  await vi.waitFor(() => expect(progress().textContent).toContain('original profile version is approved'), { timeout: 15_000 })
}, 30_000)


it('recovers the original parent when its management child was not admitted, without inventing a sign-in result', async () => {
  await ready()
  const begin = vi.spyOn(f.connections.connections.setup!, 'begin').mockRejectedValueOnce(new Error('Controlled failure before child admission'))
  await f.click('Sync Mote profile')
  await vi.waitFor(() => expect(document.body.textContent).toContain('Continue original request'))
  expect(progress().textContent).toContain('management request is not available yet')
  expect(progress().querySelector('[data-step="2"]')?.textContent).toContain('Not started')
  const parentId = (f.parentCalls.mock.calls.find(([method]) => method === 'space.mote.connection.sync')![1] as any).operationId
  const first = (await f.client.call('space.mote.connection.inspect', { operationId: parentId })).operation!
  expect(first.issue).toBe('child-unconfirmed'); expect(first.setup).toBeNull()
  const childId = first.setupOperationId
  await f.click('Continue original request')
  await vi.waitFor(() => expect(document.querySelector('[data-mote-profile-action="confirm-account"]')).not.toBeNull(), { timeout: 15_000 })
  const recovered = (await f.client.call('space.mote.connection.inspect', { operationId: parentId })).operation!
  expect(recovered.setupOperationId).toBe(childId)
  expect(begin).toHaveBeenCalledTimes(2)
  expect(begin.mock.calls[0]![0]).toEqual(begin.mock.calls[1]![0])
  expect(f.creationCount).toBe(1); expect(native.requests).toEqual([])
}, 30_000)

it('keeps a completed Console update out of the creation shortcut’s resume choice', async () => {
  await ready(); await signIn()
  await vi.waitFor(() => expect(progress().textContent).toContain('original profile version is approved'), { timeout: 15_000 })
  const before = await f.preferences.read({ kind: 'connection', target: f.target() })
  await f.client.call('space.mote.preferences.save', { kind: 'connection', operationId: 'explicit-unlink', target: f.target(), baseline: moteConnectionBaseline(before)!, values: { connection: null } })
  await f.renderCreateShortcut()
  await vi.waitFor(() => expect(document.body.textContent).toContain('Create a bot for this Mote'))
  expect(document.querySelector('[data-console-profile-task]')).toBeNull()
  expect(document.body.textContent).not.toContain('Resume original setup')
  expect(f.creationCount).toBe(1)
}, 30_000)

it('keeps recorded sign-in visible when the original management progress cannot be read after remount', async () => {
  await ready()
  const forward = f.connectionCalls.getMockImplementation()!
  f.connectionCalls.mockImplementation(async (method, input) => {
    if (method === 'connection.setup.inspect' && native.submitted) throw new Error('Controlled progress read failure')
    return forward(method, input)
  })
  await signIn()
  await vi.waitFor(() => expect(document.body.textContent).toContain('Controlled progress read failure'), { timeout: 15_000 })
  expect(progress().querySelector('[data-step="2"]')?.getAttribute('data-state')).toBe('recorded')
  expect(currentStep()).toBeUndefined()
  expect(progress().textContent).toContain('progress is not available')
  const before = native.requests.length
  await f.remount()
  await f.click('Saved public name · Profile update')
  await vi.waitFor(() => expect(document.body.textContent).toContain('Controlled progress read failure'))
  expect(progress().querySelector('[data-step="2"]')?.getAttribute('data-state')).toBe('recorded')
  expect(currentStep()).toBeUndefined()
  expect(progress().textContent).toContain('progress is not available')
  expect(progress().querySelector('[data-step="3"]')?.textContent).toContain('Result unavailable')
  expect(progress().querySelector('[data-step="4"]')?.textContent).toContain('Result unavailable')
  expect(native.requests).toHaveLength(before)
}, 30_000)
