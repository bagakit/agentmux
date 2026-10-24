import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileGoalLinks } from '../src/goals/MobileGoalLinks'
import { MobileGoalOperationRecovery, MobileGoalOperationSafety } from '../src/goals/goal-operation-recovery'
import { MobileWebUpdateSafetyProvider, useMobileWebUpdateSafety } from '../src/mobile-web/update-safety'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { withDeviceStorageLock } from '../src/recovery/device-storage-lock'
import { button, click, deferred, fixture, mount, mounted } from './conversation-fixture'

let apply: ReturnType<typeof useMobileWebUpdateSafety>['apply']
function Update() { apply = useMobileWebUpdateSafety().apply; return null }
const verifyConnection = async () => () => true
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('never invokes a delayed transaction callback after that exact wait was cancelled', async () => {
  const open: any = {}, request: any = {}, transaction: any = { objectStore: () => ({ get: () => request }), abort: () => queueMicrotask(() => transaction.onabort?.()) }
  const database = { transaction: () => transaction, close() {} }
  vi.spyOn(indexedDB, 'open').mockImplementation(() => { queueMicrotask(() => { open.result = database; open.onsuccess?.() }); return open })
  const abort = new AbortController(), write = vi.fn()
  const pending = withDeviceStorageLock(write, abort.signal)
  await vi.waitFor(() => expect(request.onsuccess).toBeDefined())
  abort.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  request.onsuccess()
  expect(write).not.toHaveBeenCalled()
})

it('cancels a queued Goal write without overtaking or losing an earlier unrelated device write', async () => {
  const owner = getDeviceWorkface()
  await owner.replaceBackup(emptyDeviceWorkface())
  const originalOpen = indexedDB.open.bind(indexedDB)
  let release: (() => void) | undefined, intercepted = false
  vi.spyOn(indexedDB, 'open').mockImplementation(((name: string, version?: number) => {
    if (name !== 'agentmux-device-workface-write-lock' || intercepted) return originalOpen(name, version)
    intercepted = true
    const waiting: any = {}
    release = () => { const actual = originalOpen(name, version); actual.onupgradeneeded = event => waiting.onupgradeneeded?.(event); actual.onsuccess = () => { waiting.result = actual.result; waiting.onsuccess?.() }; actual.onerror = () => { waiting.error = actual.error; waiting.onerror?.() } }
    return waiting
  }) as typeof indexedDB.open)
  const first = owner.updateNavigation({ selectedSessionId: 'first-original', hostUrl: '', panel: 'conversation' })
  await vi.waitFor(() => expect(release).toBeDefined())
  const item = { runtimeId: 'original-runtime', ownerInstanceId: 'original-owner', deviceHostId: null, origin: location.origin,
    method: 'goal.start' as const, request: { goalId: 'goal-original', operationId: 'queued-original' } }
  const abort = new AbortController(), goal = owner.retainGoalRequest(item, owner.recordIdentity(), abort.signal)
  let laterFinished = false
  const later = owner.updateNavigation({ selectedSessionId: 'second-original', hostUrl: '', panel: 'conversation' }).then(() => { laterFinished = true })
  abort.abort()
  const outcome = await Promise.race([goal.then(() => 'written', error => error.name), new Promise(resolve => setTimeout(() => resolve('still waiting'), 300))])
  if (outcome === 'still waiting') release!()
  expect(outcome).toBe('AbortError')
  expect(laterFinished).toBe(false)
  release!(); await first; await later
  expect(owner.snapshot().record.selectedSessionId).toBe('second-original')
  expect(owner.snapshot().record.goalOperationRecords ?? []).toEqual([])
})

it('requires a successful exact copy and explicit confirmation, cancels only the hung Goal write, and rejects its late lock callback', async () => {
  const owner = getDeviceWorkface(), f = fixture()
  await owner.replaceBackup(emptyDeviceWorkface())
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' } as never)
  const rpc = vi.fn(async () => ({ goal: { id: 'goal-original' } })); f.client.forwardRpc = rpc as any
  const originalOpen = indexedDB.open.bind(indexedDB)
  let release: (() => void) | undefined, intercepted = false
  vi.spyOn(indexedDB, 'open').mockImplementation(((name: string, version?: number) => {
    if (name !== 'agentmux-device-workface-write-lock' || intercepted) return originalOpen(name, version)
    intercepted = true
    const waiting: any = {}
    release = () => {
      const actual = originalOpen(name, version)
      actual.onupgradeneeded = event => waiting.onupgradeneeded?.(event)
      actual.onsuccess = () => { waiting.result = actual.result; waiting.onsuccess?.() }
      actual.onerror = () => { waiting.error = actual.error; waiting.onerror?.() }
    }
    return waiting
  }) as typeof indexedDB.open)
  let copyAllowed = false
  const copy = vi.fn(async (_text: string, report: (error: unknown) => void) => { if (!copyAllowed) { report(Error('clipboard unavailable')); return false } return true })
  const navigate = vi.spyOn(location, 'assign').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, url: `${location.origin}/mobile/new/${'a'.repeat(64)}/index.html` })))
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Update /><MobileGoalOperationSafety /><MobileGoalOperationRecovery copyText={copy} /><MobileGoalLinks client={f.client} goal={{ id: 'goal-original' } as any} updated={() => {}} /></MobileWebUpdateSafetyProvider>)
  const input = view.element.querySelector<HTMLInputElement>('[aria-label="关联 Session ID"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'session-original'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await click(button(view.element, '关联会话'))
  await vi.waitFor(() => expect(release).toBeDefined())
  expect(view.element.textContent).toContain('会话已关联到原目标')
  expect(await apply()).toMatchObject({ status: 'blocked' })
  await click(button(view.element, '复制原请求'))
  expect(view.element.textContent).toContain('复制未完成')
  expect(view.element.textContent).not.toContain('已另行保全，移除本页副本')
  copyAllowed = true; await click(button(view.element, '复制原请求'))
  const copied = JSON.parse(copy.mock.calls.at(-1)![0])
  expect(copied.request).toEqual(rpc.mock.calls[0]![1]); expect(copied.result).toBe('原 RPC 已收到回执')
  expect(view.element.textContent).not.toContain('确认已保全并移除本页副本')
  await click(button(view.element, '已另行保全，移除本页副本…'))
  await click(button(view.element, '取消移除'))
  expect(await apply()).toMatchObject({ status: 'blocked' })
  await click(button(view.element, '已另行保全，移除本页副本…'))
  await click(button(view.element, '确认已保全并移除本页副本'))
  await vi.waitFor(async () => { await act(async () => {}); expect(owner.snapshot().record.goalOperationRecords ?? []).toEqual([]) })
  expect(await apply()).toEqual({ status: 'navigating' }); expect(navigate).toHaveBeenCalledOnce()
  await act(async () => { release!(); await Promise.resolve() })
  expect(owner.snapshot().record.goalOperationRecords ?? []).toEqual([])
  expect(rpc).toHaveBeenCalledOnce()
})

it('keeps an already-written request and records the confirmed receipt before permitting reload', async () => {
  const owner = getDeviceWorkface(), f = fixture()
  await owner.replaceBackup(emptyDeviceWorkface())
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' } as never)
  const rpc = vi.fn(async () => ({ goal: { id: 'goal-original' } })); f.client.forwardRpc = rpc as any
  const originalOpen = indexedDB.open.bind(indexedDB)
  let intercepted = false
  vi.spyOn(indexedDB, 'open').mockImplementation(((name: string, version?: number) => {
    if (name !== 'agentmux-device-workface-write-lock' || intercepted) return originalOpen(name, version)
    intercepted = true
    const open: any = {}, request: any = {}, transaction: any = { objectStore: () => ({ get: () => request }), abort: () => queueMicrotask(() => transaction.onabort?.()) }
    const database = { transaction: () => { queueMicrotask(() => request.onsuccess?.()); return transaction }, close() {} }
    queueMicrotask(() => { open.result = database; open.onsuccess?.() })
    return open
  }) as typeof indexedDB.open)
  const copy = vi.fn(async () => true), navigate = vi.spyOn(location, 'assign').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, url: `${location.origin}/mobile/new/${'a'.repeat(64)}/index.html` })))
  const render = (show: boolean) => <MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Update /><MobileGoalOperationSafety /><MobileGoalOperationRecovery copyText={copy} />{show && <MobileGoalLinks client={f.client} goal={{ id: 'goal-original' } as any} updated={() => {}} />}</MobileWebUpdateSafetyProvider>
  const view = await mount(render(true)), input = view.element.querySelector<HTMLInputElement>('[aria-label="关联 Session ID"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'session-original'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await click(button(view.element, '关联会话'))
  await vi.waitFor(() => expect(JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1')!).goalOperationRecords).toHaveLength(1))
  await click(button(view.element, '复制原请求')); await click(button(view.element, '已另行保全，移除本页副本…'))
  await click(button(view.element, '确认已保全并移除本页副本'))
  await vi.waitFor(() => expect(view.element.textContent).toContain('原请求已写入设备记录'))
  expect(owner.snapshot().record.goalOperationRecords).toHaveLength(1)
  expect(await apply()).toMatchObject({ status: 'blocked' })
  await click(button(view.element, '重试更新设备记录'))
  await vi.waitFor(() => expect(owner.snapshot().record.goalOperationRecords?.[0]?.confirmation).toBe('confirmed'))
  expect(owner.snapshot().record.goalOperationRecords).toHaveLength(1)
  const confirmed = owner.snapshot().record.goalOperationRecords![0]!
  const { confirmation: _confirmation, ...original } = confirmed
  expect(owner.readGoalRequest(original, owner.recordIdentity())).toBe('confirmed')
  await act(async () => { await owner.confirmGoalRequest(original, owner.recordIdentity()) })
  expect(owner.snapshot().record.goalOperationRecords).toEqual([confirmed])
  await view.render(render(false))
  expect(view.element.textContent).toContain('已收到原回执')
  expect(await apply()).toEqual({ status: 'navigating' }); expect(navigate).toHaveBeenCalledOnce()
  expect(rpc).toHaveBeenCalledOnce()
})

it('allows explicit external preservation when the actual device record cannot be read', async () => {
  const owner = getDeviceWorkface(), f = fixture()
  await owner.replaceBackup(emptyDeviceWorkface())
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' } as never)
  const rpc = vi.fn(async () => { throw Error('receipt unavailable') }); f.client.forwardRpc = rpc as any
  const originalOpen = indexedDB.open.bind(indexedDB)
  let intercepted = false
  vi.spyOn(indexedDB, 'open').mockImplementation(((name: string, version?: number) => {
    if (name !== 'agentmux-device-workface-write-lock' || intercepted) return originalOpen(name, version)
    intercepted = true; return {} as IDBOpenDBRequest
  }) as typeof indexedDB.open)
  const read = owner.readGoalRequest.bind(owner)
  const failRead = vi.spyOn(owner, 'readGoalRequest').mockImplementation((item, id) => {
    const unavailable = vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw Error('device read unavailable') })
    try { return read(item, id) } finally { unavailable.mockRestore() }
  })
  const copy = vi.fn(async () => true)
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Update /><MobileGoalOperationSafety /><MobileGoalOperationRecovery copyText={copy} /><MobileGoalLinks client={f.client} goal={{ id: 'goal-original' } as any} updated={() => {}} /></MobileWebUpdateSafetyProvider>)
  const input = view.element.querySelector<HTMLInputElement>('[aria-label="关联 Session ID"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'session-original'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await click(button(view.element, '关联会话')); await vi.waitFor(() => expect(intercepted).toBe(true))
  await click(button(view.element, '复制原请求')); await click(button(view.element, '已另行保全，移除本页副本…'))
  await click(button(view.element, '确认已保全并移除本页副本'))
  await vi.waitFor(() => expect(view.element.textContent).toContain('设备原记录状态未知'))
  expect(view.element.textContent).toContain('设备存储故障仍需恢复')
  expect(view.element.querySelector('[aria-label="未确认的目标操作"]')).toBeNull()
  failRead.mockRestore()
  expect(owner.snapshot().record.goalOperationRecords ?? []).toEqual([])
  expect(rpc).toHaveBeenCalledOnce()
})

it('requires a new copy if the original RPC becomes confirmed after an unknown result was copied', async () => {
  const owner = getDeviceWorkface(), f = fixture(), receipt = deferred<any>()
  await owner.replaceBackup(emptyDeviceWorkface())
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' } as never)
  const rpc = vi.fn(() => receipt.promise); f.client.forwardRpc = rpc as any
  const originalOpen = indexedDB.open.bind(indexedDB)
  let intercepted = false
  vi.spyOn(indexedDB, 'open').mockImplementation(((name: string, version?: number) => {
    if (name !== 'agentmux-device-workface-write-lock' || intercepted) return originalOpen(name, version)
    intercepted = true; return {} as IDBOpenDBRequest
  }) as typeof indexedDB.open)
  const copy = vi.fn(async () => true)
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Update /><MobileGoalOperationSafety /><MobileGoalOperationRecovery copyText={copy} /><MobileGoalLinks client={f.client} goal={{ id: 'goal-original' } as any} updated={() => {}} /></MobileWebUpdateSafetyProvider>)
  const input = view.element.querySelector<HTMLInputElement>('[aria-label="关联 Session ID"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'session-original'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await click(button(view.element, '关联会话')); await vi.waitFor(() => expect(intercepted).toBe(true))
  await click(button(view.element, '复制原请求'))
  expect(JSON.parse(copy.mock.calls.at(-1)![0]).result).toBe('原 RPC 回执未确认')
  await click(button(view.element, '已另行保全，移除本页副本…'))
  await act(async () => { receipt.resolve({ goal: { id: 'goal-original' } }); await receipt.promise })
  expect(view.element.textContent).not.toContain('确认已保全并移除本页副本')
  await click(button(view.element, '复制原请求'))
  expect(JSON.parse(copy.mock.calls.at(-1)![0]).result).toBe('原 RPC 已收到回执')
  await click(button(view.element, '已另行保全，移除本页副本…'))
  await click(button(view.element, '确认已保全并移除本页副本'))
  await vi.waitFor(() => expect(view.element.querySelector('[aria-label="未确认的目标操作"]')).toBeNull())
  expect(rpc).toHaveBeenCalledOnce()
})

it('recognizes an exact confirmation recorded by another page and leaves that saved record intact', async () => {
  const owner = getDeviceWorkface(), f = fixture()
  await owner.replaceBackup(emptyDeviceWorkface())
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' } as never)
  const rpc = vi.fn(async () => { throw Error('lost original receipt') }); f.client.forwardRpc = rpc as any
  const originalOpen = indexedDB.open.bind(indexedDB)
  let intercepted = false
  vi.spyOn(indexedDB, 'open').mockImplementation(((name: string, version?: number) => {
    if (name !== 'agentmux-device-workface-write-lock' || intercepted) return originalOpen(name, version)
    intercepted = true; return {} as IDBOpenDBRequest
  }) as typeof indexedDB.open)
  const copy = vi.fn(async () => true), navigate = vi.spyOn(location, 'assign').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, url: `${location.origin}/mobile/new/${'a'.repeat(64)}/index.html` })))
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Update /><MobileGoalOperationSafety /><MobileGoalOperationRecovery copyText={copy} /><MobileGoalLinks client={f.client} goal={{ id: 'goal-original' } as any} updated={() => {}} /></MobileWebUpdateSafetyProvider>)
  const input = view.element.querySelector<HTMLInputElement>('[aria-label="关联 Session ID"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'session-original'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await click(button(view.element, '关联会话')); await vi.waitFor(() => expect(intercepted).toBe(true))
  await click(button(view.element, '复制原请求')); await click(button(view.element, '已另行保全，移除本页副本…'))
  const copied = JSON.parse(copy.mock.calls.at(-1)![0]); delete copied.result
  const saved = { ...copied, confirmation: 'confirmed' }, raw = JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1')!)
  localStorage.setItem('agentmux-mobile-workface-v1', JSON.stringify({ ...raw, goalOperationRecords: [saved] }))
  await click(button(view.element, '确认已保全并移除本页副本'))
  await vi.waitFor(() => expect(view.element.textContent).toContain('已收到原回执'))
  expect(owner.snapshot().record.goalOperationRecords).toEqual([saved])
  expect(await apply()).toEqual({ status: 'navigating' }); expect(navigate).toHaveBeenCalledOnce()
  expect(rpc).toHaveBeenCalledOnce()
})

it('records a late original RPC confirmation after an explicitly preserved unknown request leaves the page', async () => {
  const owner = getDeviceWorkface(), f = fixture(), receipt = deferred<any>()
  await owner.replaceBackup(emptyDeviceWorkface())
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' } as never)
  const rpc = vi.fn(() => receipt.promise); f.client.forwardRpc = rpc as any
  const originalOpen = indexedDB.open.bind(indexedDB)
  let intercepted = false
  vi.spyOn(indexedDB, 'open').mockImplementation(((name: string, version?: number) => {
    if (name !== 'agentmux-device-workface-write-lock' || intercepted) return originalOpen(name, version)
    intercepted = true; return {} as IDBOpenDBRequest
  }) as typeof indexedDB.open)
  const copy = vi.fn(async () => true)
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Update /><MobileGoalOperationSafety /><MobileGoalOperationRecovery copyText={copy} /><MobileGoalLinks client={f.client} goal={{ id: 'goal-original' } as any} updated={() => {}} /></MobileWebUpdateSafetyProvider>)
  const input = view.element.querySelector<HTMLInputElement>('[aria-label="关联 Session ID"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'session-original'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await click(button(view.element, '关联会话')); await vi.waitFor(() => expect(intercepted).toBe(true))
  await click(button(view.element, '复制原请求'))
  const captured = JSON.parse(copy.mock.calls.at(-1)![0])
  expect(captured.result).toBe('原 RPC 回执未确认')
  await click(button(view.element, '已另行保全，移除本页副本…'))
  await click(button(view.element, '确认已保全并移除本页副本'))
  await vi.waitFor(() => expect(view.element.querySelector('[aria-label="未确认的目标操作"]')).toBeNull())
  await act(async () => { receipt.resolve({ goal: { id: 'goal-original' } }); await receipt.promise })
  await vi.waitFor(() => expect(owner.snapshot().record.goalOperationRecords?.[0]?.confirmation).toBe('confirmed'))
  const saved = owner.snapshot().record.goalOperationRecords![0]!
  expect(saved.request).toEqual(captured.request)
  expect(view.element.textContent).toContain('已收到原回执')
  expect(rpc).toHaveBeenCalledOnce()
})

it('preserves a competing request while allowing explicit external preservation of the original', async () => {
  const owner = getDeviceWorkface(), f = fixture(), receipt = deferred<any>()
  await owner.replaceBackup(emptyDeviceWorkface())
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' } as never)
  const rpc = vi.fn(() => receipt.promise); f.client.forwardRpc = rpc as any
  const originalOpen = indexedDB.open.bind(indexedDB)
  let intercepted = false
  vi.spyOn(indexedDB, 'open').mockImplementation(((name: string, version?: number) => {
    if (name !== 'agentmux-device-workface-write-lock' || intercepted) return originalOpen(name, version)
    intercepted = true; return {} as IDBOpenDBRequest
  }) as typeof indexedDB.open)
  const copy = vi.fn(async () => true)
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Update /><MobileGoalOperationSafety /><MobileGoalOperationRecovery copyText={copy} /><MobileGoalLinks client={f.client} goal={{ id: 'goal-original' } as any} updated={() => {}} /></MobileWebUpdateSafetyProvider>)
  const input = view.element.querySelector<HTMLInputElement>('[aria-label="关联 Session ID"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'session-original'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await click(button(view.element, '关联会话'))
  await vi.waitFor(() => expect(intercepted).toBe(true))
  const original = JSON.parse(view.element.querySelector('pre')!.textContent!)
  const competing = { ...original, request: { ...original.request, sessionId: 'other-session' } }; delete competing.result
  const raw = JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1')!)
  localStorage.setItem('agentmux-mobile-workface-v1', JSON.stringify({ ...raw, goalOperationRecords: [competing] }))
  await click(button(view.element, '复制原请求')); await click(button(view.element, '已另行保全，移除本页副本…'))
  await click(button(view.element, '确认已保全并移除本页副本'))
  await vi.waitFor(() => expect(owner.snapshot().record.goalOperationRecords).toEqual([competing]))
  expect(view.element.textContent).toContain('设备原记录状态未知')
  expect(view.element.querySelector('[aria-label="未确认的目标操作"]')?.textContent).not.toContain('session-original')
  expect(JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1')!).goalOperationRecords).toEqual([competing])
  await act(async () => { receipt.resolve({ goal: { id: 'goal-original' } }); await receipt.promise })
  await vi.waitFor(() => expect(view.element.textContent).toContain('已收到原回执'))
  const originalDetails = [...view.element.querySelectorAll('details')].find(element => element.querySelector('summary')?.textContent?.includes('已收到原回执'))!
  await click(button(originalDetails, '复制原请求'))
  expect(JSON.parse(copy.mock.calls.at(-1)![0]).result).toBe('原 RPC 已收到回执')
  await click(button(originalDetails, '已另行保全，移除本页副本…'))
  await click(button(originalDetails, '确认已保全并移除本页副本'))
  await vi.waitFor(() => expect(view.element.textContent).toContain('设备原记录状态未知'))
  expect(JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1')!).goalOperationRecords).toEqual([competing])
  expect(rpc).toHaveBeenCalledOnce()
})

