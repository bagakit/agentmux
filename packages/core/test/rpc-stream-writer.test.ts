import { expect, it } from 'vitest'
import { Writable, PassThrough } from 'node:stream'
import { AgentMuxRpcStreamTransport } from '../src/rpc-stream-transport.js'
import { AGENTMUX_RPC_MAX_MESSAGE_BYTES } from '../src/public-rpc-frame.js'
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
class SlowWriter extends Writable {
  frames: Array<{ id?: string; method: string }> = []
  held: Array<(error?: Error | null) => void> = []
  bufferedBytes: number | undefined
  constructor() { super({ highWaterMark: 1 }) }
  get writableLength() { return this.bufferedBytes ?? super.writableLength }
  write(chunk: any, ...args: any[]): boolean { this.frames.push(JSON.parse(String(chunk))); return super.write(chunk, ...args) }
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) { this.held.push(done) }
  release() { this.held.shift()?.() }
}
function fixture() {
  const input = new SlowWriter(), output = new PassThrough()
  const dispatched: string[] = [], received: string[] = [], ended: Array<{ id: string; code?: string }> = []
  let closed = 0
  const channel = new AgentMuxRpcStreamTransport({ input, output, close: () => { closed++; input.destroy(); output.destroy() } }, () => {})
  const open = (id: string, signal = new AbortController().signal) => channel.open({ jsonrpc: '2.0', id, method: 'system.endpoint', params: {} }, frame => {
    expect((frame as any).id).toBe(id); received.push(id)
  }, error => ended.push({ id, code: (error as any)?.code }), signal, () => dispatched.push(id))
  const respond = (id: string) => output.write(JSON.stringify({ jsonrpc: '2.0', id, result: { original: id } }) + '\n')
  return { input, channel, dispatched, received, ended, open, respond, closed: () => closed }
}
it('slow writable preserves independent valid requests, drain order and request-ID delivery without aggregate refusal', async () => {
  const f = fixture(), states: Record<string, string> = {}
  try {
    await f.open('first')
    // Model an already buffered physical writer without allocating64MiB; each new frame is tiny and valid.
    f.input.bufferedBytes = AGENTMUX_RPC_MAX_MESSAGE_BYTES
    const second = f.open('second').then(value => { states.second = 'opened'; return value }, error => { states.second = error.code; return undefined })
    const third = f.open('third').then(value => { states.third = 'opened'; return value }, error => { states.third = error.code; return undefined })
    await tick(); expect(states).toEqual({}); expect(f.dispatched).toEqual(['first'])
    expect(f.input.frames.map(frame => frame.id)).toEqual(['first'])
    f.input.bufferedBytes = undefined; f.input.release(); await tick()
    expect(states).toEqual({ second: 'opened' }); expect(f.dispatched).toEqual(['first', 'second'])
    f.respond('second'); f.respond('first'); expect(f.received).toEqual(['second', 'first'])
    f.input.release(); await tick(); await second; await third
    expect(states).toEqual({ second: 'opened', third: 'opened' })
    f.respond('third'); expect(f.received).toEqual(['second', 'first', 'third'])
    expect(f.input.frames.map(frame => frame.id)).toEqual(['first', 'second', 'third'])
  } finally { f.channel.dispose() }
})
it('cancelling a queued reader writes no frame or opening deadline and preserves the channel and peer', async () => {
  const f = fixture(), cancelled = new AbortController(); let cancelledCode: string | undefined
  try {
    await f.open('first')
    const second = f.open('cancelled', cancelled.signal).catch(error => { cancelledCode = error.code })
    const third = f.open('peer').catch(() => undefined)
    await tick(); cancelled.abort(); await tick()
    expect(cancelledCode).toBe('CONTROL_CANCELLED'); await second
    expect(f.closed()).toBe(0); expect(f.dispatched).toEqual(['first'])
    f.respond('first'); expect(f.received).toEqual(['first'])
    f.input.release(); await tick(); await third
    expect(f.dispatched).toEqual(['first', 'peer'])
    expect(f.input.frames.map(frame => frame.id)).toEqual(['first', 'peer'])
    f.respond('peer'); expect(f.received).toEqual(['first', 'peer']); expect(f.closed()).toBe(0)
  } finally { f.channel.dispose() }
})
it.each(['close', 'error'] as const)('actual writable %s settles queued openings once and never replays dispatched input', async failure => {
  const f = fixture(); let waitingCode: string | undefined
  try {
    await f.open('dispatched')
    const waiting = f.open('waiting').catch(error => { waitingCode = error.code })
    await tick()
    if (failure === 'error') f.input.destroy(new Error('private controlled pipe failure'))
    else f.input.destroy()
    await tick(); expect(waitingCode).toBe('CONTROL_CONNECTION_FAILED'); await waiting
    expect(f.input.frames.map(frame => frame.id)).toEqual(['dispatched']); expect(f.dispatched).toEqual(['dispatched'])
    expect(f.ended.map(value => value.id).sort()).toEqual(['dispatched', 'waiting']); expect(f.closed()).toBe(1)
  } finally { f.channel.dispose() }
})
