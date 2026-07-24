import { randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import {
  AgentMuxAcpBridge,
  type AgentMuxAcpBinding,
  type AgentMuxPermissionHandler
} from './acp-adapter.js'
import {
  AgentProviderRegistry,
  type AgentProvider
} from './agent-provider.js'
import { AgentMuxClientEventPublisher } from './client-event-publisher.js'
import { AgentMuxDaemonClient } from './daemon-client.js'
import type {
  AgentMuxDaemonAttachResult,
  AgentMuxDaemonDataEvent,
  AgentMuxDaemonEvent,
  AgentMuxDaemonExitEvent,
  AgentMuxDaemonSession,
  AgentMuxDaemonSessionRef
} from './daemon-protocol.js'
import { AgentMuxError } from './errors.js'
import {
  AgentMuxMemoryAgentSessionStore,
  type AgentMuxAgentSessionStore
} from './agent-session-store.js'
import { AgentMuxAgentSessionRegistry } from './agent-session-registry.js'
import { projectAgentMuxViews, type AgentMuxWorkspaceView } from './runtime.js'
import type {
  AgentCapabilitySnapshot,
  AgentCatalogEntry,
  AgentId,
  AgentMuxClientEvent,
  AgentMuxAgentSession,
  AgentNativeSessionHandle,
  AgentMuxRun,
  AgentMuxRunAppliedSize,
  AgentMuxRunAttachment,
  AgentMuxRunDataEvent,
  AgentMuxRunExitEvent,
  AgentMuxRunInputAck,
  AgentMuxRunOutputAck,
  AgentMuxRunRef,
  AgentMuxRuntimeDiagnostics,
  AgentMuxRuntimeIdentity,
  NativeHookEnvelope
} from './types.js'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export type AgentMuxAgentCreateInput = {
  agentSessionId?: string
  runId?: string
  createOperationId?: string
  agentId: AgentId
  workspacePath: string
  prompt?: string
  args?: readonly string[]
  env?: Readonly<Record<string, string>>
  commandOverride?: string
  cols?: number
  rows?: number
}

export type AgentMuxTerminalCreateInput = {
  runId: string
  createOperationId: string
  workspacePath: string
  cols?: number
  rows?: number
  env?: Readonly<Record<string, string>>
}

export type AgentMuxAgentResumeInput = {
  agentSessionId: string
  runId?: string
  createOperationId?: string
  args?: readonly string[]
  env?: Readonly<Record<string, string>>
  commandOverride?: string
  cols?: number
  rows?: number
}

export type AgentMuxAgentRespawnInput = Omit<
  AgentMuxAgentCreateInput,
  'agentId' | 'workspacePath' | 'agentSessionId'
> & {
  previousAgentSessionId: string
  agentSessionId?: string
}

export type AgentMuxAgentAttachment = {
  session: AgentMuxAgentSession
  attachment: AgentMuxRunAttachment
}

export type AgentMuxClientConnector = {
  readonly expectedHostId?: string
  readonly expectedBuildIdentity?: string
  connect(): Promise<Duplex>
}

export type AgentMuxClientOptions = {
  providers?: readonly AgentProvider[]
  store?: AgentMuxAgentSessionStore
  permissionHandler?: AgentMuxPermissionHandler
  socketPath?: string
  connector?: AgentMuxClientConnector
  expectedHostId?: string
  expectedBuildIdentity?: string
}

function safeId(value: string, name: string): string {
  if (!SAFE_ID.test(value)) {
    throw new AgentMuxError(`${name} must contain only letters, numbers, underscore, or dash.`, 'INVALID_SESSION_ID')
  }
  return value
}

function cloneSession(session: AgentMuxAgentSession): AgentMuxAgentSession {
  return structuredClone(session)
}

function daemonRunRef(ref: AgentMuxRunRef): AgentMuxDaemonSessionRef {
  return { sessionId: ref.runId, incarnationId: ref.incarnationId }
}

function runRef(session: { sessionId: string; incarnationId: string }): AgentMuxRunRef {
  return { runId: session.sessionId, incarnationId: session.incarnationId }
}

function projectRun(session: AgentMuxDaemonSession): AgentMuxRun {
  return {
    runId: session.sessionId,
    incarnationId: session.incarnationId,
    createOperationId: session.createOperationId,
    kind: session.kind,
    agentId: session.agentId,
    agentSessionId: session.agentSessionId,
    workspacePath: session.cwd,
    pid: session.pid,
    ...(session.processStartedAt === undefined ? {} : { processStartedAt: session.processStartedAt }),
    state: session.state,
    cols: session.cols,
    rows: session.rows,
    createdAt: session.createdAt,
    latestOutputBytes: session.latestSequence,
    acceptedInputBytes: session.acceptedInputSequence,
    ...(session.exitedAt === undefined ? {} : { exitedAt: session.exitedAt }),
    ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
    ...(session.exitSignal === undefined ? {} : { exitSignal: session.exitSignal }),
    ...(session.lostAt === undefined ? {} : { lostAt: session.lostAt }),
    ...(session.lostReason === undefined ? {} : { lostReason: session.lostReason })
  }
}

function projectRunData(event: AgentMuxDaemonDataEvent): AgentMuxRunDataEvent {
  return {
    type: 'data',
    ...runRef(event),
    startByte: event.startSequence,
    endByte: event.endSequence,
    data: event.data
  }
}

function projectRunExit(event: AgentMuxDaemonExitEvent): AgentMuxRunExitEvent {
  return {
    type: 'exit',
    ...runRef(event),
    pid: event.pid,
    exitCode: event.exitCode,
    ...(event.exitSignal === undefined ? {} : { exitSignal: event.exitSignal }),
    observedAt: event.observedAt
  }
}

function projectAttachment(attached: AgentMuxDaemonAttachResult): AgentMuxRunAttachment {
  return {
    run: projectRun(attached.session),
    replay: attached.replay.map(projectRunData),
    gap: attached.gap
      ? {
          requestedAfterByte: attached.gap.requestedAfterSequence,
          firstAvailableByte: attached.gap.firstAvailableSequence
        }
      : null
  }
}

function projectInputAck(ack: {
  sessionId: string
  incarnationId: string
  acceptedThrough: number
  duplicate: boolean
}): AgentMuxRunInputAck {
  return { ...runRef(ack), acceptedThroughByte: ack.acceptedThrough, duplicate: ack.duplicate }
}

function projectOutputAck(ack: {
  sessionId: string
  incarnationId: string
  acknowledgedThrough: number
}): AgentMuxRunOutputAck {
  return { ...runRef(ack), acknowledgedThroughByte: ack.acknowledgedThrough }
}

function projectAppliedSize(size: {
  sessionId: string
  incarnationId: string
  cols: number
  rows: number
}): AgentMuxRunAppliedSize {
  return { ...runRef(size), cols: size.cols, rows: size.rows }
}

function matchesRun(session: { sessionId: string; incarnationId: string }, ref: AgentMuxRunRef): boolean {
  return session.sessionId === ref.runId && session.incarnationId === ref.incarnationId
}

export class AgentMuxClient {
  readonly providers: AgentProviderRegistry
  private readonly kernel: AgentMuxDaemonClient
  private readonly registry: AgentMuxAgentSessionRegistry
  private readonly publisher = new AgentMuxClientEventPublisher()
  private readonly acp: AgentMuxAcpBridge
  private unsubscribeKernel: (() => void) | null = null
  private connecting: Promise<void> | null = null
  private connectionEpoch = 0
  private connected = false

  constructor(options: AgentMuxClientOptions = {}) {
    const {
      providers,
      store,
      permissionHandler,
      ...daemonOptions
    } = options
    this.providers = new AgentProviderRegistry(providers)
    this.registry = new AgentMuxAgentSessionRegistry(store ?? new AgentMuxMemoryAgentSessionStore())
    this.kernel = new AgentMuxDaemonClient(daemonOptions)
    this.acp = new AgentMuxAcpBridge(
      {
        onEvent: (agentSessionId, event, evidence) => {
          const session = this.registry.get(agentSessionId)
          this.publisher.publishAcp(agentSessionId, event, {
            ...evidence,
            run: { ...session.run }
          })
        },
        onNativeHandle: async (agentSessionId, handle) => {
          await this.updateNativeHandle(agentSessionId, handle)
        }
      },
      permissionHandler
    )
  }

  async connect(): Promise<void> {
    if (this.connected && this.kernel.isConnected()) return
    this.connected = false
    if (this.connecting) return await this.connecting
    const attempt = this.open(this.connectionEpoch)
    this.connecting = attempt
    try {
      await attempt
    } finally {
      if (this.connecting === attempt) this.connecting = null
    }
  }

  private async open(epoch: number): Promise<void> {
    await this.kernel.connect()
    try {
      this.assertConnectionEpoch(epoch)
      const hostId = this.kernel.daemonIdentity().hostId
      await this.registry.load(hostId)
      await this.synchronizeAgentRuns(hostId)
      this.assertConnectionEpoch(epoch)
      this.unsubscribeKernel?.()
      this.unsubscribeKernel = this.kernel.onEvent((event) => this.acceptKernelEvent(event))
      this.connected = true
    } catch (error) {
      this.kernel.disconnect()
      throw error
    }
  }

  disconnect(): void {
    this.connectionEpoch += 1
    this.connected = false
    this.connecting = null
    this.unsubscribeKernel?.()
    this.unsubscribeKernel = null
    this.kernel.disconnect()
  }

  async dispose(): Promise<void> {
    this.disconnect()
    await this.acp.dispose()
    this.publisher.dispose()
  }

  onEvent(listener: (event: AgentMuxClientEvent) => unknown): () => void {
    return this.publisher.onEvent(listener)
  }

  catalog(): AgentCatalogEntry[] {
    return this.providers.catalog()
  }

  agentSessions(): AgentMuxAgentSession[] {
    return this.registry.list()
  }

  agentSession(agentSessionId: string): AgentMuxAgentSession {
    return cloneSession(this.registry.get(agentSessionId))
  }

  runtimeIdentity(): AgentMuxRuntimeIdentity {
    const identity = this.kernel.daemonIdentity()
    return {
      hostId: identity.hostId,
      buildIdentity: identity.buildIdentity,
      protocolVersion: identity.protocolVersion,
      processId: identity.daemonPid,
      instanceId: identity.daemonInstanceId
    }
  }

  async runtimeDiagnostics(): Promise<AgentMuxRuntimeDiagnostics> {
    this.requireConnected()
    return structuredClone(await this.kernel.diagnose())
  }

  async probeAgent(agentId: AgentId, commandOverride?: string): Promise<AgentCapabilitySnapshot> {
    this.requireConnected()
    return await this.providers.get(agentId).probeCapabilities(
      { hasExecutable: async (executable) => await this.kernel.probeExecutable(executable) },
      commandOverride
    )
  }

  async listRuns(): Promise<AgentMuxRun[]> {
    this.requireConnected()
    return (await this.kernel.listSessions()).map(projectRun)
  }

  async workspaceView(): Promise<AgentMuxWorkspaceView> {
    this.requireConnected()
    const hostId = this.kernel.daemonIdentity().hostId
    return {
      hostId,
      views: projectAgentMuxViews(
        hostId,
        (await this.kernel.listSessions()).map(projectRun),
        this.registry.list()
      )
    }
  }

  async createTerminal(input: AgentMuxTerminalCreateInput): Promise<AgentMuxRun> {
    this.requireConnected()
    const run = await this.kernel.createTerminal({
      sessionId: input.runId,
      createOperationId: input.createOperationId,
      cwd: input.workspacePath,
      ...(input.cols === undefined ? {} : { cols: input.cols }),
      ...(input.rows === undefined ? {} : { rows: input.rows }),
      ...(input.env === undefined ? {} : { env: input.env })
    })
    this.emitProcessState(run)
    return projectRun(run)
  }

  async attachTerminal(runId: string, afterByte = 0): Promise<AgentMuxRunAttachment> {
    this.requireConnected()
    const attached = await this.kernel.attach(runId, afterByte)
    if (attached.session.kind !== 'terminal' || attached.session.agentSessionId !== null) {
      throw new AgentMuxError('Requested run is not a Raw Terminal.', 'SESSION_KIND_MISMATCH')
    }
    this.emitProcessState(attached.session)
    return projectAttachment(attached)
  }

  async releaseTerminalAttachment(ref: AgentMuxRunRef): Promise<void> {
    this.requireConnected()
    await this.kernel.detach(daemonRunRef(ref))
  }

  async writeTerminal(ref: AgentMuxRunRef, data: string): Promise<AgentMuxRunInputAck> {
    this.requireConnected()
    return projectInputAck(await this.kernel.write(daemonRunRef(ref), data))
  }

  async resizeTerminal(ref: AgentMuxRunRef, cols: number, rows: number): Promise<AgentMuxRunAppliedSize> {
    this.requireConnected()
    return projectAppliedSize(await this.kernel.resize(daemonRunRef(ref), cols, rows))
  }

  async acknowledgeTerminalOutput(ref: AgentMuxRunRef, throughByte: number): Promise<AgentMuxRunOutputAck> {
    this.requireConnected()
    return projectOutputAck(await this.kernel.acknowledgeOutput(daemonRunRef(ref), throughByte))
  }

  async signalTerminal(ref: AgentMuxRunRef, signal: string): Promise<void> {
    this.requireConnected()
    await this.kernel.signal(daemonRunRef(ref), signal)
  }

  async stopTerminal(ref: AgentMuxRunRef): Promise<void> {
    this.requireConnected()
    await this.kernel.stop(daemonRunRef(ref))
    this.publisher.publish({
      type: 'run-removed',
      run: { ...ref },
      evidence: { source: 'user', observedAt: Date.now(), run: { ...ref } }
    })
  }

  async createAgent(input: AgentMuxAgentCreateInput): Promise<AgentMuxAgentSession> {
    this.requireConnected()
    const agentSessionId = safeId(input.agentSessionId ?? randomUUID(), 'Agent Session id')
    const runId = safeId(input.runId ?? agentSessionId, 'Run id')
    const createOperationId = safeId(input.createOperationId ?? randomUUID(), 'Create operation id')
    const release = this.registry.reserveNew(agentSessionId)
    try {
      const provider = this.providers.get(input.agentId)
      const capability = await this.probeAgent(input.agentId, input.commandOverride)
      if (!capability.installed) {
        throw new AgentMuxError(`${provider.label} is not installed on this host.`, 'AGENT_NOT_FOUND')
      }
      const plan = provider.buildLaunch({
        workspacePath: input.workspacePath,
        prompt: input.prompt ?? '',
        args: input.args ?? [],
        env: input.env ?? {},
        ...(input.commandOverride === undefined ? {} : { commandOverride: input.commandOverride })
      })
      const run = await this.kernel.createAgent({
        agentSessionId,
        sessionId: runId,
        createOperationId,
        agentId: input.agentId,
        command: plan.command,
        args: plan.args,
        env: plan.env,
        cwd: input.workspacePath,
        ...(input.cols === undefined ? {} : { cols: input.cols }),
        ...(input.rows === undefined ? {} : { rows: input.rows })
      })
      const now = Date.now()
      const session: AgentMuxAgentSession = {
        kind: 'agent',
        agentSessionId,
        agentId: input.agentId,
        hostId: this.kernel.daemonIdentity().hostId,
        workspacePath: input.workspacePath,
        run: runRef(run),
        outputCursorBytes: 0,
        createdAt: now,
        updatedAt: now
      }
      try {
        await this.registry.put(session)
      } catch (error) {
        try {
          await this.kernel.stop(run)
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Agent Session persistence and Run rollback both failed.')
        }
        throw error
      }
      this.publisher.publish({ type: 'agent-session', session: cloneSession(session) })
      this.emitProcessState(run, agentSessionId)
      if (input.prompt?.trim()) {
        this.publisher.publish({
          type: 'agent-activity',
          agentSessionId,
          activity: {
            id: randomUUID(),
            kind: 'prompt',
            createdAt: now,
            title: 'Initial prompt',
            content: input.prompt.trim()
          },
          evidence: { source: 'user', observedAt: now, run: { ...session.run } }
        })
      }
      return cloneSession(session)
    } finally {
      release()
    }
  }

  async reattachAgent(
    agentSessionId: string,
    afterByte?: number
  ): Promise<AgentMuxAgentAttachment> {
    this.requireConnected()
    const session = this.requireAgentSession(agentSessionId)
    const attached = await this.kernel.attach(
      session.run.runId,
      afterByte ?? session.outputCursorBytes
    )
    if (
      attached.session.kind !== 'agent' ||
      attached.session.agentId !== session.agentId ||
      attached.session.agentSessionId !== session.agentSessionId ||
      !matchesRun(attached.session, session.run)
    ) {
      throw new AgentMuxError('Run no longer matches the Agent Session.', 'AGENT_SESSION_RUN_MISMATCH')
    }
    this.emitProcessState(attached.session, session.agentSessionId)
    return { session: cloneSession(session), attachment: projectAttachment(attached) }
  }

  async releaseAgentAttachment(agentSessionId: string): Promise<void> {
    this.requireConnected()
    await this.kernel.detach(daemonRunRef(this.requireAgentSession(agentSessionId).run))
  }

  async resumeAgent(input: AgentMuxAgentResumeInput): Promise<AgentMuxAgentSession> {
    this.requireConnected()
    const current = this.requireAgentSession(input.agentSessionId)
    const release = this.registry.reserveExisting(current.agentSessionId)
    try {
      if (!current.nativeHandle || current.nativeHandle.kind !== 'provider') {
        throw new AgentMuxError('Provider-native resume requires a verified provider session handle.', 'AGENT_RESUME_UNAVAILABLE')
      }
      const oldRun = (await this.kernel.listSessions()).find(
        (run) => matchesRun(run, current.run)
      )
      if (oldRun?.state === 'running') {
        throw new AgentMuxError('Cannot resume while the original Run is still running.', 'AGENT_SESSION_STILL_RUNNING')
      }
      const provider = this.providers.get(current.agentId)
      const capability = await this.probeAgent(current.agentId, input.commandOverride)
      if (!capability.installed) {
        throw new AgentMuxError(`${provider.label} is not installed on this host.`, 'AGENT_NOT_FOUND')
      }
      const plan = provider.buildResumeLaunch({
        workspacePath: current.workspacePath,
        nativeHandle: current.nativeHandle,
        args: input.args ?? [],
        env: input.env ?? {},
        ...(input.commandOverride === undefined ? {} : { commandOverride: input.commandOverride })
      })
      const runId = safeId(input.runId ?? randomUUID(), 'Run id')
      const createOperationId = safeId(input.createOperationId ?? randomUUID(), 'Create operation id')
      if (oldRun) await this.kernel.stop(oldRun)
      const run = await this.kernel.createAgent({
        agentSessionId: current.agentSessionId,
        sessionId: runId,
        createOperationId,
        agentId: current.agentId,
        command: plan.command,
        args: plan.args,
        env: plan.env,
        cwd: current.workspacePath,
        ...(input.cols === undefined ? {} : { cols: input.cols }),
        ...(input.rows === undefined ? {} : { rows: input.rows })
      })
      const next: AgentMuxAgentSession = {
        ...current,
        run: runRef(run),
        outputCursorBytes: 0,
        updatedAt: Date.now(),
        nativeHandle: structuredClone(current.nativeHandle)
      }
      delete next.hookReceipt
      try {
        await this.registry.put(next, current.run)
      } catch (error) {
        try {
          await this.kernel.stop(run)
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Resume persistence and daemon rollback both failed.')
        }
        throw error
      }
      this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
      this.emitProcessState(run, next.agentSessionId)
      return cloneSession(next)
    } finally {
      release()
    }
  }

  async respawnAgent(input: AgentMuxAgentRespawnInput): Promise<AgentMuxAgentSession> {
    const previous = this.requireAgentSession(input.previousAgentSessionId)
    const agentSessionId = input.agentSessionId ?? randomUUID()
    if (agentSessionId === previous.agentSessionId) {
      throw new AgentMuxError('Respawn must create a new Agent Session identity.', 'AGENT_SESSION_ID_REUSE')
    }
    const {
      previousAgentSessionId: _previousAgentSessionId,
      ...launch
    } = input
    return await this.createAgent({
      ...launch,
      agentSessionId,
      agentId: previous.agentId,
      workspacePath: previous.workspacePath
    })
  }

  async writeAgent(agentSessionId: string, data: string): Promise<AgentMuxRunInputAck> {
    this.requireConnected()
    return projectInputAck(await this.kernel.write(
      daemonRunRef(this.requireAgentSession(agentSessionId).run),
      data
    ))
  }

  async submitAgentPrompt(agentSessionId: string, prompt: string): Promise<void> {
    this.requireConnected()
    const content = prompt.trim()
    if (!content) throw new AgentMuxError('Agent prompt cannot be empty.', 'INVALID_AGENT_PROMPT')
    const session = this.requireAgentSession(agentSessionId)
    await this.kernel.write(daemonRunRef(session.run), `${content}\r`)
    const observedAt = Date.now()
    this.publisher.publish({
      type: 'agent-activity',
      agentSessionId,
      activity: {
        id: randomUUID(),
        kind: 'prompt',
        createdAt: observedAt,
        title: 'Prompt',
        content
      },
      evidence: {
        source: 'user',
        observedAt,
        run: { ...session.run }
      }
    })
  }

  async resizeAgent(agentSessionId: string, cols: number, rows: number): Promise<AgentMuxRunAppliedSize> {
    this.requireConnected()
    return projectAppliedSize(await this.kernel.resize(
      daemonRunRef(this.requireAgentSession(agentSessionId).run),
      cols,
      rows
    ))
  }

  async signalAgent(agentSessionId: string, signal: string): Promise<void> {
    this.requireConnected()
    await this.kernel.signal(daemonRunRef(this.requireAgentSession(agentSessionId).run), signal)
  }

  async acknowledgeAgentOutput(agentSessionId: string, throughByte: number): Promise<void> {
    this.requireConnected()
    const session = this.requireAgentSession(agentSessionId)
    await this.kernel.acknowledgeOutput(daemonRunRef(session.run), throughByte)
    await this.registry.put(
      { ...session, outputCursorBytes: throughByte, updatedAt: Date.now() },
      session.run
    )
  }

  async stopAgent(agentSessionId: string): Promise<void> {
    this.requireConnected()
    const session = this.requireAgentSession(agentSessionId)
    const release = this.registry.reserveExisting(agentSessionId)
    try {
      const run = (await this.kernel.listSessions()).find((candidate) => (
        matchesRun(candidate, session.run)
      ))
      if (run) await this.kernel.stop(run)
      const cleanup = await Promise.allSettled([
        this.acp.unbind(agentSessionId),
        this.registry.delete(agentSessionId, session.run)
      ])
      if (cleanup[1]?.status === 'fulfilled') {
        this.publisher.publish({
          type: 'run-removed',
          agentSessionId,
          run: { ...session.run },
          evidence: {
            source: 'user',
            observedAt: Date.now(),
            run: { ...session.run }
          }
        })
      }
      const errors = cleanup.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length > 0) throw new AggregateError(errors, 'Agent stopped but Agent Session cleanup failed.')
    } finally {
      release()
    }
  }

  async bindAcp(agentSessionId: string, binding: AgentMuxAcpBinding): Promise<void> {
    this.requireConnected()
    const session = this.requireAgentSession(agentSessionId)
    const release = this.registry.reserveExisting(agentSessionId)
    try {
      if (this.providers.get(session.agentId).catalog.acpStrategy.kind !== 'adapter') {
        throw new AgentMuxError('Provider does not declare an ACP adapter.', 'ACP_UNSUPPORTED')
      }
      await this.acp.bind(agentSessionId, binding)
    } finally {
      release()
    }
  }

  private requireConnected(): void {
    if (!this.connected || !this.kernel.isConnected()) {
      throw new AgentMuxError('AgentMux client is not connected.', 'DAEMON_DISCONNECTED')
    }
  }

  private async synchronizeAgentRuns(hostId: string): Promise<void> {
    for (const run of await this.kernel.listSessions()) {
      if (run.kind !== 'agent') continue
      if (!run.agentId || !run.agentSessionId) {
        throw new AgentMuxError('Agent Run is missing Agent Session identity.', 'SESSION_KIND_MISMATCH')
      }
      if (this.registry.has(run.agentSessionId)) {
        const agentSession = this.registry.get(run.agentSessionId)
        if (!matchesRun(run, agentSession.run)) {
          throw new AgentMuxError(
            'Persisted Agent Session points to another Run.',
            'AGENT_SESSION_RUN_MISMATCH'
          )
        }
        continue
      }
      const observedAt = run.exitedAt ?? run.lostAt ?? run.createdAt
      await this.registry.put({
        kind: 'agent',
        agentSessionId: run.agentSessionId,
        agentId: run.agentId,
        hostId,
        workspacePath: run.cwd,
        run: runRef(run),
        outputCursorBytes: 0,
        createdAt: run.createdAt,
        updatedAt: observedAt
      })
    }
  }

  private assertConnectionEpoch(epoch: number): void {
    if (epoch !== this.connectionEpoch) {
      throw new AgentMuxError('AgentMux client connection was cancelled.', 'DAEMON_DISCONNECTED')
    }
  }

  private requireAgentSession(agentSessionId: string): AgentMuxAgentSession {
    return this.registry.get(agentSessionId)
  }

  private acceptKernelEvent(event: AgentMuxDaemonEvent): void {
    const agentSession = this.registry.findByRun(runRef(event))
    if (event.type !== 'hook') {
      this.publisher.publishRunEvent(
        event.type === 'data' ? projectRunData(event) : projectRunExit(event),
        agentSession
      )
      return
    }
    void this.acceptHookEvent(event).catch((error) => {
      this.publisher.publish({
        type: 'agent-error',
        agentSessionId: event.agentSessionId,
        code: error instanceof AgentMuxError ? error.code : 'AGENT_HOOK_FAILED',
        message: error instanceof Error ? error.message : String(error),
        evidence: {
          source: 'native-hook',
          observedAt: Date.now(),
          run: runRef(event)
        }
      })
    })
  }

  private async acceptHookEvent(event: Extract<AgentMuxDaemonEvent, { type: 'hook' }>): Promise<void> {
    const session = this.registry.findByRun(runRef(event))
    if (
      !session ||
      session.agentSessionId !== event.agentSessionId ||
      session.agentId !== event.agentId
    ) {
      return
    }
    const envelope: NativeHookEnvelope = {
      agentSessionId: event.agentSessionId,
      runId: event.sessionId,
      incarnationId: event.incarnationId,
      agentId: event.agentId,
      ...(event.eventName === undefined ? {} : { eventName: event.eventName }),
      ...(event.payload === undefined ? {} : { payload: event.payload })
    }
    const normalized = this.providers.get(event.agentId).normalizeHook(envelope)
    const receipt = {
      id: randomUUID(),
      agentId: session.agentId,
      agentSessionId: session.agentSessionId,
      run: { ...session.run },
      eventName: normalized.eventName,
      observedAt: normalized.status.observedAt
    }
    const next: AgentMuxAgentSession = {
      ...session,
      updatedAt: normalized.status.observedAt,
      hookReceipt: receipt,
      ...(normalized.nativeHandle ? { nativeHandle: normalized.nativeHandle } : {})
    }
    await this.registry.put(next, session.run)
    this.publisher.publishHook(session, normalized, receipt)
    this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
  }

  private async updateNativeHandle(
    agentSessionId: string,
    handle: AgentNativeSessionHandle
  ): Promise<void> {
    const session = this.requireAgentSession(agentSessionId)
    const next: AgentMuxAgentSession = {
      ...session,
      nativeHandle: handle,
      updatedAt: Date.now()
    }
    await this.registry.put(next, session.run)
    this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
  }

  private emitProcessState(run: AgentMuxDaemonSession, agentSessionId?: string): void {
    this.publisher.publishRunState(projectRun(run), agentSessionId)
  }
}
