import type { IpcRenderer, IpcRendererEvent } from 'electron'
import type { AgentExecutionInspection } from '@agentmux/core'
import { mintObjectId } from '@agentmux/identity'
import type { AgentExecutionLegacyLocator, AgentExecutionLegacyObservation, AgentExecutionRecoveryReference, SessionAgentLaunchResult } from '../shared/contracts'
import { unwrapSessionAgentLaunchResult, unconfirmedSessionAgentLaunch } from '../shared/session-agent-launch-result'
export function createExecutionBindingApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'off'>) {
  return {
    executionCoordinatorTarget: (): Promise<AgentExecutionRecoveryReference['coordinator']> => ipc.invoke('sessions:executionCoordinatorTarget'),
    resolveExecutionBinding: (input: AgentExecutionLegacyLocator): Promise<AgentExecutionLegacyObservation | null> => ipc.invoke('sessions:resolveExecutionBinding', input),
    executionBinding: (bindingId: string | AgentExecutionRecoveryReference, view?: 'association'): Promise<AgentExecutionInspection | null> => view === undefined
      ? ipc.invoke('sessions:executionBinding', bindingId) : ipc.invoke('sessions:executionBinding', bindingId, view),
    rejoinExecutionBinding: (bindingId: string, recoverProject?: true): Promise<AgentExecutionInspection> => recoverProject
      ? ipc.invoke('sessions:rejoinExecutionBinding', bindingId, recoverProject) : ipc.invoke('sessions:rejoinExecutionBinding', bindingId),
    async continueExecution(input: AgentExecutionRecoveryReference) {
      let result: SessionAgentLaunchResult
      try { result = await ipc.invoke('sessions:continueExecution', input) }
      catch (error) { throw unconfirmedSessionAgentLaunch(input.reference, error) }
      return unwrapSessionAgentLaunchResult(result)
    },
    observeExecutionBinding(bindingId: string | AgentExecutionRecoveryReference, listener: (value: AgentExecutionInspection | null) => void, onError: (error: string) => void) {
      const watchId = mintObjectId()
      let closed = false
      const changed = (_event: IpcRendererEvent, value: { watchId: string; inspection?: AgentExecutionInspection | null; error?: string }) => {
        if (!closed && value.watchId === watchId) {
          if (value.error !== undefined) onError(value.error)
          else if ('inspection' in value) listener(value.inspection ?? null)
        }
      }
      ipc.on('sessions:executionBindingChanged', changed)
      void ipc.invoke('sessions:observeExecutionBinding', bindingId, watchId).catch(error => { if (!closed) onError(error instanceof Error ? error.message : String(error)) })
      return () => {
        closed = true
        ipc.off('sessions:executionBindingChanged', changed)
        void ipc.invoke('sessions:releaseExecutionBinding', watchId).catch(() => {})
      }
    }
  }
}
