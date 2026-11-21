import type { IpcMainInvokeEvent } from 'electron'
import { isMeshNetworkMethod, parseMeshNetworkParams, parseMeshNetworkResult, type MeshNetworkMethod, type MeshNetworkParams, type MeshNetworkResults, type MeshOwner } from '@agentmux/core/mesh-network'
import { SessionHistoryReadOwners } from './session-history-read.js'
import { sessionInputOperationResult } from '../shared/session-input-result.js'

function fence(value: unknown): MeshOwner | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The original Mesh Core fence is unconfirmed.')
  const p = value as Record<string, unknown>
  if (Object.keys(p).length !== 2 || Object.keys(p).some(key => !['runtimeId', 'ownerInstanceId'].includes(key)) ||
      typeof p.runtimeId !== 'string' || !p.runtimeId || typeof p.ownerInstanceId !== 'string' || !p.ownerInstanceId) throw new Error('The original Mesh Core fence is unconfirmed.')
  return { runtimeId: p.runtimeId, ownerInstanceId: p.ownerInstanceId }
}

/** Fixed original-Core methods; trusted sender and Runtime fences never come from business input. */
export function registerMeshNetworkIpc(ports: {
  handle<T extends unknown[], R>(channel: string, listener: (event: IpcMainInvokeEvent, ...values: T) => R | Promise<R>): void
  call<M extends MeshNetworkMethod>(method: M, params: MeshNetworkParams[M], context: { signal: AbortSignal; runtimeFence?: MeshOwner }): Promise<MeshNetworkResults[M]>
  separate?<M extends MeshNetworkMethod>(runtimeId: string, method: M, params: MeshNetworkParams[M], context: { signal: AbortSignal; runtimeFence?: MeshOwner }): Promise<MeshNetworkResults[M]>
}) {
  const reads = new SessionHistoryReadOwners()
  ports.handle('mesh:call', (event, token: string, method: unknown, value: unknown, expectedOwner: unknown, separateRuntimeId?: unknown) => sessionInputOperationResult(async () => {
    let params: MeshNetworkParams[MeshNetworkMethod], original: MeshOwner | undefined
    try {
      if (!isMeshNetworkMethod(method)) throw new Error('Unknown Mesh network method.')
      params = parseMeshNetworkParams(method, value); original = fence(expectedOwner)
      if (separateRuntimeId !== undefined && (typeof separateRuntimeId !== 'string' || !separateRuntimeId.trim() || separateRuntimeId.length > 200 ||
          params.target || !ports.separate || original && original.runtimeId !== separateRuntimeId)) {
        throw new Error('Read the selected Mesh identity again before using its settings.')
      }
      if (original && params.target && params.target.hostId !== 'local') {
        if (original.runtimeId !== params.target.expectedRuntimeId || params.target.expectedOwnerInstanceId && original.ownerInstanceId !== params.target.expectedOwnerInstanceId) throw new Error('Read the selected Mesh Core again before applying its settings.')
        params.target = { ...params.target, expectedOwnerInstanceId: original.ownerInstanceId }
      }
      if (method === 'settings.mesh.configure' && !original) throw new Error('Read the original Core settings before saving this Mesh draft.')
    } catch (cause) { throw Object.assign(new Error(cause instanceof Error ? cause.message : String(cause)), { code: 'CONTROL_INVALID_REQUEST', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } }) }
    if (!isMeshNetworkMethod(method)) throw new Error('Unknown Mesh network method.')
    // A selected Host checks its own fence at the destination. A local fence belongs to the entry Core.
    if (params.target && params.target.hostId !== 'local') original = undefined
    const result = await reads.read(event.sender, token, signal => {
      const context = { signal, ...(original ? { runtimeFence: original } : {}) }
      return typeof separateRuntimeId === 'string' ? ports.separate!(separateRuntimeId, method, params, context) : ports.call(method, params, context)
    })
    return parseMeshNetworkResult(method, result, params)
  }))
  ports.handle('mesh:cancel', (event, token: string) => reads.cancel(event.sender.id, token))
  return { dispose: () => reads.dispose() }
}
