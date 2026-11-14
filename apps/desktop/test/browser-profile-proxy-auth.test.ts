import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserProfileProxyAuth } from '../src/main/browser-profile-proxy-auth.js'

/**
 * A Profile's proxy sign-in. The password is encrypted at rest, decrypted only to answer that
 * Profile's own proxy, gets one retry after a refusal, and never reaches console, reports or files.
 */
const SENTINEL = 'S3NTINEL-pa55word'
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function setup(options: { available?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-proxy-auth-')); roots.push(root)
  const path = join(root, 'browser-profile-proxy-auth.json')
  const work = { id: 'work-session' }, other = { id: 'other-session' }
  const proxies = new Map([['p-work', { host: 'gw.corp.test', port: 3128 }]])
  const reports: Array<[string, string | null]> = []
  const report = vi.fn((profileId: string, reason: string | null) => { reports.push([profileId, reason]) })
  const decrypt = vi.fn((data: Buffer) => Buffer.from(data.toString('utf8').split('').reverse().join(''), 'utf8').toString('utf8').replace(/^enc:/, ''))
  // A reversible stand-in for the keychain; the real cipher is Electron safeStorage.
  const encrypt = vi.fn((text: string) => Buffer.from(('enc:' + text).split('').reverse().join(''), 'utf8'))
  const auth = createBrowserProfileProxyAuth({
    crypto: {
      available: () => options.available ?? true,
      encrypt,
      decrypt
    },
    path,
    profileOfSession: session => session === work ? 'p-work' : null,
    proxyOf: profileId => proxies.get(profileId) ?? null,
    report
  })
  const contents = (session: unknown) => ({ session, isDestroyed: () => false }) as never
  return { auth, path, work, other, reports, report, proxies, encrypt, decrypt, contents }
}

describe('Profile proxy sign-in', () => {
  it('keeps the endpoint observed at credential admission while its asynchronous save is queued', async () => {
    const { auth, work, proxies, contents } = await setup()
    const saved = auth.set('p-work', { username: 'admitted-person', password: SENTINEL })
    proxies.set('p-work', { host: 'changed-during-save.test', port: 8181 })
    await saved
    const callback = vi.fn()
    expect(await auth.answer(contents(work), { isProxy: true, host: 'changed-during-save.test', port: 8181 }, callback)).toBe(false)
    expect(callback).not.toHaveBeenCalled()
    proxies.set('p-work', { host: 'gw.corp.test', port: 3128 })
    expect(await auth.answer(contents(work), { isProxy: true, host: 'gw.corp.test', port: 3128 }, callback, true)).toBe(true)
    expect(callback).toHaveBeenCalledWith('admitted-person', SENTINEL)
  })

  it('keeps a saved proxy password scoped to its original server after an explicit route change', async () => {
    const { auth, work, proxies, contents, decrypt } = await setup()
    await auth.set('p-work', { username: 'alice', password: SENTINEL })
    proxies.set('p-work', { host: 'replacement.test', port: 8123 })
    const callback = vi.fn()
    expect(await auth.answer(contents(work), { isProxy: true, host: 'replacement.test', port: 8123 }, callback)).toBe(false)
    expect(callback).not.toHaveBeenCalled(); expect(decrypt).not.toHaveBeenCalled()
    proxies.set('p-work', { host: 'gw.corp.test', port: 3128 })
    expect(await auth.answer(contents(work), { isProxy: true, host: 'gw.corp.test', port: 3128 }, callback, true)).toBe(true)
    expect(callback).toHaveBeenCalledWith('alice', SENTINEL)
  })

  it('answers a 407 from that Profile’s own proxy, then gives up after one retry with a reason', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info'), vi.spyOn(console, 'debug')]
    const { auth, path, work, reports, decrypt, contents } = await setup()
    await auth.set('p-work', { username: 'alice', password: SENTINEL })
    const challenge = { isProxy: true, host: 'GW.corp.test', port: 3128 }
    const answers: Array<[string | undefined, string | undefined]> = []
    const callback = (username?: string, password?: string) => { answers.push([username, password]) }

    expect(await auth.answer(contents(work), challenge, callback)).toBe(true)
    expect(await auth.answer(contents(work), challenge, callback)).toBe(true)
    expect(await auth.answer(contents(work), challenge, callback), 'a third refusal must not loop').toBe(false)
    expect(answers).toEqual([['alice', SENTINEL], ['alice', SENTINEL]])
    expect(decrypt).toHaveBeenCalledTimes(2)
    expect(reports.at(-1)).toEqual(['p-work', expect.stringContaining('refused this Profile’s user name or password')])

    // The password never leaves the login callback: not in the file, reports, or any console output.
    const disk = await readFile(path, 'utf8')
    expect(disk).not.toContain(SENTINEL)
    expect(JSON.stringify(reports)).not.toContain(SENTINEL)
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(SENTINEL)
    expect(await auth.username('p-work')).toBe('alice')

    expect(await auth.answer(contents(work), challenge, callback, true), 'a fresh request starts counting again').toBe(true)
  })

  it('never answers a server sign-in, another Profile, or a proxy that is not this Profile’s', async () => {
    const { auth, work, other, decrypt, contents } = await setup()
    await auth.set('p-work', { username: 'alice', password: SENTINEL })
    const callback = vi.fn()
    expect(await auth.answer(contents(work), { isProxy: false, host: 'gw.corp.test', port: 3128 }, callback)).toBe(false)
    expect(await auth.answer(contents(other), { isProxy: true, host: 'gw.corp.test', port: 3128 }, callback)).toBe(false)
    expect(await auth.answer(contents(work), { isProxy: true, host: 'evil.test', port: 3128 }, callback)).toBe(false)
    expect(await auth.answer(contents(work), { isProxy: true, host: 'gw.corp.test', port: 8080 }, callback)).toBe(false)
    expect(await auth.answer(null, { isProxy: true, host: 'gw.corp.test', port: 3128 }, callback)).toBe(false)
    expect(callback).not.toHaveBeenCalled()
    expect(decrypt).not.toHaveBeenCalled()
  })

  it('says a sign-in is needed when the proxy asks and none is saved', async () => {
    const { auth, work, reports, contents } = await setup()
    expect(await auth.answer(contents(work), { isProxy: true, host: 'gw.corp.test', port: 3128 }, vi.fn())).toBe(false)
    expect(reports).toEqual([['p-work', expect.stringContaining('Add its user name and password')]])
  })

  it('forgets sign-ins of Profiles that no longer use a proxy, keeping the rest', async () => {
    const { auth, path } = await setup()
    await auth.set('p-work', { username: 'alice', password: SENTINEL })
    await auth.set('p-lab', { username: 'bob', password: SENTINEL })
    await auth.forgetExcept(new Set(['p-lab']))
    expect(await auth.username('p-work')).toBeNull()
    expect(await auth.username('p-lab')).toBe('bob')
    expect(Object.keys(JSON.parse(await readFile(path, 'utf8')).profiles)).toEqual(['p-lab'])
  })

  it('refuses to keep a password without the system keychain, and forgets one on request', async () => {
    const without = await setup({ available: false })
    await expect(without.auth.set('p-work', { username: 'alice', password: SENTINEL })).rejects.toMatchObject({ code: 'BROWSER_PROFILE_PROXY_AUTH_UNAVAILABLE' })
    await expect(readFile(without.path, 'utf8')).rejects.toThrow()

    const kept = await setup()
    await kept.auth.set('p-work', { username: 'alice', password: SENTINEL })
    await kept.auth.clear('p-work')
    expect(await kept.auth.username('p-work')).toBeNull()
    expect(JSON.parse(await readFile(kept.path, 'utf8')).profiles).toEqual({})
  })

  it.each([
    { name: 'malformed JSON', data: `{ "password": "${SENTINEL}"` },
    { name: 'a different version', data: JSON.stringify({ version: 2, profiles: {} }) },
    { name: 'an array of Profiles', data: JSON.stringify({ version: 1, profiles: [] }) },
    { name: 'an invalid credential', data: JSON.stringify({ version: 1, profiles: { 'p-kept': { username: 7, password: SENTINEL } } }) },
    { name: 'unknown stored fields', data: JSON.stringify({ version: 1, profiles: {}, retained: SENTINEL }) }
  ])('keeps $name untouched, then reads the same file after repair', async ({ data }) => {
    const { auth, path } = await setup()
    await writeFile(path, data)
    const unavailable = { code: 'BROWSER_PROFILE_PROXY_AUTH_UNAVAILABLE' }
    for (const change of [
      () => auth.set('p-work', { username: 'alice', password: SENTINEL }),
      () => auth.clear('p-kept'),
      () => auth.forgetExcept(new Set(['p-work']))
    ]) {
      const failure = await change().then(() => null, error => error)
      expect(await readFile(path, 'utf8')).toBe(data)
      expect(failure).toMatchObject(unavailable)
    }
    await expect(auth.username('p-kept')).rejects.toMatchObject(unavailable)
    const failure = await auth.username('p-kept').catch(error => error)
    expect(failure.message).not.toContain(SENTINEL)
    expect(failure.message).toContain('Retry')

    const original = { version: 1, profiles: { 'p-kept': { username: 'kept', password: Buffer.from('encrypted').toString('base64') } } }
    await writeFile(path, JSON.stringify(original))
    expect(await auth.username('p-kept')).toBe('kept')
    await auth.set('p-work', { username: 'alice', password: SENTINEL })
    expect(JSON.parse(await readFile(path, 'utf8')).profiles['p-kept']).toEqual(original.profiles['p-kept'])
  })

  it('treats an IO failure as unavailable, then reads the original path after repair', async () => {
    const { auth, path } = await setup()
    // A directory produces a real read failure on every platform, even when tests run as root.
    await mkdir(path)
    await expect(auth.set('p-work', { username: 'alice', password: SENTINEL })).rejects.toMatchObject({ code: 'BROWSER_PROFILE_PROXY_AUTH_UNAVAILABLE' })
    await rm(path, { recursive: true })
    await writeFile(path, JSON.stringify({ version: 1, profiles: { 'p-kept': { username: 'kept', password: 'encrypted' } } }))
    expect(await auth.username('p-kept')).toBe('kept')
  })

  it('reports an unreadable login store without exposing its contents or rejecting the login callback', async () => {
    const { auth, path, work, reports, decrypt, contents } = await setup()
    const broken = `{ "password": "${SENTINEL}"`
    await writeFile(path, broken)
    const callback = vi.fn()
    await expect(auth.answer(contents(work), { isProxy: true, host: 'gw.corp.test', port: 3128 }, callback)).resolves.toBe(false)
    expect(callback).not.toHaveBeenCalled()
    expect(decrypt).not.toHaveBeenCalled()
    expect(reports).toEqual([['p-work', expect.stringContaining('could not be read')]])
    expect(JSON.stringify(reports)).not.toContain(SENTINEL)
    expect(await readFile(path, 'utf8')).toBe(broken)
  })

  it('keeps a keychain encryption failure from exposing the password or changing saved sign-ins', async () => {
    const { auth, path, encrypt } = await setup()
    await auth.set('p-kept', { username: 'kept', password: 'original-password' })
    const original = await readFile(path, 'utf8')
    encrypt.mockImplementationOnce(() => { throw new Error(SENTINEL) })
    const failure = await auth.set('p-work', { username: 'alice', password: SENTINEL }).catch(error => error)
    expect(failure).toMatchObject({ code: 'BROWSER_PROFILE_PROXY_AUTH_UNAVAILABLE' })
    expect(failure.message).not.toContain(SENTINEL)
    expect(failure.message).toContain('keychain')
    expect(await readFile(path, 'utf8')).toBe(original)
    expect(await auth.username('p-kept')).toBe('kept')
    await auth.set('p-work', { username: 'alice', password: SENTINEL })
    expect(await auth.username('p-work')).toBe('alice')
  })

  it('keeps the refusal as an owner fact until an explicit new save or clear, not a handed-off password', async () => {
    const { auth, work, reports, contents } = await setup()
    const challenge = { isProxy: true, host: 'gw.corp.test', port: 3128 }, callback = vi.fn()
    await auth.set('p-work', { username: 'alice', password: SENTINEL })
    await auth.answer(contents(work), challenge, callback)
    await auth.answer(contents(work), challenge, callback)
    expect(await auth.answer(contents(work), challenge, callback)).toBe(false)
    const refused = auth.issue('p-work')
    expect(refused).toContain('proxy refused')
    expect(await auth.answer(contents(work), challenge, callback, true)).toBe(true)
    expect(auth.issue('p-work'), 'passing credentials to Chromium is not a successful authentication receipt').toBe(refused)
    expect(auth.issue('p-lab')).toBeNull()
    await auth.set('p-work', { username: 'alice', password: 'new-password' })
    expect(auth.issue('p-work')).toBeNull()
    expect(reports.at(-1)).toEqual(['p-work', null])
    await auth.clear('p-work')
    await auth.answer(contents(work), challenge, callback)
    expect(auth.issue('p-work')).toContain('asks for a sign-in')
    await auth.clear('p-work')
    expect(auth.issue('p-work')).toBeNull()
  })

  it('never attributes an old challenge to a replacement route, or revives an old issue after a route change', async () => {
    const { auth, work, proxies, reports, contents } = await setup()
    const challenge = { isProxy: true, host: 'gw.corp.test', port: 3128 }
    const pending = auth.answer(contents(work), challenge, vi.fn())
    proxies.set('p-work', { host: 'other.corp.test', port: 8443 })
    await pending
    expect(auth.issue('p-work')).toBeNull()
    expect(reports).toEqual([])
    await auth.answer(contents(work), { isProxy: true, host: 'other.corp.test', port: 8443 }, vi.fn())
    expect(auth.issue('p-work')).toContain('asks for a sign-in')
    proxies.set('p-work', { host: 'gw.corp.test', port: 3128 })
    expect(auth.issue('p-work')).toBeNull()
    await auth.forgetExcept(new Set(['p-work']))
    proxies.set('p-work', { host: 'other.corp.test', port: 8443 })
    expect(auth.issue('p-work')).toBeNull()
    await auth.answer(contents(work), { isProxy: true, host: 'other.corp.test', port: 8443 }, vi.fn())
    proxies.delete('p-work')
    await auth.forgetExcept(new Set())
    expect(auth.issue('p-work')).toBeNull()
    expect(reports.at(-1)).toEqual(['p-work', null])
  })

  it('retains only a non-secret issue for unreadable storage or a keychain refusal', async () => {
    const unreadable = await setup()
    await writeFile(unreadable.path, `{ "password": "${SENTINEL}"`)
    await expect(unreadable.auth.username('p-work')).rejects.toMatchObject({ code: 'BROWSER_PROFILE_PROXY_AUTH_UNAVAILABLE' })
    expect(unreadable.auth.issue('p-work')).toContain('could not be read')
    expect(unreadable.auth.issue('p-work')).not.toContain(SENTINEL)
    await writeFile(unreadable.path, JSON.stringify({ version: 1, profiles: {} }))
    expect(await unreadable.auth.username('p-work')).toBeNull()
    expect(unreadable.auth.issue('p-work'), 'a successful read resolves only the original storage failure').toBeNull()

    const locked = await setup()
    await locked.auth.set('p-work', { username: 'alice', password: SENTINEL })
    locked.decrypt.mockImplementationOnce(() => { throw new Error(SENTINEL) })
    const callback = vi.fn()
    expect(await locked.auth.answer(locked.contents(locked.work), { isProxy: true, host: 'gw.corp.test', port: 3128 }, callback)).toBe(false)
    expect(callback).not.toHaveBeenCalled()
    expect(locked.auth.issue('p-work')).toContain('keychain')
    expect(locked.auth.issue('p-work')).not.toContain(SENTINEL)
    expect(await locked.auth.username('p-work')).toBe('alice')
    expect(locked.auth.issue('p-work'), 'reading a user name does not prove that its password works').toContain('keychain')
  })

  it('keeps the owner readable and the confirmed save successful when an auxiliary display notification fails', async () => {
    const { auth, path, work, report, contents } = await setup()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    report.mockImplementationOnce(() => { throw new Error(SENTINEL) })
    await expect(auth.answer(contents(work), { isProxy: true, host: 'gw.corp.test', port: 3128 }, vi.fn())).resolves.toBe(false)
    expect(auth.issue('p-work')).toContain('asks for a sign-in')
    report.mockImplementationOnce(() => { throw new Error(SENTINEL) })
    await expect(auth.set('p-work', { username: 'alice', password: SENTINEL })).resolves.toBeUndefined()
    expect(auth.issue('p-work')).toBeNull()
    expect(await auth.username('p-work')).toBe('alice')
    expect(JSON.parse(await readFile(path, 'utf8')).profiles['p-work'].username).toBe('alice')
    expect(warning).toHaveBeenCalledTimes(2)
    expect(warning).toHaveBeenCalledWith('The proxy sign-in notice delivery is unconfirmed. Read the original Profile owner for its current issue; confirmed credential saves remain valid.')
    expect(JSON.stringify(warning.mock.calls)).not.toContain(SENTINEL)
  })
})
