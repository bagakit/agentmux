import type { IpcRenderer, IpcRendererEvent } from 'electron'
import type { AgentExecutionInspection } from '@agentmux/core'
import { mintObjectId } from '@agentmux/identity'
import type { AgentExecutionLegacyLocator, AgentExecutionLegacyObservation, AgentExecutionRecoveryReference, SessionAgentLaunchResult } from '../shared/contracts'
import { unwrapSessionAgentLaunchResult, unconfirmedSessionAgentLaunch } from '../shared/session-agent-launch-result'
export function createExecutionBindingApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'off'>) {
  return {
    resolveExecutionBinding: (input: AgentExecutionLegacyLocator): Promise<AgentExecutionLegacyObservation | null> => ipc.invoke('sessions:resolveExecutionBinding', input),
    executionBinding: (bindingId: string | AgentExecutionRecoveryReference): Promise<AgentExecutionInspection | null> => ipc.invoke('sessions:executionBinding', bindingId),
    rejoinExecutionBinding: (bindingId: string): Promise<AgentExecutionInspection> => ipc.invoke('sessions:rejoinExecutionBinding', bindingId),
    async continueExecution(input: AgentExecutionRecoveryReference) {
      let result: SessionAgentLaunchResult
      try { result = await ipc.invoke('sessions:continueExecution', input) }
      catch (error) { throw unconfirmedSessionAgentLaunch(input.reference, error) }
      return unwrapSessionAgentLaunchResult(result)
    },
    observeExecutionBinding(bindingId: string | AgentExecutionRecoveryReference, listener: (value: AgentExecutionInspection | null) => void, onError: (error: string) => void) {
      const watchId = mintObjectId()
      let closed = false
      const changed = (_event: IpcRendererEvent, value: { watchId: string; inspection: AgentExecutionInspection | null }) => {
        if (!closed && value.watchId === watchId) listener(value.inspection)
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
