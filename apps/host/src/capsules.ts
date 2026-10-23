import { AgentMuxError } from '@agentmux/core'
import type { CapsulePort } from '@agentmux/capsule'
import { NodeCapsuleOwner } from '@agentmux/capsule/node'

/** The original Host owns content. A Capsule failure never prevents Agent startup. */
export function hostCapsules(stateDirectory: string | undefined) {
  let reserved = false
  let closed = false
  let owner: Promise<NodeCapsuleOwner> | undefined
  const acquire = async () => {
    if (closed || !reserved || !stateDirectory) throw new AgentMuxError(
      'Capsule hosting requires the original durable Host store. Existing Agents and workfaces remain available.',
      'CONTROL_UNAVAILABLE')
    if (!owner) {
      const opening = NodeCapsuleOwner.open({ stateDirectory })
      owner = opening
      void opening.catch(() => { if (owner === opening) owner = undefined })
    }
    try { return await owner }
    catch (error) {
      throw new AgentMuxError(`Capsule storage is unavailable: ${error instanceof Error ? error.message : String(error)}. Preserve the original store and retry after restoring its availability.`, 'CONTROL_UNAVAILABLE')
    }
  }
  const port: CapsulePort = { call: async (method, params, context) => (await acquire()).call(method, params, context) }
  return {
    port,
    async start() {
      reserved = true
      // Registry/content failures belong to this domain, not the semantic Agent owner.
      try { await acquire() } catch { /* The public port retains the precise failure and recovery. */ }
    },
    async close() {
      closed = true
      if (owner) await (await owner.catch(() => undefined))?.close()
    },
  }
}
