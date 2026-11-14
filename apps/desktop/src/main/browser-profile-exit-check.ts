import type { Session } from 'electron'
import { isIP } from 'node:net'
import type { BrowserProfileExitCheck } from '../shared/contracts.js'

/**
 * One explicit request through a Profile's own session, to see where its route actually reaches.
 *
 * The person names an HTTPS address in Settings › Browser (nothing is checked until they do). Check
 * sends one GET through the Profile's session, so it takes the same proxy, connections and certificates
 * as that Profile's pages. The result is what the request saw: reachable or not, the HTTP status, the
 * time it took, and the address only when the body is nothing but an IP address. There is no history,
 * no country or timezone guess, and a failed check is reported as unknown; it never blocks a page.
 */

const CHECK_TIMEOUT_MS = 10_000
const BODY_LIMIT = 256

export class BrowserProfileExitCheckInvalid extends Error {
  readonly code = 'BROWSER_PROFILE_EXIT_CHECK_INVALID'
}

/** The check address must be HTTPS without credentials, so nothing secret travels in it. */
export function validBrowserProfileExitCheckUrl(value: string): boolean {
  if (!value) return true
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && value.length <= 2048
  } catch { return false }
}

function plainAddress(body: string): string | undefined {
  const text = body.trim()
  return isIP(text) ? text.toLowerCase() : undefined
}

async function responseAddress(response: Response): Promise<string | undefined> {
  if (!response.body) return undefined
  const reader = response.body.getReader(), parts: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > BODY_LIMIT) { void reader.cancel().catch(() => {}); return undefined }
      parts.push(next.value)
    }
    return plainAddress(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)))
  } finally { reader.releaseLock() }
}

export type BrowserProfileExitCheckPorts = {
  session(profileId: string): Session
  /** Applies the Profile's route first, so the check never runs on a route its pages would not use. */
  prepare(profileId: string): Promise<void> | undefined
  fetch?(profileId: string, address: string, signal: AbortSignal): Promise<Response>
  now(): number
}

export function createBrowserProfileExitCheck(ports: BrowserProfileExitCheckPorts) {
  return async (profileId: string, address: string): Promise<BrowserProfileExitCheck> => {
    if (!address) throw new BrowserProfileExitCheckInvalid('Set a check address in Settings › Browser first, then Check.')
    if (!validBrowserProfileExitCheckUrl(address)) throw new BrowserProfileExitCheckInvalid('The check address must be an https:// address without a user name or password.')
    const target = ports.session(profileId)
    await ports.prepare(profileId)
    const started = ports.now()
    try {
      const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS)
      const response = await (ports.fetch ? ports.fetch(profileId, address, signal) : target.fetch(address, { method: 'GET', cache: 'no-store', redirect: 'follow', signal }))
      const latencyMs = ports.now() - started
      let ip: string | undefined
      try { ip = await responseAddress(response) } catch { /* the status alone is still the answer */ }
      return { status: 'reachable', httpStatus: response.status, latencyMs, ...(ip ? { ip } : {}) }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      const reason = /TimeoutError|aborted/i.test(cause instanceof Error ? cause.name + ' ' + message : message)
        ? `No answer within ${CHECK_TIMEOUT_MS / 1000} seconds.` : message.replace(/^net::/, '')
      return { status: 'unknown', reason, latencyMs: ports.now() - started }
    }
  }
}
export type BrowserProfileExitChecker = ReturnType<typeof createBrowserProfileExitCheck>
