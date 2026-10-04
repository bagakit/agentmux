import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { registerToolkitIpc } from '../src/main/toolkit-ipc.js'
import { deepMetricsSnapshot } from '../../../packages/core/test/helpers/toolkit-metrics.js'
import { TOOLKIT_CHANGED_CHANNEL, TOOLKIT_ENDED_CHANNEL } from '../src/shared/contracts.js'

it('retains available deep metrics through actual Desktop get/observe and releases only its reader', async () => {
  const snapshot = deepMetricsSnapshot(), dispose = vi.fn(), handlers = new Map<string, (...args: any[]) => any>()
  let push: (value: any) => void = () => {}
  const stop = registerToolkitIpc({ execute: async () => ({ operation: 'toolkit.get', snapshot }),
    subscribe: async (_id, callback) => { push = callback; callback(snapshot); return { dispose } } }, (channel, handler) => handlers.set(channel, handler))
  const sender = Object.assign(new EventEmitter(), { id: 11, isDestroyed: () => false, send: vi.fn() })
  const event = { sender }
  try {
    expect(await handlers.get('toolkit:get')!(event, 'performance')).toEqual({ operation: 'toolkit.get', snapshot })
    expect(await handlers.get('toolkit:observe')!(event, 'performance', 'reader')).toEqual({ id: 'reader' })
    expect(sender.send).toHaveBeenCalledWith(TOOLKIT_CHANGED_CHANNEL, { id: 'reader', snapshot })
    expect(sender.send.mock.calls.some(([channel]) => channel === TOOLKIT_ENDED_CHANNEL)).toBe(false)
    handlers.get('toolkit:release')!(event, 'reader'); handlers.get('toolkit:release')!(event, 'reader')
    expect(dispose).toHaveBeenCalledOnce()
    const previous = sender.send.mock.calls.length; push({ ...snapshot, sequence: 2 })
    expect(sender.send).toHaveBeenCalledTimes(previous)
  } finally { stop() }
})
