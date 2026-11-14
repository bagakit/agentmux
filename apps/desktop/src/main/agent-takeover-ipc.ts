import type { IpcMainInvokeEvent } from 'electron'
import { AgentMuxError } from '@agentmux/core'
import { parseAgentTakeoverQuery, type AgentTakeoverPage, type AgentTakeoverQuery } from '@agentmux/core/agent-takeover'
import type { RuntimeController } from './runtime-controller.js'

/** Trusted App-document reads use the same original admission inlet as agent.open. */
export function registerAgentTakeoverIpc(options: {
  handleWithEvent(channel: string, handler: (event: IpcMainInvokeEvent, ...input: any[]) => Promise<unknown>): void
  call(method: 'agent.takeover.ls', input: AgentTakeoverQuery): Promise<AgentTakeoverPage>
  runtime: Pick<RuntimeController, 'callOriginalCore'>
}): void {
  options.handleWithEvent('sessions:takeovers', async (_event, input) => options.call('agent.takeover.ls', parseAgentTakeoverQuery(input)))
  options.handleWithEvent('sessions:owner', async (_event, hostId: string, expectedRuntimeId?: string) => {
    const result = await options.runtime.callOriginalCore(hostId, 'runtime.owner.identity',
      expectedRuntimeId === undefined ? {} : { expectedRuntimeId }, { transport: 'unix' })
    if (expectedRuntimeId !== undefined && result.owner.runtimeId !== expectedRuntimeId)
      throw new AgentMuxError('The original Agent Runtime identity is unconfirmed. Its source and work remain available.', 'RUNTIME_OWNER_MISMATCH')
    return result
  })
}
