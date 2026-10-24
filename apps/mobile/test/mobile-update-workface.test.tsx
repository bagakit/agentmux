import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileConnectionRoot } from '../src/connection/MobileConnectionRoot'
import { prepareReloadIdentity, reloadOfferIdentity } from '../src/connection/reload-identity'
import { DEVICE_WORKFACE_KEY, emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { createBrowserPlatform } from '../src/platform/browser'
import { button, click, mount, mounted } from './conversation-fixture'

const ports = vi.hoisted(() => ({ connect: vi.fn(), existing: vi.fn() }))
vi.mock('@agentmux/core/relay-hosted', async original => ({ ...await original<object>(), connectRelayHostedClient: ports.connect }))
vi.mock('../src/connection/relay-identity', () => ({ deviceRelayIdentity: vi.fn(), existingDeviceRelayIdentity: ports.existing }))
const identity = { publicKey: new Uint8Array(32).fill(2), secretKey: new Uint8Array(32).fill(7) }
const offer = { v: 2 as const, serverId: 'original-host', daemonPublicKeyB64: 'A'.repeat(43) + '=', relay: { endpoint: '127.0.0.1:1', useTls: false } }
beforeEach(async () => { localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/'); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }; vi.restoreAllMocks(); vi.clearAllMocks() })

it('keeps the real MobileApp unmounted when another page replaced the original workface', async () => {
  const owner = getDeviceWorkface(), host = { origin: location.origin, hostId: offer.serverId }
  await owner.replaceBackup({ ...emptyDeviceWorkface(), host, selectedSessionId: 'original-session' })
  prepareReloadIdentity(identity, reloadOfferIdentity(offer), owner.recordIdentity())
  await owner.replaceBackup({ ...emptyDeviceWorkface(), host, selectedSessionId: 'replacement-session' })
  localStorage.setItem('agentmux.connection-offer.v2', JSON.stringify(offer))
  history.replaceState(null, '', '/mobile/new/' + 'a'.repeat(64) + '/index.html#amux-update')
  ports.existing.mockResolvedValue(identity)
  const view = await mount(<MobileConnectionRoot platform={createBrowserPlatform()} native={false} />)
  await vi.waitFor(() => expect(view.element.textContent).toContain('重新检查原连接'))
  expect(view.element.textContent).toContain('返回上一页')
  expect(view.element.textContent).not.toContain('replacement-session')
  expect(view.element.querySelector('.mobile-conversation')).toBeNull()
  expect(ports.connect).not.toHaveBeenCalled()
  expect(sessionStorage.getItem('agentmux.mobile-update.identity.v1')).not.toBeNull()
})

it('shows the original offline conversation and device draft after matching the local handoff', async () => {
  const owner = getDeviceWorkface(), host = { origin: location.origin, hostId: offer.serverId }
  await owner.replaceBackup({ ...emptyDeviceWorkface(), host, selectedSessionId: 'original-session',
    conversation: { version: 1, drafts: [[JSON.stringify(['draft', 'original-session']), 'original offline draft']], attempts: [], responses: [] } })
  prepareReloadIdentity(identity, reloadOfferIdentity(offer), owner.recordIdentity())
  localStorage.setItem('agentmux.connection-offer.v2', JSON.stringify(offer))
  history.replaceState(null, '', '/mobile/new/' + 'a'.repeat(64) + '/index.html#amux-update')
  ports.existing.mockResolvedValue(identity); ports.connect.mockRejectedValue(new Error('original Host offline'))
  const view = await mount(<MobileConnectionRoot platform={createBrowserPlatform()} native={false} />)
  await vi.waitFor(() => expect(ports.connect).toHaveBeenCalled())
  await vi.waitFor(() => expect(view.element.querySelector('.mobile-app')).not.toBeNull())
  expect(view.element.textContent).toContain('暂时无法连接')
  expect(view.element.querySelector('[contenteditable="true"]')?.textContent).toContain('original offline draft')
  expect(view.element.textContent).not.toContain('重新检查原连接')
  const original = mounted.pop()!
  await act(async () => original.root.unmount())
  original.element.remove()
})

it('revalidates the original workface after waiting for the actual cross-page write lock', async () => {
  const owner = getDeviceWorkface(), host = { origin: location.origin, hostId: offer.serverId }
  await owner.replaceBackup({ ...emptyDeviceWorkface(), host, selectedSessionId: 'original-session' })
  prepareReloadIdentity(identity, reloadOfferIdentity(offer), owner.recordIdentity())
  localStorage.setItem('agentmux.connection-offer.v2', JSON.stringify(offer))
  history.replaceState(null, '', '/mobile/new/' + 'a'.repeat(64) + '/index.html#amux-update')
  ports.existing.mockResolvedValue(identity)
  const open = indexedDB.open.bind(indexedDB); let release: (() => void) | undefined, delayed = false
  vi.spyOn(indexedDB, 'open').mockImplementation(((name: string, version?: number) => {
    if (name !== 'agentmux-device-workface-write-lock' || delayed || document.querySelector('.mobile-app')) return open(name, version)
    delayed = true
    const pending: any = {}
    release = () => {
      const real = open(name, version)
      real.onupgradeneeded = event => pending.onupgradeneeded?.(event)
      real.onsuccess = () => { pending.result = real.result; pending.onsuccess?.() }
      real.onerror = () => { pending.error = real.error; pending.onerror?.() }
    }
    return pending
  }) as typeof indexedDB.open)
  const view = await mount(<MobileConnectionRoot platform={createBrowserPlatform()} native={false} />)
  await vi.waitFor(() => expect(release).toBeDefined())
  await owner.replaceBackup({ ...emptyDeviceWorkface(), host, selectedSessionId: 'replacement-session' })
  await act(async () => { release!() })
  await vi.waitFor(() => expect(view.element.textContent).toContain('原工作面在重新打开期间发生变化'))
  expect(view.element.querySelector('.mobile-app')).toBeNull()
  expect(ports.connect).not.toHaveBeenCalled()
})

it('renders the original draft when a competing page tries to replace the record during the first read', async () => {
  const owner = getDeviceWorkface(), host = { origin: location.origin, hostId: offer.serverId }
  const workface = (session: string, body: string) => ({ ...emptyDeviceWorkface(), host, selectedSessionId: session,
    conversation: { version: 1 as const, drafts: [[JSON.stringify(['draft', session]), body] as [string, string]], attempts: [], responses: [] } })
  await owner.replaceBackup(workface('original-session', 'original retained draft'))
  const original = localStorage.getItem(DEVICE_WORKFACE_KEY)!
  prepareReloadIdentity(identity, reloadOfferIdentity(offer), owner.recordIdentity())
  await owner.replaceBackup(workface('replacement-session', 'replacement draft'))
  const replacement = localStorage.getItem(DEVICE_WORKFACE_KEY)!
  localStorage.setItem(DEVICE_WORKFACE_KEY, original)
  localStorage.setItem('agentmux.connection-offer.v2', JSON.stringify(offer))
  history.replaceState(null, '', '/mobile/new/' + 'a'.repeat(64) + '/index.html#amux-update')
  ports.existing.mockResolvedValue(identity); ports.connect.mockReturnValue(new Promise(() => {}))
  const open = indexedDB.open.bind(indexedDB); let lockRequested = false, markerReads = 0
  vi.spyOn(indexedDB, 'open').mockImplementation(((name: string, version?: number) => {
    if (name === 'agentmux-device-workface-write-lock') lockRequested = true
    return open(name, version)
  }) as typeof indexedDB.open)
  const readMarker = sessionStorage.getItem.bind(sessionStorage)
  vi.spyOn(sessionStorage, 'getItem').mockImplementation(key => {
    const result = readMarker(key)
    if (key === 'agentmux.mobile-update.identity.v1' && ++markerReads === 2) {
      // Model another cooperating page: it can write now only if this page did
      // not acquire the shared lock; otherwise its write follows this callback.
      const replace = () => localStorage.setItem(DEVICE_WORKFACE_KEY, replacement)
      if (lockRequested) queueMicrotask(replace); else replace()
    }
    return result
  })
  const view = await mount(<MobileConnectionRoot platform={createBrowserPlatform()} native={false} />)
  await vi.waitFor(() => expect(view.element.querySelector('[contenteditable="true"]')).not.toBeNull())
  expect(view.element.querySelector('[contenteditable="true"]')?.textContent).toContain('original retained draft')
  expect(view.element.querySelector('[contenteditable="true"]')?.textContent).not.toContain('replacement draft')
})

it('retries the original handoff after an initialization failure is repaired', async () => {
  const owner = getDeviceWorkface(), host = { origin: location.origin, hostId: offer.serverId }
  await owner.replaceBackup({ ...emptyDeviceWorkface(), host, selectedSessionId: 'original-session' })
  prepareReloadIdentity(identity, reloadOfferIdentity(offer), owner.recordIdentity())
  localStorage.setItem('agentmux.connection-offer.v2', 'invalid')
  history.replaceState(null, '', '/mobile/new/' + 'a'.repeat(64) + '/index.html#amux-update')
  ports.existing.mockResolvedValue(identity); ports.connect.mockRejectedValue(new Error('Host offline'))
  const view = await mount(<MobileConnectionRoot platform={createBrowserPlatform()} native={false} />)
  await vi.waitFor(() => expect(view.element.textContent).toContain('重新检查原连接'))
  expect(view.element.textContent).toContain('原 Mac 连接记录无法完整读取')
  expect(ports.existing).not.toHaveBeenCalled()
  localStorage.setItem('agentmux.connection-offer.v2', JSON.stringify(offer))
  await click(button(view.element, '重新检查原连接'))
  await vi.waitFor(() => expect(ports.connect).toHaveBeenCalledOnce())
  expect(view.element.querySelector('.mobile-app')).not.toBeNull()
  expect(sessionStorage.getItem('agentmux.mobile-update.identity.v1')).not.toBeNull()
})
