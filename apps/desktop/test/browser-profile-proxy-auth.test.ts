import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
  const reports: Array<[string, string | null]> = []
  const decrypt = vi.fn((data: Buffer) => Buffer.from(data.toString('utf8').split('').reverse().join(''), 'utf8').toString('utf8').replace(/^enc:/, ''))
  const auth = createBrowserProfileProxyAuth({
    crypto: {
      available: () => options.available ?? true,
      // A reversible stand-in for the keychain; the real cipher is Electron safeStorage.
      encrypt: text => Buffer.from(('enc:' + text).split('').reverse().join(''), 'utf8'),
      decrypt
    },
    path,
    profileOfSession: session => session === work ? 'p-work' : null,
    proxyOf: profileId => profileId === 'p-work' ? { host: 'gw.corp.test', port: 3128 } : null,
    report: (profileId, reason) => { reports.push([profileId, reason]) }
  })
  const contents = (session: unknown) => ({ session, isDestroyed: () => false }) as never
  return { auth, path, work, other, reports, decrypt, contents }
}

describe('Profile proxy sign-in', () => {
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
})
