import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc, AgentMuxRpcLines } from '../src/control-host.js'
import {
  AGENTMUX_CONTROL_LONG_REQUEST_TIMEOUT_MS, AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS,
  agentMuxControlTimeoutMs, type AgentMuxControlRequest, type AgentMuxControlResult
} from '../src/control.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true }))) })
const request = { jsonrpc: '2.0', id: 'literal-frame', method: 'settings.inspect', params: {} } as const
const result: Omit<Extract<AgentMuxControlResult, { operation: 'settings.get' }>, 'operation'> = {
  entries: [{ key: 'literal', kind: 'string', value: '字面值', default: '字面值' }], partial: true
}
const receipt = { jsonrpc: '2.0', id: request.id, result }
const incomplete = { code: 'CONTROL_PROTOCOL_ERROR', message: 'RPC stream ended with an incomplete frame.' }
async function clientFor(path: string) { return connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }) }

async function endpoint() {
  const root = await mkdtemp(join(tmpdir(), 'amux-frame-')); roots.push(root)
  return join(root, 'control.sock')
}

async function replyWith(makeChunks: (wireId: string) => readonly Buffer[]) {
  const path = await endpoint()
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket))
    const lines = new AgentMuxRpcLines()
    socket.on('data', chunk => lines.accept(chunk, frame => {
      const chunks = makeChunks((frame as { id: string }).id)
      if (chunks.length === 0) { socket.end(); return }
      socket.write(chunks[0]!)
      setImmediate(() => { for (const chunk of chunks.slice(1)) socket.write(chunk); socket.end() })
    }))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
  return { path, stop: async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  } }
}

describe('Control complete frames and bounded configuration writes', () => {
  it.each([
    'settings.set', 'settings.browser.links.forget', 'settings.workspaces.add',
    'settings.resource.add', 'settings.resource.update', 'settings.resource.remove'
  ] as const)('gives %s the existing durable-action budget', operation => {
    expect(agentMuxControlTimeoutMs(operation)).toBe(AGENTMUX_CONTROL_LONG_REQUEST_TIMEOUT_MS)
  })

  it('keeps reads, layout, signals and diagnostics in the existing short budget', () => {
    const operations: AgentMuxControlRequest['operation'][] = ['settings.get', 'settings.browser.links.list',
      'settings.resource.get', 'settings.resource.list', 'settings.hosts.list', 'diagnostics.crash-log.get',
      'diagnostics.crash-log.reveal', 'focus', 'arrange', 'interrupt', 'browser.subscribe']
    expect(operations.length).toBeGreaterThan(0)
    for (const operation of operations) expect(agentMuxControlTimeoutMs(operation)).toBe(AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS)
  })

  it.each([
    ['empty', []],
    ['partial JSON', [Buffer.from('{"jsonrpc":')]],
    ['valid JSON without LF', [Buffer.from(JSON.stringify(receipt))]]
  ] as const)('rejects %s EOF as an incomplete reply, not timeout or a completed result', async (name, chunks) => {
    const peer = await replyWith(() => [...chunks]), client = await clientFor(peer.path)
    try {
      await expect(client.call('settings.inspect', {})).rejects.toMatchObject(name === 'empty'
        ? { code: 'CONTROL_PROTOCOL_ERROR', message: 'RPC ended before its response.' } : incomplete)
    } finally { await client.dispose(); await peer.stop() }
  })

  it('rejects a malformed complete LF frame as a protocol error, never a completed result or timeout', async () => {
    const peer = await replyWith(() => [Buffer.from('{invalid}\n')]), client = await clientFor(peer.path)
    try { await expect(client.call('settings.inspect', {})).rejects.toMatchObject({
      code: 'CONTROL_PROTOCOL_ERROR', message: 'RPC connection failed; its business outcome is unconfirmed.'
    }) } finally { await client.dispose(); await peer.stop() }
  })

  it('reports CONTROL_TIMEOUT only when its own public socket timer actually expires', async () => {
    const path = await endpoint(); let peer: Socket | undefined
    const server = createServer(socket => { peer = socket; socket.on('error', () => {}); socket.resume() })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
    const client = await clientFor(path)
    try {
      await expect(client.call('settings.inspect', {})).rejects.toMatchObject({ code: 'CONTROL_TIMEOUT',
        message: 'RPC response timed out; the business operation is unconfirmed. Inspect its operation ID before another write.' })
    } finally { await client.dispose(); peer?.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) }
  }, 5_000)

  it('accepts a fragmented complete LF frame split inside a UTF-8 character', async () => {
    const peer = await replyWith(wireId => {
      const bytes = Buffer.from(JSON.stringify({ ...receipt, id: wireId }) + '\n')
      const boundary = bytes.indexOf(Buffer.from('字')) + 1
      expect(boundary).toBeGreaterThan(0)
      return [bytes.subarray(0, boundary), bytes.subarray(boundary)]
    }), client = await clientFor(peer.path)
    try { await expect(client.call('settings.inspect', {})).resolves.toEqual(result) }
    finally { await client.dispose(); await peer.stop() }
  })

  it('never executes valid JSON received without an LF request terminator; a complete request still works', async () => {
    const path = await endpoint(); let executions = 0
    const server = new AgentMuxControlServer({ socketPath: path, coreClients: () => [], execute: async () => {
      executions++; return { operation: 'settings.get', ...result }
    } })
    await server.start()
    const client = await clientFor(path)
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = createConnection(path); let bytes = ''
        socket.on('error', reject); socket.on('data', chunk => { bytes += chunk.toString('utf8') })
        socket.once('connect', () => socket.end(JSON.stringify(request)))
        socket.once('close', () => resolve(bytes))
      })
      expect(reply).toBe('')
      expect(executions).toBe(0)
      await expect(client.call('settings.inspect', {})).resolves.toEqual(result)
      expect(executions).toBe(1)
    } finally { await client.dispose(); await server.stop() }
  })
})
