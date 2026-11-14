// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import type { AgentMuxPreloadApi, AgentMuxDesktopApi } from '../src/shared/contracts'
import { BROWSER_PROFILE_RESULT_METHODS, unwrapIpcResultMethods } from '../src/shared/ipc-result'
const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_key: string, api: AgentMuxPreloadApi) => { bridge.api = api } }, ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), removeListener: vi.fn() }, webFrame: { getZoomFactor: () => 1 } }))
import '../src/preload/index'
it('real preload preserves the six exact Cookie file tuples and production envelope decoding', async () => {
  const scope = { kind: 'sites', sites: ['example.test'] }, source = { kind: 'local', path: '/private/input.json' }, destination = { kind: 'workspace', resource: { hostId: 'host-a', workspaceId: 'ws-a', workspacePath: '/workspace-a' }, path: '/workspace-a/new.json' }
  const cases = [
    ['prepareProfileCookieImport', ['profile-a', 'original-id', source, scope]],
    ['importProfileCookies', ['profile-a', 'original-id']],
    ['exportProfileCookies', ['profile-a', 'original-id', destination, scope]],
    ['inspectProfileCookieFiles', ['profile-a', 'original-id', 24, 24]],
    ['discardProfileCookieImport', ['profile-a', 'original-id']],
    ['revealProfileCookieFile', ['profile-a', 'original-id']]
  ] as const
  const renderer = unwrapIpcResultMethods(bridge.api!.browser as never, BROWSER_PROFILE_RESULT_METHODS) as AgentMuxDesktopApi['browser']
  for (const [name, args] of cases) {
    bridge.invoke.mockResolvedValueOnce({ ok: true, value: { original: name } })
    expect(await (renderer[name] as (...values: unknown[]) => Promise<unknown>)(...args)).toEqual({ original: name })
    expect(bridge.invoke).toHaveBeenLastCalledWith(`browser:${name}`, ...args)
    bridge.invoke.mockResolvedValueOnce({ ok: false, error: { code: 'BROWSER_PROFILE_COOKIE_FILE_ALREADY_ADMITTED', message: 'Check original ID.' } })
    await expect((renderer[name] as (...values: unknown[]) => Promise<unknown>)(...args)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_COOKIE_FILE_ALREADY_ADMITTED' })
  }
})
