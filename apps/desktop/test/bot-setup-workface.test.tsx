// @vitest-environment happy-dom
import { act } from 'react'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { moteBotUi } from './fixtures/mote-bot-ui'
import { enrollmentInitialWeb } from '../../../packages/connectors/test/fixtures/connection-enrollment-initial'
import { api } from '../src/renderer/src/lib/api'
import iconUrl from '../resources/icon-512.png'

let f: Awaited<ReturnType<typeof moteBotUi>>, releasePending: (() => void) | null = null
beforeEach(async () => { f = await moteBotUi() })
afterEach(async () => { releasePending?.(); releasePending = null; await f?.close() })
const guide = () => document.querySelector('[data-bot-setup-guide]')
const progress = () => document.querySelector('[data-initial-setup-stage]')
const originalInput = () => f.parentCalls.mock.calls.find(([method]) => method === 'space.mote.connection.create')![1] as { operationId: string }
async function visible(selector: string) {
  await vi.waitFor(async () => { await f.settle(); expect(document.querySelector(selector), selector + '\n' + document.body.textContent).not.toBeNull() }, { timeout: 7000 })
  return document.querySelector<HTMLElement>(selector)!
}
async function click(selector: string) {
  const button = await visible(selector) as HTMLButtonElement
  await vi.waitFor(() => expect(button.disabled).toBe(false))
  await act(async () => button.click())
  await f.settle()
}
function unfolded(node: HTMLElement) {
  for (let parent = node.parentElement; parent; parent = parent.parentElement)
    if (parent instanceof HTMLDetailsElement) expect(parent.open, 'Primary action must be reachable without opening details').toBe(true)
}

it('keeps the original QR during a held sign-in and exposes safe diagnosis without advancing the unconfirmed result', async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve; releasePending = resolve })
  const native = f.registration.getMockImplementation()!
  let pollStarted = false
  f.registration.mockImplementation(async (url, input) => {
    if (new URL(String(url)).pathname === '/accounts/qrlogin/polling') {
      pollStarted = true
      await pending
      return Response.json({ code: 0, data: { next_step: 'unrecognized_machine_step', step_info: { status: 99 } } })
    }
    return native(url, input)
  })
  await f.open(); await click('[data-mote-bot-create]')
  const qr = await visible('[data-enrollment-code] svg')
  const id = originalInput().operationId
  const before = (await f.client.call('space.mote.connection.inspect', { operationId: id })).operation!
  try {
    await vi.waitFor(() => expect(pollStarted).toBe(true), { timeout: 5000 })
    await f.settle()
    expect(document.querySelector('[data-enrollment-code] svg')).toBe(qr)
    expect(guide()?.querySelectorAll('li')).toHaveLength(4)
    expect(guide()?.querySelector('[aria-current="step"]')?.getAttribute('data-step')).toBe('2')
    expect(f.creationCount).toBe(0)
  } finally { release() }
  await visible('[data-mote-enrollment-action="renew-authentication"]')
  expect(guide()?.querySelector('[data-step="4"]')?.getAttribute('data-state')).not.toBe('recorded')
  expect(document.querySelector('[data-mote-enrollment-action="create"]')).toBeNull()
  expect(document.body.textContent).not.toContain('Bot setup complete')
  const after = (await f.client.call('space.mote.connection.inspect', { operationId: id })).operation!
  expect(after.enrollment?.operationId).toBe(before.enrollment?.operationId)
  expect(after.enrollment?.authentication?.attemptId).toBe(before.enrollment?.authentication?.attemptId)
  expect(after.enrollment?.authentication?.stage).toBe('unknown')
  const trace = document.querySelector<HTMLDetailsElement>('[data-request-trace]')!
  expect(trace.open).toBe(false)
  const copy = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === 'Copy diagnosis')!
  expect(copy).toBeDefined(); unfolded(copy)
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const requests = f.registration.mock.calls.length
  const writes = f.parentCalls.mock.calls.filter(([method]) => method !== 'space.mote.connection.inspect' && method !== 'space.mote.connection.ls').length
  await act(async () => copy.click())
  await vi.waitFor(() => expect(clipboard).toHaveBeenCalledTimes(1))
  const report = clipboard.mock.calls[0]![0]
  expect(report).toContain(id)
  expect(report).toContain(after.enrollment!.operationId)
  expect(report).toContain('unknown')
  const journal = await f.client.call('connection.enrollment.inspect', { operationId: after.enrollment!.operationId, requestTrace: { limit: 100 } })
  expect(journal.requestTrace!.entries.length).toBeGreaterThan(0)
  for (const entry of journal.requestTrace!.entries) expect(report).toContain(entry.stepId)
  expect(report).not.toContain('private-mote-qr')
  expect(report).not.toContain('private-mote-flow')
  expect(f.registration.mock.calls).toHaveLength(requests)
  expect(f.parentCalls.mock.calls.filter(([method]) => method !== 'space.mote.connection.inspect' && method !== 'space.mote.connection.ls')).toHaveLength(writes)
  expect(f.beginCount).toBe(1); expect(f.creationCount).toBe(0)
}, 20_000)

it('holds the configuration result until the original write settles and then presents complete setup without a required refresh', async () => {
  const web = enrollmentInitialWeb({ name: 'Saved public name', description: 'Saved public summary.' })
  const image = await readFile(resolve('apps/desktop/resources/icon-512.png'))
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve; releasePending = resolve })
  let writeStarted = false
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    if (String(input) === iconUrl) return new Response(new Uint8Array(image))
    if (String(input).includes('/event/switch/')) { writeStarted = true; await pending }
    return web.fetch(input, init)
  }))
  await f.open(); await click('[data-mote-bot-create]')
  await click('[data-mote-enrollment-action="confirm-account"]')
  await click('[data-mote-enrollment-action="create"]')
  const id = originalInput().operationId
  try {
    await vi.waitFor(() => expect(writeStarted).toBe(true), { timeout: 5000 })
    await vi.waitFor(() => expect(progress()?.getAttribute('data-initial-setup-stage')).toBe('event-transport'), { timeout: 5000 })
    expect(progress()?.getAttribute('data-state')).toBe('running')
    expect(guide()?.querySelector('[aria-current="step"]')?.getAttribute('data-step')).toBe('4')
    expect(guide()?.querySelector('[data-step="4"]')?.getAttribute('data-state')).not.toBe('recorded')
    expect(document.body.textContent).not.toContain('Bot setup complete')
    expect(document.body.textContent).not.toContain('Continue bot setup')
  } finally { release() }
  await vi.waitFor(() => expect(document.querySelector('.mote-bot-task__content')?.textContent).toContain('Bot setup complete'), { timeout: 6000 })
  await vi.waitFor(() => expect(guide()?.querySelector('[aria-current="step"]')).toBeNull())
  expect(guide()?.querySelector('[data-step="4"]')?.getAttribute('data-state')).toBe('recorded')
  const refresh = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === 'Check saved progress')!
  expect(refresh).toBeDefined()
  expect(refresh.classList.contains('primary-button')).toBe(false)
  expect(document.body.textContent).toContain('Message delivery')
  const before = [...web.requests]
  await act(async () => refresh.click())
  await f.settle()
  expect(guide()?.querySelector('[aria-current="step"]')).toBeNull()
  expect(web.requests).toEqual(before)
  const original = (await f.client.call('space.mote.connection.inspect', { operationId: id })).operation!
  expect(original.defaultLink.state).toBe('saved')
  expect(original.enrollment?.initialSetup?.progress?.state).toBe('complete')
  expect(web.requests.filter(request => request.path.includes('/manifest/upsert_by_template'))).toHaveLength(1)
  expect(web.requests.filter(request => request.path.includes('/publish/commit/'))).toHaveLength(1)
  expect(f.calls).toEqual([])
}, 20_000)
