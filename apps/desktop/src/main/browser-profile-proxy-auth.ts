import type { Session, WebContents } from 'electron'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { durableWriteFile } from '@agentmux/core'
import { z } from 'zod'

/**
 * Sign-in for a Profile's proxy, and nothing else.
 *
 * The password is encrypted with the system keychain (Electron safeStorage) and written to its own
 * file, never to Profile metadata, settings, logs or the Renderer. It is decrypted only inside the
 * app 'login' callback, for a proxy challenge from a page whose session is that Profile's, at the
 * host and port of that Profile's own proxy, and handed straight to Chromium. A wrong password gets
 * one retry; the second refusal stops answering so the page shows the proxy's 407 and the Profile
 * says why, instead of looping. A server's own sign-in (not a proxy) is never answered from here.
 */
export type BrowserProfileProxyCredential = { username: string; password: string }

export type BrowserProfileProxyAuthPorts = {
  /** Encryption from the system keychain; unavailable means no password can be kept. */
  crypto: { available(): boolean; encrypt(text: string): Buffer; decrypt(data: Buffer): string }
  /** Where encrypted sign-ins live, one file for all Profiles. */
  path: string
  /** The Profile whose session this is, if any. */
  profileOfSession(session: Session): string | null
  /** That Profile's proxy server, if its route is a proxy. */
  proxyOf(profileId: string): { host: string; port: number } | null
  /** A short, password-free reason for the Profile's network line. */
  report(profileId: string, reason: string | null): void
}

const storedSchema = z.object({
  version: z.literal(1),
  profiles: z.record(z.string(), z.object({ username: z.string(), password: z.string() }).strict())
}).strict()
type Stored = z.infer<typeof storedSchema>

const STORAGE_UNAVAILABLE = 'Saved proxy sign-ins could not be read. Their data is kept. Retry after the original file is readable and valid.'

export class BrowserProfileProxyAuthUnavailable extends Error {
  readonly code = 'BROWSER_PROFILE_PROXY_AUTH_UNAVAILABLE'
}

export function createBrowserProfileProxyAuth(ports: BrowserProfileProxyAuthPorts) {
  let stored: Stored | null = null
  let tail: Promise<unknown> = Promise.resolve()
  // Answered challenges per Profile and proxy; a second refusal in a row stops answering.
  const attempts = new Map<string, number>()

  async function read(): Promise<Stored> {
    if (stored) return stored
    try {
      stored = storedSchema.parse(JSON.parse(await readFile(ports.path, 'utf8')))
    } catch (cause) {
      // Only a missing file is an empty set. Unknown data stays on disk and is read again on Retry.
      if ((cause as NodeJS.ErrnoException)?.code !== 'ENOENT') throw new BrowserProfileProxyAuthUnavailable(STORAGE_UNAVAILABLE)
      stored = { version: 1, profiles: {} }
    }
    return stored
  }
  async function write(next: Stored): Promise<void> {
    await mkdir(dirname(ports.path), { recursive: true })
    await durableWriteFile(ports.path, `${JSON.stringify(next)}\n`)
    stored = next
  }
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.catch(() => {}).then(work)
    tail = result.catch(() => {})
    return result
  }

  return {
    /** Keep a sign-in for this Profile's proxy. The password is encrypted before it reaches disk. */
    set(profileId: string, credential: BrowserProfileProxyCredential): Promise<void> {
      return serial(async () => {
        if (!ports.crypto.available()) {
          throw new BrowserProfileProxyAuthUnavailable('The system keychain is not available, so a proxy password cannot be kept. The Profile and its route are unchanged.')
        }
        const username = credential.username.trim()
        if (!username || username.length > 256 || credential.password.length > 1024) throw new BrowserProfileProxyAuthUnavailable('Enter a user name and a password for the proxy.')
        const current = await read()
        let password: string
        try { password = ports.crypto.encrypt(credential.password).toString('base64') }
        catch { throw new BrowserProfileProxyAuthUnavailable('The proxy password could not be encrypted by the system keychain. Nothing was saved; retry when the keychain is available.') }
        await write({ version: 1, profiles: { ...current.profiles, [profileId]: { username, password } } })
        for (const key of [...attempts.keys()]) if (key.startsWith(profileId + '\0')) attempts.delete(key)
        ports.report(profileId, null)
      })
    },

    /** Forget the sign-in, for example when the Profile is deleted or its route stops being a proxy. */
    clear(profileId: string): Promise<void> {
      return serial(async () => {
        const current = await read()
        if (!(profileId in current.profiles)) return
        const { [profileId]: _removed, ...rest } = current.profiles
        await write({ version: 1, profiles: rest })
      })
    },

    /** Forget every sign-in whose Profile is not in this set, for example after a delete or a route change. */
    forgetExcept(profileIds: ReadonlySet<string>): Promise<void> {
      return serial(async () => {
        const current = await read()
        const kept = Object.fromEntries(Object.entries(current.profiles).filter(([id]) => profileIds.has(id)))
        if (Object.keys(kept).length === Object.keys(current.profiles).length) return
        await write({ version: 1, profiles: kept })
      })
    },

    /** The user name only, so the editor can show who signs in without ever reading the password. */
    async username(profileId: string): Promise<string | null> {
      return (await read()).profiles[profileId]?.username ?? null
    },

    /**
     * The app 'login' handler. Returns true when it answered; otherwise Chromium keeps its default,
     * which cancels the challenge.
     */
    async answer(contents: WebContents | null, authInfo: { isProxy: boolean; host: string; port: number },
      callback: (username?: string, password?: string) => void, firstAttempt = false): Promise<boolean> {
      if (!authInfo.isProxy || !contents || contents.isDestroyed()) return false
      const profileId = ports.profileOfSession(contents.session)
      if (!profileId) return false
      const proxy = ports.proxyOf(profileId)
      // Only that Profile's own proxy; a challenge from any other host never sees the password.
      if (!proxy || proxy.host !== authInfo.host.toLowerCase() || proxy.port !== authInfo.port) return false
      let entry: Stored['profiles'][string] | undefined
      try { entry = (await read()).profiles[profileId] }
      catch { ports.report(profileId, STORAGE_UNAVAILABLE); return false }
      if (!entry) { ports.report(profileId, 'The proxy asks for a sign-in. Add its user name and password to this Profile.'); return false }
      const key = `${profileId}\0${proxy.host}:${proxy.port}`
      // Chromium marks the first challenge of a request; a fresh request after a working sign-in starts counting again.
      if (firstAttempt) attempts.delete(key)
      const tries = (attempts.get(key) ?? 0) + 1
      if (tries > 2) { ports.report(profileId, 'The proxy refused this Profile’s user name or password. Update them and reload the page.'); return false }
      attempts.set(key, tries)
      let password: string
      try { password = ports.crypto.decrypt(Buffer.from(entry.password, 'base64')) }
      catch { ports.report(profileId, 'The saved proxy password could not be read from the keychain. Enter it again.'); return false }
      callback(entry.username, password)
      return true
    },

  }
}
export type BrowserProfileProxyAuth = ReturnType<typeof createBrowserProfileProxyAuth>
