import { it, expect, vi } from 'vitest'
import { Duplex } from 'node:stream'
const io = vi.hoisted(() => ({ socket: null as any }))
vi.mock('node:net', async original => ({ ...await original<typeof import('node:net')>(), createConnection: () => {
  const socket = io.socket; queueMicrotask(() => socket.emit('connect')); return socket
} }))
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'

class ControlledSocket extends Duplex {
  frames: Array<{ method: string }> = []
  constructor() { super({ writableHighWaterMark: 1 }) }
  _read() {}
  // Hold the real Writable above its high-water mark; no peer or user socket exists.
  _write(chunk: Buffer, _encoding: string, _done: () => void) { this.frames.push(JSON.parse(String(chunk))) }
}
it.each(['queued', 'dispatched'] as const)('public shared reader cancellation preserves exact %s dispatch facts', async state => {
  io.socket = new ControlledSocket()
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: '/private-unused-socket' } })
  const blocker = state === 'queued' ? client.call('system.endpoint', {}).catch(error => error) : undefined
  try {
    if (blocker) await vi.waitFor(() => expect(io.socket.frames).toHaveLength(1))
    const signal = new AbortController()
    const result = client.call('space.focus', { operationId: 'private-original',
      target: { kind: 'space', regionId: 'private-target' }, inputPolicy: 'preserve' }, { signal: signal.signal }).catch(error => error)
    if (state === 'queued') await vi.waitFor(() => expect((client as any).route.unix.writes.size).toBe(1))
    else await vi.waitFor(() => expect(io.socket.frames.map((frame: { method: string }) => frame.method)).toEqual(['space.focus']))
    signal.abort()
    const error = await result
    expect(error).toMatchObject({ code: 'CONTROL_CANCELLED', controlFailure: {
      disposition: state === 'queued' ? 'not_applied' : 'unknown', confirmedInputBytes: null } })
    expect(io.socket.frames.map((frame: { method: string }) => frame.method)).toEqual(state === 'queued' ? ['system.endpoint'] : ['space.focus'])
    expect((client as any).route.unix.writes.size).toBe(0)
    expect(io.socket.destroyed).toBe(false)
  } finally { await client.dispose(); await blocker }
})
