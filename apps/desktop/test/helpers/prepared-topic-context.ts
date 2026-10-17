import { composeAgentLaunchPrompt } from '@agentmux/core/agent-outbound-message'
import type { PreparedScratchAgentTopic } from '../../src/main/scratch-topics'

export function preparedContext(prepared: PreparedScratchAgentTopic): string {
  return composeAgentLaunchPrompt(undefined, false, prepared.prompt, prepared.optionalContext).systemContext ?? ''
}
