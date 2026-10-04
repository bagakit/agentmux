import { AgentMuxError } from './errors.js'
import { AGENT_MESSAGE_CHANNELS, type AgentMessageChannel } from './types.js'

export function normalizeMessageChannel(value: unknown): AgentMessageChannel {
  if (typeof value !== 'string' || !AGENT_MESSAGE_CHANNELS.some(channel => channel === value)) {
    throw new AgentMuxError('Message channel is invalid. Nothing was submitted.', 'INVALID_AGENT_PROMPT')
  }
  return value as AgentMessageChannel
}
