// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import type { AgentMuxPreloadApi, AgentMuxDesktopApi } from '../src/shared/contracts'
import { BROWSER_PROFILE_RESULT_METHODS, ipcResult, unwrapIpcResultMethods } from '../src/shared/ipc-result'
const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_key: string, api: AgentMuxPreloadApi) => { bridge.api = api } }, ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), removeListener: vi.fn() }, webFrame: { getZoomFactor: () => 1 } }))
import '../src/preload/index'
it('real preload preserves all five exact bookmark tuples and production envelope method names unwrap every result', async () => {
  const cases = [
    ['listProfileBookmarks', ['profile-a', 'folder-a', 'original-operation']],
    ['editProfileBookmark', ['profile-a', 'library-r1', 'original-operation', { kind: 'remove', id: 'bookmark-a' }]],
    ['importProfileBookmarks', ['profile-a', 'folder-a', 'library-r1', 'original-operation', '/fixture/input.html']],
    ['exportProfileBookmarks', ['profile-a', 'folder-a', 'library-r1', 'original-operation', '/fixture/new.html']],
    ['openProfileBookmark', ['profile-a', 'bookmark-a', 'browser-a', 'library-r1', 'original-operation']]
  ] as const
  const renderer = unwrapIpcResultMethods(bridge.api!.browser as never, BROWSER_PROFILE_RESULT_METHODS) as AgentMuxDesktopApi['browser']
  for (const [name, args] of cases) {
    bridge.invoke.mockImplementationOnce(async () => ipcResult(async () => ({ original: name })))
    expect(await (renderer[name] as (...values: unknown[]) => Promise<unknown>)(...args)).toEqual({ original: name })
    expect(bridge.invoke).toHaveBeenLastCalledWith(`browser:${name}`, ...args)
  }
  bridge.invoke.mockResolvedValueOnce({ ok: false, error: { code: 'CONTROL_CONFLICT', message: 'Original library changed.' } })
  await expect(renderer.listProfileBookmarks('profile-a', null)).rejects.toMatchObject({ code: 'CONTROL_CONFLICT' })
})
