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
  /** Configuration identity for Main-private protocol probes; absence never changes page login. */
  configurationRevision?(profileId: string): string | null
  /** A short, password-free reason for the Profile's network line. */
  report(profileId: string, reason: string | null): void
}

const storedSchema = z.object({
  version: z.literal(1),
  profiles: z.record(z.string(), z.object({ username: z.string(), password: z.string(), proxy: z.object({ host: z.string(), port: z.number().int().min(1).max(65535) }).strict().nullable().optional() }).strict())
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
  // Current authentication observations live here only, never in Profile metadata or operation history.
  const issues = new Map<string, { proxy: { host: string; port: number }; source: 'storage' | 'authentication'; reason: string }>()
  const sameProxy = (left: { host: string; port: number } | null, right: { host: string; port: number }) =>
    left?.host === right.host && left.port === right.port

  function notify(profileId: string, reason: string | null): void {
    try { ports.report(profileId, reason) }
    catch {
      console.warn('The proxy sign-in notice delivery is unconfirmed. Read the original Profile owner for its current issue; confirmed credential saves remain valid.')
    }
  }

  function report(profileId: string, reason: string | null, originalProxy = ports.proxyOf(profileId), source: 'storage' | 'authentication' = 'authentication'): void {
    if (reason === null) {
      if (issues.delete(profileId)) notify(profileId, null)
      return
    }
    // An old challenge cannot publish a problem for a replacement proxy.
    if (!originalProxy || !sameProxy(ports.proxyOf(profileId), originalProxy)) return
    const previous = issues.get(profileId)
    if (previous?.reason === reason && previous.source === source && sameProxy(previous.proxy, originalProxy)) return
    issues.set(profileId, { proxy: { ...originalProxy }, source, reason })
    notify(profileId, reason)
  }

  async function read(profileId?: string): Promise<Stored> {
    if (!stored) {
      try {
        stored = storedSchema.parse(JSON.parse(await readFile(ports.path, 'utf8')))
      } catch (cause) {
        // Only a missing file is an empty set. Unknown data stays on disk and is read again on Retry.
        if ((cause as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          if (profileId) report(profileId, STORAGE_UNAVAILABLE, ports.proxyOf(profileId), 'storage')
          throw new BrowserProfileProxyAuthUnavailable(STORAGE_UNAVAILABLE)
        }
        stored = { version: 1, profiles: {} }
      }
    }
    // A successful read resolves only its storage observation, never a refused authentication.
    if (profileId && issues.get(profileId)?.source === 'storage') report(profileId, null)
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
    /** Plaintext stays inside Main and is used only for this exact, still-current proxy endpoint. */
    async withProbeCredentials<T>(profileId: string, expected: { host: string; port: number; configurationRevision: string },
      use: (credential: BrowserProfileProxyCredential) => Promise<T>): Promise<T> {
      const current = () => sameProxy(ports.proxyOf(profileId), expected) && ports.configurationRevision?.(profileId) === expected.configurationRevision
      if (!current()) throw new BrowserProfileProxyAuthUnavailable('The original proxy configuration is no longer current.')
      const entry = (await read(profileId)).profiles[profileId]
      if (!entry || !entry.proxy || !sameProxy(entry.proxy, expected) || !current()) {
        throw new BrowserProfileProxyAuthUnavailable('A sign-in for this exact proxy configuration is unavailable.')
      }
      let password: string
      try { password = ports.crypto.decrypt(Buffer.from(entry.password, 'base64')) }
      catch { throw new BrowserProfileProxyAuthUnavailable('The original proxy sign-in could not be read.') }
      if (!current()) throw new BrowserProfileProxyAuthUnavailable('The original proxy configuration changed before the protocol request.')
      return await use({ username: entry.username, password })
    },
    /** A private adapter is needed only for a sign-in bound to that exact proxy; no-auth SOCKS keeps its native path. */
    async hasTransportCredentials(profileId: string, expected: { host: string; port: number }): Promise<boolean | undefined> {
      try { const entry = (await read(profileId)).profiles[profileId]; return !!entry && (entry.proxy === undefined || sameProxy(entry.proxy, expected)) }
      catch { return undefined }
    },
    /** Main's exact live transport can report a refusal; neither its capability nor password is published. */
    transportIssue(profileId: string, expected: { host: string; port: number; configurationRevision: string }, reason: string | null): void {
      if (ports.configurationRevision?.(profileId) !== expected.configurationRevision || !sameProxy(ports.proxyOf(profileId), expected)) return
      report(profileId, reason, expected)
    },
    /** The last recorded issue for this exact current proxy; absence is not proof of authentication. */
    issue(profileId: string): string | null {
      const issue = issues.get(profileId)
      return issue && sameProxy(ports.proxyOf(profileId), issue.proxy) ? issue.reason : null
    },

    /** Before a route changes, retain the original endpoint of an existing older sign-in record. */
    bindCurrentProxy(profileId: string): Promise<void> {
      return serial(async () => {
        const current = await read(profileId), entry = current.profiles[profileId]
        if (!entry || entry.proxy !== undefined) return
        const proxy = ports.proxyOf(profileId)
        await write({ version: 1, profiles: { ...current.profiles, [profileId]: { ...entry, proxy: proxy ? { ...proxy } : null } } })
      })
    },

    /** Keep a sign-in for this Profile's proxy. The password is encrypted before it reaches disk. */
    set(profileId: string, credential: BrowserProfileProxyCredential): Promise<void> {
      const admittedProxy = ports.proxyOf(profileId)
      const savedProxy = admittedProxy ? { ...admittedProxy } : null
      return serial(async () => {
        if (!ports.crypto.available()) {
          throw new BrowserProfileProxyAuthUnavailable('The system keychain is not available, so a proxy password cannot be kept. The Profile and its route are unchanged.')
        }
        const username = credential.username.trim()
        if (!username || username.length > 256 || credential.password.length > 1024) throw new BrowserProfileProxyAuthUnavailable('Enter a user name and a password for the proxy.')
        const current = await read(profileId)
        let password: string
        try { password = ports.crypto.encrypt(credential.password).toString('base64') }
        catch { throw new BrowserProfileProxyAuthUnavailable('The proxy password could not be encrypted by the system keychain. Nothing was saved; retry when the keychain is available.') }
        await write({ version: 1, profiles: { ...current.profiles, [profileId]: { username, password, proxy: savedProxy } } })
        for (const key of [...attempts.keys()]) if (key.startsWith(profileId + '\0')) attempts.delete(key)
        report(profileId, null)
      })
    },

    /** Forget the sign-in, for example when the Profile is deleted or its route stops being a proxy. */
    clear(profileId: string): Promise<void> {
      return serial(async () => {
        const current = await read(profileId)
        if (profileId in current.profiles) {
          const { [profileId]: _removed, ...rest } = current.profiles
          await write({ version: 1, profiles: rest })
        }
        report(profileId, null)
      })
    },

    /** Forget every sign-in whose Profile is not in this set, for example after a delete or a route change. */
    forgetExcept(profileIds: ReadonlySet<string>): Promise<void> {
      // Route ownership changed even if credential cleanup itself cannot read the file yet.
      for (const [profileId, issue] of issues) {
        if (!profileIds.has(profileId) || !sameProxy(ports.proxyOf(profileId), issue.proxy)) report(profileId, null)
        else notify(profileId, issue.reason) // The original Profile label may have changed with this committed list.
      }
      return serial(async () => {
        const current = await read()
        const kept = Object.fromEntries(Object.entries(current.profiles).filter(([id]) => profileIds.has(id)))
        if (Object.keys(kept).length === Object.keys(current.profiles).length) return
        await write({ version: 1, profiles: kept })
      })
    },

    /** The user name only, so the editor can show who signs in without ever reading the password. */
    async username(profileId: string): Promise<string | null> {
      return (await read(profileId)).profiles[profileId]?.username ?? null
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
      try { entry = (await read(profileId)).profiles[profileId] }
      catch { return false }
      if (!entry) { report(profileId, 'The proxy asks for a sign-in. Add its user name and password to this Profile.', proxy); return false }
      // A new route does not acquire an old server's sign-in. Legacy scope is fixed before any route edit.
      if (entry.proxy !== undefined && (!entry.proxy || !sameProxy(entry.proxy, proxy))) {
        report(profileId, 'The saved sign-in belongs to a different proxy server. Set a sign-in for this Profile’s current proxy.', proxy)
        return false
      }
      if (contents.isDestroyed() || ports.profileOfSession(contents.session) !== profileId || !sameProxy(ports.proxyOf(profileId), proxy)) return false

      const key = `${profileId}\0${proxy.host}:${proxy.port}`
      // Chromium marks the first challenge of a request; a fresh request after a working sign-in starts counting again.
      if (firstAttempt) attempts.delete(key)
      const tries = (attempts.get(key) ?? 0) + 1
      if (tries > 2) { report(profileId, 'The proxy refused this Profile’s user name or password. Update them and reload the page.', proxy); return false }
      attempts.set(key, tries)
      let password: string
      try { password = ports.crypto.decrypt(Buffer.from(entry.password, 'base64')) }
      catch { report(profileId, 'The saved proxy password could not be read from the keychain. Enter it again.', proxy); return false }
      callback(entry.username, password)
      return true
    },

  }
}
export type BrowserProfileProxyAuth = ReturnType<typeof createBrowserProfileProxyAuth>
