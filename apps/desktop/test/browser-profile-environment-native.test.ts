import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => {
  const sessions = new Map<string, { ua: string; languages: string; setUserAgent: ReturnType<typeof vi.fn>; getUserAgent(): string }>()
  const get = (id: string) => {
    if (!sessions.has(id)) {
      const target = { ua: 'Native/150', languages: 'en-US', getUserAgent() { return this.ua },
        setUserAgent: vi.fn((ua: string, languages: string) => { target.ua = ua; target.languages = languages }) }
      sessions.set(id, target)
    }
    return sessions.get(id)!
  }
  return { sessions, get }
})
vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' }, BrowserWindow: class {},
  session: { fromPartition: native.get }, webContents: { getAllWebContents: () => [] } }))

import { parseBrowserProfileEnvironment } from '@agentmux/core/control'
import { AgentMuxControlServer } from '../../../packages/core/src/control-host.js'
import { privateRpcCorePort } from '../../../packages/core/test/helpers/private-rpc-core.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { objectCliReceipt } from '../../../packages/core/test/helpers/object-cli-receipt.js'
import { BrowserProfileStore } from '../src/main/browser-profile-store.js'
import { BrowserProfileManager } from '../src/main/browser-profile-manager.js'
import { createBrowserProfileEnvironment } from '../src/main/browser-profile-environment.js'
import { executeBrowserProfileControl, isBrowserProfileControlRequest } from '../src/main/browser-profile-control.js'

const roots: string[] = []
afterEach(async () => { native.sessions.clear(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function owner() {
  const root = await mkdtemp(join(tmpdir(), 'profile-environment-')); roots.push(root)
  const path = join(root, 'profiles.json'), manager = new BrowserProfileManager(new BrowserProfileStore(path))
  await manager.initialize()
  const id = manager.defaultProfileId()
  return { root, path, manager, id, target: () => native.get(manager.resolvePartition(id)) }
}

describe('Native Profile session environment (real Electron behavior is verified by verify-browser-profile-environment.mjs)', () => {
  it('strictly validates the native header inputs, and explicitly rejects unsupported engine fields', () => {
    expect(parseBrowserProfileEnvironment({ acceptLanguages: ['fr-fr', 'de-DE', 'fr-FR'] })).toEqual({ acceptLanguages: ['fr-FR', 'de-DE'] })
    for (const value of [{}, { userAgent: 'UA\r\nInjected: yes' }, { userAgent: '' }, { userAgent: 'UA', canvas: true },
      { acceptLanguages: [] }, { acceptLanguages: ['en-US;q=0.9'] }, { timezone: 'UTC' }]) expect(() => parseBrowserProfileEnvironment(value)).toThrow()
  })

  it('persists through the original store and applies through the actual manager/session prepare boundary', async () => {
    const { manager, path, id, target } = await owner()
    const environment = { userAgent: 'FixtureBrowser/1.0', acceptLanguages: ['fr-FR', 'de-DE'] }
    const saved = await manager.updateProfile(id, { environment }, manager.listRevision())
    expect(target().setUserAgent).toHaveBeenCalledWith(environment.userAgent, 'fr-FR,de-DE')
    expect(saved).toMatchObject({ environment, environmentApplication: { status: 'applied', scope: 'session-defaults', userAgent: environment.userAgent,
      unsupported: ['navigator.language', 'navigator.languages', 'userAgentMetadata'] } })
    expect(JSON.parse(await readFile(path, 'utf8')).profiles[0]).toMatchObject({ environment })
    expect(await readFile(path, 'utf8')).not.toContain('environmentApplication')
    const reopened = new BrowserProfileManager(new BrowserProfileStore(path)); await reopened.initialize()
    expect(reopened.listProfiles()[0].environmentApplication?.status).toBe('not-applied')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    reopened.onEnvironmentApplicationChange(() => { throw new Error('Projection observer unavailable') })
    await reopened.prepareSession(id)
    expect(reopened.listProfiles()[0].environmentApplication?.status).toBe('applied')
    expect(reopened.environmentApplication(id)?.status).toBe('applied')
    expect(reopened.listProfiles()[0].id).toBe(id)
    expect(target().setUserAgent).toHaveBeenCalledTimes(2)
    await reopened.prepareSession(id)
    expect(target().setUserAgent).toHaveBeenCalledTimes(2)
  })

  it('keeps confirmed settings on native failure, reports unknown, and retries the original session without a reload', async () => {
    const { manager, id, target } = await owner()
    const changed = vi.fn(), unsubscribe = manager.onEnvironmentApplicationChange(changed)
    target().setUserAgent.mockImplementationOnce(() => { throw new Error('native setter unavailable') })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const saved = await manager.updateProfile(id, { environment: { userAgent: 'Retry/1.0' } }, manager.listRevision())
    expect(saved.environment).toEqual({ userAgent: 'Retry/1.0' })
    expect(saved.environmentApplication?.status).toBe('unknown')
    expect(manager.environmentApplication(id)?.status).toBe('unknown')
    expect(changed).toHaveBeenCalledExactlyOnceWith(id)
    expect(target().ua).toBe('Native/150')
    expect(warning).toHaveBeenCalledOnce()
    await manager.prepareSession(id)
    expect(manager.listProfiles()[0].environmentApplication?.status).toBe('applied')
    expect(target().ua).toBe('Retry/1.0')
    expect(changed.mock.calls).toEqual([[id], [id]])
    unsubscribe()
    await manager.updateProfile(id, { environment: { userAgent: 'After unsubscribe/1' } }, manager.listRevision())
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('treats an unavailable session as an unknown application, without undoing the confirmed saved configuration', () => {
    const settings = { userAgent: 'Saved/1.0' }
    const environment = createBrowserProfileEnvironment({ session: () => { throw new Error('session temporarily unavailable') },
      settings: () => settings, defaultLanguage: () => 'en-US' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => environment.prepare('original-profile')).not.toThrow()
    expect(environment.inspect('original-profile')).toMatchObject({ status: 'unknown', scope: 'session-defaults' })
    expect(settings).toEqual({ userAgent: 'Saved/1.0' })
  })

  it('does not claim application if the original native session still reports a different UA', async () => {
    const { manager, id, target } = await owner()
    target().setUserAgent.mockImplementationOnce(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const saved = await manager.updateProfile(id, { environment: { userAgent: 'Desired/1' } }, manager.listRevision())
    expect(saved.environment).toEqual({ userAgent: 'Desired/1' })
    expect(saved.environmentApplication?.status).toBe('unknown')
    expect(target().ua).toBe('Native/150')
  })

  it('restores the captured native defaults and rejects a stale edit before changing native settings', async () => {
    const { manager, id, target } = await owner()
    await manager.updateProfile(id, { environment: { userAgent: 'Edited/1', acceptLanguages: ['fr-FR'] } }, manager.listRevision())
    const saved = await manager.updateProfile(id, { environment: null }, manager.listRevision())
    expect(saved.environment).toBeUndefined()
    expect(target().setUserAgent).toHaveBeenLastCalledWith('Native/150', 'en-US')
    const calls = target().setUserAgent.mock.calls.length
    await expect(manager.updateProfile(id, { environment: { userAgent: 'Stale/1' } }, 0)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_REVISION_CONFLICT' })
    expect(target().setUserAgent).toHaveBeenCalledTimes(calls)
    expect(manager.listProfiles()[0].environment).toBeUndefined()
  })

  it('runs the compiled CLI and public receipt codec into the same production Profile owners', async () => {
    const { root, manager, id, target } = await owner()
    const core = await privateRpcCorePort(join(root, 'sessions.json'), join(root, 'messages.ndjson'))
    const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: core.clients,
      execute: async (request, context) => {
        if (!isBrowserProfileControlRequest(request)) throw new Error('Unexpected operation')
        return executeBrowserProfileControl(request, { profiles: manager, usage: { usage: async () => ({ complete: true, browsers: [] }) } as never, network: {} as never }, context?.actor)
      } })
    await server.start()
    try {
      const env = objectCliEnvironment(root, { NODE_NO_WARNINGS: '1' })
      const run = async (args: string[]) => {
        const output = await runCompiledObjectCli(['browser', 'profile', ...args], env)
        expect(output.code, output.stderr).toBe(0)
        return objectCliReceipt(JSON.parse(output.stdout)).result as any
      }
      const updated = await run(['update', '--profile', id, '--expected-revision', String(manager.listRevision()), '--environment',
        JSON.stringify({ userAgent: 'Public/1.0', acceptLanguages: ['ja-JP'] })])
      expect(updated.profile.environmentApplication).toMatchObject({ status: 'applied', scope: 'session-defaults', userAgent: 'Public/1.0', acceptLanguages: ['ja-JP'] })
      expect(target().setUserAgent).toHaveBeenLastCalledWith('Public/1.0', 'ja-JP')
      const inspected = await run(['inspect', '--profile', id])
      expect(inspected.profile).toEqual(updated.profile)
      const rejected = await runCompiledObjectCli(['browser', 'profile', 'update', '--profile', id, '--expected-revision', String(manager.listRevision()),
        '--environment', '{"canvas":true}'], env)
      expect(rejected.code).not.toBe(0)
      expect(target().ua).toBe('Public/1.0')
      const help = await runCompiledObjectCli(['browser', 'profile', 'update', '--help'], env)
      expect(help.stdout).toContain('--environment JSON')
      expect(help.stdout).toContain('navigator.language/languages')
    } finally { await server.stop(); await core.dispose() }
  }, 20_000)
})
