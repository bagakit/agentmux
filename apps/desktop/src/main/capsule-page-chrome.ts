import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError } from '@agentmux/core'
import { parseCapsuleRpcParams, parseCapsuleRpcResult, type CapsulePort } from '@agentmux/core/capsule'
import type { CapsuleRemoteSource } from '../shared/contracts.js'

/** App-only read/draft scope; it grants neither arbitrary remote RPC nor Human input. */
export function capsulePageChrome(ports: {
  source(browserId: string): Promise<{ capsuleId: string; remote?: CapsuleRemoteSource }>
  local: CapsulePort
  remote(source: CapsuleRemoteSource, capsuleId: string): Promise<CapsulePort>
}) {
  return {
    async call(browserId: string, method: unknown, value: unknown) {
      if (typeof browserId !== 'string' || !browserId || !['capsule.inspect', 'capsule.interaction.ls', 'capsule.interaction.inspect', 'capsule.interaction.draft', 'capsule.operation.inspect'].includes(String(method)))
        throw new AgentMuxError('This page chrome supports only original request observations and drafts. Confirm Human input in the original node’s trusted App.', 'CONTROL_PERMISSION_DENIED')
      const m = method as 'capsule.inspect' | 'capsule.interaction.ls' | 'capsule.interaction.inspect' | 'capsule.interaction.draft' | 'capsule.operation.inspect'
      const params = parseCapsuleRpcParams(m, value), source = await ports.source(browserId)
      if ('capsuleId' in params && params.capsuleId !== source.capsuleId) throw new AgentMuxError('This Browser belongs to another original Capsule.', 'CONTROL_PERMISSION_DENIED')
      const client = source.remote ? await ports.remote(source.remote, source.capsuleId) : ports.local
      const result = parseCapsuleRpcResult(m, await client.call(m, params), params)
      if (!isDeepStrictEqual(await ports.source(browserId), source)) throw new AgentMuxError('The Browser source changed during this operation. Inspect its original operation; no input was replayed.', 'CONTROL_UNAVAILABLE')
      if ('operation' in result && result.operation && result.operation.capsuleId !== source.capsuleId)
        throw new AgentMuxError('This original operation belongs to another Capsule.', 'CONTROL_PERMISSION_DENIED')
      return result
    }
  }
}
