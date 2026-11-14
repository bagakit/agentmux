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
}) {
  const reads = new SessionHistoryReadOwners()
  ports.handle('mesh:call', (event, token: string, method: unknown, value: unknown, expectedOwner: unknown) => sessionInputOperationResult(async () => {
    let params: MeshNetworkParams[MeshNetworkMethod], original: MeshOwner | undefined
    try {
      if (!isMeshNetworkMethod(method)) throw new Error('Unknown Mesh network method.')
      params = parseMeshNetworkParams(method, value); original = fence(expectedOwner)
      if (method === 'settings.mesh.configure' && !original) throw new Error('Read the original Core settings before saving this Mesh draft.')
    } catch (cause) { throw Object.assign(new Error(cause instanceof Error ? cause.message : String(cause)), { code: 'CONTROL_INVALID_REQUEST', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } }) }
    if (!isMeshNetworkMethod(method)) throw new Error('Unknown Mesh network method.')
    const result = await reads.read(event.sender, token, signal => ports.call(method, params, { signal, ...(original ? { runtimeFence: original } : {}) }))
    return parseMeshNetworkResult(method, result, params)
  }))
  ports.handle('mesh:cancel', (event, token: string) => reads.cancel(event.sender.id, token))
  return { dispose: () => reads.dispose() }
}
