// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import type { AgentMuxPreloadApi, HostConfig } from '../src/shared/contracts'
const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_key: string, api: AgentMuxPreloadApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), removeListener: vi.fn() }, webFrame: { getZoomFactor: () => 1 } }))
import '../src/preload/index'
import { useAppStore } from '../src/renderer/src/store'
it('actual preload separates pure inspection from explicit reconnect and preserves the original Host and operation', async () => {
  const host: HostConfig = { id: 'remote', kind: 'ssh', label: 'Remote', hostname: 'private.fixture' }
  const result = { operationId: 'original-upgrade', status: 'completed' }
  bridge.invoke.mockResolvedValue(result)
  expect(await bridge.api!.hosts.upgradeInspect(host, result.operationId)).toBe(result)
  expect(bridge.invoke).toHaveBeenLastCalledWith('hosts:upgradeInspect', host, result.operationId)
  expect(await bridge.api!.hosts.upgradeReconnect(host, result.operationId)).toBe(result)
  expect(bridge.invoke).toHaveBeenLastCalledWith('hosts:upgradeReconnect', host, result.operationId)
  expect(bridge.invoke.mock.calls).toHaveLength(2)
})

it('Renderer refuses this Main-owned explicit reconnect instead of interpreting it as a Browser action', async () => {
  bridge.invoke.mockClear()
  await expect(useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'original-upgrade', operation: 'settings.hosts.upgrade-reconnect', id: 'remote' })).rejects.toMatchObject({
    code: 'CONTROL_FAILED', message: 'Settings requests belong to the Main configuration owner.' })
  expect(bridge.invoke).not.toHaveBeenCalled()
})
