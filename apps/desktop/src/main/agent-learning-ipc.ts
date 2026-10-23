import { AgentMuxError } from '@agentmux/core'
import { isAgentLearningMethod, parseAgentLearningParams } from '@agentmux/core/agent-learning'
import { sessionInputOperationResult } from '../shared/session-input-result.js'
import type { AgentLearningAuthority } from './agent-learning-authority.js'
import type { RuntimeController } from './runtime-controller.js'
import { assertSenderTrusted, senderTrust } from './ipc-sender-trust.js'

/** Original App transport boundary; only its actual main-frame action opens a live confirmation. */
function createAgentLearningIpc(options: {
  mainFrame(): unknown
  runtime: Pick<RuntimeController, 'callOriginalCore'>
  authority: AgentLearningAuthority
}) {
  return {
    call: (method: unknown, value: unknown) => sessionInputOperationResult(async () => {
      if (!isAgentLearningMethod(method) || method === 'agent.learning.confirm' || method === 'agent.learning.confirmation')
        throw new AgentMuxError('Use the actual App confirmation action for reviewed learning. Existing Agents and drafts are kept.', 'CONTROL_PERMISSION_DENIED')
      return options.runtime.callOriginalCore('local', method, parseAgentLearningParams(method, value), { transport: 'unix', principal: { kind: 'user', id: `local-user:${process.getuid?.() ?? 'current'}` } })
    }),
    confirm: (senderFrame: unknown, value: unknown) => {
      if (senderFrame !== options.mainFrame()) throw new Error('The original App main frame must confirm this learning scope.')
      return sessionInputOperationResult(() => options.authority.confirm(value))
    }
  }
}

type LearningIpcEvent = { sender: unknown; senderFrame: unknown }

/** Register the actual native consumers together with their original window authority. */
export function registerAgentLearningIpc(options: {
  handle(channel: string, listener: (event: LearningIpcEvent, ...values: unknown[]) => unknown): void
  contents: { mainFrame: unknown }
  runtime: Pick<RuntimeController, 'callOriginalCore'>
  authority: AgentLearningAuthority
}): void {
  const ipc = createAgentLearningIpc({ mainFrame: () => options.contents.mainFrame, runtime: options.runtime, authority: options.authority })
  options.handle('agentLearning:call', (event, method, value) => {
    assertSenderTrusted(senderTrust('agentLearning:call', event.sender, options.contents))
    return ipc.call(method, value)
  })
  options.handle('agentLearning:confirm', (event, value) => {
    assertSenderTrusted(senderTrust('agentLearning:confirm', event.sender, options.contents))
    return ipc.confirm(event.senderFrame, value)
  })
}
