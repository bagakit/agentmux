import type { IpcMainInvokeEvent } from 'electron'
import { AgentMuxError } from '@agentmux/core'
import { parseAgentTakeoverQuery, parseAgentTakeoverCancellation } from '@agentmux/core/agent-takeover'
import type { AgentMuxRpcParams, AgentMuxRpcResult } from '@agentmux/core'
import type { RuntimeController } from './runtime-controller.js'

/** Trusted App-document reads use the same original admission inlet as agent.open. */
export function registerAgentTakeoverIpc(options: {
  handleWithEvent(channel: string, handler: (event: IpcMainInvokeEvent, ...input: any[]) => Promise<unknown>): void
  call<M extends 'agent.takeover.ls' | 'agent.takeover.cancel' | 'agent.takeover.cancel.inspect'>(method: M, input: AgentMuxRpcParams<M>): Promise<AgentMuxRpcResult<M>>
  runtime: Pick<RuntimeController, 'callOriginalCore'>
}): void {
  options.handleWithEvent('sessions:takeovers', async (_event, input) => options.call('agent.takeover.ls', parseAgentTakeoverQuery(input)))
  options.handleWithEvent('sessions:takeoverCancel', async (_event, input) => options.call('agent.takeover.cancel', parseAgentTakeoverCancellation(input)))
  options.handleWithEvent('sessions:takeoverCancelInspect', async (_event, input) => options.call('agent.takeover.cancel.inspect', parseAgentTakeoverCancellation(input)))
  options.handleWithEvent('sessions:owner', async (_event, hostId: string, expectedRuntimeId?: string) => {
    const result = await options.runtime.callOriginalCore(hostId, 'runtime.owner.identity',
      expectedRuntimeId === undefined ? {} : { expectedRuntimeId }, { transport: 'unix' })
    if (expectedRuntimeId !== undefined && result.owner.runtimeId !== expectedRuntimeId)
      throw new AgentMuxError('The original Agent Runtime identity is unconfirmed. Its source and work remain available.', 'RUNTIME_OWNER_MISMATCH')
    return result
  })
}
