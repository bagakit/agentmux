import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
const { build } = createRequire(resolve('packages/core/package.json'))('esbuild')

import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
const { defaultHttpInstance }: { defaultHttpInstance: { request(input: unknown): Promise<unknown> } } = createRequire(
  resolve('packages/connectors/package.json')
)('@larksuiteoapi/node-sdk')
import { AGENTMUX_RPC_NATIVE_METHODS, AgentMuxRpcService, connectAgentMuxRpc, parseMoteConnectionOperation, parseMoteConnectionResult } from '@agentmux/core'
import { AGENTMUX_CLI_COMMANDS } from '../../../packages/core/src/agentmux-cli-commands.js'
import { moteConnectionBaseline } from '@agentmux/core/mote-preferences'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { confirmAndCreateMote, moteChildDecision, moteConnectionOwner } from './fixtures/mote-connection-owner.js'
import { imagePng } from './fixtures/mote-identity-image.js'
import { moteEnrollmentWeb } from './fixtures/mote-enrollment-web.js'

const clean: Array<() => void | Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  try { for (const close of clean.splice(0).reverse()) { try { await close() } catch (error) { errors.push(error) } } }
  finally { try { vi.restoreAllMocks() } catch (error) { errors.push(error) }; try { vi.unstubAllGlobals() } catch (error) { errors.push(error) } }
  if (errors.length) throw new AggregateError(errors, 'Mote public consumer cleanup failed')
})
async function fixture(options: Parameters<typeof moteConnectionOwner>[1] = { generic: true }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mote-bot-')))
  clean.push(() => rm(root, { recursive: true, force: true }))
  const f = await moteConnectionOwner(root, options)
  clean.push(f.close)
  return f
}
const body = (r: { code: number | null; stdout: string; stderr: string }) => {
  expect(r.code, r.stdout + r.stderr).toBe(0)
  return JSON.parse(r.stdout).result
}
const cli = (f: Awaited<ReturnType<typeof fixture>>, action: string, input: unknown) =>
  runCompiledObjectCli(
    [
      '--endpoint',
      'unix:' + f.server.path,
      'space',
      'mote',
      'connection',
      action,
      ...(['create', 'sync', 'ls', 'advance'].includes(action)
        ? ['--input', '-']
        : ['--operation-id', String((input as { operationId: string }).operationId)])
    ],
    objectCliEnvironment(f.root),
    JSON.stringify(input)
  )

it('discovers exactly the five parent operations on the original public registry and CLI', () => {
  const methods = ['advance', 'create', 'inspect', 'ls', 'sync'].map((action) => 'space.mote.connection.' + action)
  expect(
    Object.keys(AGENTMUX_RPC_NATIVE_METHODS)
      .filter((method) => method.startsWith('space.mote.connection.'))
      .sort()
  ).toEqual(methods)
  expect(
    AGENTMUX_CLI_COMMANDS.filter((command) => command.method.startsWith('space.mote.connection.'))
      .map((command) => command.method)
      .sort()
  ).toEqual(methods)
})

it('discovers optional explicit naming and unchanged sync behavior through actual compiled CLI help and skill', async () => {
  const f = await fixture(), env = objectCliEnvironment(f.root)
  const help = await runCompiledObjectCli(['space', 'mote', 'connection', 'create', '--help'], env)
  expect(help.code, help.stderr).toBe(0)
  expect(help.stdout).toContain('Optional name freezes the bot name for this creation')
  expect(help.stdout).toContain('omit name to use the exact saved Mote name')
  expect(help.stdout).toContain('a changed name on the same operationId conflicts')
  const skill = await runCompiledObjectCli(['connection', '--skill'], env)
  expect(skill.code, skill.stderr).toBe(0)
  expect(skill.stdout).toContain('Create --input')
  expect(skill.stdout).toContain('accepts optional name to freeze an explicit bot name')
  expect(skill.stdout).toContain('Sync still uses the saved Mote name and does not accept name')
  expect(f.counts.begin).toBe(0)
})

it.each([undefined, 'AMUX-Orion'])('creates from original saved files and PNG through Console and compiled CLI using name %s without duplicate profile effects', async name => {
  const http: Array<{ method?: string; url?: string; data?: Record<string, unknown> }> = [],
    effects: Array<{ kind: string; preclaimed: boolean }> = []
  let f!: Awaited<ReturnType<typeof fixture>>
  const native = moteEnrollmentWeb({ appId: () => 'cli_profile', observe: () => {
      const saved = f.connections.database!.prepare('SELECT record_json FROM connection_enrollment').get()!
      const row = JSON.parse(String(saved.record_json)),
        attempt = f.connections.database!.prepare('SELECT state,kind FROM connection_enrollment_attempt WHERE attempt_id=?').get(row.attemptId)!
      effects.push({ kind: String(attempt.kind), preclaimed: attempt.state === 'claimed' })
      const parent = JSON.parse(
        String(f.connections.database!.prepare('SELECT record_json FROM mote_connection_operation').get()!.record_json)
      )
      expect(parent.baseline.document.revision).toMatch(/^sha256:/)
      expect(parent.enrollmentInput.operationId).toBe(row.operation.operationId)
  } })
  vi.stubGlobal('fetch', vi.fn(native.fetch))
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(async (raw) => {
    const r = raw as (typeof http)[number]
    if (r.url?.includes('/auth/v3/'))
      return { code: 0, tenant_access_token: 'controlled-tenant-access', app_access_token: 'controlled-app-access', expire: 3600 }
    http.push(r)
    if (r.method === 'PATCH' || r.url?.endsWith('/app_avatar/upload')) {
      const kind = r.method === 'PATCH' ? 'patch' : 'upload',
        row = f.connections.database!.prepare('SELECT record_json FROM connection_profile_operation').get()!
      effects.push({ kind, preclaimed: JSON.parse(String(row.record_json))[kind].state === 'dispatching' })
    }
    if (r.url?.endsWith('/bot/v3/info'))
      return {
        code: 0,
        bot: { open_id: 'original-bot', app_name: 'Observed bot', avatar_url: 'https://images.example.invalid/online.png' }
      }
    if (r.url?.endsWith('/app_avatar/upload')) return { code: 0, data: { url: 'https://images.example.invalid/saved.png' } }
    if (r.method === 'PATCH') return { code: 0, data: {} }
    if (r.url?.includes('/app_versions/'))
      return {
        code: 0,
        data: { app_version: { app_id: 'cli_profile', version_id: 'online-original', description: 'Online description', status: 1 } }
      }
    return {
      code: 0,
      data: {
        app: {
          app_id: 'cli_profile',
          description: 'Draft metadata',
          online_version_id: 'online-original',
          i18n: [
            { i18n_key: 'en_us', name: 'Keep English' },
            { i18n_key: 'zh_cn', name: 'Before' }
          ]
        }
      }
    }
  })
  f = await fixture({})
  const input = { ...await f.input(), ...(name === undefined ? {} : { name }) }, expectedName = name ?? 'Saved public name'
  expect(body(await cli(f, 'ls', { target: f.target() })).operations).toEqual([])
  const pending = body(await cli(f, 'create', input))
  expect(pending.enrollment.authentication.stage).toBe('waiting')
  expect(pending.snapshot.name).toBe(expectedName)
  expect(pending.enrollment).toMatchObject({ label: expectedName, preset: { name: expectedName } })
  expect(pending.defaultSave).toBeNull()
  expect(pending.profile).toBeNull()
  let child = await f.client.call('connection.enrollment.inspect', { operationId: pending.enrollmentOperationId })
  expect(child.challenge?.qrPayload).toContain('private-mote-qr-1')
  expect(JSON.stringify(pending)).not.toContain('private-mote-qr-1')
  expect(pending.snapshot.avatarSha256).toBe(createHash('sha256').update(imagePng()).digest('hex'))
  for (let step = 0; step < 8 && child.operation!.authentication!.stage !== 'account'; step++) {
    body(await cli(f, 'advance', await moteChildDecision(f, input.operationId, 'continue-authentication')))
    child = await f.client.call('connection.enrollment.inspect', { operationId: pending.enrollmentOperationId })
  }
  expect(child.account).toMatchObject({ userId: 'mote-user-1', tenantId: 'mote-tenant' }); expect(native.creates).toBe(0)
  body(await cli(f, 'advance', await moteChildDecision(f, input.operationId, 'confirm-account')))
  expect(native.creates).toBe(0)
  const complete = body(await cli(f, 'advance', await moteChildDecision(f, input.operationId, 'create')))
  const nativeUpload = native.calls.find(call => call.target.pathname === '/developers/v1/app/upload/image')!.input.body as FormData
  expect(Buffer.from(await (nativeUpload.get('file') as File).arrayBuffer())).toEqual(imagePng())
  const creationRequests = native.calls.filter(call => call.target.pathname === '/developers/v1/manifest/upsert_by_template')
  expect(creationRequests).toHaveLength(1)
  expect(native.calls.some(call => call.target.pathname === '/developers/v1/app/create')).toBe(false)
  const nativeCreate = JSON.parse(String(creationRequests[0]!.input.body))
  expect(nativeCreate).toMatchObject({ appManifestTemplateID: 'developer_console', createAppUserCustomField: {
    i18n: { zh_cn: { name: expectedName, description: 'Saved public summary.' } },
    avatar: 'https://images.example.invalid/mote-1.png', primaryLang: 'zh_cn'
  } })
  expect(http).toEqual([])
  expect(complete).toMatchObject({
    snapshot: { name: expectedName },
    operationId: input.operationId,
    defaultLink: { state: 'saved' },
    defaultSave: { observedReceipt: { status: 'saved' } },
    enrollment: { configuration: 'configured' },
    profileOperationId: null,
    profile: null,
    issue: null
  })
  expect(effects).toEqual(['begin', 'authentication', 'authentication', 'authentication', 'authentication', 'authentication', 'upload', 'create', 'credential'].map((kind) => ({ kind, preclaimed: true })))
  expect((await f.client.call('connection.inspect', { connectionId: complete.connection.connectionId })).connection?.config.label).toBe(expectedName)
  expect(await readFile(join(f.motes[0]!.directory, 'topic.md'), 'utf8')).toBe('# Saved public name\n\nSaved public summary.\n')
  await expect(f.client.call('space.mote.connection.create', { ...input, name: 'Changed manual name' })).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
  expect((await cli(f, 'create', { ...input, name: 'Another manual name' })).code).not.toBe(0)
  expect(JSON.stringify([pending, complete, http])).not.toContain('DO-NOT-PUBLISH-SOUL')
  expect(JSON.stringify(complete)).not.toContain('private-original')
  expect(JSON.stringify(complete)).not.toContain('data:image')
  expect(http.some((r) => r.url?.includes('/publish'))).toBe(false)
  const source = vi.spyOn(f.source, 'read'),
    pref = vi.spyOn(f.preferences, 'read'),
    before = effects.length
  expect(body(await cli(f, 'inspect', { operationId: input.operationId })).operation).toEqual(complete)
  expect(body(await cli(f, 'ls', { target: f.target() })).operations).toEqual([complete])
  expect(source).not.toHaveBeenCalled()
  expect(pref).not.toHaveBeenCalled()
  expect(effects).toHaveLength(before)
}, 45_000)

it('freezes an explicit manual name across source edits and owner reopening while later sync still uses the saved Mote name', async () => {
  const f = await fixture(), input = { ...await f.input(), name: 'AMUX- 旅伴' }
  const pending = await f.client.call('space.mote.connection.create', input)
  expect(pending.snapshot.name).toBe(input.name)
  const row = JSON.parse(String(f.connections.database!.prepare('SELECT record_json FROM mote_connection_operation WHERE operation_id=?').get(input.operationId)!.record_json))
  expect(row.input.name).toBe(input.name)
  expect(row.enrollmentInput).toMatchObject({ label: input.name, preset: { name: input.name } })
  await writeFile(join(f.motes[0]!.directory, 'topic.md'), '# Later saved Mote name\n\nLater saved summary.\n')
  await f.close()
  const resumed = await moteConnectionOwner(f.root, { generic: true }); clean.push(resumed.close)
  expect(body(await cli(resumed, 'create', input))).toEqual(pending)
  expect((await resumed.client.call('space.mote.connection.inspect', { operationId: input.operationId })).operation).toEqual(pending)
  const complete = await confirmAndCreateMote(resumed, input.operationId)
  expect(complete.snapshot).toEqual(pending.snapshot)
  expect(complete.profile).toBeNull()
  expect(complete.enrollment?.preset?.name).toBe(input.name)
  expect((await resumed.client.call('connection.inspect', { connectionId: complete.connection!.connectionId })).connection?.config.label).toBe(input.name)
  const changed = { ...input, name: 'AMUX-New' }
  await expect(resumed.client.call('space.mote.connection.create', changed)).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
  expect((await cli(resumed, 'create', changed)).code).not.toBe(0)
  const current = await resumed.input('sync-saved-source'), synced = body(await cli(resumed, 'sync', {
    operationId: current.operationId, source: current.source, connection: complete.connection,
    expectedConnectionRevision: 1, avatar: current.avatar
  }))
  expect(synced.snapshot.name).toBe('Later saved Mote name')
  expect(synced.profile.desired.name).toBe('Later saved Mote name')
  expect(synced.enrollmentOperationId).toBeNull()
  expect(synced.defaultLink.state).toBe('not-requested')
  expect(resumed.counts).toEqual({ begin: 0, authentication: 1, creationUpload: 1, create: 1, credential: 1, upload: 1, patch: 1 })
  expect(await readFile(join(f.motes[0]!.directory, 'topic.md'), 'utf8')).toBe('# Later saved Mote name\n\nLater saved summary.\n')
}, 30_000)

it('rejects a different explicit frozen name in public create replies while keeping the original durable operation available', async () => {
  const f = await fixture(), input = { ...await f.input(), name: 'AMUX-Exact' }
  const pending = await f.client.call('space.mote.connection.create', input), foreign = structuredClone(pending)
  foreign.snapshot.name = 'Different returned name'
  foreign.enrollment!.label = foreign.snapshot.name
  foreign.enrollment!.preset!.name = foreign.snapshot.name
  expect(parseMoteConnectionOperation(foreign).snapshot.name).toBe(foreign.snapshot.name)
  const reply = vi.spyOn(f.parent, 'create').mockResolvedValue(foreign)
  await expect(f.client.call('space.mote.connection.create', input)).rejects.toMatchObject({ code: 'INVALID_MOTE_CONNECTION_DATA' })
  expect((await cli(f, 'create', input)).code).not.toBe(0)
  expect(() => parseMoteConnectionResult('space.mote.connection.create', foreign, input)).toThrow()
  const { name: _name, ...withoutName } = input
  expect(parseMoteConnectionResult('space.mote.connection.create', foreign, withoutName).snapshot.name).toBe(foreign.snapshot.name)
  reply.mockRestore()
  expect((await f.client.call('space.mote.connection.inspect', { operationId: input.operationId })).operation).toEqual(pending)
  expect(await f.client.call('space.mote.connection.create', input)).toEqual(pending)
  expect(f.counts.begin).toBe(1)
})

it('rejects malformed explicit create names and any sync name before parent admission or native requests', async () => {
  const f = await fixture(), input = await f.input()
  for (const name of ['', ' ', 'bad\nname', 'bad\u0000name', null, 7, {}]) {
    await expect(f.client.call('space.mote.connection.create', { ...input, name } as never)).rejects.toMatchObject({ code: 'INVALID_MOTE_CONNECTION_DATA' })
    expect((await cli(f, 'create', { ...input, name })).code).not.toBe(0)
  }
  expect((await f.client.call('space.mote.connection.ls', { target: f.target() })).operations).toEqual([])
  expect(f.counts).toEqual({ begin: 0, authentication: 0, creationUpload: 0, create: 0, credential: 0, upload: 0, patch: 0 })
  await expect(f.client.call('space.mote.connection.sync', { operationId: 'invalid-sync-name', source: input.source, avatar: input.avatar, connection: { connectionId: 'saved-bot', application: { domain: input.domain, appId: 'saved-app' } }, expectedConnectionRevision: 1, name: 'Forbidden sync name' } as never)).rejects.toMatchObject({ code: 'INVALID_MOTE_CONNECTION_DATA' })
})

it('retains immutable child identity and snapshot when the original saved topic changes after registration', async () => {
  const f = await fixture(),
    input = await f.input(),
    pending = await f.client.call('space.mote.connection.create', input)
  await writeFile(join(f.motes[0]!.directory, 'topic.md'), '# Later title\nLater public summary\n')
  const done = await confirmAndCreateMote(f, input.operationId)
  expect(done.snapshot).toEqual(pending.snapshot)
  expect(done.enrollmentOperationId).toBe(pending.enrollmentOperationId)
  expect(done.profileOperationId).toBe(pending.profileOperationId)
  expect(done.profile).toBeNull()
  expect(done.enrollment!.preset!.name).toBe('Saved public name')
  expect(f.counts).toEqual({ begin: 1, authentication: 1, creationUpload: 1, create: 1, credential: 1, upload: 0, patch: 0 })
  await expect(f.client.call('space.mote.connection.create', { ...input, avatar: 'omit' })).rejects.toMatchObject({
    code: 'CONNECTION_OPERATION_CONFLICT'
  })
  const original = JSON.parse(String(f.connections.database!.prepare('SELECT record_json FROM mote_connection_operation WHERE operation_id=?').get(input.operationId)!.record_json)).enrollmentInput
  await expect(f.client.call('connection.enrollment.begin', { ...original, preset: { ...original.preset, name: 'Different frozen intent' } })).rejects.toMatchObject(
    { code: 'CONNECTION_OPERATION_CONFLICT' }
  )
}, 30_000)

it('keeps structural original identities independent of JSON property order', async () => {
  const f = await fixture(),
    input = await f.input(),
    pending = await f.client.call('space.mote.connection.create', input)
  const resource = input.source.target.expectedResource
  const reordered = {
    ...input,
    source: {
      ...input.source,
      target: {
        zoneId: input.source.target.zoneId,
        spaceId: input.source.target.spaceId,
        expectedResource: { workspacePath: resource.workspacePath, workspaceId: resource.workspaceId, hostId: resource.hostId }
      }
    }
  }
  let joined: unknown = null,
    error: unknown = null
  try {
    joined = await f.client.call('space.mote.connection.create', reordered)
  } catch (value) {
    error = value
  }
  expect(error, 'Structural source identity cannot depend on JSON property order').toBeNull()
  expect(joined).toEqual(pending)
  expect((await f.client.call('space.mote.connection.ls', { target: reordered.source.target })).operations).toEqual([pending])
  const actor = JSON.parse(String(f.connections.database!.prepare('SELECT record_json FROM mote_connection_operation').get()!.record_json))
    .actor as { kind: 'user'; id: string }
  await confirmAndCreateMote(f, input.operationId)
  const done = await f.parent.advance({ operationId: input.operationId }, { actor: { id: actor.id, kind: actor.kind } })
  expect(done.defaultLink.state).toBe('saved')
  expect(done.profile).toBeNull()
  expect(f.counts.begin).toBe(1)
}, 30_000)

it('uses exact target, topic revision and saved PNG; an existing bot can sync with an explicit omitted avatar', async () => {
  const f = await fixture(),
    input = await f.input()
  await expect(
    f.client.call('space.mote.connection.create', {
      ...input,
      source: { ...input.source, target: { ...input.source.target, zoneId: f.target(1).zoneId } }
    })
  ).rejects.toMatchObject({ code: 'MOTE_CONNECTION_SOURCE_UNCONFIRMED' })
  await expect(
    f.client.call('space.mote.connection.create', {
      ...input,
      source: { ...input.source, expectedTopicRevision: 'sha256:' + '0'.repeat(64) }
    })
  ).rejects.toMatchObject({ code: 'MOTE_CONNECTION_SOURCE_UNCONFIRMED' })
  await expect(
    f.client.call('space.mote.connection.create', {
      ...input,
      source: { ...input.source, expectedAvatarRevision: 'sha256:' + '0'.repeat(64) }
    })
  ).rejects.toMatchObject({ code: 'MOTE_CONNECTION_SOURCE_UNCONFIRMED' })
  expect(f.counts.begin).toBe(0)
  await expect(f.client.call('space.mote.connection.create', { ...input, avatar: 'omit', source: { ...input.source, expectedAvatarRevision: null } })).rejects.toMatchObject({ code: 'MOTE_CONNECTION_SOURCE_UNCONFIRMED' })
  expect(f.counts.begin).toBe(0)
  await f.client.call('space.mote.connection.create', input)
  const saved = await confirmAndCreateMote(f, input.operationId)
  const readAvatar = vi.spyOn(f.avatars, 'call')
  const pending = await f.client.call('space.mote.connection.sync', {
    operationId: 'original-omit-sync', connection: saved.connection!, expectedConnectionRevision: 1,
    avatar: 'omit',
    source: { ...input.source, expectedAvatarRevision: null }
  })
  expect(pending.snapshot.avatarSha256).toBeNull()
  expect(readAvatar).not.toHaveBeenCalled()
  expect(f.counts.begin).toBe(1)
}, 30_000)

it('keeps unavailable or hash-corrupted saved avatars local and preserves explicit omit sync for the healthy saved bot', async () => {
  const f = await fixture(),
    input = await f.input(),
    mote = f.motes[0]!
  const healthyInput = { ...input, operationId: 'healthy-saved-bot' }
  await f.client.call('space.mote.connection.create', healthyInput)
  const healthy = await confirmAndCreateMote(f, healthyInput.operationId), before = f.writes
  const path = join(mote.directory, '.agentmux', 'avatars', mote.avatar.fileName)
  await writeFile(path, Buffer.concat([imagePng(), Buffer.from([0])]))
  let refused: unknown = null
  try {
    await f.client.call('space.mote.connection.create', input)
  } catch (error) {
    refused = error
  }
  expect(refused).toMatchObject({ code: 'MOTE_CONNECTION_SOURCE_UNCONFIRMED' })
  await rm(path)
  refused = null
  try {
    await f.client.call('space.mote.connection.create', input)
  } catch (error) {
    refused = error
  }
  expect(refused).toMatchObject({ code: 'MOTE_CONNECTION_SOURCE_UNCONFIRMED' })
  expect(f.counts.begin).toBe(1)
  const omitted = await f.client.call('space.mote.connection.sync', {
    operationId: 'healthy-omit-sync', connection: healthy.connection!, expectedConnectionRevision: 1,
    avatar: 'omit',
    source: { ...input.source, expectedAvatarRevision: null }
  })
  expect(omitted.snapshot.avatarSha256).toBeNull()
  expect(f.counts.begin).toBe(1)
  expect(f.writes).toBe(before)
  expect((await f.preferences.read({ kind: 'connection', target: f.target() })).values!.connection).toEqual(healthy.connection)
}, 30_000)

it('does not make a slow original setup the guard for another Mote or a local read', async () => {
  const f = await fixture(),
    input = await f.input(),
    original = f.adapter.enrollment!.begin
  let release!: () => void,
    reached!: () => void,
    first = true
  const waiting = new Promise<void>((r) => {
      reached = r
    }),
    resume = new Promise<void>((r) => {
      release = r
    })
  f.adapter.enrollment!.begin = async (...args) => {
    if (first) {
      first = false
      reached()
      await resume
    }
    return original(...args)
  }
  const late = f.client.call('space.mote.connection.create', input)
  await waiting
  const local = await f.client.call('space.mote.connection.inspect', { operationId: input.operationId })
  expect(local.operation!.operationId).toBe(input.operationId)
  const other = await f.client.call('space.mote.connection.create', await f.input('other-independent', 1))
  expect(other.enrollment!.authentication!.stage).toBe('waiting')
  release()
  expect((await late).enrollment!.authentication!.stage).toBe('waiting')
  expect(f.counts.begin).toBe(2)
}, 30_000)

it('rejects a mismatched original directory identity rather than trusting its same display name', async () => {
  const f = await fixture(),
    input = await f.input(),
    read = f.topics.readForDirectory.bind(f.topics)
  f.sourcePorts.topicForDirectory = async (...args) => {
    const fact = await read(...args)
    return fact ? { ...fact, identityDirectoryPath: f.motes[1]!.identity } : fact
  }
  let refused: unknown = null
  try {
    await f.client.call('space.mote.connection.create', input)
  } catch (error) {
    refused = error
  }
  expect(refused, 'Another directory identity cannot qualify this saved Mote profile').toMatchObject({
    code: 'MOTE_CONNECTION_SOURCE_UNCONFIRMED'
  })
  expect(f.counts.begin).toBe(0)
}, 30_000)

it('keeps later default B when original A completes, while still configuring and syncing A', async () => {
  const f = await fixture(),
    input = await f.input(),
    first = await f.client.call('space.mote.connection.create', input)
  const stored = await f.connections.secrets.store({ operationId: 'other-secret', secret: 'other-fixture-credential' }),
    connection = { connectionId: 'other-original', application: { domain: 'signed.example', appId: 'other-app' } }
  await f.connections.connections.configure({
    operationId: 'other-configure',
    expectedRevision: null,
    connection: { ...connection, adapterId: 'signed-profile', label: 'Other robot', enabled: true, credentialRef: stored.credentialRef }
  })
  const current = await f.preferences.read({ kind: 'connection', target: f.target() })
  const later = await f.preferences.save({
    kind: 'connection',
    target: f.target(),
    baseline: moteConnectionBaseline(current)!,
    values: { connection },
    operationId: 'later-default'
  })
  expect(later.status, JSON.stringify(later)).toBe('saved')
  const result = await confirmAndCreateMote(f, input.operationId)
  expect(result.enrollmentOperationId).toBe(first.enrollmentOperationId)
  expect(result.defaultLink).toMatchObject({ state: 'conflict', current: { connection } })
  expect(result.defaultSave!.observedReceipt!.status).toBe('refused-before-write')
  expect(result.profile).toBeNull()
  expect((await f.preferences.read({ kind: 'connection', target: f.target() })).values).toEqual({ connection })
}, 30_000)

it('keeps default association available when the same healthy app has a later configuration revision', async () => {
  const f = await fixture(),
    input = await f.input()
  await f.client.call('space.mote.connection.create', input)
  const port = f.connections.connections.enrollment!,
    advance = port.advance.bind(port)
  vi.spyOn(port, 'advance').mockImplementation(async (...args) => {
    const receipt = await advance(...args)
    if (receipt.operation?.configured) {
      const record = receipt.operation.configured.connection
      await f.connections.connections.configure({
        operationId: 'later-configuration',
        expectedRevision: record.revision,
        connection: { ...record.config, label: 'Later alias' }
      })
    }
    return receipt
  })
  const done = await confirmAndCreateMote(f, input.operationId)
  expect(done.defaultLink.state).toBe('saved')
  expect(done.defaultSave!.observedReceipt!.status).toBe('saved')
  expect(done.profile).toBeNull()
  expect(done.issue).toBeNull()
  expect(f.counts).toEqual({ begin: 1, authentication: 1, creationUpload: 1, create: 1, credential: 1, upload: 0, patch: 0 })
  expect((await f.preferences.read({ kind: 'connection', target: f.target() })).values!.connection).toEqual(done.connection)
}, 30_000)

it('keeps a saved default independent of an unknown profile PATCH and never replays that child', async () => {
  const f = await fixture({ generic: true, profileUnknown: true }),
    input = await f.input()
  await f.client.call('space.mote.connection.create', input)
  const done = await confirmAndCreateMote(f, input.operationId)
  expect(done.defaultLink.state).toBe('saved')
  expect(done.profile).toBeNull()
  const synced = await f.client.call('space.mote.connection.sync', { operationId: 'explicit-profile-sync', source: input.source, connection: done.connection!, expectedConnectionRevision: 1, avatar: input.avatar })
  expect(synced.profile!.patch.state).toBe('unknown')
  expect((await f.client.call('space.mote.connection.advance', { operationId: synced.operationId })).profile!.patch.state).toBe('unknown')
  expect(f.counts).toEqual({ begin: 1, authentication: 1, creationUpload: 1, create: 1, credential: 1, upload: 1, patch: 1 })
  expect((await f.preferences.read({ kind: 'connection', target: f.target() })).values!.connection).toEqual(done.connection)
}, 30_000)

it('keeps an original lost File acknowledgement unknown and allows explicit reassociation to the same app', async () => {
  const f = await fixture({ generic: true, loseFileAck: true }),
    input = await f.input()
  await f.client.call('space.mote.connection.create', input)
  const uncertain = await confirmAndCreateMote(f, input.operationId)
  expect(uncertain.defaultLink).toMatchObject({ state: 'unknown', current: { connection: uncertain.connection } })
  expect(uncertain.defaultSave!.observedReceipt!.status).toBe('unconfirmed')
  const writes = f.writes
  await f.client.call('space.mote.connection.advance', { operationId: input.operationId })
  expect(f.writes).toBe(writes)
  expect(f.counts).toEqual({ begin: 1, authentication: 1, creationUpload: 1, create: 1, credential: 1, upload: 0, patch: 0 })
  const current = await f.preferences.read({ kind: 'connection', target: f.target() })
  expect(
    (
      await f.preferences.save({
        kind: 'connection',
        target: f.target(),
        baseline: moteConnectionBaseline(current)!,
        values: { connection: uncertain.connection },
        operationId: 'explicit-reassociation'
      })
    ).status
  ).toBe('unchanged')
  expect((await f.client.call('space.mote.connection.inspect', { operationId: input.operationId })).operation!.defaultLink.state).toBe(
    'unknown'
  )
}, 30_000)

it('does not replay unknown platform steps and keeps independent intents and ordinary files available', async () => {
  const f = await fixture({ generic: true, authenticationUnknown: true }),
    a = await f.input('one-original')
  await f.client.call('space.mote.connection.create', a)
  const unknown = await f.client.call('space.mote.connection.advance', await moteChildDecision(f, a.operationId, 'continue-authentication'))
  expect(unknown.enrollment!.authentication!.stage).toBe('unknown')
  await f.client.call('space.mote.connection.advance', { operationId: a.operationId })
  expect(f.counts.authentication).toBe(1)
  const b = await f.client.call('space.mote.connection.create', await f.input('independent-original', 1))
  expect(b.enrollment!.authentication!.stage).toBe('waiting')
  expect(f.counts.begin).toBe(2)
  expect((await f.publicFiles.read({ ...f.target(), path: 'topic.md' })).result.status).toBe('read')
}, 30_000)

it('syncs the same exact saved app without another enrollment or default write', async () => {
  const f = await fixture(),
    input = await f.input()
  await f.client.call('space.mote.connection.create', input)
  const created = await confirmAndCreateMote(f, input.operationId)
  const writes = f.writes,
    sync = {
      operationId: 'sync-original',
      source: input.source,
      connection: created.connection!,
      expectedConnectionRevision: 1,
      avatar: 'include-saved' as const
    }
  const synced = body(await cli(f, 'sync', sync))
  expect(synced.enrollmentOperationId).toBeNull()
  expect(synced.defaultLink.state).toBe('not-requested')
  expect(synced.defaultSave).toBeNull()
  expect(synced.profile.patch.state).toBe('confirmed')
  expect(f.counts).toEqual({ begin: 1, authentication: 1, creationUpload: 1, create: 1, credential: 1, upload: 1, patch: 1 })
  expect(f.writes).toBe(writes)
  await expect(
    f.client.call('space.mote.connection.sync', {
      ...sync,
      operationId: 'wrong-app',
      connection: { ...sync.connection, application: { ...sync.connection.application, appId: 'different-app' } }
    })
  ).rejects.toMatchObject({ code: 'CONNECTION_REVISION_CONFLICT' })
  expect(f.counts.patch).toBe(1)
}, 30_000)

it('requires transport authority and correlates original child receipts without accepting payload-authored privilege', async () => {
  const f = await fixture(),
    input = await f.input(),
    service = new AgentMuxRpcService({ moteConnections: f.parent })
  clean.push(() => service.dispose())
  await expect(service.call('space.mote.connection.create', input, {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect((await cli(f, 'create', { ...input, actor: { kind: 'user', id: 'invented' } })).code).not.toBe(0)
  await f.client.call('space.mote.connection.create', input)
  const done = await confirmAndCreateMote(f, input.operationId)
  await expect(
    service.call('space.mote.connection.advance', { operationId: input.operationId }, { principal: { kind: 'device', id: 'other-device' } })
  ).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(() => parseMoteConnectionOperation({ ...done, profile: { ...done.profile!, operationId: 'foreign-child' } })).toThrow()
  expect(() =>
    parseMoteConnectionResult(
      'space.mote.connection.inspect',
      { operation: { ...done, operationId: 'different' } },
      { operationId: input.operationId }
    )
  ).toThrow()
  expect(f.counts).toEqual({ begin: 1, authentication: 1, creationUpload: 1, create: 1, credential: 1, upload: 0, patch: 0 })
}, 30_000)

it('preserves original connections when optional parent schema fails, and refuses after its owner closes', async () => {
  const f = await fixture(),
    db = f.connections.database!,
    original = db.exec.bind(db)
  const fault = vi.spyOn(db, 'exec').mockImplementation((sql) => {
    if (sql.includes('mote_connection_operation')) throw new Error('private database diagnostic')
    return original(sql)
  })
  await expect(f.client.call('space.mote.connection.ls', { target: f.target() })).rejects.toThrow('unconfirmed')
  expect((await f.client.call('connection.ls', {})).connections).toEqual([])
  fault.mockRestore()
  expect((await f.client.call('space.mote.connection.ls', { target: f.target() })).operations).toEqual([])
  f.parent.close()
  await expect(f.parent.create(await f.input(), { actor: { kind: 'user', id: 'original' } })).rejects.toMatchObject({
    code: 'MOTE_CONNECTION_STORAGE_UNCONFIRMED'
  })
  expect(db.prepare('SELECT 1 AS retained').get()).toEqual({ retained: 1 })
  expect(f.counts.begin).toBe(0)
}, 30_000)

it('recovers the same parent after a real child is killed after Files commit and before the parent ACK', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mote-bot-process-')))
  clean.push(() => rm(root, { recursive: true, force: true }))
  const exported = Object.fromEntries(
    await Promise.all(
      ['core', 'connectors', 'client-ui'].map(async (name) => [
        name,
        JSON.parse(await readFile(resolve('packages', name, 'package.json'), 'utf8')) as { exports: Record<string, { import: string }> }
      ])
    )
  )
  const program = join(root, 'owner.mjs')
  const packagePath = (request: string) => {
    const [, name, ...rest] = request.split('/'),
      subpath = rest.length ? './' + rest.join('/') : '.',
      manifest = exported[name!]!
    const key = manifest.exports[subpath]
      ? subpath
      : Object.keys(manifest.exports)
          .sort((a, b) => b.length - a.length)
          .find((key) => key.includes('*') && subpath.startsWith(key.split('*')[0]!) && subpath.endsWith(key.split('*')[1]!))!
    const wildcard = key.includes('*')
      ? subpath.slice(key.split('*')[0]!.length, key.split('*')[1]!.length ? -key.split('*')[1]!.length : undefined)
      : ''
    return resolve('packages', name!, manifest.exports[key]!.import.replace('*', wildcard))
  }
  const requireDesktop = createRequire(resolve('apps/desktop/package.json'))
  await build({
    entryPoints: ['apps/desktop/test/fixtures/mote-connection-process.ts'],
    outfile: program,
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    plugins: [
      {
        name: 'original-owner-paths-and-native-leaf',
        setup(b: {
          onResolve(options: { filter: RegExp }, callback: (args: { path: string }) => unknown): void
          onLoad(options: { filter: RegExp; namespace?: string }, callback: (args: { path: string }) => unknown): void
        }) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'controlled' }))
          b.onLoad({ filter: /.*/, namespace: 'controlled' }, () => ({
            contents: `const unexpected=()=>{throw Error("Unexpected native Electron capability in Files process fixture")};
              export const nativeImage={createFromBuffer:unexpected};
              export const app={whenReady:unexpected};
              export const session={fromPartition:unexpected};
              export class WebContentsView {constructor(){unexpected()}};
              export const nativeTheme={get shouldUseDarkColors(){return unexpected()}};`
          }))
          b.onResolve({ filter: /^@agentmux\// }, (args) => ({ path: packagePath(args.path), external: true }))
          b.onResolve({ filter: /^[^./]/ }, (args) =>
            args.path.startsWith('node:')
              ? { path: args.path, external: true }
              : { path: requireDesktop.resolve(args.path), external: true }
          )
          b.onLoad({ filter: /\.(?:ts|mjs)$/ }, async (args) => ({
            contents: (await readFile(args.path, 'utf8'))
              .replaceAll('import.meta.dirname', JSON.stringify(resolve(args.path, '..')))
              .replaceAll('import.meta.url', JSON.stringify(new URL('file://' + args.path).href)),
            loader: args.path.endsWith('.ts') ? 'ts' : 'js'
          }))
        }
      }
    ]
  })
  const spawn = async (mode: string) => {
    const child = fork(program, [root, mode], {
      cwd: process.cwd(),
      env: objectCliEnvironment(root),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    clean.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await once(child, 'exit')
      }
    })
    let stderr = ''
    child.stderr!.on('data', (c) => {
      stderr += String(c)
    })
    await new Promise<void>((resolve, reject) => {
      child.on('message', (v) => {
        if ((v as { kind: string }).kind === 'ready') resolve()
      })
      child.once('exit', () => reject(new Error('Owner exited before ready: ' + stderr)))
    })
    return child
  }
  const first = await spawn('lose-ack'),
    request = JSON.parse(await readFile(join(root, 'request.json'), 'utf8'))
  const call = (action: string, input: unknown) =>
    runCompiledObjectCli(
      [
        '--endpoint',
        'unix:' + join(root, 'owner.sock'),
        'space',
        'mote',
        'connection',
        action,
        ...(['create', 'ls', 'advance'].includes(action) ? ['--input', '-'] : ['--operation-id', request.operationId])
      ],
      objectCliEnvironment(root),
      JSON.stringify(input)
    )
  const pending = body(await call('create', request)),
    reached = new Promise<void>((resolve) =>
      first.on('message', (value) => {
        if ((value as { kind: string }).kind === 'file-published') resolve()
      })
    )
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'owner.sock') } })
  clean.push(() => client.dispose())
  body(await call('advance', await moteChildDecision({ client }, request.operationId, 'continue-authentication')))
  body(await call('advance', await moteChildDecision({ client }, request.operationId, 'confirm-account')))
  const advancing = call('advance', await moteChildDecision({ client }, request.operationId, 'create'))
  await reached
  const before = await readFile(join(root, 'file-effects'), 'utf8')
  expect(before.trim().split('\n').map(line => JSON.parse(line))).toEqual([{status:'written'}])
  first.kill('SIGKILL')
  await once(first, 'exit')
  expect((await advancing).code).not.toBe(0)
  await spawn('recover')
  const reopened = body(await call('inspect', { operationId: request.operationId })).operation
  expect(reopened).toMatchObject({
    operationId: request.operationId,
    enrollmentOperationId: pending.enrollmentOperationId,
    profileOperationId: pending.profileOperationId,
    defaultLink: { state: 'unknown' },
    defaultSave: { observedReceipt: null }
  })
  const recovered = body(await call('advance', { operationId: request.operationId }))
  expect(recovered.defaultLink).toMatchObject({ state: 'unknown', current: { connection: recovered.connection } })
  expect(recovered.defaultSave.observedReceipt).toBeNull()
  expect(recovered.profile).toBeNull()
  expect(body(await call('ls', { target: request.source.target })).operations).toEqual([recovered])
  expect(await readFile(join(root, 'file-effects'), 'utf8')).toBe(before)
  expect((await readFile(join(root, 'platform-effects'), 'utf8')).trim().split('\n')).toEqual(['begin', 'authentication', 'creationUpload', 'create', 'credential'])
}, 60_000)
