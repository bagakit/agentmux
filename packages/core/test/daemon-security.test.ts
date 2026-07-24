import { once } from 'node:events'
import { access, chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentMuxDaemonClient, type AgentMuxDaemonDataEvent } from '../src/daemon-client.js'
import {
  AGENTMUX_DAEMON_MAX_FRAME_BYTES,
  parseAgentMuxDaemonFrame
} from '../src/daemon-protocol.js'
import { AgentMuxDaemonServer } from '../src/daemon-server.js'

const directories: string[] = []
const servers: AgentMuxDaemonServer[] = []
const clients: AgentMuxDaemonClient[] = []
const fuzzSeed = Number.parseInt(process.env.AGENTMUX_FUZZ_SEED ?? '1592619015', 10)

if (!Number.isSafeInteger(fuzzSeed)) throw new Error('AGENTMUX_FUZZ_SEED must be an integer.')

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect()
  await Promise.allSettled(servers.splice(0).map(async (server) => await server.stop()))
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })))
})

async function fixture(): Promise<{ directory: string; socketPath: string; server: AgentMuxDaemonServer }> {
  const directory = await mkdtemp(join(tmpdir(), 'agentmuxd-security-'))
  directories.push(directory)
  const socketPath = join(directory, 'agentmuxd.sock')
  const server = new AgentMuxDaemonServer({ socketPath })
  servers.push(server)
  await server.start()
  return { directory, socketPath, server }
}

async function connect(socketPath: string): Promise<AgentMuxDaemonClient> {
  const client = new AgentMuxDaemonClient({ socketPath })
  clients.push(client)
  await client.connect()
  return client
}

async function rawConnection(socketPath: string): Promise<Socket> {
  const socket = createConnection(socketPath)
  socket.on('error', () => {})
  await once(socket, 'connect')
  return socket
}

async function expectRejectedFrame(socketPath: string, frame: string): Promise<void> {
  const socket = await rawConnection(socketPath)
  const closed = once(socket, 'close')
  socket.write(`${frame}\n`)
  await closed
}

async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

function seededInvalidFrames(seed: number, count: number): string[] {
  let state = seed >>> 0
  const next = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state
  }
  const alphabet = '[]{}:,"abcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from({ length: count }, () => {
    const length = 1 + next() % 96
    let value = ''
    for (let index = 0; index < length; index += 1) value += alphabet[next() % alphabet.length]
    return value
  })
}

describe('agentmuxd security boundary', () => {
  it('validates response and event envelopes before a client can consume them', () => {
    expect(() => parseAgentMuxDaemonFrame(JSON.stringify({
      type: 'event',
      event: {
        type: 'data',
        sessionId: 'session',
        incarnationId: 'incarnation',
        startSequence: 0,
        endSequence: 1,
        data: '你好'
      }
    }))).toThrow('Invalid AgentMux daemon frame')
    expect(() => parseAgentMuxDaemonFrame(JSON.stringify({
      type: 'response',
      id: 'request',
      ok: false,
      error: { code: 42, message: 'invalid code type' }
    }))).toThrow('Invalid AgentMux daemon error frame')
    expect(parseAgentMuxDaemonFrame(JSON.stringify({
      type: 'event',
      event: {
        type: 'data',
        sessionId: 'session',
        incarnationId: 'incarnation',
        startSequence: 0,
        endSequence: Buffer.byteLength('你好'),
        data: '你好'
      }
    }))).toMatchObject({ type: 'event', event: { endSequence: 6, data: '你好' } })
  })

  it.runIf(process.platform !== 'win32')('refuses an insecure socket directory and preserves a non-socket endpoint', async () => {
    const insecureDirectory = await mkdtemp(join(tmpdir(), 'agentmuxd-insecure-'))
    directories.push(insecureDirectory)
    await chmod(insecureDirectory, 0o755)
    const insecure = new AgentMuxDaemonServer({ socketPath: join(insecureDirectory, 'agentmuxd.sock') })
    servers.push(insecure)
    await expect(insecure.start()).rejects.toMatchObject({ code: 'INSECURE_DAEMON_DIRECTORY' })

    const protectedDirectory = await mkdtemp(join(tmpdir(), 'agentmuxd-protected-'))
    directories.push(protectedDirectory)
    const endpoint = join(protectedDirectory, 'agentmuxd.sock')
    await writeFile(endpoint, 'user-owned')
    const protectedServer = new AgentMuxDaemonServer({ socketPath: endpoint })
    servers.push(protectedServer)
    await expect(protectedServer.start()).rejects.toMatchObject({ code: 'INVALID_DAEMON_ENDPOINT' })
    await expect(readFile(endpoint, 'utf8')).resolves.toBe('user-owned')
  })

  it('fails closed on malformed and oversized frames while keeping the daemon healthy', async () => {
    const { socketPath } = await fixture()
    const malformed = [
      'null',
      '[]',
      '{}',
      '{"type":"event","event":{}}',
      '{"type":"response","id":"x","ok":true}',
      '{"type":"request","id":1,"method":"list","params":{}}',
      '{"type":"request","id":"x","method":"unknown","params":{}}',
      ...seededInvalidFrames(fuzzSeed, 32)
    ]
    for (const frame of malformed) await expectRejectedFrame(socketPath, frame)

    const oversized = await rawConnection(socketPath)
    const closed = once(oversized, 'close')
    oversized.write('x'.repeat(AGENTMUX_DAEMON_MAX_FRAME_BYTES + 1))
    await closed

    const healthy = await connect(socketPath)
    await expect(healthy.listSessions()).resolves.toEqual([])
  })

  it('passes argv, environment, and ANSI bytes literally without shell execution or secret persistence', async () => {
    const { directory, socketPath } = await fixture()
    const client = await connect(socketPath)
    const output: AgentMuxDaemonDataEvent[] = []
    client.onEvent((event) => {
      if (event.type === 'data') output.push(event)
    })
    const sentinel = join(directory, 'must-not-exist')
    const argument = `$(touch ${sentinel}); echo injected`
    const secret = 'agentmux-test-secret-value'
    const ansi = '\u001b[31mRED\u001b[0m\u001b]0;agentmux-title\u0007'
    const source = [
      "process.stdout.write('security-fixture:' + JSON.stringify({ args: process.argv.slice(1), value: process.env.AGENTMUX_SECURITY_VALUE, cwd: process.cwd() }) + '\\n')",
      `process.stdout.write(${JSON.stringify(ansi)})`
    ].join(';')
    const session = await client.createAgent({
      sessionId: 'security-argv-env',
      createOperationId: 'operation-security-argv-env',
      semanticSessionId: 'semantic-security-argv-env',
      agentId: 'security-fixture',
      command: process.execPath,
      args: ['-e', source, argument],
      cwd: directory,
      env: { AGENTMUX_SECURITY_VALUE: secret }
    })
    await waitFor('literal fixture output', () => output.map((event) => event.data).join('').includes(ansi))
    const text = output.map((event) => event.data).join('')
    expect(text).toContain(JSON.stringify({ args: [argument], value: secret, cwd: await realpath(directory) }))
    expect(text).toContain(ansi)
    await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })

    const journal = await readFile(`${socketPath}.sessions.json`, 'utf8')
    expect(journal).not.toContain(secret)
    expect(journal).not.toContain(argument)
    await client.stop(session)
    await expect(client.listSessions()).resolves.toEqual([])
  })

  it('enforces create argument and environment budgets before spawning a process', async () => {
    const { socketPath } = await fixture()
    const client = await connect(socketPath)
    await expect(client.createAgent({
      sessionId: 'too-many-args',
      createOperationId: 'operation-too-many-args',
      semanticSessionId: 'semantic-too-many-args',
      agentId: 'security-fixture',
      command: process.execPath,
      args: Array.from({ length: 257 }, () => 'x'),
      cwd: process.cwd()
    })).rejects.toMatchObject({ code: 'INVALID_DAEMON_CREATE' })
    await expect(client.createAgent({
      sessionId: 'too-much-env',
      createOperationId: 'operation-too-much-env',
      semanticSessionId: 'semantic-too-much-env',
      agentId: 'security-fixture',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      env: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`VALUE_${index}`, 'x']))
    })).rejects.toMatchObject({ code: 'DAEMON_CREATE_LIMIT' })
    await expect(client.createAgent({
      sessionId: 'invalid-env-name',
      createOperationId: 'operation-invalid-env-name',
      semanticSessionId: 'semantic-invalid-env-name',
      agentId: 'security-fixture',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      env: { 'BAD=NAME': 'x' }
    })).rejects.toMatchObject({ code: 'INVALID_DAEMON_CREATE' })
    await expect(client.listSessions()).resolves.toEqual([])
    await expect(stat(`${socketPath}.sessions.json`)).resolves.toBeDefined()
  })
})
