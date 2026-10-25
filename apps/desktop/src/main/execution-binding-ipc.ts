import { AgentMuxError, type AgentExecutionBindingService } from '@agentmux/core'
import type { IpcMainInvokeEvent } from 'electron'
import type { ExecutionBindingReaders } from './execution-binding-readers'
export type ExecutionBindingChannel = 'sessions:executionBinding' | 'sessions:observeExecutionBinding' | 'sessions:releaseExecutionBinding'
/** Register readers on the existing binding owner. No lifecycle or creation is exposed. */
export function registerExecutionBindingIpc(args: {
  handle(channel: ExecutionBindingChannel, listener: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown): void
  assertTrusted(channel: ExecutionBindingChannel, event: IpcMainInvokeEvent): void
  bindings: Pick<AgentExecutionBindingService, 'inspect'>
  readers: ExecutionBindingReaders
}): void {
  const id = (value: unknown): string => {
    if (typeof value !== 'string' || !value || /[\0\r\n]/u.test(value)) throw new AgentMuxError('An exact execution binding is required.', 'INVALID_CONTROL_REQUEST')
    return value
  }
  args.handle('sessions:executionBinding', (event, bindingId) => {
    args.assertTrusted('sessions:executionBinding', event)
    return args.bindings.inspect(id(bindingId))
  })
  args.handle('sessions:observeExecutionBinding', (event, bindingId, watchId) => {
    args.assertTrusted('sessions:observeExecutionBinding', event)
    return args.readers.observe(event.sender, id(watchId), id(bindingId))
  })
  args.handle('sessions:releaseExecutionBinding', (event, watchId) => {
    args.assertTrusted('sessions:releaseExecutionBinding', event)
    args.readers.release(event.sender, id(watchId))
  })
}
