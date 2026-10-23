import { AgentMuxError, type AgentMuxRpcCallContext } from '@agentmux/core'
import type { ConnectionSecrets } from '@agentmux/connectors'
import type { ConnectionCredentialPort } from '@agentmux/core/connections'

/** One exact Host authorizes the original private SQLite owner; no key service or sealed protocol. */
export function createCredentialAdministration(options: { target: NonNullable<AgentMuxRpcCallContext['runtimeFence']>; secrets: Pick<ConnectionSecrets, 'store' | 'inspect'> }): ConnectionCredentialPort {
  const authorized = async (context: AgentMuxRpcCallContext, write = false) => {
    context.signal?.throwIfAborted()
    if (context.caller || !context.principal || !['user', 'device'].includes(context.principal.kind) || !context.principal.id || !context.runtimeFence || context.runtimeFence.runtimeId !== options.target.runtimeId || context.runtimeFence.ownerInstanceId !== options.target.ownerInstanceId) {
      throw new AgentMuxError('Credential administration requires the original authenticated person or device on this exact Host instance.', 'CONTROL_PERMISSION_DENIED')
    }
    if (write && context.transport !== 'unix' && context.transport !== 'relay') throw new AgentMuxError('Credential entry requires the original protected Unix, SSH-to-Unix or end-to-end relay transport. Other Host capabilities remain available.', 'CONTROL_PERMISSION_DENIED')
    await context.assertCurrent?.()
    context.signal?.throwIfAborted()
  }
  return {
    inspect: async (input, context) => {
      await authorized(context)
      const receipt = await options.secrets.inspect(input.operationId)
      await authorized(context)
      return { receipt }
    },
    store: async (input, context) => {
      await authorized(context, true)
      return await options.secrets.store(input, () => authorized(context, true))
    }
  }
}
