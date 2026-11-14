import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createCipheriv, createDecipheriv } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, session: { fromPartition: () => ({ clearStorageData: async () => {}, flushStorageData: async () => {} }) }, BrowserWindow: class {} }))

import { AGENTMUX_CONTROL_SCHEMA_VERSION, parseAgentMuxControlReceipt, parseAgentMuxControlRequest } from '@agentmux/core'
import type { AgentMuxControlRequest, AgentMuxNameActor } from '@agentmux/core/control'
import { BrowserProfileStore } from '../src/main/browser-profile-store.js'
import { BrowserProfileManager } from '../src/main/browser-profile-manager.js'
import { createBrowserProfileUsage } from '../src/main/browser-profile-usage.js'
import { executeBrowserProfileControl, isBrowserProfileControlRequest } from '../src/main/browser-profile-control.js'
import { createBrowserProfileNetworkControl } from '../src/main/browser-profile-network-control.js'
import { createBrowserProfileProxyAuth } from '../src/main/browser-profile-proxy-auth.js'
import { createBrowserProfileExitCheck } from '../src/main/browser-profile-exit-check.js'
import { AgentMuxControlServer } from '../../../packages/core/src/control-host.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { objectCliReceipt } from '../../../packages/core/test/helpers/object-cli-receipt.js'
import { privateRpcCorePort } from '../../../packages/core/test/helpers/private-rpc-core.js'

const DEFAULT_ID = '11111111-1111-4111-8111-111111111111'
const WORK_ID = '22222222-2222-4222-8222-222222222222'
const person: AgentMuxNameActor = { kind: 'device', id: 'local-user:1', verified: true }
const agent: AgentMuxNameActor = { kind: 'agent', id: 'managed-session', verified: true }
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function owners(open: Array<{ profileId: string; browserId: string }> = [], savedRead: () => Promise<unknown> = async () => null) {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-browser-profile-control-'))
  roots.push(root)
  const path = join(root, 'browser-profiles.json')
  await writeFile(path, JSON.stringify({ version: 1, defaultProfileId: DEFAULT_ID, pendingImports: [], profiles: [
    { id: DEFAULT_ID, label: 'Personal', createdAt: 1, source: null },
    { id: WORK_ID, label: 'Work', createdAt: 2, source: { browserLabel: 'Chrome', profileLabel: 'Person 1', importedAt: 3, importedCookies: 4, skippedCookies: 1 } }] }))
  // Route edits apply to the Profile's session first; this records them, and can refuse one.
  const applied: { profileId: string; network: unknown }[] = []
  const route = { refuse: false }
  const nativeUse = () => ({ status:'idle' as const,pages:0,workers:0,requests:0,downloads:0 })
  for (const id of [DEFAULT_ID,WORK_ID]) await mkdir(join(root,'Partitions',id),{recursive:true})
  const nativeSession = (id:string) => ({storagePath:join(root,'Partitions',id)}) as never
  const profiles = new BrowserProfileManager(new BrowserProfileStore(path), {
    nativeUse, nativeSession, retainedSession:nativeSession,
    prepare: () => undefined,
    apply: async (profileId: string, network: unknown) => {
      if (route.refuse) throw Object.assign(new Error('The route could not be applied.'), { code: 'BROWSER_PROFILE_NETWORK_UNAVAILABLE' })
      applied.push({ profileId, network })
    },
    observe: () => undefined
  } as never, () => root)
  const announced: number[] = []
  profiles.onChange(snapshot => announced.push(snapshot.revision))
  const clearPreviews = vi.fn(async () => ({ status: 'removed' as const }))
  // The same usage owner the Settings delete uses, with its real manager delete.
  const usage = createBrowserProfileUsage({
    open: profileId => open.filter(use => use.profileId === profileId).map(use => ({ browserId: use.browserId, workspaceId: 'w-1', title: 'Board', url: 'https://example.invalid/' })),
    readSaved: savedRead as never,
    nativeUse,
    deleteProfile: (...args) => profiles.deleteProfile(...args)
  })
  const credentialPath = join(root, 'proxy-auth.json')
  const key = Buffer.alloc(32, 7), iv = Buffer.alloc(16, 3)
  const crypto = { available: () => true,
    encrypt: (text: string) => { const cipher = createCipheriv('aes-256-cbc', key, iv); return Buffer.concat([cipher.update(text), cipher.final()]) },
    decrypt: (data: Buffer) => { const cipher = createDecipheriv('aes-256-cbc', key, iv); return Buffer.concat([cipher.update(data), cipher.final()]).toString() } }
  const proxyAuth = createBrowserProfileProxyAuth({ path: credentialPath, crypto,
    profileOfSession: () => WORK_ID, proxyOf: id => profiles.proxyOf(id), report: () => {} })
  const fetch = vi.fn(async () => ({ status: 200, text: async () => '203.0.113.9' }))
  const checkExit = createBrowserProfileExitCheck({ session: () => ({ fetch }) as never,
    prepare: id => profiles.prepareSession(id), now: () => 1 })
  const reconnect = vi.fn(async () => {})
  const network = createBrowserProfileNetworkControl({ profiles, proxyAuth, checkExit, checkAddress: () => 'https://check.example/', reconnect })
  await profiles.initialize()
  return { root, profiles, usage, network, proxyAuth, credentialPath, fetch, reconnect, announced, clearPreviews, applied, route }
}

// Build each request with the public codec, as the Core service does before Main sees it.
const request = (fields: Record<string, unknown>) => parseAgentMuxControlRequest({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'op-1', ...fields }) as AgentMuxControlRequest
// The actor is passed through exactly; an omitted argument means a person, an explicit null means no recorded caller.
async function call(ports: Awaited<ReturnType<typeof owners>>, fields: Record<string, unknown>, given: AgentMuxNameActor | null = person) {
  const actor = given ?? undefined
  const parsed = request(fields.operation==='browser.profile.delete' && fields.expectedRevision===undefined ? {...fields,expectedRevision:ports.profiles.listProfiles().find(p=>p.id===fields.profileId)?.revision ?? 'unknown-token'} : fields)
  if (!isBrowserProfileControlRequest(parsed)) throw new Error('not a Profile request')
  const { operation, ...result } = await executeBrowserProfileControl(parsed, ports, actor)
  // Every answer must pass the public receipt codec that the CLI client applies.
  const receipt = parseAgentMuxControlReceipt({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'op-1', ok: true, operation, result })
  expect(receipt.ok).toBe(true)
  return result as Record<string, any>
}

describe('Public Browser Profile control runs through the Main Profile owners', () => {
  it('runs the built CLI through the public service into the original credential and network-check owners', async () => {
    const ports = await owners()
    await ports.profiles.initialize()
    await ports.profiles.updateProfile(WORK_ID, { network: { mode: 'proxy', server: 'proxy.example:8080' } }, ports.profiles.listProfiles().find(profile => profile.id === WORK_ID)!.revision)
    const core = await privateRpcCorePort(join(ports.root, 'sessions.json'), join(ports.root, 'messages.ndjson'))
    const server = new AgentMuxControlServer({ socketPath: join(ports.root, 'control.sock'), coreClients: core.clients,
      execute: async (request, context) => {
        if (!isBrowserProfileControlRequest(request)) throw new Error('Unexpected non-Profile operation')
        return await executeBrowserProfileControl(request, ports, context?.actor)
      } })
    await server.start()
    const secret = 'proxy-owner-password-sentinel'
    const env = objectCliEnvironment(ports.root, { NODE_NO_WARNINGS: '1', AGENTMUX_RUNTIME_DIRECTORY: ports.root })
    const run = async (args: string[], stdin = '') => {
      const output = await runCompiledObjectCli(['browser', 'profile', ...args], env, stdin)
      expect(output.code, output.stderr).toBe(0)
      expect(output.stdout + output.stderr).not.toContain(secret)
      return objectCliReceipt(JSON.parse(output.stdout)).result
    }
    try {
      expect(await run(['proxy-sign-in', 'set', '--profile', WORK_ID, '--input', '-'], JSON.stringify({ username: 'alice', password: secret })))
        .toEqual({ profileId: WORK_ID, saved: true, reconnected: true })
      expect(await ports.proxyAuth.username(WORK_ID)).toBe('alice')
      expect(await readFile(ports.credentialPath, 'utf8')).not.toContain(secret)
      const answer = vi.fn()
      await expect(ports.proxyAuth.answer({ session: {}, isDestroyed: () => false } as never, { isProxy: true, host: 'proxy.example', port: 8080 }, answer)).resolves.toBe(true)
      expect(answer).toHaveBeenCalledWith('alice', secret)
      expect(await run(['network', 'check', '--profile', WORK_ID])).toEqual({ profileId: WORK_ID,
        check: { status: 'reachable', httpStatus: 200, latencyMs: 0, ip: '203.0.113.9' } })
      expect(ports.fetch).toHaveBeenCalledWith('https://check.example/', expect.objectContaining({ method: 'GET', cache: 'no-store' }))
      expect(await run(['proxy-sign-in', 'clear', '--profile', WORK_ID])).toEqual({ profileId: WORK_ID, cleared: true, reconnected: true })
      expect(await ports.proxyAuth.username(WORK_ID)).toBeNull()
      expect(ports.reconnect).toHaveBeenCalledTimes(2)
    } finally { await server.stop(); await core.dispose() }
  }, 20_000)

  it('returns the saved/cleared fact when reconnecting fails, without repeating or undoing the credential write', async () => {
    const ports = await owners()
    await ports.profiles.initialize()
    await ports.profiles.updateProfile(WORK_ID, { network: { mode: 'proxy', server: 'proxy.example:8080' } }, ports.profiles.listProfiles().find(profile => profile.id === WORK_ID)!.revision)
    ports.reconnect.mockRejectedValue(new Error('A connection could not be released.'))
    expect(await call(ports, { operation: 'browser.profile.proxy-sign-in.set', profileId: WORK_ID, signIn: { username: 'alice', password: 'private' } }))
      .toEqual({ profileId: WORK_ID, saved: true, reconnected: false })
    expect(await ports.proxyAuth.username(WORK_ID)).toBe('alice')
    expect(await call(ports, { operation: 'browser.profile.proxy-sign-in.clear', profileId: WORK_ID }))
      .toEqual({ profileId: WORK_ID, cleared: true, reconnected: false })
    expect(await ports.proxyAuth.username(WORK_ID)).toBeNull()
  })

  it.each([['managed Agent', agent], ['unverified caller', { kind: 'user', id: null, verified: false } as AgentMuxNameActor], ['no recorded caller', null]])(
    'refuses proxy writes by a %s while keeping the same network check available', async (_name, actor) => {
      const ports = await owners()
      const set = vi.spyOn(ports.network, 'setProxySignIn')
      for (const fields of [{ operation: 'browser.profile.proxy-sign-in.set', profileId: WORK_ID, signIn: { username: 'alice', password: 'private' } },
        { operation: 'browser.profile.proxy-sign-in.clear', profileId: WORK_ID }]) {
        await expect(call(ports, fields, actor)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_PROXY_AUTH_REQUIRES_PERSON' })
      }
      expect(set).not.toHaveBeenCalled()
      expect(await call(ports, { operation: 'browser.profile.network.check', profileId: WORK_ID }, actor)).toMatchObject({ profileId: WORK_ID, check: { status: 'reachable' } })
    })

  it('preserves an unknown network observation and rejects secret-bearing results', async () => {
    const ports = await owners()
    ports.fetch.mockRejectedValueOnce(new Error('net::ERR_PROXY_CONNECTION_FAILED'))
    expect(await call(ports, { operation: 'browser.profile.network.check', profileId: WORK_ID })).toEqual({ profileId: WORK_ID,
      check: { status: 'unknown', reason: 'ERR_PROXY_CONNECTION_FAILED', latencyMs: 0 } })
    expect(() => parseAgentMuxControlReceipt({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'op-1', ok: true,
      operation: 'browser.profile.proxy-sign-in.set', result: { profileId: WORK_ID, saved: true, reconnected: true, password: 'private' } }))
      .toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  })
  it('answers ls, inspect, create, update and set-default from the manager, each matching the GUI list', async () => {
    const ports = await owners([{ profileId: WORK_ID, browserId: 'b-open' }])
    expect(await call(ports, { operation: 'browser.profile.ls' })).toEqual({ revision: 0, sequence: 0, folders: [], views: [], profiles: ports.profiles.listProfiles() })
    expect(await call(ports, { operation: 'browser.profile.inspect', profileId: WORK_ID })).toEqual({ revision: 0, sequence: 0,
      profile: expect.objectContaining({ id: WORK_ID, label: 'Work', source: expect.objectContaining({ importedCookies: 4 }) }),
      usage: { complete: true, native:{status:'idle',pages:0,workers:0,requests:0,downloads:0}, browsers: [{ browserId: 'b-open', workspaceId: 'w-1', title: 'Board', url: 'https://example.invalid/', state: 'open' }] } })

    const created = await call(ports, { operation: 'browser.profile.create', operationId: 'release-review-original', label: 'Release review' })
    expect(created).toMatchObject({ revision: 1, creation: { receipt: { action: 'browser.profile.create', operationId: 'release-review-original' }, current: { state: 'present' } } })
    expect(await call(ports, { operation: 'browser.profile.update', profileId: WORK_ID, expectedRevision: ports.profiles.listProfiles().find(value => value.id === WORK_ID)!.revision, edit: { label: 'Northwind', hue: 288, notes: 'QA' } }))
      .toMatchObject({ revision: 2, profile: { id: WORK_ID, label: 'Northwind', hue: 288, notes: 'QA' } })
    expect(await call(ports, { operation: 'browser.profile.set-default', profileId: WORK_ID })).toEqual({ revision: 3, profileId: WORK_ID })
    expect(ports.profiles.defaultProfileId()).toBe(WORK_ID)
    // The manager announced every public write exactly as it does for the GUI.
    expect(ports.announced).toEqual([1, 2, 3])
    expect(await call(ports, { operation: 'browser.profile.ls' })).toEqual({ revision: 3, sequence: 3, folders: [], views: [], profiles: ports.profiles.listProfiles() })
  })

  it('keeps the owner refusal codes: stale revision, unknown Profile, status hue and Profile in use', async () => {
    const ports = await owners([{ profileId: WORK_ID, browserId: 'b-open' }])
    await expect(call(ports, { operation: 'browser.profile.update', profileId: WORK_ID, expectedRevision: 'stale-profile-token', edit: { label: 'Late' } }))
      .rejects.toMatchObject({ code: 'BROWSER_PROFILE_REVISION_CONFLICT' })
    await expect(call(ports, { operation: 'browser.profile.inspect', profileId: '33333333-3333-4333-8333-333333333333' })).rejects.toMatchObject({ code: 'BROWSER_PROFILE_NOT_FOUND' })
    await expect(call(ports, { operation: 'browser.profile.update', profileId: WORK_ID, expectedRevision: ports.profiles.listProfiles().find(value => value.id === WORK_ID)!.revision, edit: { hue: 143 } }))
      .rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST', message: expect.stringContaining('clear of status colors') })
    await expect(call(ports, { operation: 'browser.profile.delete', profileId: WORK_ID })).rejects.toMatchObject({ code: 'BROWSER_PROFILE_IN_USE',
      details: { browsers: [expect.objectContaining({ browserId: 'b-open', state: 'open' })] } })
    expect(ports.profiles.listProfiles().map(profile => profile.id)).toEqual([DEFAULT_ID, WORK_ID])
    expect(ports.announced).toEqual([])
  })

  it('sets a Profile’s network route through the same manager the Settings page uses, applied before it is saved', async () => {
    const ports = await owners()
    const proxied = await call(ports, { operation: 'browser.profile.update', profileId: WORK_ID, expectedRevision: ports.profiles.listProfiles().find(value => value.id === WORK_ID)!.revision,
      edit: { network: { mode: 'proxy', server: 'socks5://proxy.example:1080', bypass: ['intranet.example'] } } })
    expect(proxied).toMatchObject({ revision: 1, profile: { id: WORK_ID, network: { mode: 'proxy', server: { scheme: 'socks5', host: 'proxy.example', port: 1080 }, bypass: ['intranet.example'] } } })
    expect(ports.applied).toEqual([{ profileId: WORK_ID, network: expect.objectContaining({ mode: 'proxy' }) }])
    await expect(call(ports, { operation: 'browser.profile.update', profileId: WORK_ID, expectedRevision: ports.profiles.listProfiles().find(value => value.id === WORK_ID)!.revision, edit: { network: { mode: 'system' } } }))
      .resolves.toMatchObject({ revision: 2 })
    expect((await call(ports, { operation: 'browser.profile.inspect', profileId: WORK_ID }) as { profile: object }).profile).not.toHaveProperty('network')
  })

  it('refuses a route line Main cannot read, and keeps the old route when the new one cannot be applied', async () => {
    const ports = await owners()
    await expect(call(ports, { operation: 'browser.profile.update', profileId: WORK_ID, expectedRevision: ports.profiles.listProfiles().find(value => value.id === WORK_ID)!.revision, edit: { network: { mode: 'proxy', server: 'user:secret@proxy.example:8080' } } }))
      .rejects.toMatchObject({ code: 'BROWSER_PROFILE_NETWORK_INVALID', message: expect.stringContaining('Leave the user name and password out') })
    ports.route.refuse = true
    await expect(call(ports, { operation: 'browser.profile.update', profileId: WORK_ID, expectedRevision: ports.profiles.listProfiles().find(value => value.id === WORK_ID)!.revision, edit: { network: { mode: 'direct' } } }))
      .rejects.toMatchObject({ code: 'BROWSER_PROFILE_NETWORK_UNAVAILABLE' })
    expect(ports.profiles.listProfiles().find(profile => profile.id === WORK_ID)).not.toHaveProperty('network')
    expect(ports.announced, 'nothing was saved').toEqual([])
  })

  it('reports unreadable saved Tabs as unknown usage and refuses delete without removing anything', async () => {
    const ports = await owners([], async () => { throw new Error('EACCES') })
    expect((await call(ports, { operation: 'browser.profile.inspect', profileId: WORK_ID })).usage).toMatchObject({ browsers: [], complete: false })
    await expect(call(ports, { operation: 'browser.profile.delete', profileId: WORK_ID })).rejects.toMatchObject({ code: 'BROWSER_PROFILE_USAGE_UNKNOWN' })
    expect(ports.profiles.listProfiles().some(profile => profile.id === WORK_ID)).toBe(true)
  })

  it('deletes for a verified person through the same usage owner and builds the approval itself', async () => {
    const ports = await owners()
    const spy = vi.spyOn(ports.usage, 'deleteProfile')
    const token=ports.profiles.listProfiles().find(p=>p.id===WORK_ID)!.revision
    expect(await call(ports, { operation: 'browser.profile.delete', profileId: WORK_ID })).toMatchObject({ revision: 1, archive:{profile:{id:WORK_ID,revision:token}} })
    expect(spy).toHaveBeenCalledWith(WORK_ID, { kind: 'user-confirmed', operation: 'delete-profile', scope: 'profile', profileId: WORK_ID }, token)
    expect(ports.clearPreviews).not.toHaveBeenCalled()
    expect(ports.profiles.listProfiles().map(profile => profile.id)).toEqual([DEFAULT_ID])
  })

  it.each([['managed Agent', agent], ['unverified caller', { kind: 'user', id: null, verified: false } as AgentMuxNameActor], ['no recorded caller', null]])(
    'refuses delete for a %s and leaves the Profile, its data and the reads available', async (_name, actor) => {
      const ports = await owners()
      const spy = vi.spyOn(ports.usage, 'deleteProfile')
      await expect(call(ports, { operation: 'browser.profile.delete', profileId: WORK_ID }, actor)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_DELETE_REQUIRES_PERSON' })
      expect(spy).not.toHaveBeenCalled()
      expect(ports.profiles.listProfiles().some(profile => profile.id === WORK_ID)).toBe(true)
      expect((await call(ports, { operation: 'browser.profile.ls' }, actor)).profiles).toHaveLength(2)
    })

  it('rejects an approval or partition smuggled into the public request before any owner runs', () => {
    expect(() => request({ operation: 'browser.profile.delete', profileId: WORK_ID, approval: { kind: 'user-confirmed' } })).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
    expect(() => request({ operation: 'browser.profile.create', label: 'x', partition: 'persist:other' })).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
    expect(() => request({ operation: 'browser.profile.update', profileId: WORK_ID, expectedRevision: 'profile-token', edit: { hue: 360 } })).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
  })
})
