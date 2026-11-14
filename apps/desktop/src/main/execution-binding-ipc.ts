import { resolveOriginalExecutionBinding } from './execution-binding-reference'
import { AgentMuxError, parseAgentExecutionReference, type AgentExecutionBindingService } from '@agentmux/core'
import type { IpcMainInvokeEvent } from 'electron'
import type { ExecutionBindingReaders } from './execution-binding-readers'
import type { AgentExecutionRecoveryReference, AgentLaunchResult } from '../shared/contracts'
import { sessionAgentLaunchResult } from '../shared/session-agent-launch-result'
export type ExecutionBindingChannel = 'sessions:resolveExecutionBinding' | 'sessions:executionBinding' | 'sessions:rejoinExecutionBinding' | 'sessions:observeExecutionBinding' | 'sessions:releaseExecutionBinding' | 'sessions:continueExecution'
/** Observe or explicitly rejoin the original binding. Agent/helper creation is not exposed. */
export function registerExecutionBindingIpc(args: {
  handle(channel: ExecutionBindingChannel, listener: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown): void
  bindings: Pick<AgentExecutionBindingService, 'inspect' | 'rejoin' | 'continueOriginal'>
  readers: ExecutionBindingReaders
  coordinatorTarget(): Promise<AgentExecutionRecoveryReference['coordinator']>
  coordinator(target: AgentExecutionRecoveryReference['coordinator']): Promise<void>
  project(hostId: string, session: AgentLaunchResult['created']): Promise<AgentLaunchResult>
}): void {
  const id = (value: unknown): string => {
    if (typeof value !== 'string' || !value || /[\0\r\n]/u.test(value)) throw new AgentMuxError('An exact execution binding is required.', 'INVALID_CONTROL_REQUEST')
    return value
  }
  const original = (value: unknown): AgentExecutionRecoveryReference => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentMuxError('The original Coordinator reference is required.', 'INVALID_CONTROL_REQUEST')
    const source = value as AgentExecutionRecoveryReference
    const reference = parseAgentExecutionReference(source.reference)
    return { coordinator: { hostId: id(source.coordinator?.hostId), runtimeId: id(source.coordinator?.runtimeId) }, reference }
  }
  const binding = async (value: unknown): Promise<string> => {
    if (typeof value === 'string') return id(value)
    const target = original(value)
    await args.coordinator(target.coordinator)
    return target.reference.bindingId
  }
  args.handle('sessions:resolveExecutionBinding', (_event, input) => resolveOriginalExecutionBinding(input, {
    inspect: bindingId => args.bindings.inspect(bindingId), coordinatorTarget: args.coordinatorTarget, assertCoordinator: args.coordinator
  }))
  args.handle('sessions:executionBinding', async (event, target, view) => {
    if (view !== undefined && view !== 'association') throw new AgentMuxError('Choose the original binding or its association witness view.', 'INVALID_CONTROL_REQUEST')
    return args.bindings.inspect(await binding(target), view)
  })
  args.handle('sessions:rejoinExecutionBinding', (event, bindingId) => {
    return args.bindings.rejoin(id(bindingId))
  })
  args.handle('sessions:observeExecutionBinding', async (event, target, watchId) => {
    return args.readers.observe(event.sender, id(watchId), await binding(target))
  })
  args.handle('sessions:releaseExecutionBinding', (event, watchId) => {
    args.readers.release(event.sender, id(watchId))
  })
  args.handle('sessions:continueExecution', async (event, value) => {
    const target = original(value)
    return sessionAgentLaunchResult(target.reference, async () => {
      await args.coordinator(target.coordinator)
      try {
        const result = await args.bindings.continueOriginal(target.reference)
        if (result.session.agentSessionId !== target.reference.agentSessionId || result.session.creation?.createOperationId !== target.reference.createOperationId)
          throw new AgentMuxError('The continuation did not confirm this original Session and creation.', 'AGENT_LAUNCH_IDENTITY_MISMATCH')
        return await args.project(result.execution.agentHostId, result.session)
      } catch (error) {
        if (error instanceof AgentMuxError && error.executionFailure) Object.assign(error, {
          executionRecovery: { ...target, failure: error.executionFailure }
        })
        throw error
      }
    })
  })
}
