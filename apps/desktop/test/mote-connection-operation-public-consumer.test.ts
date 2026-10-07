import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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
import { AGENTMUX_RPC_NATIVE_METHODS, AgentMuxRpcService, parseMoteConnectionOperation, parseMoteConnectionResult } from '@agentmux/core'
import { AGENTMUX_CLI_COMMANDS } from '../../../packages/core/src/agentmux-cli-commands.js'
import { moteConnectionBaseline } from '@agentmux/core/mote-preferences'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { moteConnectionOwner } from './fixtures/mote-connection-owner.js'
import { imagePng } from './fixtures/mote-identity-image.js'

const clean: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of clean.splice(0).reverse()) await close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function record(name: string, value: unknown) {
  const directory = resolve('.bagakit/feature-tracker/features/f-2wr8fmvnv/artifacts/mote-bot-identities-plan/T-030-live')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, name + '.json'), JSON.stringify(value, null, 2) + '\n')
}
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
      ...(['create', 'sync', 'ls'].includes(action)
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

it('creates from original Main saved files and PNG through default Host, official SDK and compiled CLI with separate receipts', async () => {
  const http: Array<{ method?: string; url?: string; data?: Record<string, unknown> }> = [],
    effects: Array<{ kind: string; preclaimed: boolean }> = []
  let f!: Awaited<ReturnType<typeof fixture>>,
    clock = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const p = new URLSearchParams(String(init.body)),
        kind = p.get('action')!
      const saved = f.connections.database!.prepare('SELECT record_json FROM connection_enrollment').get()!
      const row = JSON.parse(String(saved.record_json)),
        attempt = f.connections.database!.prepare('SELECT state FROM connection_enrollment_attempt WHERE attempt_id=?').get(row.attemptId)
      effects.push({ kind, preclaimed: attempt?.state === 'claimed' })
      const parent = JSON.parse(
        String(f.connections.database!.prepare('SELECT record_json FROM mote_connection_operation').get()!.record_json)
      )
      expect(parent.baseline.document.revision).toMatch(/^sha256:/)
      expect(parent.enrollmentInput.operationId).toBe(row.operation.operationId)
      return Response.json(
        kind === 'begin'
          ? {
              device_code: 'private-original-device',
              user_code: 'PUBLIC',
              verification_uri_complete: 'https://open.feishu.cn/page/cli?user_code=PUBLIC',
              interval: 1,
              expires_in: 600
            }
          : { client_id: 'cli_profile', client_secret: 'private-original-secret', user_info: { tenant_brand: 'feishu' } }
      )
    })
  )
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
  const input = await f.input()
  expect(body(await cli(f, 'ls', { target: f.target() })).operations).toEqual([])
  const pending = body(await cli(f, 'create', input))
  expect(pending.enrollment.authorization).toBe('pending')
  expect(pending.defaultSave).toBeNull()
  expect(pending.profile).toBeNull()
  const qr = new URL(pending.enrollment.challenge.verificationUrl)
  expect(qr.searchParams.get('name')).toBe('Saved public name')
  expect(qr.searchParams.get('desc')).toBe('Saved public summary.')
  expect(pending.snapshot.avatarSha256).toBe(createHash('sha256').update(imagePng()).digest('hex'))
  clock = pending.enrollment.challenge.nextPollAt + 1
  const complete = body(await cli(f, 'advance', { operationId: input.operationId }))
  expect(Buffer.from(http.find((r) => r.url?.endsWith('/app_avatar/upload'))!.data!.avatar as Buffer)).toEqual(imagePng())
  expect(complete).toMatchObject({
    operationId: input.operationId,
    defaultLink: { state: 'saved' },
    defaultSave: { observedReceipt: { status: 'saved' } },
    enrollment: { configuration: 'configured' },
    profile: { upload: { state: 'confirmed' }, patch: { state: 'confirmed' }, publication: 'platform-review-required' }
  })
  expect(effects).toEqual(['begin', 'poll', 'upload', 'patch'].map((kind) => ({ kind, preclaimed: true })))
  expect(http.find((r) => r.method === 'PATCH')!.data).toMatchObject({
    i18ns: [
      { i18n_key: 'en_us', name: 'Keep English' },
      { i18n_key: 'zh_cn', name: 'Saved public name', description: 'Saved public summary.' }
    ]
  })
  expect(JSON.stringify([pending, complete, http])).not.toContain('DO-NOT-PUBLISH-SOUL')
  expect(JSON.stringify(complete)).not.toContain('private-original')
  expect(JSON.stringify(complete)).not.toContain('data:image')
  expect(http.some((r) => r.url?.includes('/publish'))).toBe(false)
  await record('default-host-receipts', {
    input,
    pending,
    complete,
    effects,
    uploadedSha256: createHash('sha256')
      .update(Buffer.from(http.find((r) => r.url?.endsWith('/app_avatar/upload'))!.data!.avatar as Buffer))
      .digest('hex')
  })
  const source = vi.spyOn(f.source, 'read'),
    pref = vi.spyOn(f.preferences, 'read'),
    before = effects.length
  expect(body(await cli(f, 'inspect', { operationId: input.operationId })).operation).toEqual(complete)
  expect(body(await cli(f, 'ls', { target: f.target() })).operations).toEqual([complete])
  expect(source).not.toHaveBeenCalled()
  expect(pref).not.toHaveBeenCalled()
  expect(effects).toHaveLength(before)
}, 45_000)

it('retains immutable child identity and snapshot when the original saved topic changes after registration', async () => {
  const f = await fixture(),
    input = await f.input(),
    pending = await f.client.call('space.mote.connection.create', input)
  await writeFile(join(f.motes[0]!.directory, 'topic.md'), '# Later title\nLater public summary\n')
  const done = await f.client.call('space.mote.connection.advance', { operationId: input.operationId })
  expect(done.snapshot).toEqual(pending.snapshot)
  expect(done.enrollmentOperationId).toBe(pending.enrollmentOperationId)
  expect(done.profileOperationId).toBe(pending.profileOperationId)
  expect(done.profile!.desired.name).toBe('Saved public name')
  expect(f.counts).toEqual({ begin: 1, poll: 1, upload: 1, patch: 1 })
  await expect(f.client.call('space.mote.connection.create', { ...input, avatar: 'omit' })).rejects.toMatchObject({
    code: 'CONNECTION_OPERATION_CONFLICT'
  })
  const original = await f.client.call('connection.enrollment.inspect', { operationId: done.enrollmentOperationId! })
  const { operationId, connectionId, adapterId, domain, label } = original.operation!
  await expect(f.client.call('connection.enrollment.begin', { operationId, connectionId, adapterId, domain, label })).rejects.toMatchObject(
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
  const done = await f.parent.advance({ operationId: input.operationId }, { actor: { id: actor.id, kind: actor.kind } })
  expect(done.defaultLink.state).toBe('saved')
  expect(done.profile!.patch.state).toBe('confirmed')
  expect(f.counts.begin).toBe(1)
}, 30_000)

it('uses exact target, topic revision and saved PNG; omit never requires an avatar fallback', async () => {
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
  const readAvatar = vi.spyOn(f.avatars, 'call')
  const pending = await f.client.call('space.mote.connection.create', {
    ...input,
    avatar: 'omit',
    source: { ...input.source, expectedAvatarRevision: null }
  })
  expect(pending.snapshot.avatarSha256).toBeNull()
  expect(readAvatar).not.toHaveBeenCalled()
  expect(f.counts.begin).toBe(1)
}, 30_000)

it('keeps unavailable or hash-corrupted saved avatars local and allows an explicit omit request', async () => {
  const f = await fixture(),
    input = await f.input(),
    mote = f.motes[0]!
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
  expect(f.counts.begin).toBe(0)
  const omitted = await f.client.call('space.mote.connection.create', {
    ...input,
    avatar: 'omit',
    source: { ...input.source, expectedAvatarRevision: null }
  })
  expect(omitted.snapshot.avatarSha256).toBeNull()
  expect(f.counts.begin).toBe(1)
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
  expect(other.enrollment!.authorization).toBe('pending')
  release()
  expect((await late).enrollment!.authorization).toBe('pending')
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
  const result = await f.client.call('space.mote.connection.advance', { operationId: input.operationId })
  expect(result.enrollmentOperationId).toBe(first.enrollmentOperationId)
  expect(result.defaultLink).toMatchObject({ state: 'conflict', current: { connection } })
  expect(result.defaultSave!.observedReceipt!.status).toBe('refused-before-write')
  expect(result.profile!.patch.state).toBe('confirmed')
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
    if (receipt.configured) {
      const record = receipt.configured.connection
      await f.connections.connections.configure({
        operationId: 'later-configuration',
        expectedRevision: record.revision,
        connection: { ...record.config, label: 'Later alias' }
      })
    }
    return receipt
  })
  const done = await f.client.call('space.mote.connection.advance', { operationId: input.operationId })
  expect(done.defaultLink.state).toBe('saved')
  expect(done.defaultSave!.observedReceipt!.status).toBe('saved')
  expect(done.profile).toBeNull()
  expect(done.issue).toBe('connection-revised')
  expect(f.counts).toEqual({ begin: 1, poll: 1, upload: 0, patch: 0 })
  expect((await f.preferences.read({ kind: 'connection', target: f.target() })).values!.connection).toEqual(done.connection)
}, 30_000)

it('keeps a saved default independent of an unknown profile PATCH and never replays that child', async () => {
  const f = await fixture({ generic: true, profileUnknown: true }),
    input = await f.input()
  await f.client.call('space.mote.connection.create', input)
  const done = await f.client.call('space.mote.connection.advance', { operationId: input.operationId })
  expect(done.defaultLink.state).toBe('saved')
  expect(done.profile!.patch.state).toBe('unknown')
  expect((await f.client.call('space.mote.connection.advance', { operationId: input.operationId })).profile!.patch.state).toBe('unknown')
  expect(f.counts).toEqual({ begin: 1, poll: 1, upload: 1, patch: 1 })
  expect((await f.preferences.read({ kind: 'connection', target: f.target() })).values!.connection).toEqual(done.connection)
}, 30_000)

it('keeps an original lost File acknowledgement unknown and allows explicit reassociation to the same app', async () => {
  const f = await fixture({ generic: true, loseFileAck: true }),
    input = await f.input()
  await f.client.call('space.mote.connection.create', input)
  const uncertain = await f.client.call('space.mote.connection.advance', { operationId: input.operationId })
  expect(uncertain.defaultLink).toMatchObject({ state: 'unknown', current: { connection: uncertain.connection } })
  expect(uncertain.defaultSave!.observedReceipt!.status).toBe('unconfirmed')
  const writes = f.writes
  await f.client.call('space.mote.connection.advance', { operationId: input.operationId })
  expect(f.writes).toBe(writes)
  expect(f.counts).toEqual({ begin: 1, poll: 1, upload: 1, patch: 1 })
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
  const f = await fixture({ generic: true, pollUnknown: true }),
    a = await f.input('one-original')
  await f.client.call('space.mote.connection.create', a)
  const unknown = await f.client.call('space.mote.connection.advance', { operationId: a.operationId })
  expect(unknown.enrollment!.authorization).toBe('unknown')
  await f.client.call('space.mote.connection.advance', { operationId: a.operationId })
  expect(f.counts.poll).toBe(1)
  const b = await f.client.call('space.mote.connection.create', await f.input('independent-original', 1))
  expect(b.enrollment!.authorization).toBe('pending')
  expect(f.counts.begin).toBe(2)
  expect((await f.publicFiles.read({ ...f.target(), path: 'topic.md' })).result.status).toBe('read')
}, 30_000)

it('syncs the same exact saved app without another enrollment or default write', async () => {
  const f = await fixture(),
    input = await f.input()
  await f.client.call('space.mote.connection.create', input)
  const created = await f.client.call('space.mote.connection.advance', { operationId: input.operationId })
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
  expect(f.counts).toEqual({ begin: 1, poll: 1, upload: 2, patch: 2 })
  expect(f.writes).toBe(writes)
  await expect(
    f.client.call('space.mote.connection.sync', {
      ...sync,
      operationId: 'wrong-app',
      connection: { ...sync.connection, application: { ...sync.connection.application, appId: 'different-app' } }
    })
  ).rejects.toMatchObject({ code: 'CONNECTION_REVISION_CONFLICT' })
  expect(f.counts.patch).toBe(2)
}, 30_000)

it('requires transport authority and correlates original child receipts without accepting payload-authored privilege', async () => {
  const f = await fixture(),
    input = await f.input(),
    service = new AgentMuxRpcService({ moteConnections: f.parent })
  clean.push(() => service.dispose())
  await expect(service.call('space.mote.connection.create', input, {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect((await cli(f, 'create', { ...input, actor: { kind: 'user', id: 'invented' } })).code).not.toBe(0)
  await f.client.call('space.mote.connection.create', input)
  const done = await f.client.call('space.mote.connection.advance', { operationId: input.operationId })
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
  expect(f.counts).toEqual({ begin: 1, poll: 1, upload: 1, patch: 1 })
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

