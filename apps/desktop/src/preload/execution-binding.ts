import type { IpcRenderer, IpcRendererEvent } from 'electron'
import type { AgentExecutionInspection } from '@agentmux/core'
import { mintObjectId } from '@agentmux/identity'
export function createExecutionBindingApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'off'>) {
  return {
    executionBinding: (bindingId: string): Promise<AgentExecutionInspection | null> => ipc.invoke('sessions:executionBinding', bindingId),
    rejoinExecutionBinding: (bindingId: string): Promise<AgentExecutionInspection> => ipc.invoke('sessions:rejoinExecutionBinding', bindingId),
    observeExecutionBinding(bindingId: string, listener: (value: AgentExecutionInspection | null) => void, onError: (error: string) => void) {
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
