import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectionLinkUrl, CONNECTION_METADATA_PATH, type ConnectionOffer } from '@agentmux/relay/offer'
import { fixture, deferred } from './conversation-fixture'

const ports = vi.hoisted(() => ({ connect: vi.fn(), pair: { publicKey: new Uint8Array(32).fill(7), secretKey: new Uint8Array(32).fill(9) }, roots: [] as Root[] }))
vi.mock('@agentmux/core/relay-hosted', async original => ({ ...await original<object>(), connectRelayHostedClient: ports.connect }))
vi.mock('../src/connection/relay-identity', () => ({ deviceRelayIdentity: async () => ports.pair, existingDeviceRelayIdentity: async () => ports.pair }))
vi.mock('@capacitor/core', async original => ({ ...await original<object>(), Capacitor: { isNativePlatform: () => false } }))
vi.mock('react-dom/client', async original => {
  const module = await original<typeof import('react-dom/client')>()
  return { ...module, createRoot: (...args: Parameters<typeof module.createRoot>) => { const root = module.createRoot(...args); ports.roots.push(root); return root } }
})
const OFFER = 'agentmux.connection-offer.v2'
const offer = (): ConnectionOffer => ({ v: 2, serverId: 'host-original', daemonPublicKeyB64: Buffer.alloc(32, 7).toString('base64'), relay: { endpoint: location.host, useTls: location.protocol === 'https:' } })
let moduleGate: ReturnType<typeof deferred<void>>
let moduleFailure: Error | null
const moduleStarted = vi.fn()
beforeEach(async () => {
  vi.resetModules(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/')
  moduleGate = deferred<void>(); moduleFailure = null; moduleStarted.mockClear(); ports.connect.mockReset()
  vi.doUnmock('../src/recovery/device-storage-lock')
  vi.doMock('../src/MobileApp', async original => { moduleStarted(); await moduleGate.promise; if (moduleFailure) throw moduleFailure; return original() })
  const { getDeviceWorkface, emptyDeviceWorkface } = await import('../src/recovery/device-workface')
  await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
})
afterEach(async () => {
  await act(async () => { for (const root of ports.roots.splice(0)) root.unmount(); moduleGate.resolve(); await vi.dynamicImportSettled() })
  document.body.replaceChildren(); vi.doUnmock('../src/MobileApp'); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function entry(url: string) {
  document.body.innerHTML = '<div id="root"></div><div id="mobile-overlays"></div>'
  history.replaceState(null, '', url)
  await act(async () => { await import('../src/main') })
}
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 5000, interval: 10 }) }
async function action(name: string) {
  const button = [...document.querySelectorAll('button')].find(node => node.textContent === name && !node.closest('[hidden]'))
  expect(button, name).toBeDefined(); await act(async () => button!.click())
}
function metadata(value: ConnectionOffer) { const response = new Response(JSON.stringify(value)); Object.defineProperty(response, 'url', { value: location.origin + CONNECTION_METADATA_PATH }); return response }
function connected() {
  const f = fixture()
  f.client.forwardRpc = vi.fn(async method => method === 'space.ls' ? { catalog: { spaces: [], zones: [], tabs: [], regions: [], locations: [], bindings: [], agentPresentation: [] } } : { agents: [], projects: [], unavailable: [] }) as typeof f.client.forwardRpc
  f.client.dispose = vi.fn(async () => {}); ports.connect.mockResolvedValue(f.client)
  return f
}

it('actual main starts its saved connection while the real product module is held, then retains that App through transport observations', async () => {
  const f = connected(), read = vi.fn(); vi.stubGlobal('fetch', read); localStorage.setItem(OFFER, JSON.stringify(offer()))
  await entry(location.origin + '/')
  await wait(() => expect(ports.connect).toHaveBeenCalledOnce())
  expect(moduleStarted).toHaveBeenCalledOnce(); expect(document.querySelector('.mobile-app')).toBeNull()
  expect(document.body.textContent).toContain('正在准备工作面'); expect(read).not.toHaveBeenCalled()
  await act(async () => { moduleGate.resolve(); await vi.dynamicImportSettled() })
  await wait(() => expect(document.querySelector('.mobile-app')).not.toBeNull())
  const app = document.querySelector('.mobile-app')
  await act(async () => f.emit({ type: 'connection-state', state: 'lost', observationOrigin: { boundary: 'consumer-core', kind: 'runtime-connection' } } as never))
  expect(document.querySelector('.mobile-app')).toBe(app); expect(f.client.dispose).not.toHaveBeenCalled()
  expect(ports.connect).toHaveBeenCalledOnce(); expect(f.submit).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
})

it('actual main waits for the real product module before its first App read inside the original update transaction', async () => {
  const { getDeviceWorkface, emptyDeviceWorkface } = await import('../src/recovery/device-workface')
  const { prepareReloadIdentity, reloadOfferIdentity } = await import('../src/connection/reload-identity')
  const owner = getDeviceWorkface(), original = offer(), draftKey = JSON.stringify(['draft', 'session-original'])
  await owner.replaceBackup({ ...emptyDeviceWorkface(), host: { origin: location.origin, hostId: original.serverId }, selectedSessionId: 'session-original',
    conversation: { version: 1, drafts: [[draftKey, 'Original saved body']], attempts: [], responses: [] } })
  await owner.retainGoalRequest({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner', deviceHostId: original.serverId, origin: location.origin,
    method: 'goal.delete', request: { goalId: 'original-goal', operationId: 'original-unknown', confirmation: 'delete' } }, owner.recordIdentity())
  const record = owner.snapshot().record
  prepareReloadIdentity(ports.pair, reloadOfferIdentity(original), owner.recordIdentity()); localStorage.setItem(OFFER, JSON.stringify(original))
  let active = 0
  vi.doMock('../src/recovery/device-storage-lock', async original => {
    const real = await original<typeof import('../src/recovery/device-storage-lock')>()
    return { ...real, withDeviceStorageLock: <T,>(action: () => T, signal?: AbortSignal) => real.withDeviceStorageLock(() => {
      active++; try { return action() } finally { active-- }
    }, signal) }
  })
  const originalRead = owner.snapshotNavigation.bind(owner), firstReads: number[] = []
  vi.spyOn(owner, 'snapshotNavigation').mockImplementation(() => { firstReads.push(active); return originalRead() })
  ports.connect.mockReturnValue(new Promise(() => {}))
  await entry(location.origin + '/#amux-update')
  await wait(() => expect(moduleStarted).toHaveBeenCalledOnce())
  expect(firstReads).toEqual([]); expect(document.querySelector('.mobile-app')).toBeNull(); expect(ports.connect).not.toHaveBeenCalled()
  await act(async () => { moduleGate.resolve(); await vi.dynamicImportSettled() })
  await wait(() => expect(document.querySelector('.mobile-app')).not.toBeNull())
  expect(firstReads.length).toBeGreaterThan(0); expect(firstReads[0], 'Actual MobileApp loadWorkface reads inside the original real IDB transaction').toBeGreaterThan(0)
  expect(owner.recordIdentity()).toBe(record.recordId)
  expect(owner.snapshot().record.conversation).toEqual(record.conversation)
  expect(owner.snapshot().record.goalOperationRecords).toEqual(record.goalOperationRecords)
  expect(document.querySelector('[contenteditable=true]')?.textContent).toContain('Original saved body')
})

it.each(['success', 'failure'] as const)('actual main cancels only pending metadata and rereads its original pin while old %s stays late', async late => {
  const first = deferred<Response>(), second = deferred<Response>(), requests: AbortSignal[] = [], f = connected(), original = offer()
  const read = vi.fn((_url: unknown, input: RequestInit) => { requests.push(input.signal!); return requests.length === 1 ? first.promise : second.promise })
  vi.stubGlobal('fetch', read)
  await entry(connectionLinkUrl(location.origin + '/', original))
  await wait(() => expect(read).toHaveBeenCalledOnce())
  expect(ports.connect).not.toHaveBeenCalled(); await action('取消本次读取')
  expect(requests[0]!.aborted).toBe(true)
  await act(async () => { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')) })
  expect(read).toHaveBeenCalledOnce(); expect(ports.connect).not.toHaveBeenCalled()
  await action('重新检查连接'); await wait(() => expect(read).toHaveBeenCalledTimes(2))
  expect(requests[1]!.aborted).toBe(false)
  moduleFailure = new Error('Product preparation failed while the original metadata remains pending')
  await act(async () => { moduleGate.resolve(); await vi.dynamicImportSettled() })
  await wait(() => expect(document.body.textContent).toContain('工作面暂时无法打开'))
  await act(async () => { if (late === 'success') first.resolve(metadata(original)); else first.reject(new Error('Old metadata read failed after cancellation')) })
  expect(requests[1]!.aborted).toBe(false); expect(ports.connect).not.toHaveBeenCalled(); expect(localStorage.getItem(OFFER)).toBeNull()
  expect(document.body.textContent).toContain('正在读取连接')
  expect([...document.querySelectorAll('button')].some(node => node.textContent === '取消本次读取'), 'Old finally may not remove the newer observation recovery control').toBe(true)
  await act(async () => second.resolve(metadata(original)))
  await wait(() => expect(ports.connect).toHaveBeenCalledOnce())
  expect(ports.connect.mock.calls[0]![0].offer).toEqual(original)
  await wait(() => expect(localStorage.getItem(OFFER)).toBe(JSON.stringify(original)))
  expect(read).toHaveBeenCalledTimes(2); expect(f.client.dispose).not.toHaveBeenCalled()
  expect(f.submit).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
})

it('a rejected product module retains its healthy original connection and exposes the original preservation recovery action', async () => {
  const f = connected(), original = offer(); localStorage.setItem(OFFER, JSON.stringify(original))
  await entry(location.origin + '/'); await wait(() => expect(ports.connect).toHaveBeenCalledOnce())
  moduleFailure = new Error('Controlled original product module unavailable')
  await act(async () => { moduleGate.resolve(); await vi.dynamicImportSettled() })
  await wait(() => expect(document.body.textContent).toContain('工作面暂时无法打开'))
  const details = document.querySelector('details')!
  expect(details.querySelector('summary')?.textContent).toBe('加载详情')
  expect(details.querySelector('p')?.textContent?.length, 'The real import rejection remains discoverable in the original failure view').toBeGreaterThan(0)
  expect([...document.querySelectorAll('button')].some(node => node.textContent === '保全并重新打开网页')).toBe(true)
  await action('返回')
  expect(f.client.dispose).not.toHaveBeenCalled(); expect(localStorage.getItem(OFFER)).toBe(JSON.stringify(original))
  expect(f.submit).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
})
