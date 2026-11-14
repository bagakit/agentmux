// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectionLinkUrl, CONNECTION_METADATA_PATH, type ConnectionOffer } from '@agentmux/relay/offer'
import { generateKeyPair } from '@agentmux/relay/e2ee'
import { fixture } from './conversation-fixture'
import { mobileAssetNamespace } from '@agentmux/core/mobile-web-codec'
const ports = vi.hoisted(() => ({ connect: vi.fn(), roots: [] as Root[], pair: null as ReturnType<typeof generateKeyPair> | null }))
vi.mock('@agentmux/core/relay-hosted', async original => ({ ...await original<object>(), connectRelayHostedClient: ports.connect }))
vi.mock('../src/connection/relay-identity', () => ({ deviceRelayIdentity: async () => ports.pair!, existingDeviceRelayIdentity: async () => ports.pair }))
vi.mock('@capacitor/core', async original => ({ ...await original<object>(), Capacitor: { isNativePlatform: () => false } }))
vi.mock('../src/platform/native/device', async original => ({ ...await original<object>(), createNativePlatform: () => { throw Error('Web entry uses its original browser platform') } }))
vi.mock('react-dom/client', async original => {
  const actual = await original<typeof import('react-dom/client')>()
  return { ...actual, createRoot: (...args: Parameters<typeof actual.createRoot>) => { const root = actual.createRoot(...args); ports.roots.push(root); return root } }
})
const OFFER = 'agentmux.connection-offer.v2'
const offer = (): ConnectionOffer => ({ v: 2, serverId: 'host-original', daemonPublicKeyB64: Buffer.alloc(32,7).toString('base64'), relay: { endpoint: location.host, useTls: location.protocol === 'https:' } })
function response(value: unknown, origin = location.origin) { const result = new Response(JSON.stringify(value), { status: 200 }); Object.defineProperty(result, 'url', { value: origin + CONNECTION_METADATA_PATH }); return result }
async function entry(url: string) { document.body.innerHTML = '<div id="root"></div><div id="mobile-overlays"></div>'; history.replaceState(null, '', url); await act(async () => { await import('../src/main') }) }
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 5000, interval: 10 }) }
async function openConnectionDetails() {
  await wait(() => expect(document.querySelector('.mobile-settings-button')).not.toBeNull())
  await act(async () => document.querySelector<HTMLButtonElement>('.mobile-settings-button')!.click())
  const drawer = document.querySelector<HTMLButtonElement>('.mobile-drawer-connection')
  if (drawer) await act(async () => drawer.click())
}
beforeEach(async () => {
  vi.resetModules(); localStorage.clear(); ports.pair = generateKeyPair(); ports.connect.mockReset()
  const { getDeviceWorkface, emptyDeviceWorkface } = await import('../src/recovery/device-workface'); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
})
afterEach(async () => { await act(async () => { for (const root of ports.roots.splice(0)) root.unmount() }); await act(async () => vi.dynamicImportSettled()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); history.replaceState(null, '', '/') })
function client() { const f = fixture(); f.client.forwardRpc = vi.fn(async method => method === 'space.ls' ? { catalog: { spaces: [], zones: [], tabs: [], regions: [], locations: [], bindings: [], agentPresentation: [] } } : { unavailable: [], agents: [] }) as typeof f.client.forwardRpc; f.client.dispose = vi.fn(async () => {}); return f }

it('actual main paints the original connection page while explicit pin metadata is held, then saves only its confirmed full offer', async () => {
  const original = offer(), f = client(); let release!: (value: Response) => void
  const read = vi.fn(() => new Promise<Response>(resolve => { release = resolve })); vi.stubGlobal('fetch', read); ports.connect.mockResolvedValue(f.client)
  const digest = 'sha256:' + '7'.repeat(64)
  await entry(connectionLinkUrl(location.origin + mobileAssetNamespace(digest), original))
  await wait(() => expect(document.querySelector('.mobile-connect-page')).not.toBeNull())
  expect(document.querySelector('.mobile-connect-page')).not.toBeNull(); expect(document.querySelector('.mobile-connect-dragon')).not.toBeNull()
  expect(document.body.textContent).toContain('正在读取连接'); expect(read).toHaveBeenCalledTimes(1); expect(ports.connect).not.toHaveBeenCalled(); expect(localStorage.getItem(OFFER)).toBeNull()
  await act(async () => release(response(original)))
  await wait(() => expect(localStorage.getItem(OFFER)).toBe(JSON.stringify(original)))
  expect(ports.connect).toHaveBeenCalledTimes(1); expect(ports.connect.mock.calls[0]![0].offer).toEqual(original)
  await wait(() => expect(vi.mocked(f.client.forwardRpc!).mock.calls.some(([method]) => method === 'app.mobile.assets.loaded')).toBe(true))
  expect(vi.mocked(f.client.forwardRpc!).mock.calls.find(([method]) => method === 'app.mobile.assets.loaded')![1]).toMatchObject({ namespaceDigest: digest, buildId: 'short-page-build' })
  expect(location.hash).toBe(''); expect(read).toHaveBeenCalledTimes(1); expect(f.submit).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
})

it.each(['other key', 'other relay', 'cross origin', 'B', 'BQ'] as const)('actual main refuses explicit %s without borrowing its saved Mac or changing its draft', async variant => {
  const original = offer(), saved = JSON.stringify(original), { getDeviceWorkface } = await import('../src/recovery/device-workface')
  localStorage.setItem(OFFER, saved); await getDeviceWorkface().updateNavigation({ selectedSessionId: 'session-original', panel: 'conversation', hostUrl: '' })
  const record = getDeviceWorkface().recordIdentity()
  let changed = original
  if (variant === 'other key') changed = { ...original, daemonPublicKeyB64: Buffer.alloc(32,8).toString('base64') }
  if (variant === 'other relay') changed = { ...original, relay: { ...original.relay, endpoint: '10.0.0.8:8443' } }
  const read = vi.fn(async () => response(changed, variant === 'cross origin' ? 'http://10.0.0.9:8443' : location.origin)); vi.stubGlobal('fetch', read)
  const url = variant === 'B' || variant === 'BQ' ? location.origin + '/#' + variant : connectionLinkUrl(location.origin + '/', original)
  await entry(url)
  await openConnectionDetails()
  await wait(() => expect(document.body.textContent).toMatch(/连接尚未确认|连接链接无法读取/))
  expect(ports.connect).not.toHaveBeenCalled(); expect(localStorage.getItem(OFFER)).toBe(saved); expect(getDeviceWorkface().recordIdentity()).toBe(record)
  if (variant === 'B' || variant === 'BQ') expect(read).not.toHaveBeenCalled()
})

it('failed explicit discovery stays on its original recovery entry and never re-fetches on foreground or online', async () => {
  const read = vi.fn().mockRejectedValue(new Error('original metadata unavailable')); vi.stubGlobal('fetch', read)
  await entry(connectionLinkUrl(location.origin + '/', offer()))
  await wait(() => expect(document.body.textContent).toContain('连接尚未确认'))
  await act(async () => { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')) })
  expect(read).toHaveBeenCalledTimes(1); expect(ports.connect).not.toHaveBeenCalled()
  const retry = [...document.querySelectorAll('button')].find(node => node.textContent === '重新检查连接')!
  expect(retry).toBeDefined(); await act(async () => retry.click()); await wait(() => expect(read).toHaveBeenCalledTimes(2))
})

it.each(['CONTROL_UNAVAILABLE', 'CONTROL_TIMEOUT'])('verified pin retries original typed %s transport failure without re-reading metadata or replacing its key', async code => {
  const original = offer(), f = client(), key = ports.pair, read = vi.fn(async () => response(original))
  vi.stubGlobal('fetch', read)
  ports.connect.mockRejectedValueOnce(Object.assign(new Error('Controlled original transport failure'), { code })).mockResolvedValueOnce(f.client)
  await entry(connectionLinkUrl(location.origin + '/', original))
  await wait(() => expect(document.body.textContent).toMatch(/连接尚未确认|暂时无法连接/))
  expect(ports.connect).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledOnce(); expect(localStorage.getItem(OFFER)).toBeNull()
  ports.pair = generateKeyPair()
  if (code === 'CONTROL_UNAVAILABLE') await act(async () => window.dispatchEvent(new Event('online')))
  await wait(() => expect(ports.connect).toHaveBeenCalledTimes(2))
  await wait(() => expect(localStorage.getItem(OFFER)).toBe(JSON.stringify(original)))
  expect(read).toHaveBeenCalledOnce()
  expect(ports.connect.mock.calls.map(([input]) => input.offer)).toEqual([original, original])
  expect(ports.connect.mock.calls.every(([input]) => input.keyPair === key), 'The same original admitted device key survives transport retry').toBe(true)
  const { getDeviceWorkface } = await import('../src/recovery/device-workface')
  await wait(() => expect(getDeviceWorkface().snapshot().record.host).toEqual({ origin: location.origin, hostId: original.serverId }))
  expect(f.submit).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
})

it.each(['CONTROL_PROTOCOL_ERROR', 'CONTROL_PERMISSION_DENIED', 'AGENT_CAPABILITY_INVALID'])('verified pin retains explicit retry after original typed %s refusal', async code => {
  const read = vi.fn(async () => response(offer())); vi.stubGlobal('fetch', read)
  ports.connect.mockRejectedValue(Object.assign(new Error('Controlled original identity or authorization refusal'), { code }))
  await entry(connectionLinkUrl(location.origin + '/', offer()))
  await wait(() => expect(document.body.textContent).toContain('连接尚未确认'))
  await act(async () => { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')) })
  expect(read).toHaveBeenCalledOnce(); expect(ports.connect).toHaveBeenCalledOnce(); expect(localStorage.getItem(OFFER)).toBeNull()
  expect([...document.querySelectorAll('button')].some(node => node.textContent === '重新检查连接')).toBe(true)
})

it('a storage read failure after the real connection leaf resolves releases that client and preserves the original offer', async () => {
  const original = offer(), saved = JSON.stringify(original), f = client(); localStorage.setItem(OFFER, saved)
  vi.stubGlobal('fetch', vi.fn(async () => response(original)))
  let release!: (value: typeof f.client) => void; ports.connect.mockImplementation(() => new Promise(resolve => { release = resolve }))
  await entry(connectionLinkUrl(location.origin + '/', original)); await wait(() => expect(ports.connect).toHaveBeenCalledOnce())
  const read = localStorage.getItem.bind(localStorage)
  vi.spyOn(localStorage, 'getItem').mockImplementation(key => { if (key === OFFER) throw Error('original storage read unavailable'); return read(key) })
  await act(async () => release(f.client)); await wait(() => expect(f.client.dispose).toHaveBeenCalledOnce())
  expect(ports.connect).toHaveBeenCalledOnce(); expect(document.body.textContent).toContain('连接尚未确认')
  vi.restoreAllMocks(); expect(localStorage.getItem(OFFER)).toBe(saved); expect(f.submit).not.toHaveBeenCalled()
})

it('saved full-offer startup performs no public discovery request', async () => {
  const original = offer(), f = client(), read = vi.fn(); localStorage.setItem(OFFER, JSON.stringify(original)); vi.stubGlobal('fetch', read); ports.connect.mockResolvedValue(f.client)
  await entry(location.origin + '/')
  await wait(() => expect(ports.connect).toHaveBeenCalledOnce()); expect(read).not.toHaveBeenCalled(); expect(ports.connect.mock.calls[0]![0].offer).toEqual(original)
})

it('a late metadata read cannot adopt a replaced original device record or its saved offer', async () => {
  const original = offer(), saved = JSON.stringify(original); localStorage.setItem(OFFER, saved)
  const { getDeviceWorkface, emptyDeviceWorkface } = await import('../src/recovery/device-workface')
  let release!: (value: Response) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { release = resolve })))
  await entry(connectionLinkUrl(location.origin + '/', original))
  await act(async () => getDeviceWorkface().replaceBackup({ ...emptyDeviceWorkface(), conversation: { version: 1, drafts: [['replacement-original', 'Keep this replacement draft']], attempts: [], responses: [] } }))
  const replacement = getDeviceWorkface().snapshot().record
  await act(async () => release(response(original)))
  await wait(() => expect(document.body.textContent).toContain('连接尚未确认'))
  expect(ports.connect).not.toHaveBeenCalled(); expect(localStorage.getItem(OFFER)).toBe(saved)
  expect(getDeviceWorkface().snapshot().record).toEqual(replacement)
})

it('unmount after the original connection request releases only its late returned client', async () => {
  const original = offer(), f = client(), saved = JSON.stringify(original); localStorage.setItem(OFFER, saved)
  vi.stubGlobal('fetch', vi.fn(async () => response(original)))
  let release!: (value: typeof f.client) => void
  ports.connect.mockImplementation(() => new Promise(resolve => { release = resolve }))
  await entry(connectionLinkUrl(location.origin + '/', original)); await wait(() => expect(ports.connect).toHaveBeenCalledOnce())
  await act(async () => { for (const root of ports.roots.splice(0)) root.unmount() })
  await act(async () => release(f.client)); await wait(() => expect(f.client.dispose).toHaveBeenCalledOnce())
  expect(localStorage.getItem(OFFER)).toBe(saved); expect(f.submit).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
})

it('fresh explicit pin refuses a substituted metadata key before any connection admission', async () => {
 const original = offer(), f = client(); ports.connect.mockResolvedValue(f.client)
 vi.stubGlobal('fetch', vi.fn(async () => response({ ...original, daemonPublicKeyB64: Buffer.alloc(32,8).toString('base64') })))
 await entry(connectionLinkUrl(location.origin + '/', original))
 await wait(() => expect(ports.connect.mock.calls.length > 0 || document.body.textContent!.includes('连接尚未确认')).toBe(true))
 expect(ports.connect, 'metadata may not replace the full original key pin').not.toHaveBeenCalled()
 expect(localStorage.getItem(OFFER)).toBeNull()
})
