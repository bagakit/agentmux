// @vitest-environment happy-dom
import { act } from 'react'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { moteBotUi } from './fixtures/mote-bot-ui'
import { enrollmentInitialWeb } from '../../../packages/connectors/test/fixtures/connection-enrollment-initial'
import iconUrl from '../resources/icon-512.png'

let f: Awaited<ReturnType<typeof moteBotUi>>
beforeEach(async () => { f = await moteBotUi() })
afterEach(async () => { await f?.close() })
async function click(selector: string) {
  let button!: HTMLButtonElement
  await vi.waitFor(() => { button = document.querySelector(selector)!; expect(button, selector + '\n' + document.body.textContent).not.toBeNull(); expect(button.disabled).toBe(false) }, { timeout: 6000 })
  await act(async () => button.click())
  await f.settle()
}
const progress = () => document.querySelector('[data-initial-setup-stage]')
async function native(options: Parameters<typeof enrollmentInitialWeb>[0]) {
  const web = enrollmentInitialWeb(options), asset = await readFile(resolve('apps/desktop/resources/icon-512.png'))
  vi.stubGlobal('fetch', vi.fn(async (input, init) => String(input) === iconUrl ? new Response(new Uint8Array(asset)) : web.fetch(input, init)))
  return web
}

it('uses the first saved Mote identity and shows the original configuration while its native write is pending', async () => {
  const web = await native({ name: 'Saved public name', description: 'Saved public summary.' })
  const fetch = globalThis.fetch
  let release!: () => void
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    if (String(input).includes('/event/switch/')) await new Promise<void>(resolve => { release = resolve })
    return fetch(input, init)
  }))
  await f.open(); await f.click('Create a bot for this Mote')
  await click('[data-mote-enrollment-action="confirm-account"]')
  await click('[data-mote-enrollment-action="create"]')
  try {
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await vi.waitFor(() => expect(progress()?.getAttribute('data-initial-setup-stage')).toBe('event-transport'), { timeout: 5000 })
    expect(progress()?.getAttribute('data-state')).toBe('running')
    expect(document.querySelector('[data-bot-setup-guide] [aria-current="step"]')?.getAttribute('data-step')).toBe('4')
    expect(document.body.textContent).not.toContain('Continue bot setup')
  } finally { release?.() }
  await vi.waitFor(() => expect(progress()?.getAttribute('data-state')).toBe('complete'), { timeout: 5000 })
  const input = f.parentCalls.mock.calls.find(([method]) => method === 'space.mote.connection.create')![1] as any
  const parent = (await f.client.call('space.mote.connection.inspect', { operationId: input.operationId })).operation!
  expect(parent.defaultLink.state).toBe('saved')
  expect(parent.profileOperationId).toBeNull(); expect(parent.profile).toBeNull()
  expect(parent.enrollment?.initialSetup?.progress?.state).toBe('complete')
  const creation = web.requests.filter(r => r.path.includes('/manifest/upsert_by_template'))
  expect(creation).toHaveLength(1)
  expect((creation[0]!.body as any).createAppUserCustomField.i18n.zh_cn).toEqual({ name: 'Saved public name', description: 'Saved public summary.' })
  expect(web.requests.filter(r => r.path.includes('/app/upload/image'))).toHaveLength(1)
  expect(web.requests.filter(r => r.path.includes('/publish/commit/'))).toHaveLength(1)
  expect(f.calls).toEqual([])
})

it('automatically configures the general AMUX identity through the same original Settings owner', async () => {
  const web = await native({ name: 'AMUX identity', description: 'Conversations with your agents in AMUX.' })
  await f.render(0, true); await f.click('Create a general identity')
  await vi.waitFor(() => expect(document.querySelector('[aria-label="New bot name"]')).not.toBeNull())
  await act(async () => { const field = document.querySelector<HTMLInputElement>('[aria-label="New bot name"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'AMUX identity'); field.dispatchEvent(new Event('input', { bubbles: true })) })
  await click('[data-enrollment-create]'); await click('[data-enrollment-action="confirm-account"]')
  await click('[data-enrollment-action="create"]')
  await vi.waitFor(() => expect(progress()?.getAttribute('data-state')).toBe('complete'), { timeout: 5000 })
  expect(document.body.textContent).not.toContain('Continue bot setup')
  expect(web.requests.filter(r => r.path.includes('/manifest/upsert_by_template'))).toHaveLength(1)
  expect(web.requests.filter(r => r.path.includes('/publish/commit/'))).toHaveLength(1)
  expect(f.calls).toEqual([])
})

it('keeps an unknown original configuration write and its exact setup when the user explicitly continues', async () => {
  const web = await native({ name: 'Saved public name', description: 'Saved public summary.', unknownEffect: '/event/switch/' })
  await f.open(); await f.click('Create a bot for this Mote')
  await click('[data-mote-enrollment-action="confirm-account"]'); await click('[data-mote-enrollment-action="create"]')
  await vi.waitFor(() => expect(progress()?.getAttribute('data-state')).toBe('attention'), { timeout: 5000 })
  const original = f.parentCalls.mock.calls.find(([method]) => method === 'space.mote.connection.create')![1] as any
  const before = (await f.client.call('space.mote.connection.inspect', { operationId: original.operationId })).operation!.enrollment!.initialSetup!
  const requests = [...web.requests]
  web.unblock()
  await click('[data-mote-enrollment-action="continue-setup"]')
  await vi.waitFor(() => expect(progress()?.getAttribute('data-state')).toBe('attention'))
  const after = (await f.client.call('space.mote.connection.inspect', { operationId: original.operationId })).operation!.enrollment!.initialSetup!
  expect(after.operationId).toBe(before.operationId)
  expect(web.requests).toEqual(requests)
  expect(web.requests.filter(r => r.path.includes('/event/switch/'))).toHaveLength(1)
  expect(web.requests.filter(r => r.path.includes('/manifest/upsert_by_template'))).toHaveLength(1)
})
