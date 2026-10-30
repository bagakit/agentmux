import { AgentMuxError, type AgentExecutionBindingService } from '@agentmux/core'
import type { IpcMainInvokeEvent } from 'electron'
import type { ExecutionBindingReaders } from './execution-binding-readers'
export type ExecutionBindingChannel = 'sessions:executionBinding' | 'sessions:rejoinExecutionBinding' | 'sessions:observeExecutionBinding' | 'sessions:releaseExecutionBinding'
/** Observe or explicitly rejoin the original binding. Agent/helper creation is not exposed. */
export function registerExecutionBindingIpc(args: {
  handle(channel: ExecutionBindingChannel, listener: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown): void
  bindings: Pick<AgentExecutionBindingService, 'inspect' | 'rejoin'>
  readers: ExecutionBindingReaders
}): void {
  const id = (value: unknown): string => {
    if (typeof value !== 'string' || !value || /[\0\r\n]/u.test(value)) throw new AgentMuxError('An exact execution binding is required.', 'INVALID_CONTROL_REQUEST')
    return value
  }
  args.handle('sessions:executionBinding', (event, bindingId) => {
    return args.bindings.inspect(id(bindingId))
  })
  args.handle('sessions:rejoinExecutionBinding', (event, bindingId) => {
    return args.bindings.rejoin(id(bindingId))
  })
  args.handle('sessions:observeExecutionBinding', (event, bindingId, watchId) => {
    return args.readers.observe(event.sender, id(watchId), id(bindingId))
  })
  args.handle('sessions:releaseExecutionBinding', (event, watchId) => {
    args.readers.release(event.sender, id(watchId))
  })
}
