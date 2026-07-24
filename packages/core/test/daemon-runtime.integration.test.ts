import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentMuxDaemonClient,
  type AgentMuxDaemonAttachResult,
  type AgentMuxDaemonDataEvent,
  type AgentMuxDaemonEvent
} from '../src/daemon-client.js'
import { AgentMuxDaemonServer } from '../src/daemon-server.js'

const fixturePath = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

async function waitForData(
  events: AgentMuxDaemonEvent[],
  predicate: (text: string) => boolean,
  timeoutMs = 5_000
): Promise<AgentMuxDaemonDataEvent[]> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const data = events.filter((event): event is AgentMuxDaemonDataEvent => event.type === 'data')
    if (predicate(data.map((event) => event.data).join(''))) return data
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for daemon output.')
}

async function waitForReplay(
  client: AgentMuxDaemonClient,
  sessionId: string,
  afterSequence: number,
  expectedText: string,
  timeoutMs = 5_000
): Promise<AgentMuxDaemonAttachResult> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const attached = await client.attach(sessionId, afterSequence)
    if (attached.replay.map((event) => event.data).join('').includes(expectedText)) return attached
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for daemon replay.')
}

describe('agentmuxd local node-pty vertical slice', () => {
  let temporaryDirectory: string
  let socketPath: string
  let server: AgentMuxDaemonServer
  const clients: AgentMuxDaemonClient[] = []

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'agentmuxd-test-'))
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

  it('keeps the endpoint private and reattaches one Raw Terminal after the first client detaches', async () => {
    expect((await stat(dirname(socketPath))).mode & 0o777).toBe(0o700)
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600)

    const first = await connect()
    const firstEvents: AgentMuxDaemonEvent[] = []
    first.onEvent((event) => firstEvents.push(event))
    const session = await first.createTerminal({
      sessionId: 'terminal-reattach',
      createOperationId: 'create-terminal-reattach',
      cwd: process.cwd(),
      cols: 90,
      rows: 30
    })
    await first.write(session, "printf 'terminal-before-detach\\n'\n")
    await waitForData(firstEvents, (text) => text.includes('terminal-before-detach'))
    const cursor = firstEvents
      .filter((event): event is AgentMuxDaemonDataEvent => event.type === 'data')
      .at(-1)?.endSequence ?? 0

    await first.detach(session)
    await first.write(session, "printf 'terminal-while-detached\\n'\n")
    first.disconnect()

    const second = await connect()
    const attached = await waitForReplay(second, session.sessionId, cursor, 'terminal-while-detached')
    expect(attached.session).toMatchObject({
      sessionId: session.sessionId,
      incarnationId: session.incarnationId,
      createOperationId: session.createOperationId,
      pid: session.pid,
      state: 'running'
    })
    expect(attached.replay.map((event) => event.data).join('')).toContain('terminal-while-detached')
    expect(attached.gap).toBeNull()
    expect(await second.resize(attached.session, 120, 40)).toMatchObject({ cols: 120, rows: 40 })

    const repeated = await second.createTerminal({
      sessionId: session.sessionId,
      createOperationId: session.createOperationId,
      cwd: process.cwd()
    })
    expect(repeated.incarnationId).toBe(session.incarnationId)
    expect(repeated.pid).toBe(session.pid)
    await second.stop(repeated)
  })

  it('fails attach-only for an unknown id without spawning a Shell', async () => {
    const client = await connect()
    await expect(client.attach('missing-session')).rejects.toMatchObject({ code: 'UNKNOWN_DAEMON_SESSION' })
    expect(await client.listSessions()).toEqual([])
  })

  it('launches one Agent command and streams input and exit from the same node-pty owner', async () => {
    const client = await connect()
    const events: AgentMuxDaemonEvent[] = []
    client.onEvent((event) => events.push(event))
    const session = await client.createAgent({
      sessionId: 'codex-provider-slice',
      createOperationId: 'create-codex-provider-slice',
      agentId: 'codex',
      semanticSessionId: 'semantic-codex-provider-slice',
      command: process.execPath,
      args: [fixturePath, 'review-the-daemon'],
      cwd: process.cwd()
    })

    expect(session).toMatchObject({
      kind: 'agent',
      agentId: 'codex',
      state: 'running'
    })
    await waitForData(events, (text) => text.includes('codex-ready:review-the-daemon'))
    await client.write(session, 'hello-from-client\n')
    await waitForData(events, (text) => text.includes('codex-input:hello-from-client'))

    const exit = new Promise<AgentMuxDaemonEvent>((resolve) => {
      const off = client.onEvent((event) => {
        if (event.type === 'exit' && event.sessionId === session.sessionId) {
          off()
          resolve(event)
        }
      })
    })
    await client.signal(session, 'SIGTERM')
    await expect(exit).resolves.toMatchObject({
      type: 'exit',
      sessionId: session.sessionId,
      incarnationId: session.incarnationId
    })
    await client.stop(session)
  })
})
