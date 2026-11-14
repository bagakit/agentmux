// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { moteBotUi } from './fixtures/mote-bot-ui'
import { confirmAndCreateMote } from './fixtures/mote-connection-owner'
import { moteProfileWeb } from './fixtures/mote-profile-web'
import { registerWorkbenchDocument } from '../src/renderer/src/lib/workbench-window-registry'

let f: Awaited<ReturnType<typeof moteBotUi>>, releaseDocument: () => void
const releases: Array<() => void> = []
beforeEach(() => { releaseDocument = registerWorkbenchDocument(document, { windowId: 'settings-test', documentGeneration: 'settings-document' }) })
afterEach(async () => {
  for (const release of releases.splice(0)) await act(async () => release())
  try { await f?.close() } finally { releaseDocument() }
})
const polling = (url: unknown) => new URL(String(url)).pathname === '/accounts/qrlogin/polling'
const creates = () => f.parentCalls.mock.calls.filter(([method]) => method === 'space.mote.connection.create')
const advances = () => f.parentCalls.mock.calls.filter(([method]) => method === 'space.mote.connection.advance')
const qr = () => document.querySelector('[data-mote-bot-code] svg, [data-mote-profile-code] svg')
const origin = () => ({ section: 'lark' as const, moteConnectionOrigin: { target: f.target(), topicId: f.motes[0]!.id, moteName: f.scopes[0]!.topic.title, hostingTarget: f.hostingTarget } })
async function pause(milliseconds = 1250) { await act(async () => { await new Promise(resolve => setTimeout(resolve, milliseconds)) }) }
async function ready(selector: string) { await vi.waitFor(async () => { await f.settle(); expect(document.querySelector(selector), selector).not.toBeNull() }, { timeout: 6000 }) }
async function selectSection(id: string) { await act(async () => (document.querySelector(`.settings-sidebar [data-settings-target="${id}"]`) as HTMLElement).click()); await f.settle() }
async function editName(value: string) {
  await f.click('Bot name source')
  await act(async () => (document.querySelector('[role="menuitemradio"][data-value="manual"]') as HTMLElement).click())
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Bot name"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it.each(['settings', 'section', 'document'] as const)('releases authentication on %s exit, keeps the draft and resumes only the same explicit operation', async boundary => {
  f = await moteBotUi()
  const forward = f.registration.getMockImplementation()!
  f.registration.mockImplementation(async (url, input) => polling(url)
    ? Response.json({ code: 0, data: { next_step: 'qr_login_polling', step_info: { status: 0 } } }) : forward(url, input))
  const request = origin(), visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const leave = async () => {
    if (boundary === 'settings') await f.renderSettings(request, false)
    else if (boundary === 'section') await selectSection('general')
    else { visibility.mockReturnValue('hidden'); await act(async () => document.dispatchEvent(new Event('visibilitychange'))) }
  }
  const restore = async () => {
    if (boundary === 'settings') await f.renderSettings(request)
    else if (boundary === 'section') await selectSection('lark')
    else { visibility.mockReturnValue('visible'); await act(async () => document.dispatchEvent(new Event('visibilitychange'))) }
  }
  await f.renderSettings(request)
  await ready('input[aria-label="Bot name"]')
  await editName('Draft bot name')
  const panel = document.querySelector('[data-mote-identity-panel]'), name = document.querySelector<HTMLInputElement>('input[aria-label="Bot name"]')!
  await leave(); await restore()
  expect(document.querySelector('[data-mote-identity-panel]')).toBe(panel)
  expect(document.querySelector('input[aria-label="Bot name"]')).toBe(name)
  expect(name.value).toBe('Draft bot name')

  await f.click('Sign in & continue')
  await ready('[data-mote-bot-code] svg')
  expect(creates()).toHaveLength(1)
  const id = (creates()[0]![1] as { operationId: string }).operationId
  expect(creates()[0]![1]).toMatchObject({ desired: { name: 'Draft bot name' } })
  await leave()
  expect(qr()).toBeNull()
  const polls = f.registration.mock.calls.filter(([url]) => polling(url)).length, count = advances().length
  await pause()
  expect(f.registration.mock.calls.filter(([url]) => polling(url))).toHaveLength(polls)
  expect(advances()).toHaveLength(count)
  await restore(); await pause()
  expect(qr()).toBeNull()
  expect(document.querySelector('[data-mote-identity-panel]')).toBe(panel)
  expect(document.body.textContent).toContain(id)
  expect(advances()).toHaveLength(count)
  expect(creates()).toHaveLength(1)
  expect(f.beginCount).toBe(1)

  await f.click('Check saved progress')
  await ready('[data-mote-bot-code] svg')
  expect(advances()).toHaveLength(count)
  await f.click('Check sign-in')
  expect(advances()).toHaveLength(count + 1)
  expect(advances().at(-1)![1]).toMatchObject({ operationId: id })
  expect(creates()).toHaveLength(1)
  expect(f.beginCount).toBe(1)
}, 20_000)

it('does not let a late original create acknowledgement reopen its private sign-in after leaving and returning', async () => {
  f = await moteBotUi()
  let release!: () => void, reached = false
  const held = new Promise<void>(resolve => { release = resolve }); releases.push(release)
  f.parentCalls.mockImplementation(async (method, input, target) => {
    const value = await f.forward(method, input, target)
    if (method === 'space.mote.connection.create') { reached = true; await held }
    return value
  })
  const request = origin()
  await f.renderSettings(request)
  await f.click('Sign in & continue')
  await vi.waitFor(() => expect(reached).toBe(true))
  expect(creates()).toHaveLength(1)
  const id = (creates()[0]![1] as { operationId: string }).operationId
  await f.renderSettings(request, false)
  await f.renderSettings(request)
  await act(async () => release())
  await f.settle()
  expect(qr()).toBeNull()
  expect(f.connectionCalls.mock.calls.filter(([method]) => method === 'connection.enrollment.inspect')).toEqual([])
  expect(creates()).toHaveLength(1)
  expect(advances()).toEqual([])
  expect(f.beginCount).toBe(1)
  expect(document.body.textContent).toContain(id)
  await f.click('Check saved progress')
  await ready('[data-mote-bot-code] svg')
  expect(creates()).toHaveLength(1)
  expect(advances()).toEqual([])
}, 15_000)

it('does not open a late profile task private reader after leaving and returning', async () => {
  f = await moteBotUi({ native: moteProfileWeb() })
  const original = await f.input('late-profile-source')
  await f.client.call('space.mote.connection.create', original)
  await confirmAndCreateMote(f, original.operationId)
  let release!: () => void, reached = false
  const held = new Promise<void>(resolve => { release = resolve }); releases.push(release)
  f.parentCalls.mockImplementation(async (method, input, target) => {
    const value = await f.forward(method, input, target)
    if (method === 'space.mote.connection.sync') { reached = true; await held }
    return value
  })
  const request = origin()
  await f.renderSettings(request)
  await f.click('Sync Mote profile')
  await vi.waitFor(() => expect(reached).toBe(true))
  const id = (f.parentCalls.mock.calls.find(([method]) => method === 'space.mote.connection.sync')![1] as { operationId: string }).operationId
  await f.renderSettings(request, false)
  await f.renderSettings(request)
  await act(async () => release())
  await pause(100)
  expect(qr()).toBeNull()
  expect(f.connectionCalls.mock.calls.filter(([method]) => method === 'connection.setup.inspect')).toEqual([])
  expect(advances()).toEqual([])
  expect(f.parentCalls.mock.calls.filter(([method]) => method === 'space.mote.connection.sync')).toHaveLength(1)
  expect(f.beginCount).toBe(2)
  const saved = (await f.client.call('space.mote.connection.inspect', { operationId: id })).operation!
  expect(saved.operationId).toBe(id)
  expect(document.querySelector('[data-console-profile-task]')?.getAttribute('data-console-profile-task')).toBe(saved.setupOperationId)
  await f.click('View saved progress')
  await ready('[data-mote-profile-code] svg')
  expect(document.querySelector('[data-console-profile-task]')?.getAttribute('data-console-profile-task')).toBe(saved.setupOperationId)
  expect(advances()).toEqual([])
}, 15_000)

it('releases a pending profile authentication observer without cancelling its original write or restoring the private view', async () => {
  const native = moteProfileWeb()
  f = await moteBotUi({ native })
  const original = await f.input('original-profile-source')
  await f.client.call('space.mote.connection.create', original)
  await confirmAndCreateMote(f, original.operationId)
  const forward = f.registration.getMockImplementation()!
  let release!: () => void, reached = false, polls = 0
  const held = new Promise<void>(resolve => { release = resolve }); releases.push(release)
  f.registration.mockImplementation(async (url, input) => {
    if (polling(url)) {
      polls++
      if (polls === 2) { reached = true; await held }
      if (polls <= 2) return Response.json({ code: 0, data: { next_step: 'qr_login_polling', step_info: { status: 0 } } })
    }
    return forward(url, input)
  })
  const request = origin()
  await f.renderSettings(request)
  await f.click('Sync Mote profile')
  await ready('[data-mote-profile-code] svg')
  const syncId = (f.parentCalls.mock.calls.find(([method]) => method === 'space.mote.connection.sync')![1] as { operationId: string }).operationId
  const panel = document.querySelector('[data-console-profile-task]'), id = panel!.getAttribute('data-console-profile-task')
  await vi.waitFor(() => expect(reached).toBe(true), { timeout: 6000 })
  await f.settle()
  const visibleReads = f.connectionCalls.mock.calls.filter(([method]) => method === 'connection.setup.inspect').length, originalQr = qr()
  await pause()
  expect(f.connectionCalls.mock.calls.filter(([method]) => method === 'connection.setup.inspect').length).toBeGreaterThan(visibleReads)
  expect(qr()).toBe(originalQr)
  await f.renderSettings(request, false)
  expect(qr()).toBeNull()
  const reads = f.connectionCalls.mock.calls.filter(([method]) => method === 'connection.setup.inspect').length, count = advances().length
  await pause()
  expect(f.connectionCalls.mock.calls.filter(([method]) => method === 'connection.setup.inspect')).toHaveLength(reads)
  expect(advances()).toHaveLength(count)
  await f.renderSettings(request)
  await pause()
  expect(qr()).toBeNull()
  expect(f.connectionCalls.mock.calls.filter(([method]) => method === 'connection.setup.inspect')).toHaveLength(reads)
  expect(document.querySelector('[data-console-profile-task]')).toBe(panel)
  await act(async () => release())
  await vi.waitFor(() => expect(panel!.querySelector('[data-profile-activity]')?.getAttribute('data-working')).toBe('false'))
  expect(qr()).toBeNull()
  expect(advances()).toHaveLength(count)
  expect(f.parentCalls.mock.calls.filter(([method]) => method === 'space.mote.connection.sync')).toHaveLength(1)
  expect(f.creationCount).toBe(1)
  await f.click('View saved progress')
  await ready('[data-mote-profile-code] svg')
  expect(document.querySelector('[data-console-profile-task]')?.getAttribute('data-console-profile-task')).toBe(id)
  expect(advances()).toHaveLength(count)
  await f.click('Continue sign-in')
  await ready('[data-mote-profile-action="confirm-account"]')
  expect(advances().at(-1)![1]).toMatchObject({ operationId: syncId, setup: { operationId: id } })
  expect(f.parentCalls.mock.calls.filter(([method]) => method === 'space.mote.connection.sync')).toHaveLength(1)
  expect(f.beginCount).toBe(2)
}, 20_000)
