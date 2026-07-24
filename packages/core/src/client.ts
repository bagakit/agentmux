import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
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
  CtxmuxRunAdapter,
  type CtxmuxAdapterEvent,
  type CtxmuxAdapterRun
} from './ctxmux-run-adapter.js'
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
  AgentMuxAgentSession,
  AgentMuxClientEvent,
  AgentMuxRun,
  AgentMuxRunAppliedSize,
  AgentMuxRunAttachment,
  AgentMuxRunDataEvent,
  AgentMuxRunInputAck,
  AgentMuxRunInputOperation,
  AgentMuxRunOutputAck,
  AgentMuxRunRef,
  AgentMuxRuntimeDiagnostics,
  AgentMuxRuntimeIdentity
} from './types.js'

export type AgentMuxAgentCreateInput = {
  agentSessionId?: string
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
  createOperationId?: string
  workspacePath: string
  command?: string
  args?: readonly string[]
  cols?: number
  rows?: number
  env?: Readonly<Record<string, string>>
}

export type AgentMuxAgentResumeInput = {
  agentSessionId: string
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

export type AgentMuxClientOptions = {
  providers?: readonly AgentProvider[]
  store?: AgentMuxAgentSessionStore
  permissionHandler?: AgentMuxPermissionHandler
}

function runRef(runId: string): AgentMuxRunRef {
  return { runId }
}

function sameRun(left: AgentMuxRunRef, right: AgentMuxRunRef): boolean {
  return left.runId === right.runId
}

function projectRun(
  run: CtxmuxAdapterRun,
  agentSession?: AgentMuxAgentSession
): AgentMuxRun {
  const observedAt = Date.now()
  return {
    runId: run.runId,
    kind: agentSession ? 'agent' : 'terminal',
    agentId: agentSession?.agentId ?? null,
    agentSessionId: agentSession?.agentSessionId ?? null,
    workspacePath: run.workspacePath ?? agentSession?.workspacePath ?? '',
    pid: run.pid,
    state: run.state.type,
    cols: run.cols,
    rows: run.rows,
    observedAt,
    latestOutputBytes: run.latestOutputBytes,
    acceptedInputBytes: run.acceptedInputBytes ?? 0,
    ...(run.state.type === 'exited'
      ? {
          exitCode: run.state.code,
          ...(run.state.signal === null ? {} : { exitSignal: run.state.signal })
        }
      : run.state.type === 'interrupted'
        ? { interruptionReason: run.state.reason }
        : {})
  }
}

async function hasExecutable(executable: string): Promise<boolean> {
  const candidates = isAbsolute(executable) || executable.includes('/')
    ? [executable]
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, executable))
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK)
      return true
    } catch {}
  }
  return false
}

function agentVerticalPending(): never {
  throw new AgentMuxError(
    'Agent Runs are unavailable in the Shell-first ctxmux checkpoint.',
    'AGENT_RUN_UNSUPPORTED'
  )
}

export class AgentMuxClient {
  readonly providers: AgentProviderRegistry
  private readonly kernel: CtxmuxRunAdapter
  private readonly registry: AgentMuxAgentSessionRegistry
  private readonly publisher = new AgentMuxClientEventPublisher()
  private readonly acp: AgentMuxAcpBridge
  private unsubscribeKernel: (() => void) | null = null
  private unsubscribeKernelErrors: (() => void) | null = null
  private connecting: Promise<void> | null = null
  private connectionEpoch = 0
  private connected = false
  private readonly runPids = new Map<string, number | null>()

  constructor(options: AgentMuxClientOptions = {}) {
    this.providers = new AgentProviderRegistry(options.providers)
    this.registry = new AgentMuxAgentSessionRegistry(
      options.store ?? new AgentMuxMemoryAgentSessionStore()
    )
    this.kernel = new CtxmuxRunAdapter()
    this.acp = new AgentMuxAcpBridge(
      {
        onEvent: (agentSessionId, event, evidence) => {
          const session = this.registry.get(agentSessionId)
          this.publisher.publishAcp(agentSessionId, event, {
            ...evidence,
            run: { ...session.run }
          })
        },
        onNativeHandle: async () => agentVerticalPending()
      },
      options.permissionHandler
    )
  }

  async connect(): Promise<void> {
    if (this.connected && this.kernel.isConnected()) return
    this.connected = false
    if (this.connecting) return await this.connecting
    const epoch = this.connectionEpoch
    const attempt = this.open(epoch)
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
      await this.registry.load('local')
      const runs = await this.kernel.list()
      for (const run of runs) this.runPids.set(run.runId, run.pid)
      this.assertConnectionEpoch(epoch)
      this.unsubscribeKernel?.()
      this.unsubscribeKernelErrors?.()
      this.unsubscribeKernel = this.kernel.onEvent((event) => this.acceptKernelEvent(event))
      this.unsubscribeKernelErrors = this.kernel.onError((error, runId) => {
        const agentSession = runId ? this.registry.findByRun(runRef(runId)) : undefined
        this.publisher.publish({
          type: 'agent-error',
          ...(agentSession ? { agentSessionId: agentSession.agentSessionId } : {}),
          code: error.code,
          message: error.message,
          evidence: {
            source: 'run-process',
            observedAt: Date.now(),
            ...(runId ? { run: runRef(runId) } : {})
          }
        })
      })
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
    this.unsubscribeKernelErrors?.()
    this.unsubscribeKernelErrors = null
    this.kernel.disconnect()
    this.runPids.clear()
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
    return structuredClone(this.registry.get(agentSessionId))
  }

  runtimeIdentity(): AgentMuxRuntimeIdentity {
    const identity = this.kernel.identity()
    return {
      hostId: 'local',
      buildIdentity: identity.buildIdentity,
      protocolVersion: identity.protocolVersion,
      processId: null,
      instanceId: identity.daemonInstanceId
    }
  }

  async runtimeDiagnostics(): Promise<AgentMuxRuntimeDiagnostics> {
    this.requireConnected()
    const identity = this.kernel.identity()
    return {
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      supported: process.platform === 'darwin' && process.arch === 'arm64',
      ctxmux: {
        version: '0.1.0',
        protocolVersion: identity.protocolVersion,
        sourceCommit: '3b94288c3a7896bb355e028135409c8e8bbaf764',
        artifactPlatform: `${process.platform}-${process.arch}`,
        ready: true
      }
    }
  }

  async probeAgent(agentId: AgentId, commandOverride?: string): Promise<AgentCapabilitySnapshot> {
    this.requireConnected()
    return await this.providers.get(agentId).probeCapabilities(
      { hasExecutable },
      commandOverride
    )
  }

  async listRuns(): Promise<AgentMuxRun[]> {
    this.requireConnected()
    return (await this.kernel.list()).map((run) => {
      this.runPids.set(run.runId, run.pid)
      return projectRun(run, this.registry.findByRun(runRef(run.runId)))
    })
  }

  async workspaceView(): Promise<AgentMuxWorkspaceView> {
    const runs = await this.listRuns()
    return {
      hostId: 'local',
      views: projectAgentMuxViews('local', runs, this.registry.list())
    }
  }

  async createTerminal(input: AgentMuxTerminalCreateInput): Promise<AgentMuxRun> {
    this.requireConnected()
    const run = await this.kernel.start({
      operationKey: input.createOperationId ?? randomUUID(),
      program: input.command ?? process.env.SHELL ?? '/bin/sh',
      args: input.args ?? [],
      cwd: input.workspacePath,
      ...(input.cols === undefined ? {} : { cols: input.cols }),
      ...(input.rows === undefined ? {} : { rows: input.rows }),
      ...(input.env === undefined ? {} : { env: input.env })
    })
    this.runPids.set(run.runId, run.pid)
    const projected = projectRun(run)
    this.publisher.publishRunState(projected)
    return projected
  }

  async attachTerminal(runId: string, afterByte = 0): Promise<AgentMuxRunAttachment> {
    this.requireConnected()
    const attached = await this.kernel.attach(runId, afterByte)
    if (this.registry.findByRun(runRef(runId))) {
      await this.kernel.detach(runId)
      throw new AgentMuxError('Requested Run belongs to an Agent Session.', 'RUN_KIND_MISMATCH')
    }
    this.runPids.set(runId, attached.run.pid)
    const run = projectRun(attached.run)
    this.publisher.publishRunState(run)
    return { run, replay: attached.replay, gap: attached.gap }
  }

  async releaseTerminalAttachment(ref: AgentMuxRunRef): Promise<void> {
    this.requireConnected()
    await this.kernel.detach(ref.runId)
  }

  async writeTerminal(
    ref: AgentMuxRunRef,
    operation: AgentMuxRunInputOperation
  ): Promise<AgentMuxRunInputAck> {
    this.requireConnected()
    const accepted = await this.kernel.input(ref.runId, operation)
    const acceptedThroughByte = accepted.run.acceptedInputBytes
    if (acceptedThroughByte === null) {
      throw new AgentMuxError('CtxMux omitted its accepted Input byte cursor.', 'CTXMUX_INPUT_CURSOR_MISSING')
    }
    return {
      runId: ref.runId,
      appliedByteRange: accepted.appliedByteRange,
      acceptedThroughByte
    }
  }

  async resizeTerminal(ref: AgentMuxRunRef, cols: number, rows: number): Promise<AgentMuxRunAppliedSize> {
    this.requireConnected()
    const applied = await this.kernel.resize(ref.runId, cols, rows)
    return { runId: ref.runId, cols: applied.cols, rows: applied.rows }
  }

  async acknowledgeTerminalOutput(ref: AgentMuxRunRef, throughByte: number): Promise<AgentMuxRunOutputAck> {
    this.requireConnected()
    const run = await this.kernel.status(ref.runId)
    if (!Number.isSafeInteger(throughByte) || throughByte < 0 || throughByte > run.latestOutputBytes) {
      throw new AgentMuxError('Output acknowledgement exceeds the authoritative CtxMux cursor.', 'INVALID_OUTPUT_CURSOR')
    }
    return { runId: ref.runId, acknowledgedThroughByte: throughByte }
  }

  async signalTerminal(ref: AgentMuxRunRef, signal: string): Promise<void> {
    this.requireConnected()
    if (signal !== 'SIGINT') {
      throw new AgentMuxError('CtxMux exposes only portable Interrupt.', 'SIGNAL_UNSUPPORTED')
    }
    await this.kernel.interrupt(ref.runId)
  }

  async stopTerminal(ref: AgentMuxRunRef): Promise<void> {
    this.requireConnected()
    await this.kernel.stop(ref.runId)
    this.runPids.delete(ref.runId)
    this.publisher.publish({
      type: 'run-removed',
      run: { ...ref },
      evidence: { source: 'user', observedAt: Date.now(), run: { ...ref } }
    })
  }

  async createAgent(_input: AgentMuxAgentCreateInput): Promise<AgentMuxAgentSession> {
    return agentVerticalPending()
  }

  async reattachAgent(_agentSessionId: string, _afterByte?: number): Promise<AgentMuxAgentAttachment> {
    return agentVerticalPending()
  }

  async releaseAgentAttachment(_agentSessionId: string): Promise<void> {
    return agentVerticalPending()
  }

  async resumeAgent(_input: AgentMuxAgentResumeInput): Promise<AgentMuxAgentSession> {
    return agentVerticalPending()
  }

  async respawnAgent(_input: AgentMuxAgentRespawnInput): Promise<AgentMuxAgentSession> {
    return agentVerticalPending()
  }

  async writeAgent(_agentSessionId: string, _data: string): Promise<AgentMuxRunInputAck> {
    return agentVerticalPending()
  }

  async submitAgentPrompt(_agentSessionId: string, _prompt: string): Promise<void> {
    return agentVerticalPending()
  }

  async resizeAgent(_agentSessionId: string, _cols: number, _rows: number): Promise<AgentMuxRunAppliedSize> {
    return agentVerticalPending()
  }

  async signalAgent(_agentSessionId: string, _signal: string): Promise<void> {
    return agentVerticalPending()
  }

  async acknowledgeAgentOutput(_agentSessionId: string, _throughByte: number): Promise<void> {
    return agentVerticalPending()
  }

  async stopAgent(_agentSessionId: string): Promise<void> {
    return agentVerticalPending()
  }

  async bindAcp(_agentSessionId: string, _binding: AgentMuxAcpBinding): Promise<void> {
    return agentVerticalPending()
  }

  private requireConnected(): void {
    if (!this.connected || !this.kernel.isConnected()) {
      throw new AgentMuxError('AgentMux client is not connected.', 'CTXMUX_DISCONNECTED')
    }
  }

  private assertConnectionEpoch(epoch: number): void {
    if (epoch !== this.connectionEpoch) {
      throw new AgentMuxError('AgentMux client connection was cancelled.', 'CTXMUX_DISCONNECTED')
    }
  }

  private acceptKernelEvent(event: CtxmuxAdapterEvent): void {
    const agentSession = this.registry.findByRun(runRef(event.runId))
    if (event.type === 'data') {
      const projected: AgentMuxRunDataEvent = {
        type: 'data',
        runId: event.runId,
        startByte: event.startByte,
        endByte: event.endByte,
        data: event.data
      }
      this.publisher.publishRunEvent(projected, agentSession)
      return
    }
    if (event.type === 'gap') {
      this.publisher.publish({
        type: 'agent-error',
        ...(agentSession ? { agentSessionId: agentSession.agentSessionId } : {}),
        code: 'OUTPUT_GAP',
        message: 'CtxMux evicted output before this Attachment could consume it.',
        evidence: {
          source: 'terminal-output',
          observedAt: Date.now(),
          run: runRef(event.runId)
        }
      })
      return
    }
    this.publisher.publish({
      type: 'process-state',
      ...(agentSession ? { agentSessionId: agentSession.agentSessionId } : {}),
      run: runRef(event.runId),
      state: event.state.type,
      pid: this.runPids.get(event.runId) ?? null,
      ...(event.state.type === 'exited'
        ? {
            exitCode: event.state.code,
            ...(event.state.signal === null ? {} : { exitSignal: event.state.signal })
          }
        : {}),
      evidence: {
        source: 'run-process',
        observedAt: event.observedAt,
        run: runRef(event.runId)
      }
    })
  }
}
