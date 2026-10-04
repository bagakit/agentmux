import { HOOK_COMMAND_TIMEOUT_SECONDS } from './providers/shared.js'

// Two observations and a bounded backoff leave room for stdin/transcript work
// inside the Provider's command deadline. The server uses the same request budget.
export const HOOK_REQUEST_TIMEOUT_MS = HOOK_COMMAND_TIMEOUT_SECONDS * 1_000 * 0.4
export const HOOK_OWNER_TIMEOUT_MS = HOOK_REQUEST_TIMEOUT_MS / 2
export const HOOK_RETRY_DELAY_MS = HOOK_REQUEST_TIMEOUT_MS / 16

/** Observation retries retain the receipt; this never submits Agent input. */
export async function sendHookReceipt(url: string, token: string, body: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let retryable = true
    let retryDelay = HOOK_RETRY_DELAY_MS
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(HOOK_REQUEST_TIMEOUT_MS + HOOK_RETRY_DELAY_MS)
      })
      if (response.ok) return
      const detail = typeof response.text === 'function' ? await response.text() : ''
      const error = new Error(`AgentMux hook ingress rejected: ${response.status}${detail ? ` ${detail}` : ''}`)
      retryable = !(response.status >= 400 && response.status < 500 && response.status !== 429)
      const retryAfter = Number(response.headers?.get('retry-after')) * 1_000
      if (Number.isFinite(retryAfter) && retryAfter > retryDelay) {
        // A longer server backoff cannot be squeezed into a Provider command.
        if (retryAfter > HOOK_REQUEST_TIMEOUT_MS / 4) retryable = false
        else retryDelay = retryAfter
      }
      throw error
    } catch (error) {
      if (!retryable) throw error
      lastError = error
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, retryDelay))
  }
  throw lastError
}

/** Generated Provider plugins execute the same bounded sender without importing Core. */
export function hookDeliverySource(): string {
  return `const HOOK_REQUEST_TIMEOUT_MS = ${HOOK_REQUEST_TIMEOUT_MS}\nconst HOOK_RETRY_DELAY_MS = ${HOOK_RETRY_DELAY_MS}\n${sendHookReceipt.toString()}\n`
}
