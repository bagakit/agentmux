import { afterEach, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { focusFacts } from './fixtures/desktop-focus-facts.js'
import { connectAgentMuxRpc, isAgentMuxRpcReplyUnconfirmed } from '../src/public-rpc-client.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const catalog = { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] }
async function fixture(options: ConstructorParameters<typeof AgentMuxControlServer>[0] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'amxburst-'))
  const states: unknown[] = []
  const server = new AgentMuxControlServer({ socketPath: join(root, 's'), onControlEndpointState: state => states.push(state), ...options })
  cleanup.push(async () => { await server.stop(); await rm(root, { recursive: true, force: true }) })
  await server.start()
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  cleanup.push(() => client.dispose())
  return { server, client, states }
}

it('one Unix client delivers repeated 193-call bursts on one physical socket', async () => {
  const f = await fixture()
  for (const count of [16, 64, 193, 193]) {
    const calls = await Promise.allSettled(Array.from({ length: count }, () => f.client.call('system.endpoint', {})))
    expect(calls.filter(call => call.status === 'fulfilled'), 'all original independent requests receive their exact response').toHaveLength(count)
    for (const call of calls) if (call.status === 'fulfilled') expect(call.value.endpoint).toEqual({ transport: 'unix', path: f.server.path })
    expect((f.server as any).sockets.size, 'reader count does not multiply physical sockets').toBe(1)
  }
  expect(f.states).toEqual([{ state: 'available' }])
})

it('193 independent subscription leases keep their own cancellation and notifications', async () => {
  const events = new Map<string, (value: any) => void>(), released: string[] = []
  const f = await fixture({ execute: async () => ({ operation: 'space.ls', catalog }), subscribeBrowserOperation: async (request, push) => {
    events.set(request.operationId, push)
    return { runOperation: null, gap: null, dispose: () => { released.push(request.operationId) } }
  } })
  const received = new Map<string, unknown[]>(), ended = vi.fn()
  const leases = await Promise.all(Array.from({ length: 193 }, async (_, index) => {
    const id = 'reader-' + index, own: unknown[] = []; received.set(id, own)
    return f.client.subscribe('browser.follow', { operationId: id }, { onInitial: () => {}, onEvent: event => own.push(event), onEnd: error => ended(id, error) })
  }))
  expect((f.server as any).sockets.size).toBe(1)
  await leases[0]!.dispose()
  await vi.waitFor(() => expect(released).toEqual(['reader-0']))
  for (let index = 0; index < 193; index++) events.get('reader-' + index)!({ sequence: 1, event: { index } })
  await vi.waitFor(() => expect([...received.values()].filter(value => value.length === 1)).toHaveLength(192))
  expect(received.get('reader-0')).toEqual([])
  for (let index = 1; index < 193; index++) expect(received.get('reader-' + index)).toEqual([{ type: 'progress', data: { sequence: 1, event: { index } } }])
  expect(ended.mock.calls.map(call => call[0])).toEqual(['reader-0'])
  expect(await f.client.call('space.ls', { target: {} })).toEqual({ catalog })
  await Promise.all(leases.slice(1).map(lease => lease.dispose()))
  await vi.waitFor(() => expect(released).toHaveLength(193))
})

it('193 independent Unix clients are not rejected by an unrelated business ACK counter', async () => {
  const f = await fixture()
  const clients = await Promise.all(Array.from({ length: 193 }, () => connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.server.path } })))
  for (const client of clients) cleanup.push(() => client.dispose())
  const calls = await Promise.allSettled(clients.map(client => client.call('system.endpoint', {})))
  expect(calls.filter(call => call.status === 'fulfilled'), 'legitimate independent callers all reach the original owner').toHaveLength(193)
  expect(f.states).toEqual([{ state: 'available' }])
})

it('a lost admitted write keeps its original unknown receipt without replay on the next explicit call', async () => {
  const applied: string[] = []; let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  const f = await fixture({ execute: async request => {
    if (request.operation !== 'focus') throw Error('Unexpected original operation')
    applied.push(request.requestId); await wait; return focusFacts(request)
  } })
  const result = f.client.call('space.focus', { operationId: 'original-write', target: { kind: 'space', regionId: 'selected' }, inputPolicy: 'preserve' })
    .then(value => ({ value }), error => ({ error }))
  await vi.waitFor(() => expect(applied).toEqual(['original-write']))
  for (const socket of (f.server as any).sockets) socket.destroy()
  const failed = await result
  expect(failed).toMatchObject({ error: { code: 'CONTROL_CONNECTION_FAILED' } })
  expect(isAgentMuxRpcReplyUnconfirmed((failed as any).error)).toBe(true)
  release()
  expect((await f.client.call('system.endpoint', {})).endpoint).toEqual({ transport: 'unix', path: f.server.path })
  expect(applied).toEqual(['original-write'])
})

it('cancelling a late opening releases only its eventual original lease', async () => {
  let release!: (value: any) => void; const released: string[] = [], ended = vi.fn()
  const f = await fixture({ subscribeBrowserOperation: async request => request.operationId === 'late'
    ? await new Promise(resolve => { release = resolve })
    : { runOperation: null, gap: null, dispose: () => { released.push(request.operationId) } } })
  const peer = await f.client.subscribe('browser.follow', { operationId: 'peer' }, { onInitial: () => {}, onEvent: () => {}, onEnd: ended })
  const abort = new AbortController()
  const late = f.client.subscribe('browser.follow', { operationId: 'late' }, { signal: abort.signal, onInitial: () => {}, onEvent: () => {} })
    .then(value => ({ value }), error => ({ error }))
  await vi.waitFor(() => expect(release).toBeTypeOf('function')); abort.abort()
  expect(await late).toMatchObject({ error: { code: 'CONTROL_CANCELLED' } })
  release({ runOperation: null, gap: null, dispose: () => { released.push('late') } })
  await vi.waitFor(() => expect(released).toEqual(['late']))
  expect(ended).not.toHaveBeenCalled()
  expect((await f.client.call('system.endpoint', {})).connection).toBe('responded')
  await peer.dispose()
})

it('the existing CLI reaches the real original listener from independent processes', async () => {
  const f = await fixture()
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
  const output = await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath,
    [join(import.meta.dirname, '../dist/agentmux.js'), '--endpoint', 'unix:' + f.server.path, 'system', 'endpoint'], { env })))
  for (const call of output) expect(JSON.parse(call.stdout)).toMatchObject({ ok: true, operation: 'system.endpoint', result: { endpoint: { transport: 'unix', path: f.server.path } } })
})
