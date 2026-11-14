import type { MeshNetworkMethod, MeshNetworkParams, MeshNetworkResults, MeshOwner } from '@agentmux/core/mesh-network'
import type { SessionInputOperationResult } from './contracts'

export type MeshCallOptions = { signal?: AbortSignal; expectedOwner?: MeshOwner }
export type DesktopMeshNetworkPort = {
  call<M extends MeshNetworkMethod>(method: M, params: MeshNetworkParams[M], options?: MeshCallOptions): Promise<MeshNetworkResults[M]>
}
export type MeshNetworkPreloadPort = {
  call<M extends MeshNetworkMethod>(method: M, params: MeshNetworkParams[M], context?: {
    expectedOwner?: MeshOwner; onAbort?: (cancel: () => void) => () => void
  }): Promise<SessionInputOperationResult<MeshNetworkResults[M]>>
}
