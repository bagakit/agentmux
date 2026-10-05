import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createLocalDrafts } from '../src/conversation/local-drafts'
import { DEVICE_WORKFACE_KEY, emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../src/platform/browser'
import { button, click, editor, fixture, mount, mounted, paste } from './conversation-fixture'

const key = JSON.stringify(['draft', 'session-original'])
const unknown = { operationId: 'original-unknown', runId: 'run-original', draft: 'original input', phase: 'unknown' as const,
  message: 'unknown', inputRequested: true }
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() } })

it('retries the second draft after its write fails without treating a pending projection as committed', async () => {
  let raw: string | null = null, writes = 0
  const storage = { getItem: () => raw, setItem: (_: string, bytes: string) => {
    if (++writes === 2) throw new Error('one quota failure')
    raw = bytes
  } }
  const local = createLocalDrafts(() => storage)
  local.attempts.set(key, unknown)
  local.drafts.set(key, 'first durable body'); const first = local.save()
  local.drafts.set(key, 'second unsaved body'); const second = local.save()
  await Promise.all([first, second])
  expect(local.drafts.get(key)).toBe('second unsaved body')
  expect(JSON.parse(raw!).conversation.drafts).toEqual([[key, 'first durable body']])
  expect(local.notice).toContain('尚未持久保存')
  expect(JSON.parse(local.exportBackup()).workface.conversation.attempts).toEqual([[key, expect.objectContaining({ operationId: unknown.operationId, phase: 'unknown' })]])
  await local.save()
  expect(local.drafts.get(key)).toBe('second unsaved body')
  expect(JSON.parse(raw!).conversation.drafts).toEqual([[key, 'second unsaved body']])
  expect(JSON.parse(raw!).conversation.attempts).toEqual([[key, expect.objectContaining({ operationId: unknown.operationId, phase: 'unknown' })]])
  expect(local.notice).toBeNull()
})

it('keeps the mounted Mobile editor text through a failed second save and an explicit save retry', async () => {
  const f = fixture(), owner = getDeviceWorkface()
  const internal = owner as unknown as { exclusive<T>(action: () => T): Promise<T>; tail: Promise<unknown> }
  const exclusive = internal.exclusive.bind(owner)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  internal.exclusive = action => gate.then(() => exclusive(action))
  const write = localStorage.setItem.bind(localStorage)
  let writes = 0
  vi.spyOn(localStorage, 'setItem').mockImplementation((name, bytes) => {
    if (name === DEVICE_WORKFACE_KEY && ++writes === 2) throw new Error('one quota failure')
    write(name, bytes)
  })
  try {
    const view = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original"
      connection={{ state: 'connected', message: 'connected' }} platform={createBrowserPlatform()} />)
    await paste(view.element, 'first body')
    await paste(view.element, ' second body')
    await act(async () => { release(); await internal.tail })
    expect(editor(view.element).textContent).toBe('first body second body')
    expect(JSON.parse(localStorage.getItem(DEVICE_WORKFACE_KEY)!).conversation.drafts).toEqual([[key, 'first body']])
    await click(button(view.element, '重试保存'))
    await act(async () => { await internal.tail })
    expect(editor(view.element).textContent).toBe('first body second body')
    expect(JSON.parse(localStorage.getItem(DEVICE_WORKFACE_KEY)!).conversation.drafts).toEqual([[key, 'first body second body']])
    expect(f.submit).not.toHaveBeenCalled()
  } finally { release(); internal.exclusive = exclusive }
})
