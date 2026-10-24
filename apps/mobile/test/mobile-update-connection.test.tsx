import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileConnectionRoot } from '../src/connection/MobileConnectionRoot'
import { DEVICE_WORKFACE_KEY, emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { createBrowserPlatform } from '../src/platform/browser'
import { deferred, mount, mounted } from './conversation-fixture'

const ports = vi.hoisted(() => ({ connect: vi.fn(), existing: vi.fn(), current: vi.fn(), apply: null as null | (() => Promise<any>) }))
vi.mock('@agentmux/core/relay-hosted', async original => ({ ...await original<object>(), connectRelayHostedClient: ports.connect }))
vi.mock('../src/connection/relay-identity', () => ({ deviceRelayIdentity: ports.current, existingDeviceRelayIdentity: ports.existing }))
vi.mock('../src/MobileApp', async () => {
  const { useMobileWebUpdateSafety } = await import('../src/mobile-web/update-safety')
  return { MobileApp: () => { ports.apply = useMobileWebUpdateSafety().apply; return null } }
})
const originalKey = { publicKey: new Uint8Array(32).fill(3), secretKey: new Uint8Array(32).fill(4) }
const offer = { v: 2 as const, serverId: 'original-host', daemonPublicKeyB64: 'A'.repeat(43) + '=', relay: { endpoint: '127.0.0.1:1', useTls: false } }
const platform = createBrowserPlatform()
let listeners: Set<(event: any) => void>
beforeEach(async () => {
  localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/'); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
  listeners = new Set()
  ports.current.mockResolvedValue(originalKey); ports.existing.mockResolvedValue(originalKey)
  ports.connect.mockResolvedValue({ onEvent: (listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener) }, dispose: vi.fn() })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, url: location.origin + '/mobile/new/' + 'a'.repeat(64) + '/index.html' })))
})
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks()
})
async function connectedRoot() {
  await mount(<MobileConnectionRoot platform={platform} native={false} offer={offer} />)
  await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.host?.hostId).toBe(offer.serverId))
}
it('checks the actual connected key and saved offer before navigating to the root', async () => {
  const navigate = vi.spyOn(location, 'assign').mockImplementation(() => {})
  await connectedRoot()
  expect(await ports.apply!()).toEqual({ status: 'navigating' })
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/#amux-update')
  ports.existing.mockResolvedValueOnce({ ...originalKey, secretKey: new Uint8Array(32).fill(9) })
  expect(await ports.apply!()).toMatchObject({ status: 'blocked' })
  expect(navigate).toHaveBeenCalledTimes(1)
})
it('retains the original page when the connected consumer is lost during entry preflight', async () => {
  await connectedRoot()
  const pending = deferred<any>(); vi.mocked(fetch).mockReturnValueOnce(pending.promise)
  const update = ports.apply!()
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  await act(async () => { for (const listener of listeners) listener({ type: 'connection-state', state: 'lost', observationOrigin: { kind: 'runtime-connection', boundary: 'consumer-core' } }) })
  pending.resolve({ ok: true, url: location.origin + '/mobile/new/' + 'a'.repeat(64) + '/index.html' })
  expect(await update).toMatchObject({ status: 'blocked', message: expect.stringContaining('连接') })
})
it('rechecks the original key after waiting for the entry response', async () => {
  const navigate = vi.spyOn(location, 'assign').mockImplementation(() => {})
  await connectedRoot()
  const pending = deferred<any>(); vi.mocked(fetch).mockReturnValueOnce(pending.promise)
  ports.existing.mockResolvedValueOnce(originalKey).mockResolvedValueOnce({ ...originalKey, secretKey: new Uint8Array(32).fill(8) })
  const update = ports.apply!()
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  pending.resolve({ ok: true, url: location.origin + '/mobile/new/' + 'a'.repeat(64) + '/index.html' })
  expect(await update).toMatchObject({ status: 'blocked' })
  expect(navigate).not.toHaveBeenCalled()
})
it('on a new document refuses a replaced identity, then reconnects the exact original key without generating a replacement', async () => {
  const navigate = vi.spyOn(location, 'assign').mockImplementation(() => {})
  await connectedRoot()
  expect(await ports.apply!()).toEqual({ status: 'navigating' })
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/#amux-update')
  const first = mounted.pop()!
  await act(async () => first.root.unmount()); first.element.remove()
  history.replaceState(null, '', '/mobile/new/' + 'a'.repeat(64) + '/index.html#amux-update')
  ports.existing.mockResolvedValue({ ...originalKey, secretKey: new Uint8Array(32).fill(7) })
  await mount(<MobileConnectionRoot platform={platform} native={false} offer={offer} />)
  await vi.waitFor(() => expect(ports.existing).toHaveBeenCalledTimes(3))
  expect(ports.connect).toHaveBeenCalledTimes(1)
  expect(ports.current).toHaveBeenCalledTimes(1)
  const second = mounted.pop()!
  await act(async () => second.root.unmount()); second.element.remove()
  ports.existing.mockResolvedValue(originalKey)
  await mount(<MobileConnectionRoot platform={platform} native={false} offer={offer} />)
  await vi.waitFor(() => expect(ports.connect).toHaveBeenCalledTimes(2))
  expect(ports.current).toHaveBeenCalledTimes(1)
  await vi.waitFor(() => expect(location.hash).toBe(''))
  expect(sessionStorage.getItem('agentmux.mobile-update.identity.v1')).toBeNull()
})
it('does not overwrite the original saved offer when the update handoff names another connection', async () => {
  vi.spyOn(location, 'assign').mockImplementation(() => {})
  await connectedRoot()
  expect(await ports.apply!()).toEqual({ status: 'navigating' })
  const savedOffer = localStorage.getItem('agentmux.connection-offer.v2')
  const first = mounted.pop()!; await act(async () => first.root.unmount()); first.element.remove()
  history.replaceState(null, '', '/mobile/new/' + 'a'.repeat(64) + '/index.html#amux-update')
  await mount(<MobileConnectionRoot platform={platform} native={false} offer={{ ...offer, relay: { endpoint: '127.0.0.1:2', useTls: false } }} />)
  await vi.waitFor(() => expect(ports.existing).toHaveBeenCalledTimes(3))
  expect(ports.connect).toHaveBeenCalledTimes(1)
  expect(localStorage.getItem('agentmux.connection-offer.v2')).toBe(savedOffer)
  expect(sessionStorage.getItem('agentmux.mobile-update.identity.v1')).not.toBeNull()
})
it('does not adopt a workface replaced by another page between the update and the new document', async () => {
  vi.spyOn(location, 'assign').mockImplementation(() => {})
  await connectedRoot()
  expect(await ports.apply!()).toEqual({ status: 'navigating' })
  const first = mounted.pop()!; await act(async () => first.root.unmount()); first.element.remove()
  await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
  history.replaceState(null, '', '/mobile/new/' + 'a'.repeat(64) + '/index.html#amux-update')
  await mount(<MobileConnectionRoot platform={platform} native={false} offer={offer} />)
  await vi.waitFor(() => expect(ports.existing).toHaveBeenCalledTimes(3))
  expect(ports.connect).toHaveBeenCalledTimes(1)
  expect(ports.current).toHaveBeenCalledTimes(1)
  expect(sessionStorage.getItem('agentmux.mobile-update.identity.v1')).not.toBeNull()
})
it('does not treat an unreadable workface as the original record during the update handoff', async () => {
  vi.spyOn(location, 'assign').mockImplementation(() => {})
  await connectedRoot()
  expect(await ports.apply!()).toEqual({ status: 'navigating' })
  const first = mounted.pop()!; await act(async () => first.root.unmount()); first.element.remove()
  history.replaceState(null, '', '/mobile/new/' + 'a'.repeat(64) + '/index.html#amux-update')
  const get = localStorage.getItem.bind(localStorage)
  vi.spyOn(localStorage, 'getItem').mockImplementation(key => { if (key === DEVICE_WORKFACE_KEY) throw new Error('unavailable'); return get(key) })
  await mount(<MobileConnectionRoot platform={platform} native={false} offer={offer} />)
  await vi.waitFor(() => expect(ports.existing).toHaveBeenCalledTimes(3))
  expect(ports.connect).toHaveBeenCalledTimes(1)
  expect(sessionStorage.getItem('agentmux.mobile-update.identity.v1')).not.toBeNull()
})
