// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { moteBotUi } from './fixtures/mote-bot-ui'

let f: Awaited<ReturnType<typeof moteBotUi>>
beforeEach(async () => { f = await moteBotUi() })
afterEach(async () => { await f?.close() })
const field = () => document.querySelector<HTMLInputElement>('[aria-label="Bot name"]')!
async function ready() { await f.open(); await vi.waitFor(() => expect(field()?.value).toBe('Saved public name')) }
async function source(label: string) {
  await f.click('Bot name source')
  const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(n => n.textContent?.trim() === label)!
  expect(option).toBeTruthy()
  await act(async () => { option.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', buttons: 1 })); option.click() })
  await f.settle()
}
async function type(value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), value); field().dispatchEvent(new Event('input', { bubbles: true })) })
}

it('defaults to the exact Mote source and preserves an edited manual draft through source switches and refresh', async () => {
  await ready()
  expect(field().readOnly).toBe(true)
  expect(f.beginCount).toBe(0)
  await source('Enter manually')
  expect(field().readOnly).toBe(false)
  expect(field().value).toMatch(/^AMUX-[0-9A-F]{8}$/)
  await type('My conversation bot')
  const input = field()
  await f.click('Refresh saved profile')
  await vi.waitFor(() => expect(field().value).toBe('My conversation bot'))
  expect(field()).toBe(input)
  await source('Use Mote name')
  expect(field().value).toBe('Saved public name')
  expect(field().readOnly).toBe(true)
  await source('Enter manually')
  expect(field().value).toBe('My conversation bot')
  expect(f.beginCount).toBe(0)
  expect(f.creationCount).toBe(0)
})

it('freezes the explicit manual name through the actual Renderer, IPC, public parent and original enrollment', async () => {
  await ready(); await source('Enter manually'); await type('AMUX-USER-CHOICE')
  const before = await readFile(join(f.motes[0]!.directory, 'topic.md'), 'utf8')
  await f.click('Create a bot for this Mote')
  await vi.waitFor(() => expect(f.parentCalls.mock.calls.some(([method]) => method === 'space.mote.connection.create')).toBe(true))
  const input = f.parentCalls.mock.calls.find(([method]) => method === 'space.mote.connection.create')![1] as any
  expect(input.name).toBe('AMUX-USER-CHOICE')
  await vi.waitFor(async () => {
    const result = (await f.client.call('space.mote.connection.inspect', { operationId: input.operationId })).operation!
    expect(result.snapshot.name).toBe(input.name)
    expect(result.enrollment?.preset?.name).toBe(input.name)
    expect(result.enrollment?.label).toBe(input.name)
  })
  expect(await readFile(join(f.motes[0]!.directory, 'topic.md'), 'utf8')).toBe(before)
  expect(f.creationCount).toBe(0)
  await vi.waitFor(() => expect(document.querySelector('[data-mote-bot-code]'), document.body.textContent).not.toBeNull())
})

it('keeps an empty manual draft editable without dispatching a new original request', async () => {
  await ready(); await source('Enter manually'); await type('   ')
  expect(document.querySelector<HTMLButtonElement>('[data-mote-bot-create]')!.disabled).toBe(true)
  expect(field().value).toBe('   ')
  expect(f.beginCount).toBe(0)
  await source('Use Mote name')
  expect(document.querySelector<HTMLButtonElement>('[data-mote-bot-create]')!.disabled).toBe(false)
})
