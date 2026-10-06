import { request as httpRequest } from 'node:http'
import { HOOK_COMMAND_TIMEOUT_SECONDS } from './providers/shared.js'

// Two observations and a bounded backoff leave room for stdin/transcript work
// inside the Provider's command deadline. The server uses the same request budget.
export const HOOK_REQUEST_TIMEOUT_MS = HOOK_COMMAND_TIMEOUT_SECONDS * 1_000 * 0.4
export const HOOK_OWNER_TIMEOUT_MS = HOOK_REQUEST_TIMEOUT_MS / 2
export const HOOK_RETRY_DELAY_MS = HOOK_REQUEST_TIMEOUT_MS / 16

/** Observation retries retain the receipt; this never submits Agent input. */
export async function sendHookReceipt(url: string, token: string, body: string, startAttempt = 0): Promise<void> {
  let lastError: unknown
  for (let attempt = startAttempt; attempt < 2; attempt += 1) {
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

/** One original synchronous callback. Failure abstains; decisions are never retried onto another invocation. */
export async function requestHookPermissionDecision(url: string, token: string, body: string): Promise<Record<string, unknown>> {
  // Until Core confirms this exact original callback, retain the ordinary observation budget.
  // After that response header, Native alone owns the synchronous human decision deadline.
  // fetch has its own implicit human deadline; this one original HTTP connection has no retries.
  return await new Promise((resolve, reject) => {
    const observation = setTimeout(() => request.destroy(new Error('AgentMux Hook decision mode was not confirmed within the observation budget.')),
      HOOK_REQUEST_TIMEOUT_MS + HOOK_RETRY_DELAY_MS)
    const request = httpRequest(url, { method: 'POST', agent: false,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    }, response => {
      clearTimeout(observation)
      if (response.statusCode !== 200 || response.headers['x-agentmux-hook-mode'] !== 'decision') {
        response.destroy()
        if (response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300) resolve({})
        else if (response.headers['x-agentmux-hook-mode'] === 'observer' &&
            (response.statusCode === 429 || response.statusCode !== undefined && response.statusCode >= 500)) {
          // Core confirmed this original receipt is observational. Reuse only its remaining
          // attempt; an unknown/decision mode can never recreate a synchronous callback.
          const retryAfter = Number(response.headers['retry-after']) * 1_000
          if (Number.isFinite(retryAfter) && retryAfter > HOOK_REQUEST_TIMEOUT_MS / 4) {
            reject(new Error('AgentMux Hook observation backoff exceeds its command budget.'))
          } else {
            setTimeout(() => { void sendHookReceipt(url, token, body, 1).then(() => resolve({}), reject) },
              Number.isFinite(retryAfter) ? Math.max(HOOK_RETRY_DELAY_MS, retryAfter) : HOOK_RETRY_DELAY_MS)
          }
        } else reject(new Error(`AgentMux Hook decision mode unavailable: ${response.statusCode}`))
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength
        // Control replies contain only a declared decision, not transcripts/tool output.
        if (bytes > 128 * 1024) response.destroy(new Error('AgentMux Hook decision exceeds the control reply budget.'))
        else chunks.push(chunk)
      })
      response.once('error', reject)
      response.once('aborted', () => reject(new Error('The original Hook decision connection ended before its reply.')))
      response.once('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error(`AgentMux Hook decision unavailable: ${response.statusCode}`)
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AgentMux Hook decision is malformed.')
          resolve(value as Record<string, unknown>)
        } catch (error) { reject(error) }
      })
    })
    request.once('error', error => { clearTimeout(observation); reject(error) })
    request.end(body)
  })
}
