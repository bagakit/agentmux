import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createLocalDrafts } from '../src/conversation/local-drafts'
import { DEVICE_WORKFACE_KEY, DeviceWorkfaceStore, emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
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

it('refuses an old completed save after another reader replaces the device record', async () => {
  let raw: string | null = null
  const storage = { getItem: () => raw, setItem: (_: string, bytes: string) => { raw = bytes } }
  const owner = getDeviceWorkface(() => storage), other = new DeviceWorkfaceStore(() => storage)
  await owner.replaceBackup(emptyDeviceWorkface())
  const originalRecordId = owner.recordIdentity(), local = createLocalDrafts(() => storage)
  local.drafts.set(key, 'original reader body')
  local.attempts.set(key, unknown)
  const replacement = { ...emptyDeviceWorkface(), conversation: { version: 1 as const,
    drafts: [[key, 'imported body']] as Array<[string, string]>, attempts: [], responses: [] } }
  const internal = owner as unknown as { exclusive<T>(action: () => T): Promise<T> }
  const exclusive = internal.exclusive.bind(owner)
  internal.exclusive = async action => {
    const committed = await exclusive(action)
    await other.replaceBackup(replacement)
    return committed
  }
  try {
    expect(await local.save()).toBe(false)
    expect(local.recordChanged).toBe(true)
    expect(local.canSave).toBe(false)
    expect(local.drafts.get(key)).toBe('original reader body')
    expect(local.attempts.get(key)).toBe(unknown)
    const exported = JSON.parse(local.exportBackup()).workface
    expect(exported.recordId).toBe(originalRecordId)
    expect(exported.conversation.drafts).toEqual([[key, 'original reader body']])
    expect(exported.conversation.attempts).toEqual([[key, expect.objectContaining({ operationId: unknown.operationId, phase: 'unknown' })]])
    expect(await local.save()).toBe(false)
    expect(JSON.parse(raw!).conversation.drafts).toEqual([[key, 'imported body']])
  } finally { internal.exclusive = exclusive }
})

it('does not send from the mounted Mobile surface when import replaces the second admission save', async () => {
  const f = fixture(), owner = getDeviceWorkface(), other = new DeviceWorkfaceStore(() => localStorage)
  const platform = createBrowserPlatform(), copy = vi.spyOn(platform, 'copyText').mockResolvedValue(true)
  const view = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original"
    connection={{ state: 'connected', message: 'connected' }} platform={platform} />)
  const internal = owner as unknown as { exclusive<T>(action: () => T): Promise<T>; tail: Promise<unknown> }
  await paste(view.element, 'original reader body')
  await act(async () => { await internal.tail })
  const exclusive = internal.exclusive.bind(owner)
  let completed = 0
  internal.exclusive = async action => {
    const committed = await exclusive(action)
    // This is the last local admission write immediately before the public SDK call.
    if (++completed === 2) await other.replaceBackup({ ...emptyDeviceWorkface(), conversation: { version: 1,
      drafts: [[key, 'imported body']], attempts: [], responses: [] } })
    return committed
  }
  try {
    await click(button(view.element, 'Send'))
    await act(async () => { await internal.tail })
    expect(completed).toBe(2)
    expect(f.submit).not.toHaveBeenCalled()
    expect(editor(view.element).textContent).toBe('original reader body')
    expect(JSON.parse(localStorage.getItem(DEVICE_WORKFACE_KEY)!).conversation.drafts).toEqual([[key, 'imported body']])
    await click(button(view.element, '复制本页保全备份'))
    const exported = JSON.parse(copy.mock.calls.at(-1)![0]).workface.conversation
    expect(exported.drafts).toEqual([[key, 'original reader body']])
    expect(exported.attempts).toEqual([[key, expect.objectContaining({ draft: 'original reader body',
      inputRequested: true, request: expect.objectContaining({ condition: { expectedRun: { runId: 'run-original' }, afterSubmissionId: null } }) })]])
  } finally { internal.exclusive = exclusive }
})
