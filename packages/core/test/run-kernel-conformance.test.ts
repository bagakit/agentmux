import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  AgentMuxDaemonClient,
  type AgentMuxDaemonEvent,
  type AgentMuxDaemonSession,
  type AgentMuxDaemonSessionRef
} from '../src/daemon-client.js'
import {
  encodeAgentMuxDaemonFrame,
  parseAgentMuxDaemonFrame,
  type AgentMuxDaemonMethod
} from '../src/daemon-protocol.js'
import { AgentMuxDaemonServer } from '../src/daemon-server.js'
import {
  RUN_KERNEL_CONFORMANCE,
  registerRunKernelConformance,
  type ConformanceAttachment,
  type ConformanceClient,
  type ConformanceCreateInput,
  type ConformanceDataEvent,
  type ConformanceRun,
  type ConformanceRunRef,
  type RunKernelConformanceHarness
} from './conformance/run-kernel-contract.js'

const workloadPath = fileURLToPath(new URL('./fixtures/run-kernel-workload.mjs', import.meta.url))

function projectRun(run: AgentMuxDaemonSession): ConformanceRun {
  return {
    runId: run.sessionId,
    incarnationId: run.incarnationId,
    createOperationId: run.createOperationId,
    pid: run.pid,
    state: run.state,
    cols: run.cols,
    rows: run.rows,
    latestOutputBytes: run.latestSequence,
    acceptedInputBytes: run.acceptedInputSequence
  }
}

function daemonRef(ref: ConformanceRunRef): AgentMuxDaemonSessionRef {
  return { sessionId: ref.runId, incarnationId: ref.incarnationId }
}

function projectData(event: Extract<AgentMuxDaemonEvent, { type: 'data' }>): ConformanceDataEvent {
  return {
    runId: event.sessionId,
    incarnationId: event.incarnationId,
    startByte: event.startSequence,
    endByte: event.endSequence,
    data: event.data
  }
}

async function rawRequest(
  socketPath: string,
  method: AgentMuxDaemonMethod,
  params: unknown
): Promise<unknown> {
  const socket = createConnection(socketPath)
  socket.setEncoding('utf8')
  const id = randomUUID()
  let input = ''
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    return await new Promise<unknown>((resolve, reject) => {
      socket.on('data', (chunk) => {
        input += chunk
        while (true) {
          const newline = input.indexOf('\n')
          if (newline < 0) return
          const line = input.slice(0, newline)
          input = input.slice(newline + 1)
          if (!line) continue
          try {
            const frame = parseAgentMuxDaemonFrame(line)
            if (frame.type !== 'response' || frame.id !== id) continue
            if (frame.ok) resolve(frame.result)
            else reject(Object.assign(new Error(frame.error.message), { code: frame.error.code }))
          } catch (error) {
            reject(error)
          }
        }
      })
      socket.once('error', reject)
      socket.write(encodeAgentMuxDaemonFrame({ type: 'request', id, method, params }))
    })
  } finally {
    socket.destroy()
  }
}

class AgentMuxdConformanceClient implements ConformanceClient {
  constructor(
    private readonly client: AgentMuxDaemonClient,
    private readonly socketPath: string
  ) {}

  async create(input: ConformanceCreateInput): Promise<ConformanceRun> {
    const run = input.command
      ? await this.client.createAgent({
          sessionId: input.runId,
          createOperationId: input.createOperationId,
          agentId: 'codex',
          agentSessionId: `agent-${input.runId}`,
          command: input.command,
          args: input.args ?? [],
          cwd: input.workspacePath,
          ...(input.cols === undefined ? {} : { cols: input.cols }),
          ...(input.rows === undefined ? {} : { rows: input.rows })
        })
      : await this.client.createTerminal({
          sessionId: input.runId,
          createOperationId: input.createOperationId,
          cwd: input.workspacePath,
          ...(input.cols === undefined ? {} : { cols: input.cols }),
          ...(input.rows === undefined ? {} : { rows: input.rows })
        })
    return projectRun(run)
  }

  async list(): Promise<ConformanceRun[]> {
    return (await this.client.listSessions()).map(projectRun)
  }

  async attach(runId: string, afterByte = 0): Promise<ConformanceAttachment> {
    const attached = await this.client.attach(runId, afterByte)
    return {
      run: projectRun(attached.session),
      replay: attached.replay.map(projectData),
      gap: attached.gap
        ? {
            requestedAfterByte: attached.gap.requestedAfterSequence,
            firstAvailableByte: attached.gap.firstAvailableSequence
          }
        : null
    }
  }

  async release(ref: ConformanceRunRef): Promise<void> {
    await this.client.detach(daemonRef(ref))
  }

  async write(ref: ConformanceRunRef, data: string) {
    const ack = await this.client.write(daemonRef(ref), data)
    return { acceptedThroughByte: ack.acceptedThrough, duplicate: ack.duplicate }
  }

  async writeAt(ref: ConformanceRunRef, startByte: number, data: string) {
    const ack = await rawRequest(this.socketPath, 'write', {
      ...daemonRef(ref),
      startSequence: startByte,
      data
    }) as { acceptedThrough: number; duplicate: boolean }
    return { acceptedThroughByte: ack.acceptedThrough, duplicate: ack.duplicate }
  }

  async resize(ref: ConformanceRunRef, cols: number, rows: number) {
    const applied = await this.client.resize(daemonRef(ref), cols, rows)
    return { cols: applied.cols, rows: applied.rows }
  }

  async acknowledge(ref: ConformanceRunRef, throughByte: number): Promise<void> {
    await this.client.acknowledgeOutput(daemonRef(ref), throughByte)
  }

  async stop(ref: ConformanceRunRef): Promise<void> {
    await this.client.stop(daemonRef(ref))
  }

  onData(listener: (event: ConformanceDataEvent) => void): () => void {
    return this.client.onEvent((event) => {
      if (event.type === 'data') listener(projectData(event))
    })
  }

  disconnect(): void {
    this.client.disconnect()
  }
}

async function createAgentMuxdHarness(): Promise<RunKernelConformanceHarness> {
  const directory = await mkdtemp(join(tmpdir(), 'agentmux-run-kernel-conformance-'))
  const socketPath = join(directory, 'agentmuxd.sock')
  const server = new AgentMuxDaemonServer({ socketPath })
  const clients: AgentMuxDaemonClient[] = []
  await server.start()
  return {
    async connect() {
      const client = new AgentMuxDaemonClient({ socketPath })
      clients.push(client)
      await client.connect()
      return new AgentMuxdConformanceClient(client, socketPath)
    },
    async dispose() {
      for (const client of clients) client.disconnect()
      await server.stop()
      await rm(directory, { recursive: true, force: true })
    }
  }
}

describe('Run Kernel Conformance catalog', () => {
  it('keeps every required local, chaos, resource, and remote oracle explicit and unique', () => {
    const ids = RUN_KERNEL_CONFORMANCE.map((definition) => definition.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(RUN_KERNEL_CONFORMANCE.map((definition) => definition.tier)).toEqual(expect.arrayContaining([
      'fast',
      'chaos',
      'resource',
      'remote'
    ]))
    expect(ids).toEqual(expect.arrayContaining([
      'create-operation-content-identity',
      'input-content-identity',
      'incarnation-fence',
      'ordered-input-output',
      'attach-release-replay-gap',
      'resize-readback',
      'stop-process-tree',
      'slow-consumer-budget',
      'release-resource-budget',
      'local-recovery',
      'ssh-partition-recovery'
    ]))
  })
})

registerRunKernelConformance({
  candidate: 'transitional agentmuxd adapter',
  createHarness: createAgentMuxdHarness,
  knownGaps: [
    'create-operation-content-identity',
    'input-content-identity'
  ],
  echoAgent: {
    command: process.execPath,
    args: (label) => [workloadPath, 'echo', label]
  }
})
