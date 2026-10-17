// @vitest-environment happy-dom
import { act } from 'react'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { diagnosisText } from './helpers/connection-diagnosis-text'
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
const result = () => {
  const node = document.querySelector('[data-profile-result]')
  expect(node, 'The original profile update keeps a readable outcome').not.toBeNull()
  return node!
}
const savedProgressButton = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'View saved progress')!
function incompleteAudience() {
  const transport = f.registration.getMockImplementation()!
  f.registration.mockImplementation(async (url, input) => {
    const response = await transport(url, input)
    return new URL(url instanceof Request ? url.url : String(url)).pathname.includes('/visible/online/')
      ? Response.json({ code: 0, data: { whiteList: native.audience } }) : response
  })
}
async function trace() {
  await act(async () => { const detail = document.querySelector<HTMLDetailsElement>('[data-connection-request-trace]') ?? document.querySelector<HTMLDetailsElement>('.connector-request-trace'); expect(detail).not.toBeNull(); detail!.open = true; detail!.dispatchEvent(new Event('toggle')) })
  await vi.waitFor(() => expect(document.querySelector('.connector-request-trace table')).not.toBeNull())
}

it('updates the original profile before an incomplete publication audience stops publishing with its exact issue', async () => {
  await ready()
  incompleteAudience()
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
  expect(result().textContent).toContain('Profile updated, not published')
  expect(result().getAttribute('data-state')).toBe('attention')
  await trace()
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const before = f.registration.mock.calls.length
  await f.click('Copy diagnosis')
  await vi.waitFor(() => expect(copy).toHaveBeenCalledTimes(1))
  const diagnosis = diagnosisText(copy.mock.calls[0]![0])
  const setupId = document.querySelector('[data-console-profile-task]')!.getAttribute('data-console-profile-task')!
  const original = await f.client.call('connection.setup.inspect', { operationId: setupId })
  expect(diagnosis.observations['setup:' + setupId].setupObservation).toMatchObject({
    scope: 'single-view-observation', operationId: setupId, revision: original.operation!.revision,
    profileUpdate: { stage: 'publication-create', state: 'attention', actionKinds: ['refresh-publication-checks'] },
    publication: { capability: original.applicationConfiguration!.capability, reason: original.applicationConfiguration!.reason ?? null, review: { issues: ['Both complete current visibility ranges are required'] } }
  })
  expect(diagnosis.observations['setup:' + setupId].setupObservation.publication.sources).toHaveLength(5)
  expect(diagnosis.observations['setup:' + setupId].setupObservation.publication.sources).toEqual(expect.arrayContaining([
    { subject: 'publication-visibility', request: 'confirmed', secureStorage: 'stored' },
    { subject: 'publication-versions', request: 'confirmed', secureStorage: 'stored' }
  ]))
  expect(diagnosis.traces.every(trace => trace.status === 'complete')).toBe(true)
  expect(diagnosis.traces.flatMap(trace => trace.entries).some((entry: any) => entry.effect === 'update-application-profile' && entry.request === 'confirmed' && entry.secureStorage === 'stored')).toBe(true)
  expect(JSON.stringify(diagnosis.observations['setup:' + setupId].setupObservation)).not.toMatch(/Saved public name|Saved public summary|original-member|account|qrPayload|pngDataUrl|base64|csrf|cookie|https?:\/\//iu)
  expect(f.registration.mock.calls).toHaveLength(before)
}, 30_000)

it('keeps the checked result and progress mounted while the real local progress response is pending', async () => {
  await ready(); incompleteAudience(); await signIn()
  await vi.waitFor(() => expect(result().textContent).toContain('Profile updated, not published'), { timeout: 15_000 })
  await vi.waitFor(() => expect(savedProgressButton().getAttribute('aria-busy')).toBe('false'))
  const previousProgress = progress(), previousResult = result(), publicationChecks = document.querySelector('[aria-label="Publication checks"]')
  const handler = f.handlers.get('connections:call')!
  let arrive!: () => void, release!: () => void
  const arrived = new Promise<void>(resolve => { arrive = resolve }), held = new Promise<void>(resolve => { release = resolve })
  f.handlers.set('connections:call', async (event, method, input) => {
    const value = await handler(event, method, input)
    if (method === 'connection.setup.inspect' && !input.requestTrace) { arrive(); await held }
    return value
  })
  const before = f.registration.mock.calls.length
  try {
    await f.click('View saved progress'); await arrived
    for (let turn = 0; turn < 2; turn++) {
      await f.settle()
      expect(savedProgressButton().getAttribute('aria-busy')).toBe('true')
      expect(document.querySelector('[data-profile-activity]')?.getAttribute('data-working')).toBe('true')
      expect(document.querySelector('[data-profile-activity]')?.getAttribute('role')).toBe('status')
      expect(document.querySelector('[data-profile-activity] svg')).not.toBeNull()
      expect(document.querySelector('[data-profile-activity]')?.textContent).toContain('Checking saved progress')
      expect(progress()).toBe(previousProgress)
      expect(result()).toBe(previousResult)
      expect(document.querySelector('[aria-label="Publication checks"]')).toBe(publicationChecks)
      expect(currentStep()).toBe('4')
      expect(result().textContent).toContain('Profile updated, not published')
      expect(progress().textContent).not.toContain('Result unavailable')
      expect(f.registration.mock.calls).toHaveLength(before)
    }
  } finally { await act(async () => release()) }
  await vi.waitFor(() => expect(savedProgressButton().getAttribute('aria-busy')).toBe('false'))
  expect(progress()).toBe(previousProgress); expect(result()).toBe(previousResult)
  expect(document.querySelector('[data-profile-activity]')?.textContent).toContain('Saved progress checked.')
  expect(document.querySelector('[data-profile-activity]')?.getAttribute('data-working')).toBe('false')
  expect(f.registration.mock.calls).toHaveLength(before)
}, 30_000)

it('keeps the manual query busy after a later background inspection completes during the original held write', async () => {
  await ready()
  const write = native.hold('/base_info/'), handler = f.handlers.get('connections:call')!
  let holdNext = false, inspection = 0, manualInspection = 0, laterReads = 0, arrive!: () => void, release!: () => void
  const arrived = new Promise<void>(resolve => { arrive = resolve }), held = new Promise<void>(resolve => { release = resolve })
  f.handlers.set('connections:call', async (event, method, input) => {
    const local = method === 'connection.setup.inspect' && !input.requestTrace
    const ordinal = local ? ++inspection : 0, manual = local && holdNext
    if (manual) { holdNext = false; manualInspection = ordinal }
    const value = await handler(event, method, input)
    if (manual) { arrive(); await held }
    else if (local && manualInspection && ordinal > manualInspection) laterReads++
    return value
  })
  try {
    await signIn(); await write.arrived
    await vi.waitFor(() => expect(currentStep()).toBe('3'), { timeout: 10_000 })
    const previousProgress = progress(), previousResult = result(), before = f.registration.mock.calls.length
    await act(async () => { holdNext = true; savedProgressButton().click() })
    await arrived
    await vi.waitFor(() => expect(laterReads).toBeGreaterThan(0), { timeout: 4000 })
    expect(savedProgressButton().getAttribute('aria-busy')).toBe('true')
    expect(savedProgressButton().querySelector('svg')).not.toBeNull()
    expect(document.querySelector('[data-profile-activity]')?.getAttribute('data-working')).toBe('true')
    expect(progress()).toBe(previousProgress); expect(result()).toBe(previousResult)
    expect(f.registration.mock.calls).toHaveLength(before)
    expect(native.requests.filter(request => request.path.includes('/base_info/'))).toHaveLength(1)
    await act(async () => release())
    await vi.waitFor(() => expect(savedProgressButton().getAttribute('aria-busy')).toBe('false'))
    expect(document.querySelector('[data-profile-activity]')?.getAttribute('data-working')).toBe('true')
    expect(native.submitted).toBe(false)
  } finally { await act(async () => { release(); write.release() }) }
  await vi.waitFor(() => expect(progress().textContent).toContain('original profile version is approved'), { timeout: 15_000 })
  expect(native.requests.filter(request => request.path.includes('/base_info/'))).toHaveLength(1)
  expect(f.creationCount).toBe(1)
}, 30_000)

it('retains the original result while an account-confirmed parent hands off to its pending local child read', async () => {
  await ready(); incompleteAudience()
  await f.click('Sync Mote profile')
  await vi.waitFor(() => expect(document.querySelector('[data-mote-profile-action="confirm-account"]')).not.toBeNull(), { timeout: 15_000 })
  const setupId = document.querySelector('[data-console-profile-task]')!.getAttribute('data-console-profile-task')!
  const previous = await f.client.call('connection.setup.inspect', { operationId: setupId })
  const previousProgress = progress(), previousResult = result(), handler = f.handlers.get('connections:call')!
  let confirmedRevision: number | undefined, arrive!: () => void, release!: () => void
  const arrived = new Promise<void>(resolve => { arrive = resolve }), held = new Promise<void>(resolve => { release = resolve })
  f.parentCalls.mockImplementation(async (method, input) => {
    const value = await f.forward(method, input)
    if (method === 'space.mote.connection.advance' && value.setup?.authentication?.stage === 'confirmed') confirmedRevision = value.setup.revision
    return value
  })
  f.handlers.set('connections:call', async (event, method, input) => {
    const value = await handler(event, method, input)
    if (method === 'connection.setup.inspect' && !input.requestTrace && confirmedRevision !== undefined) { arrive(); await held }
    return value
  })
  try {
    await f.click('Use this account & update bot'); await arrived; await f.settle()
    expect(confirmedRevision).toBeGreaterThan(previous.operation!.revision)
    expect(progress()).toBe(previousProgress); expect(result()).toBe(previousResult)
    expect(progress().textContent).not.toContain('Result unavailable')
    expect(result().textContent).toContain('Showing the last checked result.')
    expect(document.querySelector('[data-profile-activity]')?.getAttribute('data-working')).toBe('true')
    expect(document.querySelector('[data-mote-profile-action="confirm-account"]')).toBeNull()
    expect(document.querySelector('[data-mote-profile-code]')).toBeNull()
    expect(document.querySelector('[data-mote-profile-action="continue-profile-update"]')).toBeNull()
    expect(native.requests.filter(request => request.path.includes('/base_info/'))).toHaveLength(1)
    expect(native.requests.filter(request => request.path.includes('/upload/image'))).toHaveLength(1)
    expect(native.submitted).toBe(false)
  } finally { await act(async () => release()) }
  await vi.waitFor(() => expect(result().textContent).toContain('Profile updated, not published'))
  expect(progress()).toBe(previousProgress); expect(result()).toBe(previousResult)
  expect(currentStep()).toBe('4')
  expect(native.requests.filter(request => request.path.includes('/base_info/'))).toHaveLength(1)
  expect(native.requests.filter(request => request.path.includes('/upload/image'))).toHaveLength(1)
  expect(native.submitted).toBe(false); expect(f.creationCount).toBe(1)
}, 30_000)

it('identifies the last checked result after a local progress query fails without replaying any request', async () => {
  await ready(); incompleteAudience(); await signIn()
  await vi.waitFor(() => expect(result().textContent).toContain('Profile updated, not published'), { timeout: 15_000 })
  await vi.waitFor(() => expect(savedProgressButton().getAttribute('aria-busy')).toBe('false'))
  const previousProgress = progress(), previousResult = result(), checks = document.querySelector('[aria-label="Publication checks"]')
  const setupId = document.querySelector('[data-console-profile-task]')!.getAttribute('data-console-profile-task')!
  const original = await f.client.call('connection.setup.inspect', { operationId: setupId })
  const refresh = original.profileUpdate!.actions.find(action => action.kind === 'refresh-publication-checks')!
  expect(refresh).toBeTruthy()
  const handler = f.handlers.get('connections:call')!
  f.handlers.set('connections:call', async (event, method, input) => {
    if (method === 'connection.setup.inspect' && !input.requestTrace) throw new Error('Controlled local progress read failure')
    return handler(event, method, input)
  })
  const before = f.registration.mock.calls.length
  await f.click('View saved progress')
  await vi.waitFor(() => expect(document.body.textContent).toContain('Controlled local progress read failure'))
  expect(progress()).toBe(previousProgress); expect(result()).toBe(previousResult)
  expect(document.querySelector('[aria-label="Publication checks"]')).toBe(checks)
  expect(result().textContent).toContain('Profile updated, not published')
  expect(result().textContent).toContain('Showing the last checked result. The latest check could not be completed.')
  expect(document.querySelector('[data-profile-activity]')?.textContent).toContain('Showing the last checked result')
  expect(document.querySelector('[data-profile-activity]')?.textContent).not.toContain('Saved progress checked.')
  expect(savedProgressButton().getAttribute('aria-busy')).toBe('false')
  expect(currentStep()).toBe('4')
  expect(document.querySelector('[data-mote-profile-action="refresh-publication-checks"]')).not.toBeNull()
  expect(f.registration.mock.calls).toHaveLength(before)
  await f.click('Refresh publication checks')
  await vi.waitFor(() => expect(f.registration.mock.calls).toHaveLength(before + 5))
  const request = f.parentCalls.mock.calls.filter(([method]) => method === 'space.mote.connection.advance').at(-1)![1]
  expect(request).toMatchObject({ setup: { operationId: setupId, expectedRevision: refresh.expectedRevision, decision: { actionId: refresh.actionId, value: 'continue' } } })
  expect(native.requests.filter(request => request.path.includes('/base_info/'))).toHaveLength(1)
  expect(native.requests.filter(request => request.path.includes('/upload/image'))).toHaveLength(1)
  expect(native.requests.some(request => request.path.includes('/app_version/create/') || request.path.includes('/publish/commit/'))).toBe(false)
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

it('refreshes blocked publication checks without publishing until a separate original continuation', async () => {
  await ready()
  const transport = f.registration.getMockImplementation()!
  let incomplete = true
  f.registration.mockImplementation(async (url, input) => {
    const response = await transport(url, input)
    return incomplete && new URL(url instanceof Request ? url.url : String(url)).pathname.includes('/visible/online/')
      ? Response.json({ code: 0, data: { whiteList: native.audience } }) : response
  })
  await signIn()
  await vi.waitFor(() => {
    expect(document.querySelector('[data-mote-profile-action="refresh-publication-checks"]')?.textContent).toBe('Refresh publication checks')
    expect(document.querySelector('[data-mote-profile-action="continue-profile-update"]')).toBeNull()
    expect(document.querySelector('[aria-label="Publication checks"]')?.textContent).toContain('Both complete current visibility ranges are required')
    expect(document.querySelector('[aria-label="Publication checks"]')?.textContent).toContain('1.0.1')
  }, { timeout: 15_000 })
  const setupId = document.querySelector('[data-console-profile-task]')!.getAttribute('data-console-profile-task')!
  expect(f.connectionCalls.mock.calls.some(([method, input]) => method === 'connection.setup.inspect' && (input as { operationId?: string }).operationId === setupId && 'applicationConfiguration' in input)).toBe(false)
  const count = native.requests.length
  for (let read = 0; read < 2; read++) await api.connections.call('connection.setup.inspect', { operationId: setupId })
  expect(native.requests).toHaveLength(count)
  await f.click('Refresh publication checks')
  await vi.waitFor(() => expect(native.requests).toHaveLength(count + 5))
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-mote-profile-action="refresh-publication-checks"]')?.disabled).toBe(false))
  expect(document.querySelector('[data-mote-profile-action="continue-profile-update"]')).toBeNull()
  incomplete = false
  await f.click('Refresh publication checks')
  await vi.waitFor(() => {
    expect(native.requests).toHaveLength(count + 10)
    expect(document.querySelector('[data-mote-profile-action="continue-profile-update"]')).not.toBeNull()
    expect(document.querySelector('[data-mote-profile-action="create-application-version"]')).toBeNull()
    expect(document.querySelector('[data-console-profile-task]')?.textContent).not.toContain('Confirm a version and release notes')
    expect(document.querySelector('[data-console-profile-task]')?.textContent).not.toContain('Version: Not confirmed')
  })
  expect(native.requests.some(request => request.path.includes('/app_version/create/') || request.path.includes('/publish/commit/'))).toBe(false)
  expect(native.requests.filter(request => request.path.includes('/base_info/'))).toHaveLength(1)
  expect(native.requests.filter(request => request.path.includes('/upload/image'))).toHaveLength(1)
  expect(currentStep()).toBe('4')
  await f.click('Publish updated profile')
  await vi.waitFor(() => expect(progress().textContent).toContain('original profile version is approved'), { timeout: 15_000 })
  expect(native.requests.filter(request => request.path.includes('/app_version/create/'))).toHaveLength(1)
  expect(native.submitted).toBe(true)
  expect(f.creationCount).toBe(1)
}, 30_000)

it('publishes the original complete audience from the supported native collection identities', async () => {
  await ready()
  const transport = f.registration.getMockImplementation()!
  f.registration.mockImplementation(async (url, input) => {
    const response = await transport(url, input)
    return new URL(url instanceof Request ? url.url : String(url)).pathname.includes('/visible/online/')
      ? Response.json({ code: 0, data: {
          whiteList: { isAll: 0, departments: ['original-department'], members: [{ openId: 'original-member' }], groups: [{ chat_id: 'original-group' }] },
          blackList: { isAll: 0, departments: [{ open_department_id: 'excluded-department' }], members: [], groups: [] }
        } }) : response
  })
  await signIn()
  await vi.waitFor(() => expect(progress().textContent).toContain('original profile version is approved'), { timeout: 15_000 })
  const create = native.requests.filter(request => request.path.includes('/app_version/create/'))
  expect(create).toHaveLength(1)
  expect(create[0]!.body).toMatchObject({
    visibleSuggest: { isAll: 0, departments: ['original-department'], members: ['original-member'], groups: ['original-group'] },
    blackVisibleSuggest: { isAll: 0, departments: ['excluded-department'], members: [], groups: [] }
  })
  expect(native.requests.filter(request => request.path.includes('/base_info/'))).toHaveLength(1)
  expect(native.submitted).toBe(true)
  expect(f.creationCount).toBe(1)
}, 30_000)

it('names an unavailable publication review while keeping the original saved read receipts and refresh', async () => {
  await ready()
  const configuration = f.adapters.find(adapter => adapter.adapterId === 'feishu')!.setup!.applicationConfiguration!
  vi.spyOn(configuration, 'publicationPlan').mockRejectedValue(new Error('Controlled publication interpretation unavailable'))
  await signIn()
  await vi.waitFor(() => {
    expect(document.querySelector('[data-publication-unavailable]')?.textContent).toContain('current saved checks do not yet provide a confirmed publication review')
    expect(document.querySelector('[data-mote-profile-action="refresh-publication-checks"]')).not.toBeNull()
    expect(document.querySelector('[data-mote-profile-action="continue-profile-update"]')).toBeNull()
  }, { timeout: 15_000 })
  const setupId = document.querySelector('[data-console-profile-task]')!.getAttribute('data-console-profile-task')!
  const count = native.requests.length
  const view = await api.connections.call('connection.setup.inspect', { operationId: setupId })
  expect(view.applicationConfiguration?.effect).toBe('create-application-version')
  if (view.applicationConfiguration?.effect !== 'create-application-version') throw new Error('Missing original publication configuration')
  expect(Object.keys(view.applicationConfiguration.sources)).toHaveLength(5)
  expect(view.applicationConfiguration.review).toBeNull()
  expect(native.requests).toHaveLength(count)
  expect(native.requests.some(request => request.path.includes('/app_version/create/') || request.path.includes('/publish/commit/'))).toBe(false)
  expect(native.requests.filter(request => request.path.includes('/base_info/'))).toHaveLength(1)
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
  const diagnosis = diagnosisText(copy.mock.calls[0]![0])
  expect(diagnosis.traces.flatMap(trace => trace.entries).some((entry: any) => entry.request === 'unknown' && entry.diagnostic?.httpStatus === 502)).toBe(true)
  expect(diagnosis.traces.flatMap(trace => trace.entries).every((entry: any) => entry.network === null)).toBe(true)
  expect(JSON.stringify(diagnosis)).not.toMatch(/pngDataUrl|base64|csrf|cookie|controlled-tenant-access|private-mote|https?:\/\//iu)
  const before = native.requests.length
  await f.click('View saved progress')
  await f.cli('inspect', { operationId: parentId })
  expect(native.requests).toHaveLength(before)
  expect(document.querySelector('[data-mote-profile-action="continue-profile-update"]')).toBeNull()
  expect(f.creationCount).toBe(1)
}, 30_000)

it('prioritizes an unknown original publication write over its otherwise readable review', async () => {
  await ready(); native.fail('/app_version/create/')
  await signIn()
  await vi.waitFor(() => {
    expect(currentStep()).toBe('4')
    expect(result().textContent).toContain('Publication result not confirmed')
  }, { timeout: 15_000 })
  expect(result().textContent).not.toContain('Profile updated, not published')
  expect(document.querySelector('[data-publication-unavailable]')?.textContent).toContain('The original publication result is unconfirmed')
  expect(document.querySelector('[data-mote-profile-action="continue-profile-update"]')).toBeNull()
  expect(document.querySelector('[data-mote-profile-action="refresh-publication-checks"]')).toBeNull()
  const setupId = document.querySelector('[data-console-profile-task]')!.getAttribute('data-console-profile-task')!
  for (const kind of ['read-publication-pending', 'read-publication-versions', 'read-publication-visibility', 'read-publication-sharing', 'read-publication-features'] as const) {
    const original = await f.client.call('connection.setup.inspect', { operationId: setupId, applicationInspection: {} })
    const action = original.applicationInspection!.actions.find(action => action.kind === kind)!
    expect(action, 'Independent current reads do not resolve an unknown publication write').toBeTruthy()
    await f.client.call('connection.setup.advance', { operationId: setupId, expectedRevision: action.expectedRevision, decision: { actionId: action.actionId, value: 'continue' } })
  }
  const view = await f.client.call('connection.setup.inspect', { operationId: setupId })
  expect(view.applicationConfiguration?.reason).toBe('original-effect-unconfirmed')
  if (view.applicationConfiguration?.effect !== 'create-application-version') throw new Error('Missing original publication review')
  expect(view.applicationConfiguration.review).not.toBeNull()
  const before = f.registration.mock.calls.length
  await f.click('View saved progress')
  await vi.waitFor(() => expect(savedProgressButton().getAttribute('aria-busy')).toBe('false'))
  expect(result().textContent).toContain('Publication result not confirmed')
  expect(f.registration.mock.calls).toHaveLength(before)
  expect(native.requests.filter(request => request.path.includes('/app_version/create/'))).toHaveLength(1)
  expect(native.requests.some(request => request.path.includes('/publish/commit/'))).toBe(false)
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
  expect(f.parentCalls.mock.calls.filter(([method]) => method === 'space.mote.connection.sync')).toHaveLength(1)
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
  expect(currentStep()).toBe('2')
  expect(result().textContent).toContain('Showing the last checked result. The latest check could not be completed.')
  expect(progress().textContent).not.toContain('Result unavailable')
  const before = native.requests.length
  const childId = document.querySelector('[data-console-profile-task]')!.getAttribute('data-console-profile-task')
  const mutations = f.parentCalls.mock.calls.filter(([method]) => method === 'space.mote.connection.sync' || method === 'space.mote.connection.advance').length
  await f.remount()
  await vi.waitFor(() => expect(document.querySelector('[data-console-profile-task]')?.getAttribute('data-console-profile-task')).toBe(childId))
  await vi.waitFor(() => expect(document.body.textContent).toContain('Controlled progress read failure'))
  expect(progress().querySelector('[data-step="2"]')?.getAttribute('data-state')).toBe('recorded')
  expect(currentStep()).toBeUndefined()
  expect(progress().textContent).toContain('progress is not available')
  expect(progress().querySelector('[data-step="3"]')?.textContent).toContain('Result unavailable')
  expect(progress().querySelector('[data-step="4"]')?.textContent).toContain('Result unavailable')
  expect(native.requests).toHaveLength(before)
  expect(f.parentCalls.mock.calls.filter(([method]) => method === 'space.mote.connection.sync' || method === 'space.mote.connection.advance')).toHaveLength(mutations)
}, 30_000)
