import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'

type DiagnosticError = Error & { privateCdp: { role: string; method: string; requestId?: number } }
type Connection = { call(method: string, params?: object): Promise<unknown>; evaluate(expression: string): Promise<unknown>; close(): void }

function fixture(autoOpen = true) {
  const source = readFileSync(new URL('../scripts/verify-browser-recovery-restart.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('async function connectCdp(')
  const end = source.indexOf('async function identity()', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const block = source.slice(start, end)
  expect(block).toContain('const socket = new WebSocket(url)')
  expect(block).toContain('return cdp')
  const sockets: FakeSocket[] = [], timers = new Map<number, () => void>(), connections = new Set()
  let timerId = 0
  class FakeSocket {
    listeners = new Map<string, Array<(event: unknown) => void>>()
    sent: Array<{ id: number; method: string; params: object }> = []
    constructor(readonly url: string) {
      sockets.push(this)
      if (autoOpen) queueMicrotask(() => this.emit('open', {}))
    }
    addEventListener(name: string, listener: (event: unknown) => void) {
      this.listeners.set(name, [...this.listeners.get(name) ?? [], listener])
    }
    emit(name: string, event: unknown) { for (const listener of this.listeners.get(name) ?? []) listener(event) }
    send(value: string) { this.sent.push(JSON.parse(value)) }
    reply(value: object) { this.emit('message', { data: JSON.stringify(value) }) }
    close() { this.emit('close', {}) }
  }
  const connect = runInNewContext(`${block}\nconnectCdp`, {
    WebSocket: FakeSocket, connections,
    setTimeout: (callback: () => void, milliseconds: number) => {
      expect(milliseconds).toBe(12_000)
      const id = ++timerId; timers.set(id, callback); return id
    },
    clearTimeout: (id: number) => timers.delete(id)
  }) as (url: string, role: string) => Promise<Connection>
  const expire = () => {
    expect(timers.size).toBeGreaterThan(0)
    for (const [id, callback] of [...timers]) { timers.delete(id); callback() }
  }
  return { connect, sockets, timers, connections, expire }
}

it('preserves exact calls and successful responses without attaching diagnostics to page results', async () => {
  const f = fixture(), cdp = await f.connect('ws://private', 'first:renderer'), socket = f.sockets[0]!
  expect(f.connections.size).toBe(1)
  const result = cdp.evaluate('private expression')
  expect(socket.sent).toEqual([{ id: 1, method: 'Runtime.evaluate', params: { expression: 'private expression', awaitPromise: true, returnByValue: true } }])
  socket.reply({ id: 1, result: { result: { value: { count: 0, enabled: false } } } })
  await expect(result).resolves.toEqual({ count: 0, enabled: false })
  expect(f.timers.size).toBe(0)
})

it('joins out-of-order protocol failures to the original caller and method, not the newest request', async () => {
  const f = fixture(), cdp = await f.connect('ws://private', 'second:main'), socket = f.sockets[0]!
  const first = cdp.call('Runtime.evaluate', { expression: 'private secret' }).catch(error => error as DiagnosticError)
  const next = cdp.call('Runtime.getProperties')
  expect(socket.sent.map(row => [row.id, row.method])).toEqual([[1, 'Runtime.evaluate'], [2, 'Runtime.getProperties']])
  socket.reply({ id: 2, result: { properties: [] } })
  socket.reply({ id: 1, error: { message: 'Promise was collected' } })
  const error = await first as DiagnosticError
  expect(error.message).toBe('Promise was collected')
  expect(error.privateCdp).toEqual({ role: 'second:main', method: 'Runtime.evaluate', requestId: 1 })
  expect(JSON.stringify(error.privateCdp)).not.toContain('private secret')
  await expect(next).resolves.toEqual({ properties: [] })
  expect(f.timers.size).toBe(0)
})

it('identifies the actual request on the unchanged timeout', async () => {
  const f = fixture(), cdp = await f.connect('ws://private', 'first:renderer')
  const result = cdp.call('Runtime.evaluate').catch(error => error as DiagnosticError)
  f.expire()
  const error = await result as DiagnosticError
  expect(error.message).toBe('CDP timed out: Runtime.evaluate')
  expect(error.privateCdp).toEqual({ role: 'first:renderer', method: 'Runtime.evaluate', requestId: 1 })
  expect(f.timers.size).toBe(0)
})

it('reports each outstanding request when its private connection closes', async () => {
  const f = fixture(), cdp = await f.connect('ws://private', 'second:renderer')
  const pending = [cdp.call('Runtime.evaluate'), cdp.call('Runtime.getProperties')].map(call => call.catch(error => error as DiagnosticError))
  cdp.close()
  const errors = await Promise.all(pending) as DiagnosticError[]
  expect(errors.map(error => ({ message: error.message, ...error.privateCdp }))).toEqual([
    { message: 'Private CDP closed', role: 'second:renderer', method: 'Runtime.evaluate', requestId: 1 },
    { message: 'Private CDP closed', role: 'second:renderer', method: 'Runtime.getProperties', requestId: 2 }
  ])
  expect(f.timers.size).toBe(0)
})

it('keeps a handshake failure distinct from a page action', async () => {
  const f = fixture(false)
  const connection = f.connect('ws://private', 'first:main').catch(error => error as DiagnosticError)
  f.expire()
  const error = await connection as DiagnosticError
  expect(error.message).toBe('Private CDP handshake timed out')
  expect(error.privateCdp).toEqual({ role: 'first:main', method: 'handshake' })
  expect(f.sockets.map(socket => socket.sent)).toEqual([[]])
})
