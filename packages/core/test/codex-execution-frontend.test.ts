import { once } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { WebSocket } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { runCodexExecutionFrontend } from '../src/providers/codex-execution-frontend.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function fixture(maxPendingRequests = 8, maxFrameBytes?: number, agentSessionId?: string) {
  const input = new PassThrough(), output = new PassThrough()
  const errors: Error[] = [], frames: any[] = []
  let text = ''
  output.on('data', chunk => {
    text += chunk.toString()
    for (;;) {
      const newline = text.indexOf('\n')
      if (newline < 0) break
      frames.push(JSON.parse(text.slice(0, newline)))
      text = text.slice(newline + 1)
    }
  })
  const frontend = await runCodexExecutionFrontend({ input, output, onError: error => errors.push(error), maxPendingRequests, ...(agentSessionId ? { agentSessionId } : {}), ...(maxFrameBytes === undefined ? {} : { maxFrameBytes }) })
  cleanups.push(async () => { await frontend.close(); input.destroy(); output.destroy() })
  const connect = async (url = frontend.url) => {
    const socket = new WebSocket(url)
    const messages: any[] = []
    socket.on('message', data => messages.push(JSON.parse(String(data))))
    await once(socket, 'open')
    return { socket, messages }
  }
  const reply = (generation: string, payload: unknown) => input.write(JSON.stringify({ type: 'response', generation, payload }) + '\n')
  const requests = () => frames.filter(frame => frame.type === 'request')
  return { frontend, input, output, errors, frames, connect, reply, requests }
}

it('opens only an unguessable loopback endpoint and emits pure machine frames', async () => {
  const f = await fixture()
  const url = new URL(f.frontend.url)
  expect(url.hostname).toBe('127.0.0.1')
  expect(url.pathname).toMatch(/^\/[0-9a-f]{64}$/u)
  expect(f.frames).toEqual([{ type: 'ready', url: f.frontend.url }])
  const wrong = new WebSocket(`ws://${url.host}/wrong`)
  const rejected = once(wrong, 'unexpected-response')
  const [, response] = await rejected
  expect(response.statusCode).toBe(403)
  wrong.terminate()
  wrong.on('error', () => {})
  const peer = await f.connect()
  const payload = { id: 1, method: 'initialize', params: { clientName: 'codex-environment', resumeSessionId: null } }
  peer.socket.send(JSON.stringify(payload))
  await vi.waitFor(() => expect(f.requests()).toHaveLength(1))
  const frame = f.requests()[0]
  expect(frame).toEqual({ type: 'request', generation: expect.any(String), payload })
  expect(frame.generation).toMatch(/^[0-9a-f-]{36}$/u)
  f.reply(frame.generation, { id: 1, result: { sessionId: 'native-session' } })
  await vi.waitFor(() => expect(peer.messages).toEqual([{ id: 1, result: { sessionId: 'native-session' } }]))
  expect(f.errors).toEqual([])
})

it('does not deliver a late original-generation reply or output to a replacement socket', async () => {
  const f = await fixture()
  const first = await f.connect()
  first.socket.send(JSON.stringify({ id: 1, method: 'environment/info' }))
  await vi.waitFor(() => expect(f.requests()).toHaveLength(1))
  const original = f.requests()[0].generation
  const ended = once(first.socket, 'close'); first.socket.close(); await ended
  await vi.waitFor(() => expect(f.frames).toContainEqual({ type: 'closed', generation: original }))
  const second = await f.connect()
  second.socket.send(JSON.stringify({ id: 1, method: 'environment/info' }))
  await vi.waitFor(() => expect(f.requests()).toHaveLength(2))
  const replacement = f.requests()[1].generation
  expect(replacement).not.toBe(original)
  f.reply(original, { id: 1, result: { owner: 'old' } })
  f.reply(original, { method: 'process/output', params: { processId: 'old', chunk: 'b2xk' } })
  f.reply(replacement, { id: 1, result: { owner: 'new' } })
  await vi.waitFor(() => expect(second.messages).toEqual([{ id: 1, result: { owner: 'new' } }]))
  expect(f.errors).toEqual([])
})

it('rejects only the over-budget request and accepts new work once the original settles', async () => {
  const f = await fixture(1), peer = await f.connect()
  peer.socket.send(JSON.stringify({ id: 1, method: 'fs/readFile', params: { path: 'file:///workspace/one' } }))
  peer.socket.send(JSON.stringify({ id: 2, method: 'fs/readFile', params: { path: 'file:///workspace/two' } }))
  await vi.waitFor(() => expect(peer.messages).toHaveLength(1))
  expect(peer.messages[0]).toMatchObject({ id: 2, error: { code: -32001 } })
  expect(f.requests()).toHaveLength(1)
  const generation = f.requests()[0].generation
  f.reply(generation, { id: 1, result: { dataBase64: 'b25l' } })
  await vi.waitFor(() => expect(peer.messages).toHaveLength(2))
  peer.socket.send(JSON.stringify({ id: 3, method: 'fs/readFile', params: { path: 'file:///workspace/three' } }))
  await vi.waitFor(() => expect(f.requests()).toHaveLength(2))
  expect(peer.socket.readyState).toBe(WebSocket.OPEN)
  expect(f.requests()[1]).toMatchObject({ generation, payload: { id: 3 } })
})

it('keeps initialized and executor notifications on the same socket without a second handshake', async () => {
  const f = await fixture(), peer = await f.connect()
  peer.socket.send(JSON.stringify({ method: 'initialized', params: {} }))
  await vi.waitFor(() => expect(f.requests()).toHaveLength(1))
  const generation = f.requests()[0].generation
  const notification = { method: 'process/output', params: { processId: 'p', seq: 2, stream: 'stdout', chunk: 'b2s=' } }
  f.reply(generation, notification)
  await vi.waitFor(() => expect(peer.messages).toEqual([notification]))
  expect(f.errors).toEqual([])
})

it('keeps the original socket and request while the machine output reader detaches', async () => {
  const f = await fixture(), peer = await f.connect()
  f.output.pause()
  peer.socket.send(JSON.stringify({ id: 1, method: 'environment/info' }))
  expect(peer.socket.readyState).toBe(WebSocket.OPEN)
  f.output.resume()
  await vi.waitFor(() => expect(f.requests()).toHaveLength(1))
  f.reply(f.requests()[0].generation, { id: 1, result: { available: true } })
  await vi.waitFor(() => expect(peer.messages).toHaveLength(1))
  expect(peer.socket.readyState).toBe(WebSocket.OPEN)
})

it('does not shut down native connections on machine stdin EOF or malformed peer input', async () => {
  const f = await fixture(), peer = await f.connect()
  f.input.end()
  peer.socket.send('not JSON')
  peer.socket.send(JSON.stringify({ id: 1, method: 'environment/info' }))
  await vi.waitFor(() => expect(f.requests()).toHaveLength(1))
  expect(f.errors).toHaveLength(1)
  expect(peer.socket.readyState).toBe(WebSocket.OPEN)
  expect(peer.messages).toEqual([])
})

it('never forwards a second mutation when a native peer reuses an in-flight request ID', async () => {
  const f = await fixture(), peer = await f.connect()
  const payload = { id: 'write-1', method: 'fs/remove', params: { path: 'file:///workspace/file' } }
  peer.socket.send(JSON.stringify(payload)); peer.socket.send(JSON.stringify(payload))
  await vi.waitFor(() => expect(f.errors).toHaveLength(1))
  expect(f.requests()).toHaveLength(1)
  expect(peer.messages).toEqual([])
  f.reply(f.requests()[0].generation, { id: 'write-1', result: {} })
  await vi.waitFor(() => expect(peer.messages).toEqual([{ id: 'write-1', result: {} }]))
})

it('waits for stdout writes instead of growing an unbounded forward queue', async () => {
  const input = new PassThrough(), frames: any[] = []
  let unblock: (() => void) | undefined
  const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, done) {
    const frame = JSON.parse(chunk.toString()); frames.push(frame)
    if (frame.type === 'request') unblock = done
    else done()
  } })
  const errors: Error[] = []
  const frontend = await runCodexExecutionFrontend({ input, output, onError: error => errors.push(error), maxFrameBytes: 512 })
  cleanups.push(async () => { unblock?.(); await frontend.close(); input.destroy(); output.destroy() })
  const peer = new WebSocket(frontend.url)
  await once(peer, 'open')
  for (let id = 1; id <= 8; id++) peer.send(JSON.stringify({ id, method: 'fs/readFile', params: { path: 'file:///workspace/' + 'a'.repeat(160) } }))
  await vi.waitFor(() => expect(frames.filter(f => f.type === 'request')).toHaveLength(1))
  await new Promise(resolve => setImmediate(resolve))
  expect(frames.filter(f => f.type === 'request')).toHaveLength(1)
  expect(errors).toEqual([])
  unblock!(); unblock = undefined
  await vi.waitFor(() => expect(frames.filter(f => f.type === 'request')).toHaveLength(2))
  expect(errors).toEqual([])
  expect(peer.readyState).toBe(WebSocket.OPEN)
})

it('rejects a native request whose machine envelope exceeds the limit without consuming pending capacity', async () => {
  const f = await fixture(1, 512), peer = await f.connect()
  const payload = { id: 1, method: 'fs/writeFile', params: { path: 'file:///workspace', dataBase64: 'a'.repeat(384) } }
  expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(512)
  peer.socket.send(JSON.stringify(payload))
  await vi.waitFor(() => expect(peer.messages).toHaveLength(1))
  expect(peer.messages[0]).toMatchObject({ id: 1, error: { code: -32001 } })
  expect(f.requests()).toHaveLength(0)
  peer.socket.send(JSON.stringify({ id: 2, method: 'environment/info' }))
  await vi.waitFor(() => expect(f.requests()).toHaveLength(1))
  expect(peer.socket.readyState).toBe(WebSocket.OPEN)
})


it('reports typed registration failure on its exact generation while native requests remain usable without an Agent caller', async () => {
  const f = await fixture(8, undefined, 'original-agent')
  const peer = await f.connect(f.frontend.url + '/unverified/RUNTIME_OWNER_MISMATCH')
  peer.socket.send(JSON.stringify({ id: 6, method: 'initialize', params: { clientName: 'codex-environment', resumeSessionId: null } }))
  await vi.waitFor(() => expect(f.requests()).toHaveLength(1))
  f.reply(f.requests()[0].generation, { id: 6, result: { sessionId: 'native-original' } })
  await vi.waitFor(() => expect(peer.messages).toHaveLength(1))
  const payload = { id: 7, method: 'process/start', params: { command: ['/usr/bin/true'], cwd: 'file:///original/workspace' } }
  peer.socket.send(JSON.stringify(payload))
  await vi.waitFor(() => expect(f.requests()).toHaveLength(2))
  const frame = f.requests()[1]
  expect(f.frames).toContainEqual({ type: 'agent-control-state', generation: frame.generation, state: 'unverified', stage: 'invocation-registration', code: 'RUNTIME_OWNER_MISMATCH' })
  expect(f.frames.some(value => value.type === 'agent-rpc-context')).toBe(false)
  expect(frame.payload).toEqual(payload)
  f.reply(frame.generation, { id: 7, result: { processId: 'native-original' } })
  await vi.waitFor(() => expect(peer.messages.at(-1)).toEqual({ id: 7, result: { processId: 'native-original' } }))
  expect(peer.socket.readyState).toBe(WebSocket.OPEN)
  expect(f.errors).toEqual([])
})
