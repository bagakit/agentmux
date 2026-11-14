// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_key: string, api: AgentMuxPreloadApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), removeListener: vi.fn() }, webFrame: { getZoomFactor: () => 1 } }))
import '../src/preload/index'

it('the actual preload preserves exact parallel start, original lookup and both pagination boundaries', async () => {
  bridge.invoke.mockClear()
  const input = { operationId: 'original-start', concurrency: 2, targets: [{ id: 'target-a', browserId: 'browser-a', profileId: 'profile-a', parameters: { value: 'fresh-entry' }, calls: { child: { parameters: {}, items: [{ id: 'child-a', parameters: { entry: 'fresh-child' } }] } } }] }
  const summary = { operationId: input.operationId }, inspection = { run: summary, targets: [] }, history = { runs: [summary] }
  bridge.invoke.mockResolvedValueOnce(summary)
  expect(await bridge.api!.browser.runTaskParallel('source-browser', 'fixed-asset', 1, input)).toBe(summary)
  expect(bridge.invoke).toHaveBeenLastCalledWith('browser:runTaskParallel', 'source-browser', 'fixed-asset', 1, input)
  bridge.invoke.mockResolvedValueOnce(inspection)
  expect(await bridge.api!.browser.inspectTaskParallel('source-browser', { operationId: input.operationId, after: 'target-a', limit: 16 })).toBe(inspection)
  expect(bridge.invoke).toHaveBeenLastCalledWith('browser:inspectTaskParallel', 'source-browser', { operationId: input.operationId, after: 'target-a', limit: 16 })
  bridge.invoke.mockResolvedValueOnce(history)
  expect(await bridge.api!.browser.listTaskParallel('source-browser', { before: 'older-original', limit: 16 })).toBe(history)
  expect(bridge.invoke).toHaveBeenLastCalledWith('browser:listTaskParallel', 'source-browser', { before: 'older-original', limit: 16 })
  expect(bridge.invoke).toHaveBeenCalledTimes(3)
})

it('the actual preload preserves exact group stop and independent target continuation identities', async () => {
  const input = { continuationId: 'new-human-intent', expectedRevision: 'a'.repeat(64), parameters: { value: 'fresh' }, calls: { child: { parameters: {}, items: [{ id: 'original-item', parameters: { entry: 'fresh-child' } }] } } }
  bridge.invoke.mockResolvedValueOnce(null)
  expect(await bridge.api!.browser.stopTaskParallel('source-browser', 'original-group')).toBeNull()
  expect(bridge.invoke).toHaveBeenLastCalledWith('browser:stopTaskParallel', 'source-browser', 'original-group')
  const receipt = { run: { operationId: 'original-group' }, continuation: { id: input.continuationId } }
  bridge.invoke.mockResolvedValueOnce(receipt)
  expect(await bridge.api!.browser.continueTaskParallelTarget('source-browser', 'original-group', 'original-target', input)).toBe(receipt)
  expect(bridge.invoke).toHaveBeenLastCalledWith('browser:continueTaskParallelTarget', 'source-browser', 'original-group', 'original-target', input)
  await bridge.api!.browser.inspectTaskParallel('source-browser', { operationId: 'original-group', continuationId: input.continuationId, limit: 16 })
  expect(bridge.invoke).toHaveBeenLastCalledWith('browser:inspectTaskParallel', 'source-browser', { operationId: 'original-group', continuationId: input.continuationId, limit: 16 })
})
