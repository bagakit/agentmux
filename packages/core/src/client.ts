import { randomUUID } from 'node:crypto'
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
import {
  AgentMuxDaemonClient,
  type AgentMuxDaemonClientOptions,
  type AgentMuxDaemonTerminalCreateInput
} from './daemon-client.js'
import type {
  AgentMuxDaemonAttachResult,
  AgentMuxDaemonEvent,
  AgentMuxDaemonSession,
  AgentMuxDaemonSessionRef
} from './daemon-protocol.js'
import { AgentMuxError } from './errors.js'
import {
  AgentMuxMemorySemanticStore,
  type AgentMuxSemanticStore
} from './semantic-store.js'
import { AgentMuxSemanticSessionRegistry } from './semantic-session-registry.js'
import { projectAgentMuxSessions, type AgentMuxRuntimeSnapshot } from './runtime.js'
import type {
  AgentCapabilitySnapshot,
  AgentCatalogEntry,
  AgentId,
  AgentMuxClientEvent,
  AgentMuxSemanticSession,
  AgentNativeSessionHandle,
  NativeHookEnvelope
} from './types.js'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export type AgentMuxAgentCreateInput = {
  semanticSessionId?: string
  daemonSessionId?: string
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

export type AgentMuxTerminalCreateInput = AgentMuxDaemonTerminalCreateInput

export type AgentMuxAgentResumeInput = {
  semanticSessionId: string
  daemonSessionId?: string
  createOperationId?: string
  args?: readonly string[]
  env?: Readonly<Record<string, string>>
  commandOverride?: string
  cols?: number
  rows?: number
}

export type AgentMuxAgentRespawnInput = Omit<
  AgentMuxAgentCreateInput,
  'agentId' | 'workspacePath' | 'semanticSessionId'
> & {
  previousSemanticSessionId: string
  semanticSessionId?: string
}

export type AgentMuxSemanticAttachResult = {
  session: AgentMuxSemanticSession
  run: AgentMuxDaemonAttachResult
}

export type AgentMuxClientOptions = AgentMuxDaemonClientOptions & {
  providers?: readonly AgentProvider[]
  store?: AgentMuxSemanticStore
  permissionHandler?: AgentMuxPermissionHandler
}

function safeId(value: string, name: string): string {
  if (!SAFE_ID.test(value)) {
    throw new AgentMuxError(`${name} must contain only letters, numbers, underscore, or dash.`, 'INVALID_SESSION_ID')
  }
  return value
}

function cloneSession(session: AgentMuxSemanticSession): AgentMuxSemanticSession {
  return structuredClone(session)
}

function runRef(session: { sessionId: string; incarnationId: string }): AgentMuxDaemonSessionRef {
  return { sessionId: session.sessionId, incarnationId: session.incarnationId }
}

function sameRun(
  left: { sessionId: string; incarnationId: string },
  right: { sessionId: string; incarnationId: string }
): boolean {
  return left.sessionId === right.sessionId && left.incarnationId === right.incarnationId
}

export class AgentMuxClient {
  readonly providers: AgentProviderRegistry
  private readonly daemon: AgentMuxDaemonClient
  private readonly registry: AgentMuxSemanticSessionRegistry
  private readonly publisher = new AgentMuxClientEventPublisher()
  private readonly acp: AgentMuxAcpBridge
  private unsubscribeDaemon: (() => void) | null = null
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
    this.registry = new AgentMuxSemanticSessionRegistry(store ?? new AgentMuxMemorySemanticStore())
    this.daemon = new AgentMuxDaemonClient(daemonOptions)
    this.acp = new AgentMuxAcpBridge(
      {
        onEvent: (semanticSessionId, event, evidence) => {
          this.publisher.publishAcp(semanticSessionId, event, evidence)
        },
        onNativeHandle: async (semanticSessionId, handle) => {
          await this.updateNativeHandle(semanticSessionId, handle)
        }
      },
      permissionHandler
    )
  }

  async connect(): Promise<void> {
    if (this.connected && this.daemon.isConnected()) return
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
    await this.daemon.connect()
    try {
      this.assertConnectionEpoch(epoch)
      const hostId = this.daemon.daemonIdentity().hostId
      await this.registry.load(hostId)
      await this.synchronizeAgentRuns(hostId)
      this.assertConnectionEpoch(epoch)
      this.unsubscribeDaemon?.()
      this.unsubscribeDaemon = this.daemon.onEvent((event) => this.acceptDaemonEvent(event))
      this.connected = true
    } catch (error) {
      this.daemon.disconnect()
      throw error
    }
  }

  disconnect(): void {
    this.connectionEpoch += 1
    this.connected = false
    this.connecting = null
    this.unsubscribeDaemon?.()
    this.unsubscribeDaemon = null
    this.daemon.disconnect()
  }

  async dispose(): Promise<void> {
    this.disconnect()
    await this.acp.dispose()
    this.publisher.dispose()
  }

  onEvent(listener: (event: AgentMuxClientEvent) => void): () => void {
    return this.publisher.onEvent(listener)
  }

  catalog(): AgentCatalogEntry[] {
    return this.providers.catalog()
  }

  semanticSessions(): AgentMuxSemanticSession[] {
    return this.registry.list()
  }

  semanticSession(semanticSessionId: string): AgentMuxSemanticSession {
    return cloneSession(this.registry.get(semanticSessionId))
  }

  daemonIdentity() {
    return this.daemon.daemonIdentity()
  }

  async daemonDiagnostics() {
    this.requireConnected()
    return await this.daemon.diagnose()
  }

  async probeAgent(agentId: AgentId, commandOverride?: string): Promise<AgentCapabilitySnapshot> {
    this.requireConnected()
    return await this.providers.get(agentId).probeCapabilities(
      { hasExecutable: async (executable) => await this.daemon.probeExecutable(executable) },
      commandOverride
    )
  }

  async listRuns(): Promise<AgentMuxDaemonSession[]> {
    this.requireConnected()
    return await this.daemon.listSessions()
  }

  async snapshot(): Promise<AgentMuxRuntimeSnapshot> {
    this.requireConnected()
    const hostId = this.daemon.daemonIdentity().hostId
    return {
      hostId,
      sessions: projectAgentMuxSessions(hostId, await this.daemon.listSessions(), this.registry.list())
    }
  }

  async createTerminal(input: AgentMuxTerminalCreateInput): Promise<AgentMuxDaemonSession> {
    this.requireConnected()
    const run = await this.daemon.createTerminal(input)
    this.emitProcessState(run)
    return run
  }

  async attachTerminal(sessionId: string, afterSequence = 0): Promise<AgentMuxDaemonAttachResult> {
    this.requireConnected()
    const attached = await this.daemon.attach(sessionId, afterSequence)
    if (attached.session.kind !== 'terminal' || attached.session.semanticSessionId !== null) {
      throw new AgentMuxError('Requested run is not a Raw Terminal.', 'SESSION_KIND_MISMATCH')
    }
    this.emitProcessState(attached.session)
    return attached
  }

  async detachTerminal(ref: AgentMuxDaemonSessionRef): Promise<void> {
    this.requireConnected()
    await this.daemon.detach(ref)
  }

  async writeTerminal(ref: AgentMuxDaemonSessionRef, data: string) {
    this.requireConnected()
    return await this.daemon.write(ref, data)
  }

  async resizeTerminal(ref: AgentMuxDaemonSessionRef, cols: number, rows: number) {
    this.requireConnected()
    return await this.daemon.resize(ref, cols, rows)
  }

  async acknowledgeTerminalOutput(ref: AgentMuxDaemonSessionRef, sequence: number) {
    this.requireConnected()
    return await this.daemon.acknowledgeOutput(ref, sequence)
  }

  async signalTerminal(ref: AgentMuxDaemonSessionRef, signal: string): Promise<void> {
    this.requireConnected()
    await this.daemon.signal(ref, signal)
  }

  async stopTerminal(ref: AgentMuxDaemonSessionRef): Promise<void> {
    this.requireConnected()
    await this.daemon.stop(ref)
    this.publisher.publish({
      type: 'session-removed',
      daemonSession: { ...ref },
      evidence: { source: 'user', observedAt: Date.now(), daemonSession: { ...ref } }
    })
  }

  async createAgent(input: AgentMuxAgentCreateInput): Promise<AgentMuxSemanticSession> {
    this.requireConnected()
    const semanticSessionId = safeId(input.semanticSessionId ?? randomUUID(), 'Semantic session id')
    const daemonSessionId = safeId(input.daemonSessionId ?? semanticSessionId, 'Daemon session id')
    const createOperationId = safeId(input.createOperationId ?? randomUUID(), 'Create operation id')
    const release = this.registry.reserveNew(semanticSessionId)
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
      const run = await this.daemon.createAgent({
        semanticSessionId,
        sessionId: daemonSessionId,
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
      const session: AgentMuxSemanticSession = {
        kind: 'agent',
        semanticSessionId,
        agentId: input.agentId,
        hostId: this.daemon.daemonIdentity().hostId,
        workspacePath: input.workspacePath,
        daemonSession: runRef(run),
        outputCursor: 0,
        createdAt: now,
        updatedAt: now
      }
      try {
        await this.registry.put(session)
      } catch (error) {
        try {
          await this.daemon.stop(run)
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Semantic persistence and daemon rollback both failed.')
        }
        throw error
      }
      this.publisher.publish({ type: 'semantic-session', session: cloneSession(session) })
      this.emitProcessState(run, semanticSessionId)
      if (input.prompt?.trim()) {
        this.publisher.publish({
          type: 'semantic-activity',
          semanticSessionId,
          activity: {
            id: randomUUID(),
            kind: 'prompt',
            createdAt: now,
            title: 'Initial prompt',
            content: input.prompt.trim()
          },
          evidence: { source: 'user', observedAt: now, daemonSession: { ...session.daemonSession } }
        })
      }
      return cloneSession(session)
    } finally {
      release()
    }
  }

  async reattachAgent(
    semanticSessionId: string,
    afterSequence?: number
  ): Promise<AgentMuxSemanticAttachResult> {
    this.requireConnected()
    const session = this.requireSemanticSession(semanticSessionId)
    const attached = await this.daemon.attach(
      session.daemonSession.sessionId,
      afterSequence ?? session.outputCursor
    )
    if (
      attached.session.kind !== 'agent' ||
      attached.session.agentId !== session.agentId ||
      attached.session.semanticSessionId !== session.semanticSessionId ||
      !sameRun(attached.session, session.daemonSession)
    ) {
      throw new AgentMuxError('Daemon run no longer matches the semantic session.', 'SEMANTIC_RUN_MISMATCH')
    }
    this.emitProcessState(attached.session, session.semanticSessionId)
    return { session: cloneSession(session), run: attached }
  }

  async detachAgent(semanticSessionId: string): Promise<void> {
    this.requireConnected()
    await this.daemon.detach(this.requireSemanticSession(semanticSessionId).daemonSession)
  }

  async resumeAgent(input: AgentMuxAgentResumeInput): Promise<AgentMuxSemanticSession> {
    this.requireConnected()
    const current = this.requireSemanticSession(input.semanticSessionId)
    const release = this.registry.reserveExisting(current.semanticSessionId)
    try {
      if (!current.nativeHandle || current.nativeHandle.kind !== 'provider') {
        throw new AgentMuxError('Provider-native resume requires a verified provider session handle.', 'AGENT_RESUME_UNAVAILABLE')
      }
      const oldRun = (await this.daemon.listSessions()).find(
        (run) => sameRun(run, current.daemonSession)
      )
      if (oldRun?.state === 'running') {
        throw new AgentMuxError('Cannot resume while the original daemon run is still running.', 'SEMANTIC_SESSION_STILL_RUNNING')
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
      const daemonSessionId = safeId(input.daemonSessionId ?? randomUUID(), 'Daemon session id')
      const createOperationId = safeId(input.createOperationId ?? randomUUID(), 'Create operation id')
      if (oldRun) await this.daemon.stop(oldRun)
      const run = await this.daemon.createAgent({
        semanticSessionId: current.semanticSessionId,
        sessionId: daemonSessionId,
        createOperationId,
        agentId: current.agentId,
        command: plan.command,
        args: plan.args,
        env: plan.env,
        cwd: current.workspacePath,
        ...(input.cols === undefined ? {} : { cols: input.cols }),
        ...(input.rows === undefined ? {} : { rows: input.rows })
      })
      const next: AgentMuxSemanticSession = {
        ...current,
        daemonSession: runRef(run),
        outputCursor: 0,
        updatedAt: Date.now(),
        nativeHandle: structuredClone(current.nativeHandle)
      }
      delete next.hookReceipt
      try {
        await this.registry.put(next, current.daemonSession)
      } catch (error) {
        try {
          await this.daemon.stop(run)
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Resume persistence and daemon rollback both failed.')
        }
        throw error
      }
      this.publisher.publish({ type: 'semantic-session', session: cloneSession(next) })
      this.emitProcessState(run, next.semanticSessionId)
      return cloneSession(next)
    } finally {
      release()
    }
  }

  async respawnAgent(input: AgentMuxAgentRespawnInput): Promise<AgentMuxSemanticSession> {
    const previous = this.requireSemanticSession(input.previousSemanticSessionId)
    const semanticSessionId = input.semanticSessionId ?? randomUUID()
    if (semanticSessionId === previous.semanticSessionId) {
      throw new AgentMuxError('Respawn must create a new semantic session identity.', 'SEMANTIC_ID_REUSE')
    }
    const {
      previousSemanticSessionId: _previousSemanticSessionId,
      ...launch
    } = input
    return await this.createAgent({
      ...launch,
      semanticSessionId,
      agentId: previous.agentId,
      workspacePath: previous.workspacePath
    })
  }

  async writeAgent(semanticSessionId: string, data: string) {
    this.requireConnected()
    return await this.daemon.write(this.requireSemanticSession(semanticSessionId).daemonSession, data)
  }

  async submitAgentPrompt(semanticSessionId: string, prompt: string): Promise<void> {
    this.requireConnected()
    const content = prompt.trim()
    if (!content) throw new AgentMuxError('Agent prompt cannot be empty.', 'INVALID_AGENT_PROMPT')
    const session = this.requireSemanticSession(semanticSessionId)
    await this.daemon.write(session.daemonSession, `${content}\r`)
    const observedAt = Date.now()
    this.publisher.publish({
      type: 'semantic-activity',
      semanticSessionId,
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
        daemonSession: { ...session.daemonSession }
      }
    })
  }

  async resizeAgent(semanticSessionId: string, cols: number, rows: number) {
    this.requireConnected()
    return await this.daemon.resize(this.requireSemanticSession(semanticSessionId).daemonSession, cols, rows)
  }

  async signalAgent(semanticSessionId: string, signal: string): Promise<void> {
    this.requireConnected()
    await this.daemon.signal(this.requireSemanticSession(semanticSessionId).daemonSession, signal)
  }

  async acknowledgeAgentOutput(semanticSessionId: string, sequence: number): Promise<void> {
    this.requireConnected()
    const session = this.requireSemanticSession(semanticSessionId)
    await this.daemon.acknowledgeOutput(session.daemonSession, sequence)
    await this.registry.put(
      { ...session, outputCursor: sequence, updatedAt: Date.now() },
      session.daemonSession
    )
  }

  async stopAgent(semanticSessionId: string): Promise<void> {
    this.requireConnected()
    const session = this.requireSemanticSession(semanticSessionId)
    const release = this.registry.reserveExisting(semanticSessionId)
    try {
      const run = (await this.daemon.listSessions()).find((candidate) => (
        sameRun(candidate, session.daemonSession)
      ))
      if (run) await this.daemon.stop(run)
      const cleanup = await Promise.allSettled([
        this.acp.unbind(semanticSessionId),
        this.registry.delete(semanticSessionId, session.daemonSession)
      ])
      if (cleanup[1]?.status === 'fulfilled') {
        this.publisher.publish({
          type: 'session-removed',
          semanticSessionId,
          daemonSession: { ...session.daemonSession },
          evidence: {
            source: 'user',
            observedAt: Date.now(),
            daemonSession: { ...session.daemonSession }
          }
        })
      }
      const errors = cleanup.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length > 0) throw new AggregateError(errors, 'Agent stopped but semantic cleanup failed.')
    } finally {
      release()
    }
  }

  async bindAcp(semanticSessionId: string, binding: AgentMuxAcpBinding): Promise<void> {
    this.requireConnected()
    const session = this.requireSemanticSession(semanticSessionId)
    const release = this.registry.reserveExisting(semanticSessionId)
    try {
      if (this.providers.get(session.agentId).catalog.acpStrategy.kind !== 'adapter') {
        throw new AgentMuxError('Provider does not declare an ACP adapter.', 'ACP_UNSUPPORTED')
      }
      await this.acp.bind(semanticSessionId, binding)
    } finally {
      release()
    }
  }

  private requireConnected(): void {
    if (!this.connected || !this.daemon.isConnected()) {
      throw new AgentMuxError('AgentMux client is not connected.', 'DAEMON_DISCONNECTED')
    }
  }

  private async synchronizeAgentRuns(hostId: string): Promise<void> {
    for (const run of await this.daemon.listSessions()) {
      if (run.kind !== 'agent') continue
      if (!run.agentId || !run.semanticSessionId) {
        throw new AgentMuxError('Agent run is missing semantic identity.', 'SESSION_KIND_MISMATCH')
      }
      if (this.registry.has(run.semanticSessionId)) {
        const semantic = this.registry.get(run.semanticSessionId)
        if (!sameRun(semantic.daemonSession, run)) {
          throw new AgentMuxError(
            'Persisted semantic session points to another daemon run.',
            'SEMANTIC_RUN_MISMATCH'
          )
        }
        continue
      }
      const observedAt = run.exitedAt ?? run.lostAt ?? run.createdAt
      await this.registry.put({
        kind: 'agent',
        semanticSessionId: run.semanticSessionId,
        agentId: run.agentId,
        hostId,
        workspacePath: run.cwd,
        daemonSession: runRef(run),
        outputCursor: 0,
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

  private requireSemanticSession(semanticSessionId: string): AgentMuxSemanticSession {
    return this.registry.get(semanticSessionId)
  }

  private acceptDaemonEvent(event: AgentMuxDaemonEvent): void {
    const semantic = this.registry.findByRun(event)
    if (event.type !== 'hook') {
      this.publisher.publishDaemonEvent(event, semantic)
      return
    }
    void this.acceptHookEvent(event).catch((error) => {
      this.publisher.publish({
        type: 'semantic-error',
        semanticSessionId: event.semanticSessionId,
        code: error instanceof AgentMuxError ? error.code : 'SEMANTIC_HOOK_FAILED',
        message: error instanceof Error ? error.message : String(error),
        evidence: {
          source: 'native-hook',
          observedAt: Date.now(),
          daemonSession: runRef(event)
        }
      })
    })
  }

  private async acceptHookEvent(event: Extract<AgentMuxDaemonEvent, { type: 'hook' }>): Promise<void> {
    const session = this.registry.findByRun(event)
    if (
      !session ||
      session.semanticSessionId !== event.semanticSessionId ||
      session.agentId !== event.agentId
    ) {
      return
    }
    const envelope: NativeHookEnvelope = {
      semanticSessionId: event.semanticSessionId,
      daemonSessionId: event.sessionId,
      incarnationId: event.incarnationId,
      agentId: event.agentId,
      ...(event.eventName === undefined ? {} : { eventName: event.eventName }),
      ...(event.payload === undefined ? {} : { payload: event.payload })
    }
    const normalized = this.providers.get(event.agentId).normalizeHook(envelope)
    const receipt = {
      id: randomUUID(),
      agentId: session.agentId,
      semanticSessionId: session.semanticSessionId,
      daemonSession: { ...session.daemonSession },
      eventName: normalized.eventName,
      observedAt: normalized.status.observedAt
    }
    const next: AgentMuxSemanticSession = {
      ...session,
      updatedAt: normalized.status.observedAt,
      hookReceipt: receipt,
      ...(normalized.nativeHandle ? { nativeHandle: normalized.nativeHandle } : {})
    }
    await this.registry.put(next, session.daemonSession)
    this.publisher.publishHook(session, normalized, receipt)
    this.publisher.publish({ type: 'semantic-session', session: cloneSession(next) })
  }

  private async updateNativeHandle(
    semanticSessionId: string,
    handle: AgentNativeSessionHandle
  ): Promise<void> {
    const session = this.requireSemanticSession(semanticSessionId)
    const next: AgentMuxSemanticSession = {
      ...session,
      nativeHandle: handle,
      updatedAt: Date.now()
    }
    await this.registry.put(next, session.daemonSession)
    this.publisher.publish({ type: 'semantic-session', session: cloneSession(next) })
  }

  private emitProcessState(run: AgentMuxDaemonSession, semanticSessionId?: string): void {
    this.publisher.publishProcessState(run, semanticSessionId)
  }
}
