import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { WebSocket } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { parseClaudeExecutionMessage, parseClaudeExecutionServerMessage, restoreClaudeExecutionConnection } from '../../providers/src/claude/execution-protocol.js'
import { createAgentExecutionExecutor } from '../src/agent-execution/executor.js'
import { runAgentExecutionFrontend } from '../src/agent-execution/frontend.js'
import { AgentExecutionJournal } from '../src/agent-execution/journal.js'
import { nativeConnectionRecovery } from '../src/agent-execution/native-connection-recovery.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

const handshake = { jsonrpc: '2.0', method: 'initialize', id: 0, params: {
  protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'original-client', version: '1' }
} }
const fixtureNative = String.raw`
const fs = require('node:fs')
const rl = require('node:readline').createInterface({ input: process.stdin })
let initialized = false
for await (const line of rl) {
  const frame = JSON.parse(line)
  let result
  if (frame.method === 'initialize') {
    fs.appendFileSync('initializations', process.argv[1] + '\n')
    while (fs.existsSync('hold-initialization')) await new Promise(r => setTimeout(r, 10))
    result = { protocolVersion: frame.params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: 'fixture-native-mcp', version: process.argv[1] } }
  } else if (frame.method === 'notifications/initialized') { initialized = true; continue }
  else if (!initialized) {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32001, message: 'Missing native handshake' } }))
    continue
  } else if (frame.params?.name === 'Write') {
    fs.appendFileSync('effects', 'once\n')
    continue
  } else result = { content: [{ type: 'text', text: fs.readFileSync('original-project', 'utf8') }] }
  console.log(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }))
}`

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'amux-tool-recovery-'))
  cleanup.push(() => rm(workspace, { recursive: true, force: true }))
  await writeFile(join(workspace, 'original-project'), 'project-result')
  const dir = join(workspace, 'journal'), bindingId = 'original-binding'
  const frontendInput = new PassThrough(), frontendOutput = new PassThrough()
  let resourceInput = new PassThrough()
  const outbound = createInterface({ input: frontendOutput })
  const originalFrames: { type: string; generation: string; requestSequence?: number; payload?: { id?: number | string } }[] = []
  outbound.on('line', line => {
    const frame = JSON.parse(line)
    if (frame.type !== 'ready') {
      originalFrames.push(frame)
      resourceInput.write(line + '\n')
    }
  })
  const frontend = await runAgentExecutionFrontend({ input: frontendInput, output: frontendOutput, projectConnectionRecovery: true, onError: () => {} })
  cleanup.push(async () => { outbound.close(); await frontend.close(); frontendInput.destroy(); frontendOutput.destroy() })
  const socket = new WebSocket(frontend.url)
  cleanup.push(async () => { socket.terminate() })
  const replies: { id: string | number; result?: unknown; error?: { code: number } }[] = []
  const observations: { type: string; generation: string }[] = []
  socket.on('message', bytes => replies.push(JSON.parse(String(bytes))))
  await once(socket, 'open')
  const send = (frame: unknown) => socket.send(JSON.stringify(frame))
  const call = (id: string | number, name: 'Read' | 'Write') => send({ jsonrpc: '2.0', id, method: 'tools/call',
    params: { name, arguments: { file_path: join(workspace, 'original-project') } } })
  const wait = (id: string | number) => vi.waitFor(() => {
    const reply = replies.find(item => item.id === id)
    expect(reply).toBeDefined()
    return reply!
  })
  async function start(version = 'original', recoverable = true) {
    const input = resourceInput = new PassThrough(), output = new PassThrough()
    const journal = await AgentExecutionJournal.open(dir)
    const inbound = createInterface({ input: output })
    inbound.on('line', line => {
      const frame = JSON.parse(line)
      observations.push(frame)
      if (frame.type === 'response') frontendInput.write(line + '\n')
    })
    const native = process.env.AGENTMUX_CLAUDE_RECOVERY_EXECUTABLE
    const executor = createAgentExecutionExecutor({ bindingId, journal, input, output, onError: () => {},
      authorize: async target => { expect(target.bindingId).toBe(bindingId) },
      protocol: { parse: parseClaudeExecutionMessage, parseServer: parseClaudeExecutionServerMessage,
        ...(recoverable ? { restoreConnection: restoreClaudeExecutionConnection } : {}),
        executor: { command: native ?? process.execPath, args: native ? ['mcp', 'serve'] :
          ['--input-type=module', '-e', "const require = (await import('node:module')).createRequire(process.cwd() + '/fixture.js');\n" + fixtureNative, version],
        cwd: workspace, ...(native ? { env: { CLAUDE_CONFIG_DIR: join(workspace, 'claude-config'), DISABLE_AUTOUPDATER: '1' } } : {}) } } })
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      await executor.dispose(); await journal.close(); inbound.close(); input.destroy(); output.destroy()
    }
    cleanup.push(close)
    return { journal, close }
  }
  const initialize = async () => {
    send(handshake)
    expect(await wait(0)).toHaveProperty('result')
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return originalFrames[0]!.generation
  }
  return { socket, initialize, call, wait, start, send, bindingId, workspace, originalFrames, observations, replies,
    retire(through: number) { frontendInput.write(JSON.stringify({ type: 'retire-frontend-requests', through }) + '\n') } }
}

it('uses the same socket and generation after resource replacement while a previous write stays unknown', async () => {
  if (process.env.AGENTMUX_CLAUDE_RECOVERY_EXECUTABLE) return
  const f = await fixture(), first = await f.start(), generation = await f.initialize()
  f.call(1, 'Write')
  await vi.waitFor(async () => expect(await readFile(join(f.workspace, 'effects'), 'utf8')).toBe('once\n'))
  const key = { bindingId: f.bindingId, streamGeneration: generation, nativeRequestId: 1 }
  const original = await first.journal.inspect(key)
  expect(original).toMatchObject({ phase: 'dispatched', outcome: 'unknown' })
  await first.close()
  const next = await f.start()
  f.call('0', 'Read')
  f.retire(f.originalFrames.find(frame => frame.payload?.id === 1)!.requestSequence!)
  expect(await f.wait(1)).toMatchObject({ error: { code: -32603 } })
  expect(await f.wait('0')).toMatchObject({ result: { content: [{ text: 'project-result' }] } })
  expect(f.originalFrames.filter(frame => frame.payload?.id !== undefined).map(frame => frame.generation)).toEqual([generation, generation, generation])
  expect(f.replies.filter(reply => reply.id === 0)).toHaveLength(1)
  expect(await next.journal.inspect(key)).toEqual(original)
  expect(await readFile(join(f.workspace, 'effects'), 'utf8')).toBe('once\n')
  expect(await readFile(join(f.workspace, 'initializations'), 'utf8')).toBe('original\noriginal\n')
  expect(f.socket.readyState).toBe(WebSocket.OPEN)
})

it('honors exact client cancellation before a recovered socket writes a queued effect', async () => {
  if (process.env.AGENTMUX_CLAUDE_RECOVERY_EXECUTABLE) return
  const f = await fixture(), first = await f.start(), generation = await f.initialize()
  await first.close()
  const hold = join(f.workspace, 'hold-initialization')
  await writeFile(hold, '')
  const next = await f.start()
  f.call(1, 'Write')
  f.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })
  await vi.waitFor(async () => expect(await readFile(join(f.workspace, 'initializations'), 'utf8')).toBe('original\noriginal\n'))
  await rm(hold)
  expect(await f.wait(1)).toMatchObject({ error: { code: -32002 } })
  expect(await next.journal.inspect({ bindingId: f.bindingId, streamGeneration: generation, nativeRequestId: 1 })).toMatchObject({ phase: 'prepared', outcome: 'not-dispatched' })
  await expect(readFile(join(f.workspace, 'effects'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('a late native initialization response cannot requalify a closed socket', async () => {
  if (process.env.AGENTMUX_CLAUDE_RECOVERY_EXECUTABLE) return
  const f = await fixture(), first = await f.start()
  const hold = join(f.workspace, 'hold-initialization')
  await writeFile(hold, '')
  f.send(handshake)
  await vi.waitFor(async () => expect(await readFile(join(f.workspace, 'initializations'), 'utf8')).toBe('original\n'))
  f.socket.close()
  await vi.waitFor(() => expect(f.observations).toContainEqual(expect.objectContaining({ type: 'generation' })))
  await rm(hold)
  const generation = f.originalFrames[0]!.generation
  await vi.waitFor(async () => expect(await first.journal.inspect({ bindingId: f.bindingId, streamGeneration: generation, nativeRequestId: 0 })).toMatchObject({ phase: 'completed' }))
  expect(await first.journal.readConnectionInitialization(f.bindingId, generation)).toBeNull()
})

it.each(['changed-native', 'missing-evidence'])('preserves the open client and refuses new effects with %s', async failure => {
  if (process.env.AGENTMUX_CLAUDE_RECOVERY_EXECUTABLE) return
  const f = await fixture(), first = await f.start('original', failure !== 'missing-evidence'), generation = await f.initialize()
  f.call(1, 'Read')
  expect(await f.wait(1)).toHaveProperty('result')
  await first.close()
  const next = await f.start(failure === 'changed-native' ? 'changed' : 'original')
  f.call(2, 'Write')
  expect(await f.wait(2)).toHaveProperty('error.code', -32002)
  const operation = await next.journal.inspect({ bindingId: f.bindingId, streamGeneration: generation, nativeRequestId: 2 })
  expect(operation?.phase).toBe(failure === 'changed-native' ? 'prepared' : undefined)
  await expect(readFile(join(f.workspace, 'effects'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.socket.readyState).toBe(WebSocket.OPEN)
})

it('finishes private initialization cancellation even while the last native write is hung', async () => {
  const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' }
  const plan = nativeConnectionRecovery({ request: handshake, requestId: 0, accepts: () => true, initialized })
  const send = vi.fn(async (frame: unknown) => { if (frame === initialized) await new Promise<void>(() => {}) })
  const result = plan.negotiate(send)
  plan.receive(0, { jsonrpc: '2.0', id: 0, result: {} })
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith(initialized))
  plan.cancel()
  await expect(result).resolves.toBe(false)
})

it.runIf(!!process.env.AGENTMUX_CLAUDE_RECOVERY_EXECUTABLE)('renegotiates the actual Claude MCP resource server on one live socket', async () => {
  const f = await fixture(), first = await f.start(), generation = await f.initialize()
  f.call(1, 'Read')
  expect(JSON.stringify((await f.wait(1)).result)).toContain('project-result')
  await first.close()
  const next = await f.start()
  f.call('0', 'Read')
  expect(JSON.stringify((await f.wait('0')).result)).toContain('project-result')
  expect(f.originalFrames.filter(frame => frame.payload?.id !== undefined).map(frame => frame.generation)).toEqual([generation, generation, generation])
  expect(await next.journal.inspect({ bindingId: f.bindingId, streamGeneration: generation, nativeRequestId: '0' })).toMatchObject({ phase: 'completed' })
  expect(f.socket.readyState).toBe(WebSocket.OPEN)
}, 20_000)
