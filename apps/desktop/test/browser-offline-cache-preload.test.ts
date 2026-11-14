// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import type { AgentMuxPreloadApi, AgentMuxDesktopApi } from '../src/shared/contracts.js'
import { BROWSER_PROFILE_RESULT_METHODS, unwrapIpcResultMethods } from '../src/shared/ipc-result.js'
const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_key: string, api: AgentMuxPreloadApi) => { bridge.api = api } }, ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), removeListener: vi.fn() }, webFrame: { getZoomFactor: () => 1 } }))
import '../src/preload/index.js'
it('the actual preload and result decoder keep original Profile, OP and exact frozen key tuple', async () => {
  const api = unwrapIpcResultMethods(bridge.api!.browser as never, BROWSER_PROFILE_RESULT_METHODS) as AgentMuxDesktopApi['browser']
  const input = { profileId: 'p', expectedRevision: 'r', operationId: 'op', sites: [{ origin: 'https://one.test', storageKeys: ['https://one.test/^0https://top.test'] }] }
  bridge.invoke.mockResolvedValueOnce({ ok: true, value: { original: true } })
  expect(await api.clearProfileStorage(input)).toEqual({ original: true })
  expect(bridge.invoke).toHaveBeenLastCalledWith('browser:clearProfileStorage', input)
  bridge.invoke.mockResolvedValueOnce({ ok: true, value: { original: 'op' } })
  expect(await api.inspectProfileStorage('p', 'op')).toEqual({ original: 'op' })
  expect(bridge.invoke).toHaveBeenLastCalledWith('browser:inspectProfileStorage', 'p', 'op')
  bridge.invoke.mockResolvedValueOnce({ ok: false, error: { code: 'BROWSER_PROFILE_STORAGE_REFUSED', message: 'original target unavailable' } })
  await expect(api.inspectProfileStorage('p')).rejects.toMatchObject({ code: 'BROWSER_PROFILE_STORAGE_REFUSED' })
})
