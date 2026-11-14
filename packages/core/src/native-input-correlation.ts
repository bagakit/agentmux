import { base64urlnopad } from '@scure/base'
import { validateAgentPromptInputKey, type AgentPromptInputKey } from './agent-prompt-condition.js'

/** Source identity shared by native input planning and original-claim adoption. */
export function nativeInputSourceId(source: { providerId: string; nativeSessionId: string }): string {
  return JSON.stringify([source.providerId, source.nativeSessionId])
}

/** Frozen in the original claim before dispatch. Correlation is never an idempotency key or acceptance. */
export function createNativeInputCorrelation(key: AgentPromptInputKey): string {
  const nonce = base64urlnopad.encode(globalThis.crypto.getRandomValues(new Uint8Array(24)))
  return `amux-input-v1.${base64urlnopad.encode(new TextEncoder().encode(JSON.stringify({ key: validateAgentPromptInputKey(key), nonce })))}`
}

/** An address candidate only. The original complete frozen claim must independently confirm it. */
export function nativeInputCorrelationKey(value: string): AgentPromptInputKey | null {
  if (value.length > 8192 || !/^amux-input-v1\.[A-Za-z0-9_-]+$/u.test(value)) return null
  try {
    const body = value.slice('amux-input-v1.'.length), bytes = base64urlnopad.decode(body)
    if (base64urlnopad.encode(bytes) !== body) return null
    const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || Object.keys(decoded).some(key => key !== 'key' && key !== 'nonce') ||
        typeof decoded.nonce !== 'string' || !/^[A-Za-z0-9_-]{32}$/u.test(decoded.nonce)) return null
    return validateAgentPromptInputKey(decoded.key)
  } catch { return null }
}
