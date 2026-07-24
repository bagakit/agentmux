import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { AgentTerminalScreen } from './agent-terminal-screen.js'
import {
  CtxmuxRunAdapter,
  type CtxmuxAdapterDataEvent,
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
  AgentPromptInputPlan,
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
  AgentTerminalHandshake,
  AgentTerminalPromptRenderMatcher,
  NativeHookEnvelope
} from './types.js'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const TERMINAL_HANDSHAKE_TIMEOUT_MS = 10_000
const TERMINAL_PROMPT_RENDER_TIMEOUT_MS = 10_000
const AGENTMUX_CLI_PATH = fileURLToPath(new URL('../bin/agentmux', import.meta.url))

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
  operationId: string
  prompt: string
  args?: readonly string[]
  env?: Readonly<Record<string, string>>
  commandOverride?: string
  cols?: number
  rows?: number
}

export type AgentMuxAgentPromptInput = {
  agentSessionId: string
  operationId: string
  prompt: string
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

function agentLifecycleOperationIdentity(
  kind: 'create' | 'resume',
  agentSessionId: string,
  requestedOperationId: string
): string {
  return createHash('sha256')
    .update(JSON.stringify(['agentmux-agent-lifecycle-v1', kind, agentSessionId, requestedOperationId]))
    .digest('base64url')
}

function terminalHandshakeOperationIdentity(
  agentId: AgentId,
  runId: string,
  handshake: AgentTerminalHandshake
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      'agentmux-terminal-handshake-v1',
      agentId,
      runId,
      handshake.query,
      handshake.response
    ]))
    .digest('base64url')
}

function terminalPromptPhaseOperationIdentity(
  session: AgentMuxAgentSession,
  submissionId: string,
  phase: 'payload' | 'submit',
  data: string
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      'agentmux-terminal-prompt-v1',
      session.agentSessionId,
      session.run.runId,
      submissionId,
      phase,
      data
    ]))
    .digest('base64url')
}

function terminalEnvironment(
  environment: Readonly<Record<string, string>>
): Record<string, string> {
  const inheritedPath = environment.PATH ?? process.env.PATH ?? ''
  return {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'AgentMux',
    TERM_PROGRAM_VERSION: '0.1.0',
    FORCE_HYPERLINK: '1',
    ...environment,
    PATH: [dirname(AGENTMUX_CLI_PATH), inheritedPath].filter(Boolean).join(delimiter),
    AGENTMUX_ENV: '1',
    AGENTMUX_CLI: AGENTMUX_CLI_PATH
  }
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
  private readonly terminalStopReadinessCancels = new Map<string, () => void>()

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
      await this.recoverStaleLifecycles()
      await this.registry.load('local')
      const runs = await this.kernel.list()
      for (const run of runs) this.runPids.set(run.runId, run.pid)
      this.synchronizeAgentRuns(runs)
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
      await this.tryRestoreHookIngress(runs)
      for (const session of this.registry.list()) {
        const run = runs.find((candidate) => candidate.runId === session.run.runId)
        if (run?.state.type === 'running') {
          await this.ensureTerminalHandshake(session, run)
          const current = this.registry.get(session.agentSessionId)
          if (
            current.terminalStopReceipt &&
            current.terminalStopReceipt.readyThroughByte === undefined &&
            current.terminalStopReceipt.consumedBySubmissionId === undefined
          ) {
            this.observeTerminalStopReadiness(current, current.terminalStopReceipt)
          }
        }
      }
      this.assertConnectionEpoch(epoch)
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
    for (const cancel of this.terminalStopReadinessCancels.values()) cancel()
    this.terminalStopReadinessCancels.clear()
  }

  async dispose(): Promise<void> {
    await this.hookServer.stop()
    this.disconnect()
    for (const binding of this.hookBindings.values()) binding.close()
    this.hookBindings.clear()
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
        sourceCommit: '2e32a9d647d627952ea5c455fb2efef6c636643a',
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
      env: terminalEnvironment(input.env ?? {}),
      ...(input.cols === undefined ? {} : { cols: input.cols }),
      ...(input.rows === undefined ? {} : { rows: input.rows })
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

  async readRunReplay(ref: AgentMuxRunRef, afterByte = 0): Promise<AgentMuxRunAttachment> {
    this.requireConnected()
    if (this.registry.isRetiredRun(ref)) {
      throw new AgentMuxError('Retired Agent Run replay is unavailable.', 'STALE_AGENT_SESSION_BINDING')
    }
    const replay = await this.kernel.replay(ref.runId, afterByte)
    if (this.registry.isRetiredRun(ref)) {
      throw new AgentMuxError('Agent Run retired while its replay was being read.', 'STALE_AGENT_SESSION_BINDING')
    }
    this.runPids.set(ref.runId, replay.run.pid)
    return {
      run: projectRun(replay.run, this.registry.findByRun(ref)),
      replay: replay.replay,
      gap: replay.gap
    }
  }

  async releaseRunAttachment(ref: AgentMuxRunRef): Promise<void> {
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
    const lifecycleOperationId = agentLifecycleOperationIdentity(
      'create',
      agentSessionId,
      input.createOperationId ?? randomUUID()
    )
    const reservation = await this.registry.reserveNew(agentSessionId, lifecycleOperationId)
    let hookBinding: AgentHookBinding | null = null
    let persisted: AgentMuxAgentSession | null = null
    let abandonedRun: AgentMuxRunRef | null = null
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
        hookBindingIdentity(lifecycleOperationId)
      )
      const run = await this.kernel.start({
        operationKey: lifecycleOperationId,
        program: plan.command,
        args: plan.args,
        cwd: input.workspacePath,
        env: this.agentEnvironment(
          plan.env,
          agentSessionId,
          input.agentId,
          hookBinding,
          lifecycleOperationId
        ),
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
      let readySession = session
      try {
        persisted = await this.registry.commitLifecycle(reservation, session)
        await hookBinding.bindRun(run.runId)
        readySession = await this.ensureTerminalHandshake(session, run)
      } catch (error) {
        const rollbackErrors: unknown[] = [error]
        try {
          hookBinding.close()
          await this.retireUncommittedRun(run.runId)
          abandonedRun = runRef(run.runId)
        }
        catch (cleanupError) { rollbackErrors.push(cleanupError) }
        if (persisted) {
          try {
            await this.registry.delete(agentSessionId, session.run)
            await this.registry.retireRuns([session.run])
            abandonedRun = null
          } catch (cleanupError) {
            rollbackErrors.push(cleanupError)
          }
        }
        if (rollbackErrors.length > 1) {
          throw new AggregateError(rollbackErrors, 'Agent Session persistence and Run rollback failed.')
        }
        throw error
      }
      this.hookBindings.set(run.runId, hookBinding)
      this.runPids.set(run.runId, run.pid)
      this.publisher.publish({ type: 'agent-session', session: cloneSession(readySession) })
      this.publisher.publishRunState(projectRun(run, readySession), agentSessionId)
      if (input.prompt?.trim()) this.publishPrompt(readySession, 'Initial prompt', input.prompt.trim(), now)
      return cloneSession(readySession)
    } finally {
      if (hookBinding && ![...this.hookBindings.values()].includes(hookBinding)) hookBinding.close()
      await this.registry.releaseLifecycle(reservation, abandonedRun ? [abandonedRun] : [])
    }
  }

  async reattachAgent(agentSessionId: string, afterByte?: number): Promise<AgentMuxAgentAttachment> {
    this.requireConnected()
    const session = this.requireAgentSession(agentSessionId)
    const attached = await this.kernel.attach(session.run.runId, afterByte ?? session.outputCursorBytes)
    try {
      const current = this.requireAgentSession(agentSessionId)
      if (current.run.runId !== session.run.runId) {
        throw new AgentMuxError('Agent Session changed while its Run was being attached.', 'STALE_AGENT_SESSION_BINDING')
      }
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

  async resumeAgent(input: AgentMuxAgentResumeInput): Promise<AgentMuxAgentSession> {
    this.requireConnected()
    const current = this.requireAgentSession(input.agentSessionId)
    const prompt = input.prompt.trim()
    if (!prompt) throw new AgentMuxError('Agent resume prompt cannot be empty.', 'INVALID_AGENT_PROMPT')
    const lifecycleOperationId = agentLifecycleOperationIdentity(
      'resume',
      current.agentSessionId,
      safeId(input.operationId, 'Agent resume operation id')
    )
    const reservation = await this.registry.reserveExisting(
      'resume',
      current.agentSessionId,
      lifecycleOperationId
    )
    let hookBinding: AgentHookBinding | null = null
    let persisted: AgentMuxAgentSession | null = null
    let abandonedRun: AgentMuxRunRef | null = null
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
        prompt,
        args: input.args ?? [],
        env: input.env ?? {},
        ...(input.commandOverride === undefined ? {} : { commandOverride: input.commandOverride })
      })
      await this.requireHookIngressOwner()
      this.hookBindings.get(current.run.runId)?.close()
      this.hookBindings.delete(current.run.runId)
      hookBinding = this.hookServer.createBinding(
        current.agentSessionId,
        current.agentId,
        hookBindingIdentity(lifecycleOperationId)
      )
      const run = await this.kernel.start({
        operationKey: lifecycleOperationId,
        program: plan.command,
        args: plan.args,
        cwd: current.workspacePath,
        env: this.agentEnvironment(
          plan.env,
          current.agentSessionId,
          current.agentId,
          hookBinding,
          lifecycleOperationId
        ),
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
      delete next.terminalHandshake
      delete next.terminalStopReceipt
      delete next.terminalPromptSubmission
      let readySession = next
      try {
        persisted = await this.registry.commitLifecycle(reservation, next)
        await hookBinding.bindRun(run.runId)
        readySession = await this.ensureTerminalHandshake(next, run)
      } catch (error) {
        const rollbackErrors: unknown[] = [error]
        try {
          hookBinding.close()
          await this.retireUncommittedRun(run.runId)
          abandonedRun = runRef(run.runId)
        }
        catch (cleanupError) { rollbackErrors.push(cleanupError) }
        if (persisted) {
          try {
            await this.registry.put({
              ...current,
              retiredRuns: [...current.retiredRuns, next.run].slice(-16),
              updatedAt: Date.now()
            }, next.run)
            abandonedRun = null
          } catch (cleanupError) {
            rollbackErrors.push(cleanupError)
          }
        }
        if (rollbackErrors.length > 1) {
          throw new AggregateError(rollbackErrors, 'Resume persistence and Run rollback failed.')
        }
        throw error
      }
      this.hookBindings.set(run.runId, hookBinding)
      this.runPids.delete(current.run.runId)
      this.runPids.set(run.runId, run.pid)
      this.publisher.publish({ type: 'agent-session', session: cloneSession(readySession) })
      this.publisher.publishRunState(projectRun(run, readySession), readySession.agentSessionId)
      this.publishPrompt(readySession, 'Resume prompt', prompt, Date.now())
      return cloneSession(readySession)
    } finally {
      if (hookBinding && ![...this.hookBindings.values()].includes(hookBinding)) hookBinding.close()
      await this.registry.releaseLifecycle(reservation, abandonedRun ? [abandonedRun] : [])
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

  async submitAgentPrompt(input: AgentMuxAgentPromptInput): Promise<void> {
    this.requireConnected()
    const content = input.prompt.trim()
    if (!content) throw new AgentMuxError('Agent prompt cannot be empty.', 'INVALID_AGENT_PROMPT')
    const operationId = safeId(input.operationId, 'Agent prompt operation id')
    const session = await this.ensureTerminalHandshake(
      this.requireAgentSession(input.agentSessionId)
    )
    const plan = this.providers.get(session.agentId).planPromptInput(content)
    await this.serializeAgentInput(session, async (current, run) => {
      await this.submitAgentInputPlan(current, run, operationId, content, plan)
    })
    this.publishPrompt(this.requireAgentSession(input.agentSessionId), 'Prompt', content, Date.now())
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
    await this.registry.update(
      agentSessionId,
      session.run,
      (current) => throughByte <= current.outputCursorBytes
        ? current
        : { ...current, outputCursorBytes: throughByte, updatedAt: Date.now() }
    )
  }

  async stopAgent(agentSessionId: string): Promise<void> {
    this.requireConnected()
    const session = this.requireAgentSession(agentSessionId)
    const reservation = await this.registry.reserveExisting('stop', agentSessionId, randomUUID())
    try {
      const run = await this.requireCurrentAgentRun(session)
      if (run.state.type === 'running') await this.stopRunningRun(session.run.runId)
      this.hookBindings.get(session.run.runId)?.close()
      this.hookBindings.delete(session.run.runId)
      const cleanup = await Promise.allSettled([
        this.acp.unbind(agentSessionId),
        this.registry.commitLifecycle(reservation, null)
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
      await this.registry.releaseLifecycle(reservation)
    }
  }

  async bindAcp(agentSessionId: string, binding: AgentMuxAcpBinding): Promise<void> {
    this.requireConnected()
    const session = this.requireAgentSession(agentSessionId)
    if (this.providers.get(session.agentId).catalog.acpStrategy.kind !== 'adapter') {
      throw new AgentMuxError('Provider does not declare an ACP adapter.', 'ACP_UNSUPPORTED')
    }
    await this.acp.bind(agentSessionId, binding)
  }

  private async recoverStaleLifecycles(): Promise<void> {
    const reservations = await this.registry.claimStaleLifecycles()
    if (reservations.length === 0) return
    const runs = await this.kernel.list()
    for (const reservation of reservations) {
      let retiredRuns: AgentMuxRunRef[] = []
      if (reservation.kind !== 'stop') {
        const candidates = runs.filter(
          (run) => run.lifecycleOperationId === reservation.operationId
        )
        for (const run of candidates) await this.retireUncommittedRun(run.runId)
        retiredRuns = candidates.map((run) => runRef(run.runId))
      }
      await this.registry.releaseLifecycle(reservation, retiredRuns)
    }
  }

  private async retireUncommittedRun(runId: string): Promise<void> {
    let run: CtxmuxAdapterRun
    try {
      run = await this.kernel.status(runId)
    } catch (error) {
      if (error instanceof AgentMuxError && error.code === 'CTXMUX_run_not_found') return
      throw error
    }
    if (run.state.type === 'running') await this.stopRunningRun(runId)
  }

  private async stopRunningRun(runId: string): Promise<void> {
    try {
      await this.kernel.stop(runId)
    } catch (error) {
      if (!(error instanceof AgentMuxError) || error.code !== 'CTXMUX_invalid_run_state') throw error
      const current = await this.kernel.status(runId)
      if (current.state.type === 'running') throw error
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
    binding: AgentHookBinding,
    lifecycleOperationId: string
  ): Record<string, string> {
    return {
      ...terminalEnvironment(environment),
      AGENTMUX_HOOK_URL: binding.endpoint.url,
      AGENTMUX_HOOK_TOKEN: binding.endpoint.token,
      AGENTMUX_AGENT_SESSION_ID: agentSessionId,
      AGENTMUX_AGENT_ID: agentId,
      AGENTMUX_LIFECYCLE_OPERATION_ID: lifecycleOperationId
    }
  }

  private async ensureTerminalHandshake(
    requestedSession: AgentMuxAgentSession,
    knownRun?: CtxmuxAdapterRun
  ): Promise<AgentMuxAgentSession> {
    const provider = this.providers.get(requestedSession.agentId)
    const handshake = provider.terminalHandshake
    if (!handshake) {
      if (knownRun?.acceptedInputBytes !== null && knownRun?.acceptedInputBytes !== undefined) {
        this.agentInputCursors.set(requestedSession.agentSessionId, knownRun.acceptedInputBytes)
      }
      return this.requireAgentSession(requestedSession.agentSessionId)
    }

    const session = this.requireAgentSession(requestedSession.agentSessionId)
    if (!sameRun(session.run, requestedSession.run)) {
      throw new AgentMuxError(
        'Agent Session changed before terminal handshake completed.',
        'STALE_AGENT_SESSION'
      )
    }
    const operationId = terminalHandshakeOperationIdentity(
      session.agentId,
      session.run.runId,
      handshake
    )
    const responseBytes = Buffer.byteLength(handshake.response)
    const assertState = (value: NonNullable<AgentMuxAgentSession['terminalHandshake']>): void => {
      if (
        value.run.runId !== session.run.runId ||
        value.operationId !== operationId ||
        value.inputByteRange.endByte - value.inputByteRange.startByte !== responseBytes
      ) {
        throw new AgentMuxError(
          'Persisted terminal handshake does not match the Provider and exact Run.',
          'AGENT_TERMINAL_HANDSHAKE_STATE_INVALID'
        )
      }
    }
    if (session.terminalHandshake) {
      assertState(session.terminalHandshake)
      if (session.terminalHandshake.acknowledged) {
        if (
          knownRun?.acceptedInputBytes !== null &&
          knownRun?.acceptedInputBytes !== undefined &&
          knownRun.acceptedInputBytes < session.terminalHandshake.inputByteRange.endByte
        ) {
          throw new AgentMuxError(
            'CtxMux Input cursor precedes the persisted terminal handshake receipt.',
            'AGENT_TERMINAL_HANDSHAKE_STATE_INVALID'
          )
        }
        if (knownRun?.acceptedInputBytes !== null && knownRun?.acceptedInputBytes !== undefined) {
          this.agentInputCursors.set(session.agentSessionId, knownRun.acceptedInputBytes)
        }
        return session
      }
    }

    let tail = ''
    let queryObserved = false
    let resolveQuery!: () => void
    let rejectQuery!: (error: Error) => void
    const query = new Promise<void>((resolve, reject) => {
      resolveQuery = resolve
      rejectQuery = reject
    })
    const observe = (data: string): void => {
      if (queryObserved) return
      const candidate = `${tail}${data}`
      if (candidate.includes(handshake.query)) {
        queryObserved = true
        resolveQuery()
        return
      }
      tail = candidate.slice(-Math.max(0, handshake.query.length - 1))
    }
    const unsubscribe = this.publisher.onEvent((event) => {
      if (event.type !== 'terminal-output' && event.type !== 'process-state') return
      if (event.run.runId !== session.run.runId) return
      if (event.type === 'terminal-output') {
        observe(event.data)
      } else if (event.state !== 'running') {
        rejectQuery(new AgentMuxError(
          'Agent Run exited before its terminal capability query was observed.',
          'AGENT_TERMINAL_HANDSHAKE_FAILED'
        ))
      }
    })
    const timer = setTimeout(() => {
      rejectQuery(new AgentMuxError(
        'Timed out waiting for the Provider terminal capability query.',
        'AGENT_TERMINAL_HANDSHAKE_TIMEOUT'
      ))
    }, TERMINAL_HANDSHAKE_TIMEOUT_MS)
    let attached = false
    try {
      const attachment = await this.kernel.attach(session.run.runId, 0)
      attached = true
      for (const event of attachment.replay) observe(event.data)
      if (!queryObserved) await query

      const claimed = await this.registry.update(
        session.agentSessionId,
        session.run,
        (current) => {
          if (current.terminalHandshake) {
            assertState(current.terminalHandshake)
            return current
          }
          const startByte = attachment.run.acceptedInputBytes
          if (startByte === null) {
            throw new AgentMuxError(
              'CtxMux omitted its accepted Input byte cursor.',
              'CTXMUX_INPUT_CURSOR_MISSING'
            )
          }
          return {
            ...current,
            terminalHandshake: {
              run: { ...current.run },
              operationId,
              inputByteRange: {
                startByte,
                endByte: startByte + responseBytes
              },
              acknowledged: false
            },
            updatedAt: Date.now()
          }
        }
      )
      const state = claimed.terminalHandshake
      if (!state) {
        throw new AgentMuxError(
          'Terminal handshake claim was not persisted.',
          'AGENT_TERMINAL_HANDSHAKE_STATE_INVALID'
        )
      }
      assertState(state)
      if (state.acknowledged) {
        const acceptedInputBytes = attachment.run.acceptedInputBytes
        if (acceptedInputBytes === null || acceptedInputBytes < state.inputByteRange.endByte) {
          throw new AgentMuxError(
            'CtxMux Input cursor precedes the persisted terminal handshake receipt.',
            'AGENT_TERMINAL_HANDSHAKE_STATE_INVALID'
          )
        }
        this.agentInputCursors.set(session.agentSessionId, acceptedInputBytes)
        return claimed
      }

      const accepted = await this.kernel.input(session.run.runId, {
        ownerInstanceId: this.kernel.identity().daemonInstanceId,
        operationId: state.operationId,
        expectedByte: state.inputByteRange.startByte,
        data: handshake.response
      })
      if (
        accepted.appliedByteRange.startByte !== state.inputByteRange.startByte ||
        accepted.appliedByteRange.endByte !== state.inputByteRange.endByte ||
        accepted.run.acceptedInputBytes === null ||
        accepted.run.acceptedInputBytes < state.inputByteRange.endByte
      ) {
        throw new AgentMuxError(
          'CtxMux terminal handshake receipt does not match the persisted Input claim.',
          'AGENT_TERMINAL_HANDSHAKE_RECEIPT_MISMATCH'
        )
      }
      const ready = await this.registry.update(
        session.agentSessionId,
        session.run,
        (current) => {
          if (!current.terminalHandshake) {
            throw new AgentMuxError(
              'Terminal handshake claim disappeared before acknowledgement.',
              'AGENT_TERMINAL_HANDSHAKE_STATE_INVALID'
            )
          }
          assertState(current.terminalHandshake)
          return {
            ...current,
            terminalHandshake: {
              ...current.terminalHandshake,
              acknowledged: true
            },
            updatedAt: Date.now()
          }
        }
      )
      this.agentInputCursors.set(session.agentSessionId, accepted.run.acceptedInputBytes)
      return ready
    } finally {
      clearTimeout(timer)
      unsubscribe()
      if (attached) await this.kernel.detach(session.run.runId)
    }
  }

  private async submitAgentInputPlan(
    session: AgentMuxAgentSession,
    run: CtxmuxAdapterRun,
    submissionId: string,
    prompt: string,
    plan: AgentPromptInputPlan
  ): Promise<void> {
    if (plan.kind === 'single-phase') {
      const expectedByte = this.agentInputCursors.get(session.agentSessionId) ?? run.acceptedInputBytes
      if (expectedByte === null) {
        throw new AgentMuxError('CtxMux omitted its accepted Input byte cursor.', 'CTXMUX_INPUT_CURSOR_MISSING')
      }
      const accepted = await this.kernel.input(session.run.runId, {
        ownerInstanceId: this.kernel.identity().daemonInstanceId,
        operationId: terminalPromptPhaseOperationIdentity(
          session,
          submissionId,
          'payload',
          plan.data
        ),
        expectedByte,
        data: plan.data
      })
      if (accepted.run.acceptedInputBytes === null) {
        throw new AgentMuxError('CtxMux omitted its accepted Input byte cursor.', 'CTXMUX_INPUT_CURSOR_MISSING')
      }
      this.agentInputCursors.set(session.agentSessionId, accepted.run.acceptedInputBytes)
      return
    }
    if (!plan.payload || !plan.submit) {
      throw new AgentMuxError(
        'Provider terminal prompt phases cannot be empty.',
        'INVALID_AGENT_PROVIDER'
      )
    }

    const promptDigest = createHash('sha256').update(prompt).digest('base64url')
    const payloadOperationId = terminalPromptPhaseOperationIdentity(
      session,
      submissionId,
      'payload',
      plan.payload
    )
    const submitOperationId = terminalPromptPhaseOperationIdentity(
      session,
      submissionId,
      'submit',
      plan.submit
    )
    const payloadBytes = Buffer.byteLength(plan.payload)
    const submitBytes = Buffer.byteLength(plan.submit)
    type Submission = NonNullable<AgentMuxAgentSession['terminalPromptSubmission']>
    const assertSubmission = (value: Submission): void => {
      if (
        value.run.runId !== session.run.runId ||
        value.submissionId !== submissionId ||
        value.promptDigest !== promptDigest ||
        value.readyThroughByte < value.stopOutputCursorBytes ||
        value.outputCursorBytes < value.readyThroughByte ||
        value.payload.operationId !== payloadOperationId ||
        value.submit.operationId !== submitOperationId ||
        value.payload.inputByteRange.endByte - value.payload.inputByteRange.startByte !== payloadBytes ||
        value.submit.inputByteRange.endByte - value.submit.inputByteRange.startByte !== submitBytes ||
        value.payload.inputByteRange.endByte !== value.submit.inputByteRange.startByte
      ) {
        throw new AgentMuxError(
          'Agent prompt operation was reused with conflicting Session or content.',
          'AGENT_PROMPT_OPERATION_CONFLICT'
        )
      }
    }
    const expectedByte = this.agentInputCursors.get(session.agentSessionId) ?? run.acceptedInputBytes
    if (expectedByte === null) {
      throw new AgentMuxError('CtxMux omitted its accepted Input byte cursor.', 'CTXMUX_INPUT_CURSOR_MISSING')
    }
    let current: AgentMuxAgentSession
    try {
      current = await this.registry.update(
        session.agentSessionId,
        session.run,
        (stored) => {
          const existing = stored.terminalPromptSubmission
          if (existing?.submissionId === submissionId) {
            assertSubmission(existing)
            return stored
          }
          if (existing && !existing.submit.acknowledged) {
            throw new AgentMuxError(
              'Another Agent prompt operation is incomplete for this Run.',
              'AGENT_PROMPT_SUBMISSION_BUSY'
            )
          }
          const stopReceipt = stored.terminalStopReceipt
          if (!stopReceipt || stopReceipt.readyThroughByte === undefined) {
            throw new AgentMuxError(
              'Agent prompt requires a ready native Stop receipt for this exact Run.',
              'AGENT_PROMPT_NOT_READY'
            )
          }
          if (stopReceipt.consumedBySubmissionId !== undefined) {
            throw new AgentMuxError(
              'The current native Stop receipt was already consumed by another prompt.',
              'AGENT_PROMPT_STOP_RECEIPT_CONSUMED'
            )
          }
          const outputCursorBytes = Math.max(run.latestOutputBytes, stopReceipt.readyThroughByte)
          return {
            ...stored,
            terminalStopReceipt: {
              ...stopReceipt,
              consumedBySubmissionId: submissionId
            },
            terminalPromptSubmission: {
              run: { ...stored.run },
              submissionId,
              promptDigest,
              stopReceiptId: stopReceipt.id,
              stopOutputCursorBytes: stopReceipt.outputCursorBytes,
              readyThroughByte: stopReceipt.readyThroughByte,
              outputCursorBytes,
              payload: {
                operationId: payloadOperationId,
                inputByteRange: {
                  startByte: expectedByte,
                  endByte: expectedByte + payloadBytes
                },
                acknowledged: false
              },
              submit: {
                operationId: submitOperationId,
                inputByteRange: {
                  startByte: expectedByte + payloadBytes,
                  endByte: expectedByte + payloadBytes + submitBytes
                },
                acknowledged: false
              }
            },
            updatedAt: Date.now()
          }
        }
      )
    } catch (error) {
      if (error instanceof AgentMuxError && error.code === 'STALE_AGENT_SESSION') {
        throw new AgentMuxError(
          'Native Stop receipt changed or was consumed by another Client.',
          'AGENT_PROMPT_STOP_RECEIPT_CONFLICT'
        )
      }
      throw error
    }
    let submission = current.terminalPromptSubmission
    if (!submission) {
      throw new AgentMuxError(
        'Agent prompt submission claim was not persisted.',
        'AGENT_PROMPT_SUBMISSION_STATE_INVALID'
      )
    }
    assertSubmission(submission)
    let acceptedInputBytes = run.acceptedInputBytes

    const applyPhase = async (
      phaseName: 'payload' | 'submit',
      data: string
    ): Promise<void> => {
      submission = this.requireAgentSession(session.agentSessionId).terminalPromptSubmission
      if (!submission) {
        throw new AgentMuxError(
          'Agent prompt submission claim disappeared.',
          'AGENT_PROMPT_SUBMISSION_STATE_INVALID'
        )
      }
      assertSubmission(submission)
      const phase = submission[phaseName]
      if (phase.acknowledged) {
        if (acceptedInputBytes === null || acceptedInputBytes < phase.inputByteRange.endByte) {
          throw new AgentMuxError(
            'CtxMux Input cursor precedes the persisted prompt phase receipt.',
            'AGENT_PROMPT_SUBMISSION_STATE_INVALID'
          )
        }
        this.agentInputCursors.set(session.agentSessionId, acceptedInputBytes)
        return
      }
      const accepted = await this.kernel.input(session.run.runId, {
        ownerInstanceId: this.kernel.identity().daemonInstanceId,
        operationId: phase.operationId,
        expectedByte: phase.inputByteRange.startByte,
        data
      })
      if (
        accepted.appliedByteRange.startByte !== phase.inputByteRange.startByte ||
        accepted.appliedByteRange.endByte !== phase.inputByteRange.endByte ||
        accepted.run.acceptedInputBytes === null ||
        accepted.run.acceptedInputBytes < phase.inputByteRange.endByte
      ) {
        throw new AgentMuxError(
          'CtxMux prompt phase receipt does not match the persisted Input claim.',
          'AGENT_PROMPT_SUBMISSION_RECEIPT_MISMATCH'
        )
      }
      acceptedInputBytes = accepted.run.acceptedInputBytes
      current = await this.registry.update(
        session.agentSessionId,
        session.run,
        (stored) => {
          const state = stored.terminalPromptSubmission
          if (!state) {
            throw new AgentMuxError(
              'Agent prompt submission claim disappeared.',
              'AGENT_PROMPT_SUBMISSION_STATE_INVALID'
            )
          }
          assertSubmission(state)
          return {
            ...stored,
            terminalPromptSubmission: {
              ...state,
              [phaseName]: { ...state[phaseName], acknowledged: true }
            },
            updatedAt: Date.now()
          }
        }
      )
      submission = current.terminalPromptSubmission
      this.agentInputCursors.set(session.agentSessionId, acceptedInputBytes)
    }

    if (submission.submit.acknowledged) {
      await applyPhase('submit', plan.submit)
      return
    }
    await applyPhase('payload', plan.payload)
    submission = this.requireAgentSession(session.agentSessionId).terminalPromptSubmission
    if (!submission) {
      throw new AgentMuxError(
        'Agent prompt submission claim disappeared.',
        'AGENT_PROMPT_SUBMISSION_STATE_INVALID'
      )
    }
    await this.waitForTerminalPromptRender(session, submission, plan.payload)
    await applyPhase('submit', plan.submit)
  }

  private async waitForTerminalPromptRender(
    session: AgentMuxAgentSession,
    submission: NonNullable<AgentMuxAgentSession['terminalPromptSubmission']>,
    content: string
  ): Promise<void> {
    const matcher = this.providers.get(session.agentId).terminalPromptRender
    if (!matcher) {
      throw new AgentMuxError(
        'Provider omitted its terminal prompt render matcher.',
        'INVALID_AGENT_PROVIDER'
      )
    }
    await this.waitForTerminalScreenState(
      session,
      submission.outputCursorBytes,
      true,
      (screen) => screen.composerText(matcher.activeComposer) === content,
      {
        timeoutMs: TERMINAL_PROMPT_RENDER_TIMEOUT_MS,
        timeoutMessage: 'Timed out waiting for the Agent prompt to render.',
        terminalMessage: 'Agent Run exited before the prompt was rendered.'
      }
    )
  }

  private async waitForTerminalScreenState(
    session: AgentMuxAgentSession,
    outputBoundaryByte: number,
    requireOutputAfterBoundary: boolean,
    predicate: (screen: AgentTerminalScreen) => boolean,
    options: {
      timeoutMs?: number
      timeoutMessage: string
      terminalMessage: string
      signal?: AbortSignal
    }
  ): Promise<number> {
    let observation: Awaited<ReturnType<CtxmuxRunAdapter['observeOutput']>> | null = null
    let screen: AgentTerminalScreen | null = null
    let initialized = false
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let tail = Promise.resolve()
    const pending: CtxmuxAdapterDataEvent[] = []
    let resolveState!: (throughByte: number) => void
    let rejectState!: (error: Error) => void
    const state = new Promise<number>((resolve, reject) => {
      resolveState = resolve
      rejectState = reject
    })
    void state.catch(() => {})
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      rejectState(error)
    }
    const inspect = (): void => {
      if (settled || !screen) return
      const crossedBoundary = requireOutputAfterBoundary
        ? screen.throughByte > outputBoundaryByte
        : screen.throughByte >= outputBoundaryByte
      if (crossedBoundary && predicate(screen)) {
        settled = true
        resolveState(screen.throughByte)
      }
    }
    const apply = async (event: CtxmuxAdapterDataEvent, inspectAfterWrite: boolean): Promise<void> => {
      if (settled || !screen) return
      await screen.write(event)
      if (inspectAfterWrite) inspect()
    }
    const enqueue = (event: CtxmuxAdapterDataEvent): void => {
      tail = tail.then(async () => await apply(event, true))
      void tail.catch((error) => fail(error instanceof Error ? error : new Error(String(error))))
    }
    const abort = (): void => fail(new AgentMuxError(
      'Terminal screen observation was cancelled.',
      'AGENT_PROMPT_READINESS_CANCELLED'
    ))
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => fail(new AgentMuxError(
        options.timeoutMessage,
        'AGENT_PROMPT_RENDER_TIMEOUT'
      )), options.timeoutMs)
    }
    try {
      observation = await this.kernel.observeOutput(session.run.runId, 0, (event) => {
        if (event.type === 'data') {
          if (initialized) enqueue(event)
          else pending.push(event)
        } else if (event.type === 'gap') {
          fail(new AgentMuxError(
            'Terminal screen evidence was evicted from CtxMux replay.',
            'OUTPUT_GAP'
          ))
        } else if (event.type === 'exit') {
          fail(new AgentMuxError(options.terminalMessage, 'AGENT_PROMPT_RENDER_FAILED'))
        }
      })
      if (observation.gap) {
        throw new AgentMuxError(
          'Terminal screen evidence was evicted from CtxMux replay.',
          'OUTPUT_GAP'
        )
      }
      screen = new AgentTerminalScreen(observation.run.cols, observation.run.rows)
      for (const event of observation.replay) await apply(event, false)
      pending.sort((left, right) => left.startByte - right.startByte)
      initialized = true
      for (const event of pending.splice(0)) enqueue(event)
      await tail
      inspect()
      return await state
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
      return await state
    } finally {
      initialized = false
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      await tail.catch(() => {})
      await observation?.close().catch(() => {})
      screen?.dispose()
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
    return await this.serializeAgentInput(requestedSession, async (session, run) => {
      const expectedByte = this.agentInputCursors.get(session.agentSessionId) ?? run.acceptedInputBytes
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
      this.agentInputCursors.set(session.agentSessionId, result.run.acceptedInputBytes)
      return {
        runId: session.run.runId,
        appliedByteRange: result.appliedByteRange,
        acceptedThroughByte: result.run.acceptedInputBytes
      }
    })
  }

  private async serializeAgentInput<T>(
    requestedSession: AgentMuxAgentSession,
    operation: (session: AgentMuxAgentSession, run: CtxmuxAdapterRun) => Promise<T>
  ): Promise<T> {
    const agentSessionId = requestedSession.agentSessionId
    const previous = this.agentInputTails.get(agentSessionId) ?? Promise.resolve()
    let result!: T
    const queued = previous.catch(() => {}).then(async () => {
      const session = this.requireAgentSession(agentSessionId)
      if (!sameRun(session.run, requestedSession.run)) {
        throw new AgentMuxError('Agent Session changed before Input was accepted.', 'STALE_AGENT_SESSION')
      }
      const run = await this.requireCurrentAgentRun(session)
      result = await operation(session, run)
    })
    const tail = queued.then(() => {}, () => {})
    this.agentInputTails.set(agentSessionId, tail)
    try {
      await queued
      return result
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
    const stopRun = normalized.eventName === 'Stop'
      ? await this.kernel.status(session.run.runId)
      : null
    const receipt = {
      id: envelope.receiptId,
      agentId: session.agentId,
      agentSessionId: session.agentSessionId,
      run: { ...session.run },
      eventName: normalized.eventName,
      observedAt: normalized.status.observedAt,
      ...(stopRun ? { outputCursorBytes: stopRun.latestOutputBytes } : {})
    }
    const next = await this.registry.update(
      session.agentSessionId,
      session.run,
      (current) => {
        const existingStop = current.terminalStopReceipt?.id === receipt.id
          ? current.terminalStopReceipt
          : undefined
        const persistedReceipt = existingStop
          ? { ...receipt, outputCursorBytes: existingStop.outputCursorBytes }
          : receipt
        return {
          ...current,
          updatedAt: normalized.status.observedAt,
          hookReceipt: persistedReceipt,
          ...(stopRun
            ? {
                terminalStopReceipt: existingStop ?? {
                  id: receipt.id,
                  run: { ...current.run },
                  outputCursorBytes: stopRun.latestOutputBytes
                }
              }
            : {}),
          ...(normalized.nativeHandle ? { nativeHandle: normalized.nativeHandle } : {})
        }
      }
    )
    const persistedReceipt = next.hookReceipt
    if (!persistedReceipt) {
      throw new AgentMuxError('Native Hook receipt was not persisted.', 'HOOK_RECEIPT_INVALID')
    }
    this.publisher.publishHook(next, normalized, persistedReceipt)
    this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
    if (
      normalized.eventName === 'Stop' &&
      next.terminalStopReceipt &&
      next.terminalStopReceipt.readyThroughByte === undefined &&
      next.terminalStopReceipt.consumedBySubmissionId === undefined
    ) {
      this.observeTerminalStopReadiness(next, next.terminalStopReceipt)
    }
  }

  private observeTerminalStopReadiness(
    session: AgentMuxAgentSession,
    stopReceipt: NonNullable<AgentMuxAgentSession['terminalStopReceipt']>
  ): void {
    const matcher = this.providers.get(session.agentId).terminalPromptRender
    if (!matcher) return
    this.terminalStopReadinessCancels.get(session.agentSessionId)?.()
    const controller = new AbortController()
    const cancel = (): void => {
      if (this.terminalStopReadinessCancels.get(session.agentSessionId) === cancel) {
        this.terminalStopReadinessCancels.delete(session.agentSessionId)
      }
      controller.abort()
    }
    this.terminalStopReadinessCancels.set(session.agentSessionId, cancel)
    const persistReady = async (readyThroughByte: number): Promise<void> => {
      try {
        const next = await this.registry.update(
          session.agentSessionId,
          session.run,
          (current) => {
            const currentStop = current.terminalStopReceipt
            if (!currentStop || currentStop.id !== stopReceipt.id) {
              throw new AgentMuxError(
                'Native Stop receipt changed before readiness was persisted.',
                'AGENT_PROMPT_STOP_RECEIPT_CONFLICT'
              )
            }
            if (currentStop.readyThroughByte !== undefined) return current
            if (currentStop.consumedBySubmissionId !== undefined) {
              throw new AgentMuxError(
                'Native Stop receipt was consumed before readiness was persisted.',
                'AGENT_PROMPT_STOP_RECEIPT_CONFLICT'
              )
            }
            return {
              ...current,
              terminalStopReceipt: { ...currentStop, readyThroughByte },
              updatedAt: Date.now()
            }
          }
        )
        this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
      } catch (error) {
        this.publisher.publish({
          type: 'agent-error',
          agentSessionId: session.agentSessionId,
          code: error instanceof AgentMuxError ? error.code : 'AGENT_PROMPT_READINESS_FAILED',
          message: error instanceof Error ? error.message : String(error),
          evidence: {
            source: 'terminal-output',
            observedAt: Date.now(),
            run: { ...session.run }
          }
        })
      } finally {
        if (this.terminalStopReadinessCancels.get(session.agentSessionId) === cancel) {
          this.terminalStopReadinessCancels.delete(session.agentSessionId)
        }
      }
    }
    void this.waitForTerminalScreenState(
      session,
      stopReceipt.outputCursorBytes,
      false,
      (screen) => screen.composerText(matcher.activeComposer) === '',
      {
        timeoutMessage: 'Timed out waiting for an empty Agent composer.',
        terminalMessage: 'Agent Run exited before its Stop receipt became ready.',
        signal: controller.signal
      }
    ).then(persistReady).catch((error) => {
      if (error instanceof AgentMuxError && error.code === 'AGENT_PROMPT_READINESS_CANCELLED') return
      if (this.terminalStopReadinessCancels.get(session.agentSessionId) === cancel) {
        this.terminalStopReadinessCancels.delete(session.agentSessionId)
      }
      this.publisher.publish({
        type: 'agent-error',
        agentSessionId: session.agentSessionId,
        code: error instanceof AgentMuxError ? error.code : 'AGENT_PROMPT_READINESS_FAILED',
        message: error instanceof Error ? error.message : String(error),
        evidence: {
          source: 'terminal-output',
          observedAt: Date.now(),
          run: { ...session.run }
        }
      })
    })
  }

  private async updateNativeHandle(
    agentSessionId: string,
    handle: AgentNativeSessionHandle
  ): Promise<void> {
    const session = this.requireAgentSession(agentSessionId)
    const next = await this.registry.update(
      agentSessionId,
      session.run,
      (current) => ({ ...current, nativeHandle: handle, updatedAt: Date.now() })
    )
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
