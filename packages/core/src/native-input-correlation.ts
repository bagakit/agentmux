import { randomBytes } from 'node:crypto'
import { validateAgentPromptInputKey, type AgentPromptInputKey } from './agent-prompt-condition.js'

/** Frozen in the original claim before dispatch. Correlation is never an idempotency key or acceptance. */
export function createNativeInputCorrelation(key: AgentPromptInputKey): string {
  return `amux-input-v1.${Buffer.from(JSON.stringify({ key: validateAgentPromptInputKey(key), nonce: randomBytes(24).toString('base64url') })).toString('base64url')}`
}
