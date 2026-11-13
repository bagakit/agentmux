import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { objectCliReceipt } from './helpers/object-cli-receipt.js'
import { privateRpcCorePort } from './helpers/private-rpc-core.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentMuxControlServer } from '../src/control-host.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { hashAgentCapability, issueAgentCapability } from '../src/agent-capability.js'
import type { AgentMuxControlRequest, AgentMuxControlResult, BrowserProfileControlProfile } from '../src/control.js'
import type { AgentMuxNameContext } from '../src/display-label.js'

const DEFAULT_ID = 'D3fau1tPr0f1'
const WORK_ID = 'W0rkPr0f1leX'

describe('browser profile built CLI reaches the public Control owner', () => {
  let root: string, server: AgentMuxControlServer, seen: Array<{ request: AgentMuxControlRequest; actor: AgentMuxNameContext['actor'] | undefined }>
  let revision: number, profiles: BrowserProfileControlProfile[], inUse: boolean, answerAbout: string | null
  let core: Awaited<ReturnType<typeof privateRpcCorePort>>, capability: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'amux-bp-cli-'))
    seen = []; revision = 3; inUse = false; answerAbout = null
    profiles = [
      { id: DEFAULT_ID, label: 'Personal', createdAt: 1, isDefault: true, source: null },
      { id: WORK_ID, label: 'Work', createdAt: 2, isDefault: false, source: { browserLabel: 'Chrome', profileLabel: 'Person 1', importedAt: 3, importedCookies: 4, skippedCookies: 1 }, hue: 288, notes: 'Client QA' }
    ]
    // One managed Agent with a real capability, so the refusal below comes from an authenticated caller.
    capability = issueAgentCapability()
    const storePath = join(root, 'sessions.json')
    await new AgentMuxFileAgentSessionStore(storePath).compareAndSwap(null, {
      kind: 'agent', agentSessionId: 'managed', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: root,
      run: { runId: 'original-managed' }, retiredRuns: [], hookBindingId: 'hook-managed', hookToken: 'synthetic-managed',
      createdAt: 1, updatedAt: 1, capabilityHash: hashAgentCapability(capability)
    })
    core = await privateRpcCorePort(storePath, join(root, 'messages.ndjson'))
    const find = (id: string) => profiles.find(profile => profile.id === id) ?? (() => { throw new AgentMuxError(`Unknown Browser Profile: ${id}`, 'BROWSER_PROFILE_NOT_FOUND') })()
    server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: core.clients,
      async execute(request, nameContext): Promise<AgentMuxControlResult> {
        seen.push({ request, actor: nameContext?.actor })
        switch (request.operation) {
          case 'browser.profile.ls': return { operation: request.operation, revision, profiles }
          // answerAbout lets one case model an owner that answers about a different Profile.
          case 'browser.profile.inspect': return { operation: request.operation, revision, profile: find(answerAbout ?? request.profileId),
            usage: { complete: true, browsers: inUse ? [{ browserId: 'b-1', workspaceId: 'w-1', title: 'Board', url: 'https://example.invalid/', state: 'open' }] : [] } }
          case 'browser.profile.create': {
            const created = { id: 'N3wPr0f1leXy', label: request.label, createdAt: 9, isDefault: false, source: null }
            profiles = [...profiles, created]; revision += 1
            return { operation: request.operation, revision, profile: created }
          }
          case 'browser.profile.update': {
            if (request.expectedRevision !== revision) throw new AgentMuxError(`Browser Profiles changed since revision was read; current revision is ${revision}.`, 'BROWSER_PROFILE_REVISION_CONFLICT')
            const next = { ...find(request.profileId), ...(request.edit.label === undefined ? {} : { label: request.edit.label }), ...(request.edit.notes === undefined ? {} : { notes: request.edit.notes }) }
            if (request.edit.hue === null) delete next.hue; else if (request.edit.hue !== undefined) next.hue = request.edit.hue
            profiles = profiles.map(profile => profile.id === next.id ? next : profile); revision += 1
            return { operation: request.operation, revision, profile: next }
          }
          case 'browser.profile.set-default':
            find(request.profileId)
            profiles = profiles.map(profile => ({ ...profile, isDefault: profile.id === request.profileId })); revision += 1
            return { operation: request.operation, revision, profileId: request.profileId }
          case 'browser.profile.delete':
            if (inUse) throw Object.assign(new AgentMuxError('Browser Profile is still used by an open Browser', 'BROWSER_PROFILE_IN_USE'),
              { details: { browsers: [{ browserId: 'b-1', title: 'Board', url: 'https://example.invalid/', state: 'open' }] } })
            profiles = profiles.filter(profile => profile.id !== request.profileId); revision += 1
            return { operation: request.operation, revision, profileId: request.profileId, deleted: true }
          case 'open.browser': {
            const used = request.mode === 'private' ? undefined : find(request.profileId ?? profiles.find(profile => profile.isDefault)!.id)
            return { operation: request.operation, region: { tabId: 't-1', regionId: 'r-new', workspaceId: 'w-1', kind: 'browser', browserId: 'b-new',
              mode: request.mode ?? 'normal', ...(used ? { profile: { id: used.id, label: used.label } } : {}) } }
          }
          default: throw new Error(`Unexpected ${request.operation}`)
        }
      } })
    await server.start()
  })
  afterEach(async () => { await server?.stop(); await core?.dispose(); if (root) await rm(root, { recursive: true, force: true }) })

  // NODE_NO_WARNINGS keeps the runtime's experimental-feature notice off stderr, where the receipt is read.
  const person = () => objectCliEnvironment(root, { NODE_NO_WARNINGS: '1', AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined })
  const agent = () => objectCliEnvironment(root, { NODE_NO_WARNINGS: '1', AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_AGENT_SESSION_ID: 'managed', AGENTMUX_AGENT_CAPABILITY: capability })
  async function run(args: readonly string[], env = person()) {
    const output = await runCompiledObjectCli(['browser', 'profile', ...args], env)
    return { ...output, body: objectCliReceipt(JSON.parse(output.code === 0 ? output.stdout : output.stderr)) }
  }
  const requests = () => seen.map(({ request: { schemaVersion: _v, requestId: _id, ...body } }) => body)

  // Seven built-CLI processes run in sequence; each pays Node startup, so this journey gets its own deadline.
  it('lists, inspects, creates, edits and moves the default through the owner, returning only Profile facts', async () => {
    const listed = await run(['ls'])
    expect(listed.code, listed.stderr).toBe(0)
    expect(listed.body.result).toEqual({ revision: 3, profiles })
    // Counts of imported cookies are a summary; storage locations, cookie files and values never appear.
    const keys = new Set<string>()
    JSON.parse(JSON.stringify(listed.body.result), (key, value) => { keys.add(key); return value })
    for (const forbidden of ['partition', 'cookies', 'cookiesPath', 'cookiePath', 'sourcePath', 'browserRoot', 'profileDirectory']) expect(keys.has(forbidden), forbidden).toBe(false)
    expect(JSON.stringify(listed.body.result)).not.toContain('persist:')

    inUse = true
    const inspected = await run(['inspect', '--profile', WORK_ID])
    expect(inspected.body.result).toMatchObject({ profile: { id: WORK_ID, hue: 288 }, usage: { complete: true, browsers: [{ browserId: 'b-1', state: 'open' }] } })
    inUse = false

    expect((await run(['create', '--label', 'Release review'])).body.result).toMatchObject({ revision: 4, profile: { label: 'Release review', isDefault: false } })
    expect((await run(['update', '--profile', WORK_ID, '--expected-revision', '4', '--label', 'Northwind', '--hue', '300', '--notes', ''])).body.result)
      .toMatchObject({ revision: 5, profile: { id: WORK_ID, label: 'Northwind', hue: 300, notes: '' } })
    expect((await run(['update', '--profile', WORK_ID, '--expected-revision', '5', '--clear-hue'])).body.result.profile).not.toHaveProperty('hue')
    expect((await run(['set-default', '--profile', WORK_ID])).body.result).toEqual({ revision: 7, profileId: WORK_ID })

    expect(requests()).toEqual([
      { operation: 'browser.profile.ls' },
      { operation: 'browser.profile.inspect', profileId: WORK_ID },
      { operation: 'browser.profile.create', label: 'Release review' },
      { operation: 'browser.profile.update', profileId: WORK_ID, expectedRevision: 4, edit: { label: 'Northwind', hue: 300, notes: '' } },
      { operation: 'browser.profile.update', profileId: WORK_ID, expectedRevision: 5, edit: { hue: null } },
      { operation: 'browser.profile.set-default', profileId: WORK_ID }
    ])
  }, 20_000)

  it('carries per-reason skipped cookie counts through inspect, and rejects a count that is not a number', async () => {
    profiles[1] = { ...profiles[1]!, source: { ...profiles[1]!.source!, skippedByReason: { expired: 2, 'app-bound-encryption': 3 } } }
    const inspected = await run(['inspect', '--profile', WORK_ID])
    expect(inspected.code, inspected.stderr).toBe(0)
    expect(inspected.body.result.profile.source).toEqual({ browserLabel: 'Chrome', profileLabel: 'Person 1', importedAt: 3, importedCookies: 4, skippedCookies: 1,
      skippedByReason: { expired: 2, 'app-bound-encryption': 3 } })
    profiles[1] = { ...profiles[1]!, source: { ...profiles[1]!.source!, skippedByReason: { expired: 'two' as never } } }
    expect((await run(['inspect', '--profile', WORK_ID])).body.error).toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  })

  it('inspect shows a Profile’s network route and refuses one with an unknown key or a bad port', async () => {
    profiles[1] = { ...profiles[1]!, network: { mode: 'proxy', server: { scheme: 'socks5', host: '10.0.0.2', port: 1080 }, bypass: ['*.corp.test'] } }
    const inspected = await run(['inspect', '--profile', WORK_ID])
    expect(inspected.code, inspected.stderr).toBe(0)
    expect(inspected.body.result.profile.network).toEqual({ mode: 'proxy', server: { scheme: 'socks5', host: '10.0.0.2', port: 1080 }, bypass: ['*.corp.test'] })
    profiles[1] = { ...profiles[1]!, network: { mode: 'direct' } }
    expect((await run(['inspect', '--profile', WORK_ID])).body.result.profile.network).toEqual({ mode: 'direct' })
    for (const bad of [{ mode: 'proxy', server: { scheme: 'http', host: 'gw', port: 0 } }, { mode: 'proxy', server: { scheme: 'http', host: 'gw', port: 80, password: 'x' } },
      { mode: 'direct', server: { scheme: 'http', host: 'gw', port: 80 } }]) {
      profiles[1] = { ...profiles[1]!, network: bad as never }
      expect((await run(['inspect', '--profile', WORK_ID])).body.error, JSON.stringify(bad)).toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    }
  }, 20_000)

  it('opens a Browser in an exact Profile and the receipt names it; private and conflicting choices do not', async () => {
    const open = (extra: string[]) => runCompiledObjectCli(['browser', 'open', '--url', 'https://example.invalid/', '--in-region', 'r-1', ...extra], person())
      .then(output => ({ ...output, body: objectCliReceipt(JSON.parse(output.code === 0 ? output.stdout : output.stderr)) }))
    const inWork = await open(['--profile', WORK_ID])
    expect(inWork.code, inWork.stderr).toBe(0)
    expect(inWork.body.result.region).toMatchObject({ browserId: 'b-new', mode: 'normal', profile: { id: WORK_ID, label: 'Work' } })
    expect((await open([])).body.result.region.profile).toEqual({ id: DEFAULT_ID, label: 'Personal' })
    expect((await open(['--private'])).body.result.region).not.toHaveProperty('profile')
    const both = await open(['--profile', WORK_ID, '--private'])
    expect(both.code).toBe(1)
    expect(both.body.error.code).toBe('INVALID_CLI_ARGUMENT')
    expect(seen.map(({ request }) => request).filter(request => request.operation === 'open.browser').map(request => (request as { profileId?: string }).profileId))
      .toEqual([WORK_ID, undefined, undefined])
  })

  it('rejects an owner answer about another Profile instead of reporting it as this one', async () => {
    answerAbout = DEFAULT_ID
    const answer = await run(['inspect', '--profile', WORK_ID])
    expect(answer.code).toBe(1)
    expect(answer.body.error).toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  })

  it('returns the owner refusal codes unchanged: stale revision, unknown Profile and Profile in use', async () => {
    const stale = await run(['update', '--profile', WORK_ID, '--expected-revision', '1', '--label', 'Late'])
    expect(stale.code).toBe(1)
    expect(stale.body.error).toMatchObject({ code: 'BROWSER_PROFILE_REVISION_CONFLICT', message: expect.stringContaining('current revision is 3') })
    expect((await run(['inspect', '--profile', 'Unkn0wnPr0f1'])).body.error).toMatchObject({ code: 'BROWSER_PROFILE_NOT_FOUND' })
    inUse = true
    const busy = await run(['delete', '--profile', WORK_ID])
    expect(busy.body.error).toMatchObject({ code: 'BROWSER_PROFILE_IN_USE', details: { browsers: [{ browserId: 'b-1', state: 'open' }] } })
    expect(profiles.map(profile => profile.id)).toEqual([DEFAULT_ID, WORK_ID])
  })

  it('lets a person delete and passes Main the verified person, never an approval from params', async () => {
    const deleted = await run(['delete', '--profile', WORK_ID])
    expect(deleted.code, deleted.stderr).toBe(0)
    expect(deleted.body.result).toEqual({ revision: 4, profileId: WORK_ID, deleted: true })
    expect(seen.at(-1)).toEqual({ request: expect.objectContaining({ operation: 'browser.profile.delete', profileId: WORK_ID }),
      actor: expect.objectContaining({ verified: true, kind: expect.stringMatching(/^(user|device)$/u) }) })
    expect(Object.keys(seen.at(-1)!.request).sort()).toEqual(['operation', 'profileId', 'requestId', 'schemaVersion'])
  })

  it('refuses delete for an authenticated managed Agent before the owner, while its reads still work', async () => {
    const refused = await run(['delete', '--profile', WORK_ID], agent())
    expect(refused.code).toBe(1)
    expect(refused.body.error).toMatchObject({ code: 'BROWSER_PROFILE_DELETE_REQUIRES_PERSON', message: expect.stringContaining('ask the person') })
    expect(seen).toEqual([])
    const listed = await run(['ls'], agent())
    expect(listed.code, listed.stderr).toBe(0)
    expect(seen.map(({ request }) => request.operation)).toEqual(['browser.profile.ls'])
    expect(profiles.map(profile => profile.id)).toEqual([DEFAULT_ID, WORK_ID])
  })

  it.each([
    [['update', '--profile', WORK_ID, '--expected-revision', '3']],
    [['update', '--profile', WORK_ID, '--expected-revision', '3', '--hue', '300', '--clear-hue']],
    [['update', '--profile', WORK_ID, '--expected-revision', 'old', '--label', 'x']],
    [['update', '--profile', WORK_ID, '--expected-revision', '3', '--hue', '12.5']],
    [['inspect']], [['inspect', '--profile', 'self']], [['create']], [['delete', '--profile', WORK_ID, '--approval', '{}']]
  ])('rejects malformed syntax %j before the owner', async args => {
    const output = await run(args)
    expect(output.code).toBe(1)
    expect(output.body.error.code).toMatch(/^INVALID_(CLI_ARGUMENT|CONTROL_REQUEST)$/u)
    expect(seen).toEqual([])
  })

  it('rejects an out-of-range hue in the public schema, not only in the owner', async () => {
    const output = await run(['update', '--profile', WORK_ID, '--expected-revision', '3', '--hue', '360'])
    expect(output.body.error).toMatchObject({ code: 'INVALID_CONTROL_REQUEST', message: expect.stringContaining('0 to 359') })
    expect(seen).toEqual([])
  })

  it('documents every action, the hue flags and the delete authority in offline help', async () => {
    await server.stop()
    const top = await runCompiledObjectCli(['browser', 'profile', '--help'], person())
    expect(top.code).toBe(0)
    for (const action of ['ls', 'inspect', 'create', 'update', 'set-default', 'delete']) expect(top.stdout).toContain(`browser profile ${action}`)
    const update = await runCompiledObjectCli(['browser', 'profile', 'update', '--help'], person())
    expect(update.stdout).toContain('--hue N | --clear-hue'); expect(update.stdout).toContain('BROWSER_PROFILE_REVISION_CONFLICT')
    const remove = await runCompiledObjectCli(['browser', 'profile', 'delete', '--help'], person())
    expect(remove.stdout).toContain('BROWSER_PROFILE_DELETE_REQUIRES_PERSON'); expect(remove.stdout).toContain('BROWSER_PROFILE_IN_USE')
    expect(seen).toEqual([])
  })
})
