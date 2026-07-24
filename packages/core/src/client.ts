import { createHash, randomUUID } from 'node:crypto'
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
  AgentMuxFileAgentSessionStore,
  type AgentMuxAgentSessionStore
} from './agent-session-store.js'
import {
  AgentMuxAgentSessionRegistry,
  type AgentMuxAgentSessionLookup
} from './agent-session-registry.js'
import { AgentHookServer, type AgentHookBinding } from './hook-server.js'
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
  AgentMuxRuntimeIdentity,
  AgentNativeSessionHandle,
  NativeHookEnvelope
} from './types.js'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

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

export type AgentMuxAgentRuntimeStatus = {
  session: AgentMuxAgentSession
  run: AgentMuxRun
  capabilities: AgentCapabilitySnapshot['capabilities']
}

function runRef(runId: string): AgentMuxRunRef {
  return { runId }
}

function sameRun(left: AgentMuxRunRef, right: AgentMuxRunRef): boolean {
  return left.runId === right.runId
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

function hookBindingIdentity(operationId: string): string {
  return createHash('sha256').update(operationId).digest('base64url')
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

export class AgentMuxClient {
  readonly providers: AgentProviderRegistry
  private readonly kernel: CtxmuxRunAdapter
  private readonly registry: AgentMuxAgentSessionRegistry
  private readonly publisher = new AgentMuxClientEventPublisher()
  private readonly acp: AgentMuxAcpBridge
  private readonly hookServer: AgentHookServer
  private unsubscribeKernel: (() => void) | null = null
  private unsubscribeKernelErrors: (() => void) | null = null
  private connecting: Promise<void> | null = null
  private connectionEpoch = 0
  private connected = false
  private readonly runPids = new Map<string, number | null>()
  private readonly hookBindings = new Map<string, AgentHookBinding>()
  private readonly agentInputCursors = new Map<string, number>()
  private readonly agentInputTails = new Map<string, Promise<void>>()

  constructor(options: AgentMuxClientOptions = {}) {
    this.providers = new AgentProviderRegistry(options.providers)
    this.registry = new AgentMuxAgentSessionRegistry(
      options.store ?? new AgentMuxFileAgentSessionStore()
    )
    this.kernel = new CtxmuxRunAdapter()
    this.hookServer = new AgentHookServer(async (event) => await this.acceptHookEvent(event))
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
    try {
      await this.kernel.connect()
      this.assertConnectionEpoch(epoch)
      await this.registry.load('local')
      const runs = await this.kernel.list()
      for (const run of runs) this.runPids.set(run.runId, run.pid)
      this.synchronizeAgentRuns(runs)
      await this.tryRestoreHookIngress(runs)
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
      await this.hookServer.stop()
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
    this.agentInputCursors.clear()
    this.agentInputTails.clear()
  }

  async dispose(): Promise<void> {
    this.disconnect()
    for (const binding of this.hookBindings.values()) binding.close()
    this.hookBindings.clear()
    await Promise.all([this.acp.dispose(), this.hookServer.stop()])
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

  resolveAgentSession(lookup: AgentMuxAgentSessionLookup): AgentMuxAgentSession {
    return cloneSession(this.registry.resolve(lookup))
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
    return (await this.kernel.list()).flatMap((run) => {
      this.runPids.set(run.runId, run.pid)
      const ref = runRef(run.runId)
      if (this.registry.isRetiredRun(ref)) return []
      return [projectRun(run, this.registry.findByRun(ref))]
    })
  }

  async workspaceView(): Promise<AgentMuxWorkspaceView> {
    const runs = await this.listRuns()
    return {
      hostId: 'local',
      views: projectAgentMuxViews('local', runs, this.registry.list())
    }
  }

  async statusAgent(agentSessionId: string): Promise<AgentMuxAgentRuntimeStatus> {
    this.requireConnected()
    const session = this.requireAgentSession(agentSessionId)
    const run = await this.requireCurrentAgentRun(session)
    return {
      session: cloneSession(session),
      run: projectRun(run, session),
      capabilities: { ...this.providers.get(session.agentId).catalog.capabilities }
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

  async createAgent(input: AgentMuxAgentCreateInput): Promise<AgentMuxAgentSession> {
    this.requireConnected()
    const agentSessionId = safeId(input.agentSessionId ?? randomUUID(), 'Agent Session id')
    const createOperationId = input.createOperationId ?? randomUUID()
    const release = this.registry.reserveNew(agentSessionId)
    let hookBinding: AgentHookBinding | null = null
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
      await this.requireHookIngressOwner()
      hookBinding = this.hookServer.createBinding(
        agentSessionId,
        input.agentId,
        hookBindingIdentity(createOperationId)
      )
      const run = await this.kernel.start({
        operationKey: createOperationId,
        program: plan.command,
        args: plan.args,
        cwd: input.workspacePath,
        env: this.agentEnvironment(plan.env, agentSessionId, input.agentId, hookBinding),
        ...(input.cols === undefined ? {} : { cols: input.cols }),
        ...(input.rows === undefined ? {} : { rows: input.rows })
      })
      const now = Date.now()
      const session: AgentMuxAgentSession = {
        kind: 'agent',
        agentSessionId,
        agentId: input.agentId,
        hostId: 'local',
        workspacePath: input.workspacePath,
        run: runRef(run.runId),
        retiredRuns: [],
        hookBindingId: hookBinding.bindingId,
        outputCursorBytes: 0,
        createdAt: now,
        updatedAt: now
      }
      try {
        await this.registry.put(session)
        await hookBinding.bindRun(run.runId)
      } catch (error) {
        try {
          hookBinding.close()
          await this.kernel.stop(run.runId)
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Agent Session persistence and Run rollback both failed.')
        }
        throw error
      }
      this.hookBindings.set(run.runId, hookBinding)
      this.runPids.set(run.runId, run.pid)
      if (run.acceptedInputBytes !== null) {
        this.agentInputCursors.set(agentSessionId, run.acceptedInputBytes)
      }
      this.publisher.publish({ type: 'agent-session', session: cloneSession(session) })
      this.publisher.publishRunState(projectRun(run, session), agentSessionId)
      if (input.prompt?.trim()) this.publishPrompt(session, 'Initial prompt', input.prompt.trim(), now)
      return cloneSession(session)
    } finally {
      if (hookBinding && ![...this.hookBindings.values()].includes(hookBinding)) hookBinding.close()
      release()
    }
  }

  async reattachAgent(agentSessionId: string, afterByte?: number): Promise<AgentMuxAgentAttachment> {
    this.requireConnected()
    const session = this.requireAgentSession(agentSessionId)
    const attached = await this.kernel.attach(session.run.runId, afterByte ?? session.outputCursorBytes)
    try {
      this.assertAgentRun(session, attached.run)
    } catch (error) {
      try {
        await this.kernel.detach(attached.run.runId)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Agent reattach rollback failed.')
      }
      throw error
    }
    this.runPids.set(attached.run.runId, attached.run.pid)
    if (attached.run.acceptedInputBytes !== null) {
      this.agentInputCursors.set(agentSessionId, attached.run.acceptedInputBytes)
    }
    this.publisher.publishRunState(projectRun(attached.run, session), agentSessionId)
    return {
      session: cloneSession(session),
      attachment: {
        run: projectRun(attached.run, session),
        replay: attached.replay,
        gap: attached.gap
      }
    }
  }

  async releaseAgentAttachment(agentSessionId: string): Promise<void> {
    this.requireConnected()
    await this.kernel.detach(this.requireAgentSession(agentSessionId).run.runId)
  }

  async resumeAgent(input: AgentMuxAgentResumeInput): Promise<AgentMuxAgentSession> {
    this.requireConnected()
    const current = this.requireAgentSession(input.agentSessionId)
    const release = this.registry.reserveExisting(current.agentSessionId)
    let hookBinding: AgentHookBinding | null = null
    try {
      if (!current.nativeHandle || current.nativeHandle.kind !== 'provider') {
        throw new AgentMuxError('Provider-native resume requires a verified provider session handle.', 'AGENT_RESUME_UNAVAILABLE')
      }
      let oldRun: CtxmuxAdapterRun | null = null
      try {
        oldRun = await this.kernel.status(current.run.runId)
        this.assertAgentRun(current, oldRun)
      } catch (error) {
        if (!(error instanceof AgentMuxError) || error.code !== 'CTXMUX_run_not_found') throw error
      }
      if (oldRun?.state.type === 'running') {
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
      await this.requireHookIngressOwner()
      this.hookBindings.get(current.run.runId)?.close()
      this.hookBindings.delete(current.run.runId)
      const createOperationId = input.createOperationId ?? randomUUID()
      hookBinding = this.hookServer.createBinding(
        current.agentSessionId,
        current.agentId,
        hookBindingIdentity(createOperationId)
      )
      const run = await this.kernel.start({
        operationKey: createOperationId,
        program: plan.command,
        args: plan.args,
        cwd: current.workspacePath,
        env: this.agentEnvironment(plan.env, current.agentSessionId, current.agentId, hookBinding),
        ...(input.cols === undefined ? {} : { cols: input.cols }),
        ...(input.rows === undefined ? {} : { rows: input.rows })
      })
      const next: AgentMuxAgentSession = {
        ...current,
        run: runRef(run.runId),
        retiredRuns: [...current.retiredRuns, current.run].slice(-16),
        hookBindingId: hookBinding.bindingId,
        outputCursorBytes: 0,
        updatedAt: Date.now(),
        nativeHandle: structuredClone(current.nativeHandle)
      }
      delete next.hookReceipt
      try {
        await this.registry.put(next, current.run)
        await hookBinding.bindRun(run.runId)
      } catch (error) {
        try {
          hookBinding.close()
          await this.kernel.stop(run.runId)
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Resume persistence and Run rollback both failed.')
        }
        throw error
      }
      this.hookBindings.set(run.runId, hookBinding)
      this.runPids.delete(current.run.runId)
      this.runPids.set(run.runId, run.pid)
      this.agentInputCursors.set(current.agentSessionId, run.acceptedInputBytes ?? 0)
      this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
      this.publisher.publishRunState(projectRun(run, next), next.agentSessionId)
      return cloneSession(next)
    } finally {
      if (hookBinding && ![...this.hookBindings.values()].includes(hookBinding)) hookBinding.close()
      release()
    }
  }

  async respawnAgent(input: AgentMuxAgentRespawnInput): Promise<AgentMuxAgentSession> {
    const previous = this.requireAgentSession(input.previousAgentSessionId)
    const agentSessionId = input.agentSessionId ?? randomUUID()
    if (agentSessionId === previous.agentSessionId) {
      throw new AgentMuxError('Respawn must create a new Agent Session identity.', 'AGENT_SESSION_ID_REUSE')
    }
    const { previousAgentSessionId: _previousAgentSessionId, ...launch } = input
    return await this.createAgent({
      ...launch,
      agentSessionId,
      agentId: previous.agentId,
      workspacePath: previous.workspacePath
    })
  }

  async writeAgent(agentSessionId: string, data: string): Promise<AgentMuxRunInputAck> {
    this.requireConnected()
    return await this.writeAgentInput(this.requireAgentSession(agentSessionId), data)
  }

  async submitAgentPrompt(agentSessionId: string, prompt: string): Promise<void> {
    this.requireConnected()
    const content = prompt.trim()
    if (!content) throw new AgentMuxError('Agent prompt cannot be empty.', 'INVALID_AGENT_PROMPT')
    const session = this.requireAgentSession(agentSessionId)
    await this.writeAgentInput(session, `${content}\r`)
    this.publishPrompt(session, 'Prompt', content, Date.now())
  }

  async resizeAgent(agentSessionId: string, cols: number, rows: number): Promise<AgentMuxRunAppliedSize> {
    this.requireConnected()
    return await this.resizeTerminal(this.requireAgentSession(agentSessionId).run, cols, rows)
  }

  async signalAgent(agentSessionId: string, signal: string): Promise<void> {
    this.requireConnected()
    await this.signalTerminal(this.requireAgentSession(agentSessionId).run, signal)
  }

  async acknowledgeAgentOutput(agentSessionId: string, throughByte: number): Promise<void> {
    this.requireConnected()
    const session = this.requireAgentSession(agentSessionId)
    await this.acknowledgeTerminalOutput(session.run, throughByte)
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
      await this.requireCurrentAgentRun(session)
      await this.kernel.stop(session.run.runId)
      this.hookBindings.get(session.run.runId)?.close()
      this.hookBindings.delete(session.run.runId)
      const cleanup = await Promise.allSettled([
        this.acp.unbind(agentSessionId),
        this.registry.delete(agentSessionId, session.run)
      ])
      if (cleanup[1]?.status === 'fulfilled') {
        this.runPids.delete(session.run.runId)
        this.agentInputCursors.delete(agentSessionId)
        this.agentInputTails.delete(agentSessionId)
        this.publisher.publish({
          type: 'run-removed',
          agentSessionId,
          run: { ...session.run },
          evidence: { source: 'user', observedAt: Date.now(), run: { ...session.run } }
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

  private synchronizeAgentRuns(runs: readonly CtxmuxAdapterRun[]): void {
    const runsById = new Map(runs.map((run) => [run.runId, run]))
    for (const session of this.registry.list()) {
      const run = runsById.get(session.run.runId)
      if (run) this.assertAgentRun(session, run)
    }
  }

  private async restoreHookBindings(runs: readonly CtxmuxAdapterRun[]): Promise<void> {
    const runsById = new Map(runs.map((run) => [run.runId, run]))
    for (const session of this.registry.list()) {
      if (!runsById.has(session.run.runId) || this.hookBindings.has(session.run.runId)) continue
      const binding = this.hookServer.createBinding(
        session.agentSessionId,
        session.agentId,
        session.hookBindingId
      )
      try {
        await binding.bindRun(session.run.runId)
        this.hookBindings.set(session.run.runId, binding)
      } catch (error) {
        binding.close()
        throw error
      }
    }
  }

  private async tryRestoreHookIngress(runs: readonly CtxmuxAdapterRun[]): Promise<void> {
    if (this.registry.list().length === 0) return
    try {
      await this.hookServer.start()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return
      throw error
    }
    await this.restoreHookBindings(runs)
  }

  private async requireHookIngressOwner(): Promise<void> {
    if (this.hookServer.isRunning()) return
    try {
      await this.hookServer.start()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        throw new AgentMuxError(
          'Another AgentMux client owns the Hook ingress required for this lifecycle operation.',
          'HOOK_INGRESS_BUSY'
        )
      }
      throw error
    }
  }

  private assertAgentRun(session: AgentMuxAgentSession, run: CtxmuxAdapterRun): void {
    const resolved = this.registry.resolve({ kind: 'run', run: runRef(run.runId) })
    if (
      !sameRun(session.run, runRef(run.runId)) ||
      resolved.agentSessionId !== session.agentSessionId ||
      run.workspacePath !== session.workspacePath
    ) {
      throw new AgentMuxError('Run no longer matches the Agent Session.', 'AGENT_SESSION_RUN_MISMATCH')
    }
  }

  private async requireCurrentAgentRun(session: AgentMuxAgentSession): Promise<CtxmuxAdapterRun> {
    let run: CtxmuxAdapterRun
    try {
      run = await this.kernel.status(session.run.runId)
    } catch (error) {
      if (error instanceof AgentMuxError && error.code === 'CTXMUX_run_not_found') {
        throw new AgentMuxError('Agent Session points to a Run that is no longer available.', 'STALE_AGENT_SESSION_BINDING')
      }
      throw error
    }
    this.assertAgentRun(session, run)
    return run
  }

  private agentEnvironment(
    environment: Readonly<Record<string, string>>,
    agentSessionId: string,
    agentId: AgentId,
    binding: AgentHookBinding
  ): Record<string, string> {
    return {
      ...environment,
      AGENTMUX_HOOK_URL: binding.endpoint.url,
      AGENTMUX_HOOK_TOKEN: binding.endpoint.token,
      AGENTMUX_AGENT_SESSION_ID: agentSessionId,
      AGENTMUX_AGENT_ID: agentId
    }
  }

  private publishPrompt(
    session: AgentMuxAgentSession,
    title: string,
    content: string,
    observedAt: number
  ): void {
    this.publisher.publish({
      type: 'agent-activity',
      agentSessionId: session.agentSessionId,
      activity: {
        id: randomUUID(),
        kind: 'prompt',
        createdAt: observedAt,
        title,
        content
      },
      evidence: { source: 'user', observedAt, run: { ...session.run } }
    })
  }

  private async writeAgentInput(
    requestedSession: AgentMuxAgentSession,
    data: string
  ): Promise<AgentMuxRunInputAck> {
    const agentSessionId = requestedSession.agentSessionId
    const previous = this.agentInputTails.get(agentSessionId) ?? Promise.resolve()
    let accepted!: AgentMuxRunInputAck
    const operation = previous.catch(() => {}).then(async () => {
      const session = this.requireAgentSession(agentSessionId)
      if (!sameRun(session.run, requestedSession.run)) {
        throw new AgentMuxError('Agent Session changed before Input was accepted.', 'STALE_AGENT_SESSION')
      }
      const run = await this.requireCurrentAgentRun(session)
      const expectedByte = this.agentInputCursors.get(agentSessionId) ?? run.acceptedInputBytes
      if (expectedByte === null) {
        throw new AgentMuxError('CtxMux omitted its accepted Input byte cursor.', 'CTXMUX_INPUT_CURSOR_MISSING')
      }
      const result = await this.kernel.input(session.run.runId, {
        ownerInstanceId: this.kernel.identity().daemonInstanceId,
        operationId: randomUUID(),
        expectedByte,
        data
      })
      if (result.run.acceptedInputBytes === null) {
        throw new AgentMuxError('CtxMux omitted its accepted Input byte cursor.', 'CTXMUX_INPUT_CURSOR_MISSING')
      }
      this.agentInputCursors.set(agentSessionId, result.run.acceptedInputBytes)
      accepted = {
        runId: session.run.runId,
        appliedByteRange: result.appliedByteRange,
        acceptedThroughByte: result.run.acceptedInputBytes
      }
    })
    const tail = operation.then(() => {}, () => {})
    this.agentInputTails.set(agentSessionId, tail)
    try {
      await operation
      return accepted
    } catch (error) {
      this.agentInputCursors.delete(agentSessionId)
      throw error
    } finally {
      if (this.agentInputTails.get(agentSessionId) === tail) this.agentInputTails.delete(agentSessionId)
    }
  }

  private requireAgentSession(agentSessionId: string): AgentMuxAgentSession {
    return this.registry.get(agentSessionId)
  }

  private async acceptHookEvent(envelope: NativeHookEnvelope): Promise<void> {
    const session = this.registry.findByRun(runRef(envelope.runId))
    if (
      !session ||
      session.agentSessionId !== envelope.agentSessionId ||
      session.agentId !== envelope.agentId
    ) return
    const normalized = this.providers.get(envelope.agentId).normalizeHook(envelope)
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
