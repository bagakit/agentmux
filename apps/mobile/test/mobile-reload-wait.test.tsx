import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileWebUpdateSafetyProvider, useMobileWebUpdateSafety } from '../src/mobile-web/update-safety'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { mount, mounted } from './conversation-fixture'

let apply: ReturnType<typeof useMobileWebUpdateSafety>['apply']
function Action() { apply = useMobileWebUpdateSafety().apply; return null }
afterEach(async () => {
  vi.useRealTimers()
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('ends each timed-out preflight observation without accumulating waiters or cancelling the original device write', async () => {
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
  const write = owner.updateConversation({ version: 1, drafts: [['["draft","original"]', '原正文']], attempts: [], responses: [] })
  await vi.waitFor(() => expect(release).toBeDefined())
  const originalTail = (owner as any).tail as Promise<unknown>, subscribe = vi.spyOn(originalTail, 'then')
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, url: location.origin + '/mobile/new-build/' + 'a'.repeat(64) + '/index.html' })))
  const navigate = vi.spyOn(location, 'assign').mockImplementation(() => {})
  await mount(<MobileWebUpdateSafetyProvider verifyConnection={async () => () => true}><Action /></MobileWebUpdateSafetyProvider>)
  vi.useFakeTimers()
  for (let i = 0; i < 3; i++) {
    const observation = apply()
    await vi.advanceTimersByTimeAsync(15000)
    expect(await observation).toMatchObject({ status: 'blocked' })
    expect((owner as any).reloadWait?.listeners.size).toBe(0)
  }
  expect(subscribe).toHaveBeenCalledTimes(1)
  expect(fetch).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled()
  expect(owner.snapshot().record.conversation.drafts).toEqual([['["draft","original"]', '原正文']])
  vi.useRealTimers(); release!(); await write
  expect(JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1')!).conversation.drafts).toEqual([['["draft","original"]', '原正文']])
  expect(await apply()).toEqual({ status: 'navigating' }); expect(navigate).toHaveBeenCalledOnce()
})
