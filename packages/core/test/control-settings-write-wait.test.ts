import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentMuxControlServer, requestAgentMuxControl } from '../src/control-host.js'
import {
  AGENTMUX_CONTROL_LONG_REQUEST_TIMEOUT_MS, AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS,
  AGENTMUX_CONTROL_SCHEMA_VERSION, agentMuxControlTimeoutMs, type AgentMuxControlRequest
} from '../src/control.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true }))) })
const request = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'literal-frame', operation: 'list.agents' } as const
const receipt = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: request.requestId,
  operation: request.operation, ok: true, result: { agents: [] } }
const incomplete = { code: 'CONTROL_PROTOCOL_ERROR', message: 'Control connection closed before a complete message was received.' }

async function endpoint() {
  const root = await mkdtemp(join(tmpdir(), 'amux-frame-')); roots.push(root)
  return join(root, 'control.sock')
}

async function replyWith(chunks: Buffer[]) {
  const path = await endpoint()
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket))
    socket.once('data', () => {
      if (chunks.length === 0) { socket.end(); return }
      socket.write(chunks[0]!)
      setImmediate(() => { for (const chunk of chunks.slice(1)) socket.write(chunk); socket.end() })
    })
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
    ['partial JSON', [Buffer.from('{"schemaVersion":')]],
    ['valid JSON without LF', [Buffer.from(JSON.stringify(receipt))]]
  ] as const)('rejects %s EOF as an incomplete reply, not timeout or invalid JSON', async (_name, chunks) => {
    const peer = await replyWith([...chunks])
    try { await expect(requestAgentMuxControl(request, peer.path)).rejects.toMatchObject(incomplete) }
    finally { await peer.stop() }
  })

  it('keeps a malformed complete LF frame classified as invalid JSON', async () => {
    const peer = await replyWith([Buffer.from('{invalid}\n')])
    try { await expect(requestAgentMuxControl(request, peer.path)).rejects.toMatchObject({
      code: 'CONTROL_PROTOCOL_ERROR', message: 'Control message is invalid JSON.'
    }) } finally { await peer.stop() }
  })

  it('reports CONTROL_TIMEOUT only when its own public socket timer actually expires', async () => {
    const path = await endpoint(); let peer: Socket | undefined
    const server = createServer(socket => { peer = socket; socket.on('error', () => {}); socket.resume() })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
    try {
      await expect(requestAgentMuxControl(request, path)).rejects.toMatchObject({ code: 'CONTROL_TIMEOUT',
        message: 'Control request timed out before a complete reply was received; the result is unconfirmed.' })
    } finally { peer?.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) }
  }, 5_000)

  it('accepts a fragmented complete LF frame split inside a UTF-8 character', async () => {
    const read = { ...request, operation: 'settings.get' } as const
    const result = { entries: [{ key: 'literal', kind: 'string', value: '字面值', default: '字面值' }], partial: true }
    const bytes = Buffer.from(`${JSON.stringify({ ...receipt, operation: read.operation, result })}\n`)
    const boundary = bytes.indexOf(Buffer.from('字')) + 1
    expect(boundary).toBeGreaterThan(0)
    const peer = await replyWith([bytes.subarray(0, boundary), bytes.subarray(boundary)])
    try { await expect(requestAgentMuxControl(read, peer.path)).resolves.toMatchObject({ ok: true, result }) }
    finally { await peer.stop() }
  })

  it('never executes valid JSON received without an LF request terminator', async () => {
    const path = await endpoint(); let executions = 0
    const server = new AgentMuxControlServer({ execute: async () => { executions++; return { operation: 'list.agents', agents: [] } } }, path)
    await server.start()
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = createConnection(path); let bytes = ''
        socket.on('error', reject); socket.on('data', chunk => { bytes += chunk.toString('utf8') })
        socket.once('connect', () => socket.end(JSON.stringify(request)))
        socket.once('end', () => { socket.destroy(); resolve(bytes) })
      })
      expect(JSON.parse(reply)).toMatchObject({ ok: false, error: incomplete })
      expect(executions).toBe(0)
    } finally { await server.stop() }
  })
})
