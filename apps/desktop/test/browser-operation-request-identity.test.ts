import { describe, expect, it, vi } from 'vitest'
import { rpcControlRequest } from '../../../packages/core/src/rpc-business-codec.js'
import { DesktopControlIpcBridge } from '../src/main/control-ipc-bridge.js'
import type { DesktopControlRequest } from '../src/shared/contracts.js'

describe('Browser operation addressing while its original request is pending', () => {
  it('lets inspect and stop address the running original operation without colliding with it', async () => {
    const originalId = 'original-browser-operation'
    const run = rpcControlRequest('browser.run', { browserId: 'original-page', code: 'return 7', operationId: originalId })
    const inspect = rpcControlRequest('browser.inspect', { operationId: originalId })
    const stop = rpcControlRequest('browser.stop', { operationId: originalId })
    const sent: DesktopControlRequest[] = []
    const cancel = vi.fn()
    const bridge = new DesktopControlIpcBridge({ isAvailable: () => true, sendRequest: request => { sent.push(request) }, sendCancellation: cancel })
    const running = bridge.execute(run).catch(error => error)
    try {
      expect(run.requestId).toBe(originalId)
      expect([inspect, stop].map(request => request.operation)).toEqual(['browser.operation', 'browser.stop'])
      expect(new Set([run.requestId, inspect.requestId, stop.requestId]).size).toBe(3)
      const read = bridge.execute(inspect)
      const stopped = bridge.execute(stop)
      expect(sent).toEqual([run, inspect, stop])
      expect(inspect).toMatchObject({ operationId: originalId })
      expect(stop).toMatchObject({ operationId: originalId })
      bridge.accept({ requestId: inspect.requestId, ok: true, result: { operation: 'browser.operation', runOperation: null } })
      bridge.accept({ requestId: stop.requestId, ok: true, result: { operation: 'browser.stop', runOperation: null } })
      expect(await read).toMatchObject({ operation: 'browser.operation' })
      expect(await stopped).toMatchObject({ operation: 'browser.stop' })
      expect(cancel).not.toHaveBeenCalled()
      await expect(bridge.execute(run)).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
      expect(sent).toHaveLength(3)
    } finally { bridge.dispose(); await running }
  })

  it('keeps each observation distinct, validates its original target and retains side-effect request identities', () => {
    const reads = [rpcControlRequest('browser.inspect', { operationId: ' original ' }), rpcControlRequest('browser.inspect', { operationId: ' original ' })]
    expect(reads[0]!.requestId).not.toBe(reads[1]!.requestId)
    expect(reads.map(request => Reflect.get(request, 'operationId'))).toEqual([' original ', ' original '])
    for (const method of ['browser.inspect', 'browser.stop'] as const) {
      expect(() => rpcControlRequest(method, { operationId: 'bad\nidentity' })).toThrow('Operation ID')
    }
    expect(rpcControlRequest('browser.run', { browserId: 'page', code: 'return 1', operationId: 'retained-run' }).requestId).toBe('retained-run')
  })
})
