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

