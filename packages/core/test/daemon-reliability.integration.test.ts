import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnection } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentMuxDaemonClient,
  type AgentMuxDaemonDataEvent,
  type AgentMuxDaemonEvent,
  type AgentMuxDaemonSession
} from '../src/daemon-client.js'
import { encodeAgentMuxDaemonFrame, type AgentMuxDaemonCreateRequest } from '../src/daemon-protocol.js'
import { AgentMuxDaemonServer } from '../src/daemon-server.js'
import { posixProcessIsControllable } from '../src/posix-process-identity.js'

const fakeCodexPath = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
const stubbornTreePath = fileURLToPath(new URL('./fixtures/stubborn-process-tree.mjs', import.meta.url))

async function waitForCondition(
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

function output(events: readonly AgentMuxDaemonEvent[]): string {
  return events
    .filter((event): event is AgentMuxDaemonDataEvent => event.type === 'data')
    .map((event) => event.data)
    .join('')
}

function latestOutputSequence(events: readonly AgentMuxDaemonEvent[]): number {
  return events
    .filter((event): event is AgentMuxDaemonDataEvent => event.type === 'data')
    .at(-1)?.endSequence ?? 0
}

async function sendRequestAndDrop(socketPath: string, method: 'create' | 'write', params: unknown): Promise<void> {
  const socket = createConnection(socketPath)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  await new Promise<void>((resolve, reject) => {
    socket.write(encodeAgentMuxDaemonFrame({
      type: 'request',
      id: `dropped-${Date.now()}`,
      method,
      params
    }), (error) => {
      socket.destroy()
      if (error) reject(error)
      else resolve()
    })
  })
}

function processIsAlive(pid: number): boolean {
  return posixProcessIsControllable(pid)
}

describe('agentmuxd reliability contract', () => {
  let temporaryDirectory: string
  let socketPath: string
  let server: AgentMuxDaemonServer
  const clients: AgentMuxDaemonClient[] = []

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'agentmuxd-reliability-'))
    socketPath = join(temporaryDirectory, 'agentmuxd.sock')
    server = new AgentMuxDaemonServer({ socketPath })
    await server.start()
  })

  afterEach(async () => {
    for (const client of clients.splice(0)) client.disconnect()
    await server.stop()
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  async function connect(): Promise<AgentMuxDaemonClient> {
    const client = new AgentMuxDaemonClient({ socketPath })
    clients.push(client)
    await client.connect()
    return client
  }

  it('recovers a lost Create response by operation id without spawning twice', async () => {
    const request: AgentMuxDaemonCreateRequest = {
      sessionId: 'lost-create-response',
      createOperationId: 'operation-lost-create-response',
      kind: 'terminal',
      agentId: null,
      semanticSessionId: null,
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      env: {}
    }
    await sendRequestAndDrop(socketPath, 'create', request)
    const client = await connect()
    let recovered: AgentMuxDaemonSession | null = null
    await waitForCondition('the durable create receipt', async () => {
      recovered = await client.findCreateOperation(request.createOperationId)
      return recovered !== null
    })
    const first = recovered!

    await sendRequestAndDrop(socketPath, 'create', request)
    await waitForCondition('the repeated create receipt', async () => {
      const repeated = await client.findCreateOperation(request.createOperationId)
      return repeated?.pid === first.pid && repeated.incarnationId === first.incarnationId
    })
    const attached = await client.attach(request.sessionId)
    expect(attached.session).toMatchObject({
      pid: first.pid,
      incarnationId: first.incarnationId,
      createOperationId: request.createOperationId
    })
    await client.stop(attached.session)
  })

  it('fences stale controls after a session id receives a new incarnation', async () => {
    const staleClient = await connect()
    const controller = await connect()
    const first = await staleClient.createTerminal({
      sessionId: 'reused-session-id',
      createOperationId: 'operation-first-incarnation',
      cwd: process.cwd()
    })
    await controller.attach(first.sessionId)
    await controller.stop(first)

    const second = await controller.createTerminal({
      sessionId: first.sessionId,
      createOperationId: 'operation-second-incarnation',
      cwd: process.cwd()
    })
    expect(second.incarnationId).not.toBe(first.incarnationId)
    await expect(staleClient.resize(first, 120, 40)).rejects.toMatchObject({
      code: 'STALE_SESSION_INCARNATION'
    })
    await expect(staleClient.stop(first)).rejects.toMatchObject({
      code: 'STALE_SESSION_INCARNATION'
    })
    await staleClient.detach(first)
    expect((await controller.listSessions())[0]).toMatchObject({
      incarnationId: second.incarnationId,
      state: 'running'
    })
    await controller.stop(second)
  })

  it('serializes concurrent input and advances a byte cursor only after acknowledgement', async () => {
    const client = await connect()
    const events: AgentMuxDaemonEvent[] = []
    client.onEvent((event) => events.push(event))
    const session = await client.createAgent({
      sessionId: 'ordered-input',
      createOperationId: 'operation-ordered-input',
      agentId: 'codex',
      semanticSessionId: 'semantic-ordered-input',
      command: process.execPath,
      args: [fakeCodexPath, 'ordered-input'],
      cwd: process.cwd()
    })
    await waitForCondition('the fake agent ready signal', () => output(events).includes('codex-ready:ordered-input'))

    const chunks = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, '0')}\n`)
    const acknowledgements = await Promise.all(chunks.map(async (chunk) => await client.write(session, chunk)))
    await waitForCondition('all ordered agent input', () => output(events).includes('codex-input:099'))
    const text = output(events)
    let previousIndex = -1
    for (const chunk of chunks) {
      const index = text.indexOf(`codex-input:${chunk.trim()}`)
      expect(index).toBeGreaterThan(previousIndex)
      previousIndex = index
    }
    expect(acknowledgements.at(-1)?.acceptedThrough).toBe(
      chunks.reduce((bytes, chunk) => bytes + Buffer.byteLength(chunk), 0)
    )
    await client.acknowledgeOutput(session, latestOutputSequence(events))
    await client.stop(session)
  })

  it('uses the authoritative input cursor after a lost Write response without repeating accepted bytes', async () => {
    const creator = await connect()
    const creatorEvents: AgentMuxDaemonEvent[] = []
    creator.onEvent((event) => creatorEvents.push(event))
    const session = await creator.createAgent({
      sessionId: 'lost-write-response',
      createOperationId: 'operation-lost-write-response',
      agentId: 'codex',
      semanticSessionId: 'semantic-lost-write-response',
      command: process.execPath,
      args: [fakeCodexPath, 'lost-write-response'],
      cwd: process.cwd()
    })
    await waitForCondition('the lost-write fixture ready signal', () => (
      output(creatorEvents).includes('codex-ready:lost-write-response')
    ))
    const readyCursor = latestOutputSequence(creatorEvents)
    creator.disconnect()

    const firstInput = 'accepted-once\n'
    const rawWrite = {
      sessionId: session.sessionId,
      incarnationId: session.incarnationId,
      startSequence: 0,
      data: firstInput
    }
    await sendRequestAndDrop(socketPath, 'write', rawWrite)
    const recovery = await connect()
    await waitForCondition('the accepted input cursor', async () => {
      const snapshot = (await recovery.listSessions()).find((candidate) => candidate.sessionId === session.sessionId)
      return snapshot?.acceptedInputSequence === Buffer.byteLength(firstInput)
    })
    await sendRequestAndDrop(socketPath, 'write', rawWrite)

    let attached = await recovery.attach(session.sessionId, readyCursor)
    await waitForCondition('the single recovered input result', async () => {
      attached = await recovery.attach(session.sessionId, readyCursor)
      return attached.replay.some((event) => event.data.includes('codex-input:accepted-once'))
    })
    expect(attached.replay.map((event) => event.data).join('').match(/codex-input:accepted-once/g)).toHaveLength(1)

    const next = await recovery.write(attached.session, 'next-input\n')
    expect(next.acceptedThrough).toBe(Buffer.byteLength(firstInput) + Buffer.byteLength('next-input\n'))
    await recovery.stop(attached.session)
  })

  it('disconnects a client that does not acknowledge output and exposes a bounded replay gap', async () => {
    const producer = await connect()
    const slowConsumer = await connect()
    const session = await producer.createTerminal({
      sessionId: 'slow-output-consumer',
      createOperationId: 'operation-slow-output-consumer',
      cwd: process.cwd()
    })
    await producer.detach(session)
    await slowConsumer.attach(session.sessionId)

    const source = "process.stdout.write('x'.repeat(700000))"
    await producer.write(session, `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}\n`)
    await waitForCondition('the slow consumer to be disconnected', async () => {
      try {
        await slowConsumer.listSessions()
        return false
      } catch (error) {
        return (error as { code?: string }).code === 'DAEMON_DISCONNECTED'
      }
    })

    const monitor = await connect()
    await waitForCondition('the daemon to record the completed burst', async () => {
      const current = (await monitor.listSessions()).find((candidate) => candidate.sessionId === session.sessionId)
      return (current?.latestSequence ?? 0) >= 700_000
    })
    const recovery = await connect()
    const attached = await recovery.attach(session.sessionId, 0)
    expect(attached.gap).not.toBeNull()
    expect(Buffer.byteLength(attached.replay.map((event) => event.data).join(''))).toBeLessThanOrEqual(256 * 1024)
    for (let index = 1; index < attached.replay.length; index += 1) {
      expect(attached.replay[index]!.startSequence).toBe(attached.replay[index - 1]!.endSequence)
    }
    await recovery.acknowledgeOutput(attached.session, attached.session.latestSequence)
    await recovery.stop(attached.session)
  })

  it.runIf(process.platform !== 'win32')('force-stops a stubborn PTY process tree without orphaning its child', async () => {
    const client = await connect()
    const events: AgentMuxDaemonEvent[] = []
    client.onEvent((event) => events.push(event))
    const session = await client.createAgent({
      sessionId: 'stubborn-process-tree',
      createOperationId: 'operation-stubborn-process-tree',
      agentId: 'codex',
      semanticSessionId: 'semantic-stubborn-process-tree',
      command: process.execPath,
      args: [stubbornTreePath],
      cwd: process.cwd()
    })
    let childPid = 0
    await waitForCondition('the stubborn child pid', () => {
      const match = /stubborn-root:\d+:(\d+)/.exec(output(events))
      if (!match) return false
      childPid = Number(match[1])
      return childPid > 0
    })
    expect(processIsAlive(session.pid)).toBe(true)
    expect(processIsAlive(childPid)).toBe(true)

    await client.stop(session)
    await waitForCondition('the complete PTY process tree to exit', () => (
      !processIsAlive(session.pid) && !processIsAlive(childPid)
    ))
    expect(await client.listSessions()).toEqual([])
  })

  it('releases a client slot after enforcing the per-daemon client limit', async () => {
    const shared = new AgentMuxDaemonClient({ socketPath })
    clients.push(shared)
    await Promise.all(Array.from({ length: 32 }, async () => await shared.connect()))
    const accepted = [
      shared,
      ...await Promise.all(Array.from({ length: 63 }, async () => await connect()))
    ]
    const rejected = new AgentMuxDaemonClient({ socketPath })
    clients.push(rejected)
    await expect(rejected.connect()).rejects.toMatchObject({ code: 'DAEMON_DISCONNECTED' })

    accepted[0]!.disconnect()
    await waitForCondition('the disconnected client slot to be released', async () => {
      const replacement = new AgentMuxDaemonClient({ socketPath })
      try {
        await replacement.connect()
        clients.push(replacement)
        return true
      } catch {
        replacement.disconnect()
        return false
      }
    })
  })

  it('repeatedly attaches and detaches without losing control or leaking an attachment', async () => {
    const controller = await connect()
    const observer = await connect()
    const session = await controller.createTerminal({
      sessionId: 'attach-detach-loop',
      createOperationId: 'operation-attach-detach-loop',
      cwd: process.cwd()
    })
    for (let index = 0; index < 100; index += 1) {
      const attached = await observer.attach(session.sessionId)
      expect(attached.session.incarnationId).toBe(session.incarnationId)
      await observer.detach(attached.session)
    }
    await controller.write(session, "printf 'still-controlled\\n'\n")
    const attached = await observer.attach(session.sessionId)
    expect(attached.session.state).toBe('running')
    await observer.stop(attached.session)
    await expect(controller.listSessions()).resolves.toEqual([])
  })

  it('converges concurrent Stop and Resize requests on one removed process', async () => {
    const first = await connect()
    const second = await connect()
    const session = await first.createTerminal({
      sessionId: 'stop-resize-race',
      createOperationId: 'operation-stop-resize-race',
      cwd: process.cwd()
    })
    const attached = await second.attach(session.sessionId)
    const results = await Promise.allSettled([
      first.stop(session),
      second.stop(attached.session),
      ...Array.from({ length: 32 }, (_, index) => second.resize(
        attached.session,
        80 + index,
        24 + index % 8
      ))
    ])
    expect(results.slice(0, 2).some((result) => result.status === 'fulfilled')).toBe(true)
    for (const result of results) {
      if (result.status === 'rejected') {
        expect((result.reason as { code?: string }).code).toMatch(/^(SESSION_NOT_RUNNING|UNKNOWN_DAEMON_SESSION)$/)
      }
    }
    await expect(first.listSessions()).resolves.toEqual([])
    expect(processIsAlive(session.pid)).toBe(false)
  })
})
