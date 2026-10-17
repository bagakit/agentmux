import { afterEach, expect, it, vi } from 'vitest'
import { ConnectionProfileHost } from '@agentmux/connectors'
import { FeishuAdapter } from '@agentmux/connectors/adapters/feishu'
import { profileFixture, originalI18n, type ProfileRequest } from './fixtures/connection-profile.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture(options: Parameters<typeof profileFixture>[0]) { const f = await profileFixture(options); cleanup.push(f.close); return f }
const reply = (request: ProfileRequest) => request.url?.endsWith('/app_avatar/upload') ? { code: 0, data: { url: 'https://images.example.invalid/upload.png' } }
  : request.url?.endsWith('/bot/v3/info') ? { code: 0, bot: { open_id: 'original-bot' } }
  : request.method === 'PATCH' ? { code: 0, data: {} }
  : { code: 0, data: { app: { app_id: 'cli_profile', i18n: structuredClone(originalI18n) } } }
const cliResult = (result: { code: number | null; stdout: string; stderr: string }) => { expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result }

it('retains the exact native preparation refusal through the default SDK, original owner, inspect, compiled CLI and reopen', async () => {
  const f = await fixture({ http: async request => request.url?.endsWith('/applications/cli_profile') ? { code: 210006, msg: 'private response message', token: 'private native token' } : reply(request) })
  const input = { ...f.input, desired: { name: 'Original desired' } }
  const operation = await f.sdk.call('connection.profile.sync', input)
  expect(operation.patch).toEqual({ state: 'not-dispatched', diagnostic: { stage: 'prepare-patch', nativeCode: 210006 } })
  expect(operation.reason).toBe('permission-required'); expect(f.effects).toHaveLength(0)
  const before = f.calls.length
  expect((await f.sdk.call('connection.profile.inspect', { operationId: input.operationId })).operation).toEqual(operation)
  expect(cliResult(await f.cli(['inspect', '--operation-id', input.operationId])).operation).toEqual(operation)
  expect(f.calls).toHaveLength(before)
  await f.closeOwner(); await f.reopen()
  expect(cliResult(await f.cli(['inspect', '--operation-id', input.operationId])).operation).toEqual(operation)
  expect(f.calls).toHaveLength(before); expect(JSON.stringify(operation)).not.toMatch(/private response|private native|pngDataUrl/)
}, 30_000)

it('keeps an unclassified native PATCH code unknown and does not mistake body status for an HTTP observation', async () => {
  const f = await fixture({ http: async request => request.method === 'PATCH' ? { code: 210099, status: 503, msg: 'private body', data: { secret: 'private token' } } : reply(request) })
  const input = { ...f.input, desired: { name: 'Original desired' } }, operation = await f.sdk.call('connection.profile.sync', input)
  expect(operation.patch).toEqual({ state: 'unknown', diagnostic: { stage: 'patch', nativeCode: 210099 } })
  expect(operation.reason).toBe('effect-unconfirmed'); expect(f.effects).toHaveLength(1)
  expect(cliResult(await f.cli(['inspect', '--operation-id', input.operationId])).operation).toEqual(operation)
  expect(JSON.stringify(operation)).not.toMatch(/private body|private token|httpStatus/)
  await f.sdk.call('connection.profile.advance', { operationId: input.operationId }); expect(f.effects).toHaveLength(1)
}, 30_000)

it.each(['upload', 'prepare-patch', 'patch'] as const)('preserves safe %s transport facts before SDK error erasure without authorizing replay', async stage => {
  const f = await fixture({ http: async request => {
    const selected = stage === 'upload' ? request.url?.endsWith('/app_avatar/upload') : stage === 'patch' ? request.method === 'PATCH' : request.url?.endsWith('/applications/cli_profile')
    if (selected) throw Object.assign(new Error('private URL/body/cookie error'), { code: 'ETIMEDOUT', isAxiosError: true, response: { status: 504, data: { code: 999999, token: 'private raw response' } }, config: { url: 'https://private.example.invalid/?secret=private' } })
    return reply(request)
  } })
  const input = stage === 'upload' ? f.input : { ...f.input, desired: { name: 'Original desired' } }, operation = await f.sdk.call('connection.profile.sync', input)
  const slot = stage === 'upload' ? 'upload' : 'patch'
  expect(operation[slot]).toEqual({ state: stage === 'prepare-patch' ? 'not-dispatched' : 'unknown', diagnostic: { stage, transportCode: 'ETIMEDOUT', httpStatus: 504 } })
  expect(operation.reason).toBe(stage === 'prepare-patch' ? 'source-unconfirmed' : 'effect-unconfirmed')
  const before = f.calls.length, effects = f.effects.length
  expect(cliResult(await f.cli(['inspect', '--operation-id', input.operationId])).operation).toEqual(operation); expect(f.calls).toHaveLength(before)
  if (stage !== 'prepare-patch') { await f.sdk.call('connection.profile.advance', { operationId: input.operationId }); expect(f.effects).toHaveLength(effects) }
  expect(JSON.stringify(operation)).not.toMatch(/private URL|private raw|private.example|cookie|secret|stack/)
}, 30_000)

it('retains only the exact avatar upload native code before SDK unwrapping and keeps unrelated leaves sanitized', async () => {
  const f = await fixture({ http: async request => {
    if (request.url?.endsWith('/app_avatar/upload')) return { code: 210006, status: 403, msg: 'private rejected payload', data: {} }
    if (request.url?.endsWith('/probe')) throw Object.assign(new Error('private TLS details'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', isAxiosError: true, response: { status: 502 } })
    if (request.url?.endsWith('/other-leaf')) return { code: 210006, data: {} }
    return reply(request)
  } })
  const operation = await f.sdk.call('connection.profile.sync', f.input)
  expect(operation.upload).toEqual({ state: 'unknown', diagnostic: { stage: 'upload', nativeCode: 210006 } }); expect(operation.patch.state).toBe('not-dispatched')
  const adapter = new FeishuAdapter()
  let error: unknown
  try { await adapter.withClient(f.config, 'private-profile-secret', client => client.request({ url: '/probe', method: 'GET' })) } catch (caught) { error = caught }
  expect(error).toMatchObject({ code: 'FEISHU_SDK_REQUEST_FAILED' })
  expect(JSON.stringify(error)).not.toMatch(/UNABLE_TO_GET_ISSUER|502|private TLS|diagnostic|response/)
  expect(await adapter.withClient(f.config, 'private-profile-secret', client => client.request({ url: '/other-leaf', method: 'GET' }))).toEqual({ code: 210006, data: {} })
}, 30_000)

it('preserves an old unrecorded diagnostic as absent through inspect and reopen without a write or effect replay', async () => {
  const f = await fixture({ generic: true, profile: { patch: vi.fn(async () => ({ state: 'unknown', reason: 'effect-unconfirmed' })) } })
  const input = { ...f.input, desired: { name: 'Original desired' } }, operation = await f.sdk.call('connection.profile.sync', input)
  expect(operation.patch).toEqual({ state: 'unknown' })
  const before = f.services.database!.prepare('SELECT record_json FROM connection_profile_operation WHERE operation_id=?').get(input.operationId)
  await f.closeOwner(); await f.reopen()
  expect(cliResult(await f.cli(['inspect', '--operation-id', input.operationId])).operation).toEqual(operation)
  expect(f.services.database!.prepare('SELECT record_json FROM connection_profile_operation WHERE operation_id=?').get(input.operationId)).toEqual(before)
  await f.sdk.call('connection.profile.advance', { operationId: input.operationId }); expect(f.profile.patch).toHaveBeenCalledTimes(1)
}, 30_000)

it.each(['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'private-code-with-secret'] as const)('retains only allowlisted transport code %s and leaves unavailable HTTP absent', async code => {
  const f = await fixture({ http: async request => {
    if (request.url?.endsWith('/app_avatar/upload')) throw Object.assign(new Error('private TLS or proxy message'), { code, response: { status: 503 } })
    return reply(request)
  } })
  const operation = await f.sdk.call('connection.profile.sync', f.input)
  expect(operation.upload).toEqual({ state: 'unknown', diagnostic: { stage: 'upload', ...(code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' ? { transportCode: code } : {}) } })
  expect(JSON.stringify(operation)).not.toMatch(/private-code|private TLS|httpStatus|503/)
  const before = f.calls.length
  expect(cliResult(await f.cli(['inspect', '--operation-id', f.input.operationId])).operation).toEqual(operation); expect(f.calls).toHaveLength(before)
}, 30_000)

it('strictly rejects unsafe, wrong-slot or fabricated diagnostic fields through original public inspect', async () => {
  const f = await fixture({ generic: true }), operation = await f.sdk.call('connection.profile.sync', f.input), inspect = ConnectionProfileHost.prototype.inspect
  const unsafe = [
    { stage: 'patch', nativeCode: 1, message: 'private exception' }, { stage: 'patch', nativeCode: 1.5 },
    { stage: 'patch', httpStatus: 99 }, { stage: 'patch', httpStatus: 600 },
    { stage: 'upload', transportCode: 'ETIMEDOUT' }, { stage: 'patch', transportCode: 'PRIVATE_SECRET_AS_CODE' }
  ]
  for (const diagnostic of unsafe) {
    const spy = vi.spyOn(ConnectionProfileHost.prototype, 'inspect').mockImplementation(async function (input, context) {
      const original = await inspect.call(this, input, context)
      return { operation: original.operation ? { ...original.operation, patch: { state: 'unknown', diagnostic }, publication: 'not-requested', reason: 'effect-unconfirmed' } as typeof operation : null }
    })
    await expect(f.sdk.call('connection.profile.inspect', { operationId: f.input.operationId })).rejects.toMatchObject({ code: 'INVALID_CONNECTION_PROFILE_DATA' })
    spy.mockRestore()
  }
  expect(cliResult(await f.cli(['inspect', '--operation-id', f.input.operationId])).operation).toEqual(operation)
  expect(operation.upload).not.toHaveProperty('diagnostic'); expect(operation.patch).not.toHaveProperty('diagnostic')
}, 30_000)
