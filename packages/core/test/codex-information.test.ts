import { afterEach, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { parseAgentInformationSnapshot } from '../src/agent-information.js'
import { parseAgentConfigurationSnapshot } from '../src/agent-configuration.js'

const location = vi.hoisted(() => ({ endpoint: '', reads: 0, changed: false, foreignListener: false }))
vi.mock('../src/agent-native-process.js', async original => ({ ...await original<typeof import('../src/agent-native-process.js')>(),
  nativeProcessBirth: async (pid: number) => pid + ':original',
  nativeProcessTcpListeners: async () => { location.reads++; return [{ processId: 200,
    endpoint: location.changed && location.reads > 1 ? 'ws://127.0.0.1:1' : location.endpoint },
    ...(location.foreignListener ? [{ processId: 201, endpoint: location.endpoint }] : [])] }
}))
const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); Object.assign(location, { endpoint: '', reads: 0, changed: false, foreignListener: false }) })

async function fixture() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening')
  const address = server.address(); if (typeof address === 'string' || !address) throw new Error('Original actor did not listen')
  location.endpoint = `ws://127.0.0.1:${address.port}`
  closes.push(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [], authorization: unknown[] = []
  const thread = { id: 'native-original', sessionId: 'runtime-original', canAcceptDirectInput: true as boolean | null, status: { type: 'idle' }, model: 'model-original', modelProvider: 'provider-original' }
  const account = { account: { type: 'chatgpt', planType: 'pro', email: 'private-account@example.invalid' }, userId: 'private-native-user', requiresOpenaiAuth: true, workspaceRouting: null }
  const limits: Record<string, unknown> = { rateLimits: {}, rateLimitsByLimitId: {
    codex: { limitId: 'codex', limitName: 'Original quota', primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 3600 }, secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: null } },
    independent: { limitId: 'independent', limitName: null, primary: { usedPercent: 105, windowDurationMins: null, resetsAt: null }, secondary: null }
  } }
  const models = ['model-original', 'model-selected'].map((model, i) => ({ model, id: 'catalog-id-' + i, displayName: 'Native ' + model, description: 'Native catalog entry', hidden: false }))
  const controls = { accountError: false, limitsError: false, changedAccount: false, accountReads: 0, setApplied: true, setError: false,
    missingModel: false, pageLoop: false, smallPages: false, changingRuntime: false, reads: 0 }
  server.on('connection', (socket, request) => {
    authorization.push(request.headers.authorization)
    socket.on('message', bytes => {
      const value = JSON.parse(bytes.toString()); requests.push(value)
      if (!Object.hasOwn(value, 'id')) return
      const reply = (result: unknown) => socket.send(JSON.stringify({ jsonrpc: '2.0', id: value.id, result }))
      const error = () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: value.id, error: { code: -32603, message: 'Private native observation failure' } }))
      switch (value.method) {
        case 'initialize': return reply({})
        case 'thread/read': controls.reads++; return reply({ thread: { ...thread,
          ...(controls.changingRuntime && controls.reads > 1 ? { sessionId: 'replacement-runtime-session' } : {}) } })
        case 'account/read': controls.accountReads++; return controls.accountError ? error() : reply(controls.changedAccount && controls.accountReads > 1
          ? { ...account, userId: 'another-native-user' } : account)
        case 'account/rateLimits/read': return controls.limitsError ? error() : reply(limits)
        case 'model/list': {
          if (controls.smallPages) {
            const index = value.params.cursor ? Number(value.params.cursor) : 0
            return reply({ data: [models[index]], nextCursor: index + 1 < models.length ? String(index + 1) : null })
          }
          return reply({ data: controls.missingModel ? [models[1]] : value.params.cursor ? [models[1]] : [models[0]],
            nextCursor: controls.pageLoop || !value.params.cursor ? 'original-next-page' : null })
        }
        case 'thread/settings/update':
          if (controls.setError) return error()
          if (controls.setApplied) thread.model = value.params.model
          return reply({})
        default: return error()
      }
    })
  })
  const provider = new AgentProviderRegistry().get('codex')
  const context = { processId: 100, workspacePath: '/original-workspace', signal: AbortSignal.timeout(10000),
    nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: thread.id },
    nativeActor: { protocolId: 'codex-app-server-v2-0.163', actorId: 'original-actor', lifecycleOperationId: 'original-lifecycle', token: 'private-original-token', launch: { command: 'codex', args: ['--model', 'stale-launch-model'] } } }
  const read = () => provider.readInformation!(context, 'native-original')
  const configuration = () => provider.readConfiguration!(context, 'native-original')
  const set = (revision: string, value = 'model-selected') => provider.setConfiguration!(context, 'native-original',
    { configId: 'model', value, expectedRevision: revision, requestId: 'original-model-operation' })
  return { provider, context, read, configuration, set, requests, authorization, thread, account, limits, controls, models }
}

it('reads live model, subscription and independent native quota windows on the exact actor', async () => {
  const h = await fixture(), information = await h.read()
  expect(information).toMatchObject({ nativeSessionId: 'native-original', sourceId: expect.any(String), model: { id: 'model-original', scope: 'next-turn' }, plan: { id: 'pro', name: 'pro' }, issues: [] })
  expect(information.limits).toEqual([
    { id: 'codex:primary', name: 'Original quota · 300 min', usedPercent: 23, windowMinutes: 300, resetsAt: 3600000 },
    { id: 'codex:secondary', name: 'Original quota · 10080 min', usedPercent: 0, windowMinutes: 10080 },
    { id: 'independent:primary', name: 'independent · primary', usedPercent: 105 }
  ])
  expect(parseAgentInformationSnapshot(information)).toEqual(information)
  expect(h.authorization).toEqual(['Bearer private-original-token'])
  expect(JSON.stringify(information)).not.toMatch(/private-account|private-native-user|private-original-token|stale-launch-model/)
  expect(h.requests.find(request => request.method === 'account/read')?.params).toEqual({ refreshToken: false })
  expect(h.requests.find(request => request.method === 'account/rateLimits/read')?.params).toEqual({ excludeResetCreditDetails: true })
  expect(h.requests.some(request => ['thread/start', 'thread/resume', 'turn/start', 'config/value/write'].includes(request.method))).toBe(false)
})

it('a quota observation failure preserves the original model and plan', async () => {
  const h = await fixture(); h.controls.limitsError = true
  expect(await h.read()).toMatchObject({ model: { id: 'model-original' }, plan: { id: 'pro' }, issues: [{ field: 'limits', kind: 'unavailable', code: 'AGENT_NATIVE_LIMITS_READ_FAILED' }] })
})

it('missing subscription and empty native windows remain unknown without inventing full quota', async () => {
  const h = await fixture(); h.account.account = { type: 'apiKey' } as typeof h.account.account; h.limits.rateLimitsByLimitId = {}
  const info = await h.read()
  expect(info.plan).toBeUndefined(); expect(info.limits).toEqual([])
  expect(info.issues).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'plan', kind: 'unsupported' }), expect.objectContaining({ field: 'limits', kind: 'unconfirmed' })]))
  expect(info.model?.id).toBe('model-original')
})

it('a native account switch during reading cannot relabel the previous quota', async () => {
  const h = await fixture(); h.controls.changedAccount = true
  const info = await h.read()
  expect(info.plan).toBeUndefined(); expect(info.limits).toBeUndefined(); expect(info.model?.id).toBe('model-original')
  expect(info.issues).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'limits', code: 'AGENT_NATIVE_ACCOUNT_CHANGED' })]))
})

it.each(['unloaded', 'foreign', 'new-runtime', 'new-listener', 'ambiguous-listener'] as const)('rejects %s native identity without starting another actor', async scenario => {
  const h = await fixture()
  if (scenario === 'unloaded') { h.thread.canAcceptDirectInput = false; h.thread.status.type = 'notLoaded' }
  if (scenario === 'foreign') h.thread.id = 'foreign-thread'
  if (scenario === 'new-runtime') h.controls.changingRuntime = true
  if (scenario === 'new-listener') location.changed = true
  if (scenario === 'ambiguous-listener') location.foreignListener = true
  await expect(h.read()).rejects.toMatchObject({ code: 'AGENT_CONFIGURATION_UNAVAILABLE' })
  expect(h.requests.some(request => request.method === 'thread/start')).toBe(false)
})

it.each([['idle', false], ['active', false], ['systemError', false], ['idle', null]] as const)('native loaded %s settings remain available with direct-input eligibility=%s', async (type, directInput) => {
  const h = await fixture()
  h.thread.status = { type, ...(type === 'active' ? { activeFlags: [] } : {}) }
  h.thread.canAcceptDirectInput = directInput
  expect((await h.read()).model?.id).toBe('model-original')
  const before = (await h.configuration())!
  expect((await h.set(before.revision)).options).toEqual([expect.objectContaining({ currentValue: 'model-selected' })])
  expect(h.requests.some(request => ['thread/start', 'thread/resume', 'turn/start'].includes(request.method))).toBe(false)
})

it('missing managed actor is unavailable independently of healthy ordinary terminal input', async () => {
  const h = await fixture(), { nativeActor: _actor, ...context } = h.context
  await expect(h.provider.readInformation!(context, 'native-original')).rejects.toMatchObject({ code: 'AGENT_CONFIGURATION_UNAVAILABLE' })
  expect(await h.provider.readConfiguration!(context, 'native-original')).toBeNull()
  expect(h.requests).toEqual([])
})

it('reads every native model page for the original configured provider, then changes the same thread without a new turn', async () => {
  const h = await fixture(), before = (await h.configuration())!
  expect(parseAgentConfigurationSnapshot(before)).toEqual(before)
  expect(before.options).toEqual([expect.objectContaining({ id: 'model', category: 'model', type: 'select', currentValue: 'model-original',
    choices: [expect.objectContaining({ value: 'model-original' }), expect.objectContaining({ value: 'model-selected' })] })])
  const after = await h.set(before.revision)
  expect(after.options[0]?.currentValue).toBe('model-selected'); expect(after.revision).not.toBe(before.revision)
  expect(h.requests.filter(request => request.method === 'model/list').every(request => request.params.modelProvider === 'provider-original')).toBe(true)
  expect(h.requests.filter(request => request.method === 'thread/settings/update')).toEqual([expect.objectContaining({ id: 'original-model-operation', params: { threadId: 'native-original', model: 'model-selected' } })])
  expect(h.requests.some(request => ['thread/start', 'thread/resume', 'turn/start', 'turn/settings/update', 'config/value/write'].includes(request.method))).toBe(false)
})

it('a stale or invalid model selection is refused before native settings dispatch', async () => {
  const h = await fixture(), before = (await h.configuration())!
  await expect(h.set('old-revision')).rejects.toMatchObject({ controlFailure: { disposition: 'not_applied' } })
  await expect(h.set(before.revision, 'not-in-native-catalog')).rejects.toMatchObject({ controlFailure: { disposition: 'not_applied' } })
  expect(h.requests.filter(request => request.method === 'thread/settings/update')).toEqual([])
})

it('an empty native setter reply is not a confirmed model application', async () => {
  const h = await fixture(), before = (await h.configuration())!; h.controls.setApplied = false
  await expect(h.set(before.revision)).rejects.toMatchObject({ code: 'AGENT_CONFIGURATION_UNAVAILABLE' })
  expect(h.requests.filter(request => request.method === 'thread/settings/update')).toHaveLength(1)
})

it('a native internal setter failure is unknown and is never retried by the Provider', async () => {
  const h = await fixture(), before = (await h.configuration())!; h.controls.setError = true
  await expect(h.set(before.revision)).rejects.toMatchObject({ code: -32603 })
  expect(h.requests.filter(request => request.method === 'thread/settings/update')).toHaveLength(1)
})

it.each(['missing-current-model', 'repeated-cursor'] as const)('does not offer a picker from a %s native catalog', async scenario => {
  const h = await fixture()
  if (scenario === 'missing-current-model') h.controls.missingModel = true
  else h.controls.pageLoop = true
  await expect(h.configuration()).rejects.toMatchObject({ code: 'AGENT_CONFIGURATION_UNAVAILABLE' })
  expect(h.requests.filter(request => request.method === 'model/list').length).toBeLessThanOrEqual(2)
})

it('valid model pages are bounded by the public choice contract rather than an invented page count', async () => {
  const h = await fixture(); h.controls.smallPages = true
  h.models.push(...Array.from({ length: 4 }, (_, index) => ({ id: 'extra-catalog-' + index, model: 'extra-model-' + index,
    displayName: 'Extra native model ' + index, description: 'Native catalog entry', hidden: false })))
  const value = await h.configuration()
  expect(value?.options[0]).toMatchObject({ type: 'select', choices: expect.arrayContaining([expect.objectContaining({ value: 'extra-model-3' })]) })
  expect(h.requests.filter(request => request.method === 'model/list')).toHaveLength(6)
})

it('a native response with many legitimate quota buckets preserves all its windows', async () => {
  const h = await fixture()
  h.limits.rateLimitsByLimitId = Object.fromEntries(Array.from({ length: 130 }, (_, index) => ['native-bucket-' + index,
    { limitId: 'native-bucket-' + index, limitName: null, primary: { usedPercent: index, windowDurationMins: null, resetsAt: null }, secondary: null }]))
  const value = await h.read()
  expect(value.limits).toHaveLength(130); expect(value.issues).toEqual([])
})
