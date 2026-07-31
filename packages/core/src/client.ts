import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AgentMuxAcpBridge,
  type AgentMuxAcpBinding
} from './acp-adapter.js'
import { normalizeAgentInteractionResponse } from './agent-interaction.js'
import {
  normalizeLaunchOptionSelection,
  type LaunchOptionSelection
} from './agent-launch-option.js'
import {
  AgentProviderRegistry,
  resolveManagedHookPlan,
  type AgentProvider
} from './agent-provider.js'
import { releaseSubagentRoster } from './hook-normalizer.js'
import { USAGE_FINALIZATION_EVENTS } from './agent-hook-command.js'
import { classifyRunExit } from './agent-run-exit.js'
import { composeAgentLaunchPrompt, composeOutboundMessage } from './agent-outbound-message.js'
import { hashAgentCapability, issueAgentCapability, resolveCapabilityAuthor } from './agent-capability.js'
import { planDiscussion } from './agent-discussion.js'
import {
  ackDeliveryBatch,
  checkDeliveries,
  type DeliveryBatch,
  type DeliveryQueue
} from './agent-delivery-queue.js'
import { answerAsk, cancelAsk, type AgentAsk } from './agent-ask.js'
import {
  AGENT_TERMINAL_CAPABILITY_PERSIST_FAILED,
  AGENT_TERMINAL_HANDSHAKE_FAILED,
  AGENT_TERMINAL_HANDSHAKE_TIMEOUT,
  classifyTerminalHandshakeFailure,
  degradedInputCursor
} from './agent-terminal-handshake-outcome.js'
import {
  handOff,
  openDispatch,
  recordDispatchEvent,
  type Dispatch,
  type DispatchEventKind,
  type HandoffResult
} from './agent-handoff.js'
import { advanceDelivery, type AgentThread } from './agent-message.js'
import { AgentMuxClientEventPublisher } from './client-event-publisher.js'
import { MAX_AGENT_PROMPT_BYTES } from './agent-terminal-screen.js'
import { cloneSession, sameRun } from './agent-session-identity.js'
import { AgentScreenEvidenceStore } from './screen-evidence.js'
import { AgentPromptSubmissionCoordinator } from './prompt-submission.js'
import {
  CtxmuxRunAdapter,
  type CtxmuxAdapterDataEvent,
  type CtxmuxAdapterEvent,
  type CtxmuxAdapterRun,
  type CtxmuxAdapterStopOperation
} from './ctxmux-run-adapter.js'
import { AgentMuxError } from './errors.js'
import type { EndpointReclaimOutcome } from './runtime-endpoint-reclaim.js'
import {
  AgentMuxFileAgentSessionStore,
  type AgentMuxAgentSessionStore
} from './agent-session-store.js'
import {
  AgentMuxAgentSessionRegistry,
  type AgentMuxAgentSessionLookup
} from './agent-session-registry.js'
import {
  decideAgentSessionContinuity,
  type AgentMuxAgentContinuityInput,
  type AgentMuxAgentContinuityResult
} from './agent-session-continuity.js'
import { AgentHookServer, type AgentHookBinding } from './hook-server.js'
import { AgentManagedHookInstaller } from './managed-hook-installer.js'
import { defaultCtxmuxStateDirectory, resolveCoreBinPath } from './runtime-paths.js'
import { projectAgentMuxRuntimeSubjects, type AgentMuxRuntimeProjection } from './runtime.js'
import { agentTimelineMutationFromAcpEvent } from './session-timeline.js'
import type {
  AgentCapabilitySnapshot,
  AgentCatalogEntry,
  AgentExecutorId,
  AgentProviderId,
  AgentMuxAgentSession,
  AgentMuxClientEvent,
  AgentMuxInteractionRequest,
  AgentMuxInteractionResponse,
  AgentMuxRun,
  AgentMuxRunAppliedSize,
  AgentMuxRunAttachment,
  AgentMuxRunDataEvent,
  AgentMuxRunInputAck,
  AgentMuxRunInputOperation,
  AgentMuxRunOutputAck,
  AgentMuxRunRef,
  AgentMuxStoredAgentSession,
  AgentMuxRuntimeDiagnostics,
  AgentMuxRuntimeIdentity,
  AgentNativeSessionHandle,
  AgentTerminalCapabilityState,
  AgentTimelineItem,
  AgentTimelineMutation,
  AgentTimelineSnapshot,
  AgentTerminalHandshake,
  AgentStatus,
  NativeHookEnvelope
} from './types.js'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const TERMINAL_HANDSHAKE_TIMEOUT_MS = 10_000
const AGENTMUX_CLI_PATH = resolveCoreBinPath('agentmux')

export type AgentMuxAgentCreateInput = {
  agentSessionId?: string
  createOperationId?: string
  providerId: AgentProviderId
  executorId: AgentExecutorId
  workspacePath: string
  injectAgentMuxGuide: boolean
  prompt?: string
  /**
   * AgentMux 自己要对 Agent 说的额外上下文（如 Scratch Topic 说明），署名进出站信封而非混进用户段。
   * 与 `prompt`（用户/发起者的原话，逐字节透传）分层：调用方分开传，信封组装由 Core 的出口负责。
   */
  agentMuxNote?: string
  args?: readonly string[]
  /**
   * Chosen ids for the sealed launch options this Provider declares (see agent-launch-option.ts). The
   * argv each choice contributes is resolved core-side and appended at spawn; an option or choice the
   * Provider does not declare fails closed rather than launching an un-offered posture.
   */
  launchOptions?: LaunchOptionSelection
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

type AgentMuxAgentResumeOperationInput = Omit<AgentMuxAgentResumeInput, 'prompt'> & {
  prompt?: string
}

export type AgentMuxAgentPromptInput = {
  agentSessionId: string
  operationId: string
  prompt: string
}

export type AgentMuxAgentInteractionInput = {
  agentSessionId: string
  expectedRun: AgentMuxRunRef
  response: AgentMuxInteractionResponse
}

export type AgentMuxAgentPostureInput = {
  agentSessionId: string
  expectedRun: AgentMuxRunRef
  modeId: string
}

export type AgentMuxAgentRespawnInput = Omit<
  AgentMuxAgentCreateInput,
  'providerId' | 'executorId' | 'workspacePath' | 'agentSessionId'
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
  /**
   * Installs the provider's managed Hook config before its first launch. Defaults to a `hooks`
   * subdirectory of the ctxmux state directory so backups live beside the rest of the runtime state.
   * Tests inject one over an isolated state directory to keep hook writes out of the real `$HOME`.
   */
  hookInstaller?: AgentManagedHookInstaller
}

export type AgentMuxAgentRuntimeStatus = {
  session: AgentMuxAgentSession
  run: AgentMuxRun
  capabilities: AgentCapabilitySnapshot['capabilities']
}

function runRef(runId: string): AgentMuxRunRef {
  return { runId }
}

/**
 * Normalize the one transport error which has a precise meaning inside the terminal handshake.
 *
 * CtxMux may report a vanished Run from any of the handshake's three I/O phases (attach/replay,
 * the post-replay status boundary, or the capability Input write). Keeping this mapping at the
 * handshake boundary gives the public connect loop one stable, Session-scoped classification while
 * lifecycle callers can still fail closed on the resulting `AGENT_TERMINAL_HANDSHAKE_FAILED`.
 */
function mapVanishedTerminalHandshakeRun(error: unknown): unknown {
  if (!(error instanceof AgentMuxError) || error.code !== 'CTXMUX_run_not_found') return error
  const mapped = new AgentMuxError(
    'Agent Run disappeared before its terminal capability query was observed.',
    AGENT_TERMINAL_HANDSHAKE_FAILED,
    error.detail
  )
  // Keep the transport error available to diagnostics without leaking its transport-specific code
  // into the public handshake contract.
  mapped.cause = error
  return mapped
}

function safeId(value: string, name: string): string {
  if (!SAFE_ID.test(value)) {
    throw new AgentMuxError(`${name} must contain only letters, numbers, underscore, or dash.`, 'INVALID_SESSION_ID')
  }
  return value
}

function hookBindingIdentity(operationId: string): string {
  return createHash('sha256').update(operationId).digest('base64url')
}

function agentLifecycleOperationIdentity(
  kind: 'create' | 'resume' | 'stop',
  agentSessionId: string,
  requestedOperationId: string
): string {
  return createHash('sha256')
    .update(JSON.stringify(['agentmux-agent-lifecycle-v1', kind, agentSessionId, requestedOperationId]))
    .digest('base64url')
}

function terminalHandshakeOperationIdentity(
  providerId: AgentProviderId,
  runId: string,
  handshake: AgentTerminalHandshake
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      'agentmux-terminal-handshake-v1',
      providerId,
      runId,
      handshake.query,
      handshake.response
    ]))
    .digest('base64url')
}

function terminalInitialPromptReadinessIdentity(
  session: AgentMuxAgentSession,
  handshakeOperationId: string
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      'agentmux-terminal-prompt-readiness-v1',
      'initial-composer',
      session.providerId,
      session.run.runId,
      handshakeOperationId
    ]))
    .digest('base64url')
}

function agentInteractionOperationIdentity(
  session: AgentMuxAgentSession,
  requestId: string,
  responseDigest: string,
  data: string
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      'agentmux-agent-interaction-v1',
      session.agentSessionId,
      session.run.runId,
      requestId,
      responseDigest,
      data
    ]))
    .digest('base64url')
}

function digestInteractionResponse(response: AgentMuxInteractionResponse): string {
  return createHash('sha256').update(JSON.stringify(response)).digest('base64url')
}

function assertAgentPromptSize(prompt: string): void {
  if (Buffer.byteLength(prompt) > MAX_AGENT_PROMPT_BYTES) {
    throw new AgentMuxError(
      `Agent prompt exceeds the ${MAX_AGENT_PROMPT_BYTES}-byte limit.`,
      'INVALID_AGENT_PROMPT'
    )
  }
}

export function terminalEnvironment(
  environment: Readonly<Record<string, string>>,
  agentSessionStorePath?: string
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
    AGENTMUX_CLI: AGENTMUX_CLI_PATH,
    // Tell every process AgentMux spawns where the Agent Session store lives, so the CLI an Agent runs
    // resolves sessions out of the SAME file this Client writes — not the temp default it would otherwise
    // reach. The path's authority is whoever constructed the store (the desktop points it at userData).
    ...(agentSessionStorePath ? { AGENTMUX_AGENT_SESSION_STORE: agentSessionStorePath } : {})
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
    providerId: agentSession?.providerId ?? null,
    executorId: agentSession?.executorId ?? null,
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
  private readonly store: AgentMuxAgentSessionStore
  private readonly publisher = new AgentMuxClientEventPublisher()
  private readonly acp: AgentMuxAcpBridge
  private readonly hookServer: AgentHookServer
  private readonly hookInstaller: AgentManagedHookInstaller
  private unsubscribeKernel: (() => void) | null = null
  private unsubscribeKernelErrors: (() => void) | null = null
  private connecting: Promise<void> | null = null
  private connectionEpoch = 0
  private connected = false
  private readonly runPids = new Map<string, number | null>()
  private readonly hookBindings = new Map<string, AgentHookBinding>()
  private readonly agentInputCursors = new Map<string, number>()
  private readonly agentInputTails = new Map<string, Promise<void>>()
  private readonly agentContinuityTails = new Map<string, Promise<void>>()
  // 「用户为这个 runId 发起过停止」这条**意图**事实的台账。与内核报的退出**结果**分居两处：控制面在
  // stop 路径写入意图，acceptKernelEvent 在退出事件里读它、合成 exitReason。一个 runId 只会退出一次，
  // 分类后即删，不留驻。裸集合足矣——意图是布尔（在场即「我们关的」），不需要携带别的。
  private readonly stopRequestedRuns = new Set<string>()
  private readonly screenEvidence: AgentScreenEvidenceStore
  private readonly promptSubmission: AgentPromptSubmissionCoordinator

  constructor(options: AgentMuxClientOptions = {}) {
    this.providers = new AgentProviderRegistry(options.providers)
    this.store = options.store ?? new AgentMuxFileAgentSessionStore()
    this.registry = new AgentMuxAgentSessionRegistry(this.store)
    this.kernel = new CtxmuxRunAdapter()
    this.hookServer = new AgentHookServer(
      async (event, signal) => await this.acceptHookEvent(event, signal)
    )
    this.hookInstaller = options.hookInstaller
      ?? new AgentManagedHookInstaller(join(defaultCtxmuxStateDirectory(), 'hooks'))
    this.acp = new AgentMuxAcpBridge(
      {
        onEvent: async (agentSessionId, event, evidence) => {
          const session = this.registry.get(agentSessionId)
          const observed = {
            ...evidence,
            run: { ...session.run }
          }
          const mutation = agentTimelineMutationFromAcpEvent(agentSessionId, event, observed)
          if (mutation) await this.persistAndPublishTimeline(mutation, observed)
          if (event.type === 'status' && event.state !== 'unknown') {
            await this.persistSemanticStatus(agentSessionId, session.run, {
              state: event.state,
              source: 'acp',
              observedAt: observed.observedAt,
              ...(event.detail === undefined ? {} : { detail: event.detail })
            })
          }
          this.publisher.publishAcp(agentSessionId, event, observed)
        },
        onNativeHandle: async (agentSessionId, handle) => {
          await this.updateNativeHandle(agentSessionId, handle)
        },
        onInteraction: async (request) => {
          const session = this.requireAgentSession(request.agentSessionId)
          const observedRequest = {
            ...request,
            evidence: { ...request.evidence, run: { ...session.run } }
          }
          const next = await this.persistPendingInteraction(observedRequest)
          this.publisher.publishInteraction(observedRequest)
          this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
        },
        onInteractionSettled: async (request) => {
          const session = this.requireAgentSession(request.agentSessionId)
          const next = await this.clearPendingInteraction(session, request.id)
          this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
        }
      }
    )
    this.screenEvidence = new AgentScreenEvidenceStore({
      kernel: this.kernel,
      providers: this.providers
    })
    this.promptSubmission = new AgentPromptSubmissionCoordinator({
      kernel: this.kernel,
      providers: this.providers,
      registry: this.registry,
      publisher: this.publisher,
      agentInputCursors: this.agentInputCursors,
      screenEvidence: this.screenEvidence,
      requireAgentSession: (agentSessionId) => this.requireAgentSession(agentSessionId),
      assertAgentRun: (session, run) => { this.assertAgentRun(session, run) },
      updateExactAgentSession: (agentSessionId, expectedRun, update) =>
        this.updateExactAgentSession(agentSessionId, expectedRun, update)
    })
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
      // Hook config files outlive an App bundle. Re-ensure the managed entries from the current
      // executable before restoring bindings so a moved/replaced install cannot leave old
      // `/Applications/AgentMux.app` commands behind. This is deliberately best-effort and
      // deduplicated by Provider + Workspace; a hook repair failure is an advisory diagnostic,
      // never a reason to block the runtime or healthy Agent Runs.
      await this.repairManagedHooks()
      await this.tryRestoreHookIngress(runs)
      // Probe every running Session together. A serial `await` here makes N healthy Agents
      // wait behind N ten-second capability windows, which is especially visible when the
      // user opens several sessions at once. Each promise still owns one exact Run; only the
      // scoped vanished-Run classification is consumed here. Unknown errors remain fatal, but
      // we wait for all probes to settle first so a slow sibling cannot be abandoned halfway
      // through its cleanup and leave a shared attachment behind.
      const handshakeErrors: unknown[] = []
      await Promise.all(this.registry.list().map(async (session) => {
        const run = runs.find((candidate) => candidate.runId === session.run.runId)
        if (run?.state.type !== 'running') return
        try {
          await this.ensureTerminalHandshakeOrDegrade(session, run)
        } catch (error) {
          if (
            error instanceof AgentMuxError &&
            error.code === AGENT_TERMINAL_HANDSHAKE_FAILED
          ) {
            // A Run that vanished during this Session's handshake is a real failure for this exact
            // Agent, but it is not a failure of the shared CtxMux connection. Keep the other Sessions
            // attachable and make the scoped failure visible to the renderer.
            this.publisher.publish({
              type: 'agent-error',
              agentSessionId: session.agentSessionId,
              code: error.code,
              message: error.message,
              evidence: {
                source: 'run-process',
                observedAt: Date.now(),
                run: { ...session.run }
              }
            })
            return
          }
          // Preserve the existing fail-closed behavior for Store invariant failures and
          // unclassified transport errors. Promise.all waits for sibling probes rather than
          // serializing their ten-second timers.
          handshakeErrors.push(error)
        }
      }))
      if (handshakeErrors.length > 0) throw handshakeErrors[0]
      await this.recoverPendingInteractionResponses(runs)
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
    this.stopRequestedRuns.clear()
    this.agentInputCursors.clear()
    this.agentInputTails.clear()
    this.promptSubmission.cancelAllReadiness()
    this.screenEvidence.discardAll()
  }

  async dispose(): Promise<void> {
    await this.hookServer.stop()
    this.disconnect()
    await Promise.allSettled([...this.hookBindings.values()].map(async (binding) => await binding.close()))
    this.hookBindings.clear()
    await this.acp.dispose()
    this.publisher.dispose()
  }

  /**
   * Registers a synchronous observation callback. Copy work into a
   * Consumer-owned bounded queue before returning if asynchronous handling is
   * required. Promise-returning callbacks are detached on their first event.
   */
  onEvent(listener: (event: AgentMuxClientEvent) => void): () => void {
    return this.publisher.onEvent(listener)
  }

  catalog(): AgentCatalogEntry[] {
    return this.providers.catalog()
  }

  agentSessions(): AgentMuxAgentSession[] {
    return this.registry.list().map(cloneSession)
  }

  agentSession(agentSessionId: string): AgentMuxAgentSession {
    return cloneSession(this.registry.get(agentSessionId))
  }

  async sessionTimeline(agentSessionId: string): Promise<AgentTimelineSnapshot> {
    this.requireAgentSession(agentSessionId)
    return await this.store.loadTimeline(agentSessionId)
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
        sourceCommit: '073e206407ce28331aa882c2c80e9354cfe2879a',
        artifactPlatform: 'darwin-arm64',
        ready: true,
        capabilities: {
          transport: 'local-unix',
          orderedOutputBytes: true,
          boundedReplay: true,
          recoverableInput: true,
          resize: true,
          interrupt: true,
          completeStop: true
        }
      }
    }
  }

  /**
   * 本次连接顺带做的孤儿 endpoint 目录回收结果；未连接过时为 null。
   *
   * 回收本身是启动路径上的自愈动作，成功不打扰任何人。但失败必须能被看见——否则一个每次都删不掉的
   * 目录会无声堆积，直到磁盘告警才浮出来。诊断经这里读取。
   */
  endpointReclaim(): EndpointReclaimOutcome | null {
    return this.kernel.lastEndpointReclaim
  }

  async probeAgent(providerId: AgentProviderId, commandOverride?: string): Promise<AgentCapabilitySnapshot> {
    this.requireConnected()
    return await this.providers.get(providerId).probeCapabilities(
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

  async runtimeProjection(): Promise<AgentMuxRuntimeProjection> {
    const runs = await this.listRuns()
    return {
      hostId: 'local',
      subjects: projectAgentMuxRuntimeSubjects('local', runs, this.registry.list().map(cloneSession))
    }
  }

  async statusAgent(agentSessionId: string): Promise<AgentMuxAgentRuntimeStatus> {
    this.requireConnected()
    const session = this.requireAgentSession(agentSessionId)
    const run = await this.requireCurrentAgentRun(session)
    return {
      session: cloneSession(session),
      run: projectRun(run, session),
      capabilities: { ...this.providers.get(session.providerId).catalog.capabilities }
    }
  }

  async createTerminal(input: AgentMuxTerminalCreateInput): Promise<AgentMuxRun> {
    this.requireConnected()
    const run = await this.kernel.start({
      operationKey: input.createOperationId ?? randomUUID(),
      program: input.command ?? process.env.SHELL ?? '/bin/sh',
      args: input.args ?? [],
      cwd: input.workspacePath,
      env: terminalEnvironment(input.env ?? {}, this.agentSessionStorePath()),
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
    // 先记停止意图，再动内核：若退出事件在 stop 返回前就到（自退与我们的 stop 撞车），分类仍读得到意图。
    this.stopRequestedRuns.add(ref.runId)
    await this.kernel.stop(await this.kernel.prepareStop(ref.runId))
    this.runPids.delete(ref.runId)
    this.publisher.publish({
      type: 'run-removed',
      run: { ...ref },
      evidence: { source: 'user', observedAt: Date.now(), run: { ...ref } }
    })
  }

  /**
   * 一次 Discussion：受管 Agent A 创建专属 Agent B 并投递首条消息。
   *
   * author 由 Core 从 A 交回的凭证解析——调用方声称的身份不作数。首条消息作为 B 的启动
   * Prompt 投递，但那只是**账本首条消息的 transport**：Provider 收下启动参数最多证明
   * `delivered`，证明不了 B 接受或回复了它。
   *
   * 创建走的是 `createAgent` 那条已验证的 reservation → commit 原子路径，不复制一份；
   * 相同 operationId 因此天然落到同一个 Thread，重试不会再建一个 Session、
   * 也不会重复注入 Prompt。
   */
  /**
   * 解析调用方的 author，失败即关闭。
   *
   * 每个通信动作都先过这里：author 由 Core 从凭证解析，调用方声称的身份不作数。
   * 抽成一处，是为了让"新增一个动作"不必重新想一遍怎么验身份——漏验一次就是一个冒充口子。
   */
  private resolveMessageAuthor(capability: string, callerAgentSessionId: string): string {
    const caller = this.registry.get(callerAgentSessionId)
    return resolveCapabilityAuthor(capability, {
      agentSessionId: caller.agentSessionId,
      workspacePath: caller.workspacePath,
      runId: caller.run.runId,
      capabilityHash: caller.capabilityHash ?? ''
    }, caller.run.runId)
  }

  /** 取最旧的一批未确认投递。Ack 之前重复调用重放同一批——崩溃重连才不会丢消息。 */
  checkDeliveries(input: {
    capability: string
    callerAgentSessionId: string
    queue: DeliveryQueue
    limit: number
  }): DeliveryBatch {
    const consumerId = this.resolveMessageAuthor(input.capability, input.callerAgentSessionId)
    return checkDeliveries(input.queue, consumerId, input.limit)
  }

  /** 确认一批。只推进这个 consumer 的游标，不改变消息本身的状态。 */
  ackDeliveryBatch(input: {
    capability: string
    callerAgentSessionId: string
    queue: DeliveryQueue
    generation: number
  }): DeliveryQueue {
    const consumerId = this.resolveMessageAuthor(input.capability, input.callerAgentSessionId)
    return ackDeliveryBatch(input.queue, consumerId, input.generation)
  }

  /** 回答一个问题。相同回答幂等，不同回答冲突。 */
  answerAsk(input: {
    capability: string
    callerAgentSessionId: string
    ask: AgentAsk
    answer: string
  }): AgentAsk {
    this.resolveMessageAuthor(input.capability, input.callerAgentSessionId)
    return answerAsk(input.ask, input.answer, Date.now())
  }

  /** 不等了。与超时同为 closed，但原因不同。 */
  cancelAsk(input: { capability: string; callerAgentSessionId: string; ask: AgentAsk }): AgentAsk {
    this.resolveMessageAuthor(input.capability, input.callerAgentSessionId)
    return cancelAsk(input.ask, Date.now())
  }

  /** 交出去：责任跟着工作走，原 Owner 不再等待。 */
  handOff(input: {
    capability: string
    callerAgentSessionId: string
    toAgentSessionId: string
    taskId: string
  }): HandoffResult {
    const from = this.resolveMessageAuthor(input.capability, input.callerAgentSessionId)
    return handOff({
      fromAgentSessionId: from,
      toAgentSessionId: input.toAgentSessionId,
      taskId: input.taskId,
      at: Date.now()
    })
  }

  /** 派出去：所有权留在派发方，它仍要接问题、接升级、接收工。 */
  openDispatch(input: {
    capability: string
    callerAgentSessionId: string
    dispatchId: string
    workerAgentSessionId: string
    taskId: string
    attempt: number
  }): Dispatch {
    const owner = this.resolveMessageAuthor(input.capability, input.callerAgentSessionId)
    return openDispatch({
      dispatchId: input.dispatchId,
      ownerAgentSessionId: owner,
      workerAgentSessionId: input.workerAgentSessionId,
      taskId: input.taskId,
      attempt: input.attempt,
      at: Date.now()
    })
  }

  /** 记一次派发事件。同一事件重放幂等，不会记两次。 */
  recordDispatchEvent(input: {
    capability: string
    callerAgentSessionId: string
    dispatch: Dispatch
    kind: DispatchEventKind
  }): Dispatch {
    this.resolveMessageAuthor(input.capability, input.callerAgentSessionId)
    return recordDispatchEvent(input.dispatch, input.kind, Date.now())
  }

  async startDiscussion(input: {
    capability: string
    /**
     * 调用方自称的 Agent Session。它只是**上下文提示**：Core 会用凭证核对它，
     * 对不上就拒绝——所以改这个字段冒充别人是行不通的。
     */
    callerAgentSessionId: string
    executorId: AgentExecutorId
    providerId: AgentProviderId
    workspacePath: string
    body: string
    operationId: string
  }): Promise<{ thread: AgentThread; session: AgentMuxAgentSession }> {
    this.requireConnected()
    const author = this.registry.get(input.callerAgentSessionId)
    const plan = planDiscussion({
      capability: input.capability,
      binding: {
        agentSessionId: author.agentSessionId,
        workspacePath: author.workspacePath,
        runId: author.run.runId,
        capabilityHash: author.capabilityHash ?? ''
      },
      currentRunId: author.run.runId,
      targetWorkspacePath: input.workspacePath,
      body: input.body,
      operationId: input.operationId,
      now: Date.now()
    })
    const session = await this.createAgent({
      executorId: input.executorId,
      providerId: input.providerId,
      workspacePath: input.workspacePath,
      prompt: plan.launchPrompt,
      injectAgentMuxGuide: true,
      // 同一个 operation id：重试落到同一次创建，不会重复 Spawn 或重复注入 Prompt。
      createOperationId: input.operationId
    })
    return {
      thread: {
        ...plan.thread,
        targetAgentSessionId: session.agentSessionId,
        // ctxmux 收下了启动输入——这最多证明送达。
        delivery: advanceDelivery(plan.thread.delivery, 'delivered', Date.now())
      },
      session
    }
  }

  async createAgent(input: AgentMuxAgentCreateInput): Promise<AgentMuxAgentSession> {
    this.requireConnected()
    if (input.prompt !== undefined) assertAgentPromptSize(input.prompt.trim())
    const agentSessionId = safeId(input.agentSessionId ?? randomUUID(), 'Agent Session id')
    const executorId = safeId(input.executorId, 'Agent Executor id')
    const lifecycleOperationId = agentLifecycleOperationIdentity(
      'create',
      agentSessionId,
      input.createOperationId ?? randomUUID()
    )
    const reservation = await this.registry.reserveNew(agentSessionId, lifecycleOperationId)
    let hookBinding: AgentHookBinding | null = null
    let persisted: AgentMuxStoredAgentSession | null = null
    let abandonedRun: AgentMuxRunRef | null = null
    try {
      const provider = this.providers.get(input.providerId)
      // 这个 Run 的说话凭证。raw 只进受管进程的环境，Core 侧只留 hash。
      const invocationCapability = issueAgentCapability()
      const capability = await this.probeAgent(input.providerId, input.commandOverride)
      if (!capability.installed) {
        throw new AgentMuxError(`${provider.label} is not installed on this host.`, 'AGENT_NOT_FOUND')
      }
      const launchPrompt = composeAgentLaunchPrompt(
        input.prompt,
        input.injectAgentMuxGuide,
        input.agentMuxNote
      )
      // Sealed launch options resolve to their argv core-side (fails closed on an un-declared choice) and
      // join the caller's args ahead of the prompt, exactly as buildArgs orders every other flag.
      const launchOptionArgv = provider.resolveLaunchArgv(input.launchOptions ?? {})
      const plan = provider.buildLaunch({
        workspacePath: input.workspacePath,
        prompt: launchPrompt,
        args: [...(input.args ?? []), ...launchOptionArgv],
        env: input.env ?? {},
        ...(input.commandOverride === undefined ? {} : { commandOverride: input.commandOverride })
      })
      await this.ensureManagedHooks(provider, input.providerId, input.workspacePath, agentSessionId, input.env ?? {})
      await this.requireHookIngressOwner()
      hookBinding = this.hookServer.createBinding(
        agentSessionId,
        input.providerId,
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
          input.providerId,
          executorId,
          hookBinding,
          lifecycleOperationId,
          invocationCapability
        ),
        ...(input.cols === undefined ? {} : { cols: input.cols }),
        ...(input.rows === undefined ? {} : { rows: input.rows })
      })
      const launchOptions = normalizeLaunchOptionSelection(input.launchOptions)
      const now = Date.now()
      const session: AgentMuxStoredAgentSession = {
        kind: 'agent',
        agentSessionId,
        providerId: input.providerId,
        executorId,
        hostId: 'local',
        workspacePath: input.workspacePath,
        run: runRef(run.runId),
        retiredRuns: [],
        hookBindingId: hookBinding.bindingId,
        hookToken: hookBinding.endpoint.token,
        // 只存 hash：raw 凭证已随 env 进了受管进程，Core 这边不再留明文。
        capabilityHash: hashAgentCapability(invocationCapability),
        outputCursorBytes: 0,
        createdAt: now,
        updatedAt: now,
        ...(launchOptions ? { launchOptions } : {})
      }
      if (
        !launchPrompt.trim() &&
        (input.args?.length ?? 0) === 0 &&
        provider.terminalHandshake &&
        provider.terminalPromptRender
      ) {
        const handshakeOperationId = terminalHandshakeOperationIdentity(
          session.providerId,
          session.run.runId,
          provider.terminalHandshake
        )
        session.terminalPromptReadiness = {
          source: 'initial-composer',
          id: terminalInitialPromptReadinessIdentity(session, handshakeOperationId),
          run: { ...session.run },
          outputCursorBytes: 0
        }
      }
      let readySession = session
      try {
        persisted = await this.registry.commitLifecycle(reservation, session)
        await hookBinding.bindRun(run.runId)
        // 超时不回滚。下面的 catch 会关 hook 绑定、退休 run、删 session——那是在用我们一次
        // 慢探测杀掉一个刚启动好的健康 Agent。只有 run 真的退出了才该走那条路。
        readySession = await this.ensureTerminalHandshakeOrDegrade(session, run)
      } catch (error) {
        const rollbackErrors: unknown[] = [error]
        try {
          await hookBinding.close()
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
      if (input.prompt?.trim()) {
        await this.recordPromptAfterSideEffect(
          readySession,
          `prompt:${lifecycleOperationId}`,
          'Initial prompt',
          input.prompt.trim(),
          now
        )
      }
      return cloneSession(readySession)
    } finally {
      if (hookBinding && ![...this.hookBindings.values()].includes(hookBinding)) await hookBinding.close()
      await this.registry.releaseLifecycle(reservation, abandonedRun ? [abandonedRun] : [])
    }
  }

  /**
   * Ensure the provider's managed Hook config is installed before its process starts. This is the
   * F3 launch-time trigger: idempotent (an already-current config is a no-op) and install-and-leave —
   * the config is never uninstalled on stop, because a provider like antigravity shares one global
   * `~/.gemini` file across every concurrent agent and ripping it out would break a running sibling.
   *
   * Best-effort: a native provider whose hook config cannot be written still launches (its terminal
   * output remains observable) — the install failure is surfaced as a non-fatal `agent-error` rather
   * than aborting the launch. Providers whose hooks are `unmanaged` (e.g. pi's TypeScript extension)
   * never reach the installer — the `explicit-managed` gate below returns before a plan is resolved.
   *
   * The launch `env` is threaded into plan resolution because a provider's config dir can be env-derived
   * (hermes reads `$HERMES_HOME`): the installer must target the same dir the launched process will read.
   */
  private async ensureManagedHooks(
    provider: AgentProvider,
    providerId: AgentProviderId,
    workspacePath: string,
    agentSessionId: string,
    env: Readonly<Record<string, string>>
  ): Promise<void> {
    const hookStrategy = provider.catalog.hookStrategy
    if (hookStrategy.kind !== 'native' || hookStrategy.installation !== 'explicit-managed') return
    try {
      const plan = resolveManagedHookPlan(providerId, workspacePath, env)
      if (!plan) return
      await this.hookInstaller.ensure(plan)
    } catch (error) {
      this.publisher.publish({
        type: 'agent-error',
        agentSessionId,
        code: error instanceof AgentMuxError ? error.code : 'HOOK_INSTALL_FAILED',
        message: `Managed Hook install for ${provider.label} failed; launching without status hooks. ${
          error instanceof Error ? error.message : String(error)
        }`,
        evidence: { source: 'user', observedAt: Date.now() }
      })
    }
  }

  private async repairManagedHooks(): Promise<void> {
    const repaired = new Set<string>()
    for (const session of this.registry.list()) {
      let provider: AgentProvider
      try {
        provider = this.providers.get(session.providerId)
      } catch {
        // A persisted Session for an unavailable Provider is handled by the existing Session
        // projection. It must not prevent other Providers' hook paths from being repaired.
        continue
      }
      if (
        provider.catalog.hookStrategy.kind !== 'native' ||
        provider.catalog.hookStrategy.installation !== 'explicit-managed'
      ) continue
      const key = `${session.providerId}\u0000${session.workspacePath}`
      if (repaired.has(key)) continue
      repaired.add(key)
      await this.ensureManagedHooks(
        provider,
        session.providerId,
        session.workspacePath,
        session.agentSessionId,
        {}
      )
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

  // Per-Agent-Session serialization of continuity attempts. NOT what bounds new Runs to one — the
  // store's `reserveLifecycle` is an atomic check-and-set, so a concurrent loser fails its
  // reservation before ever reaching `kernel.start` even with this tail removed (measured).
  // What the tail buys is the loser's CLASSIFICATION: serialized behind the winner, its expectedRun
  // fence sees the Run already replaced and reports `session-run-changed` with `currentRun` pointing
  // at the real new Run. Run them concurrently and the loser's fence passes on the stale Run, then
  // trips the reservation and surfaces a bare `lifecycle-busy` carrying an outdated `currentRun` —
  // a worse answer to "why did my recovery not happen". Guarded by the concurrency tests in
  // agent-session-continuity.test.ts; deleting this makes them red on the reason, not on the count.
  async ensureAgentContinuity(
    input: AgentMuxAgentContinuityInput
  ): Promise<AgentMuxAgentContinuityResult> {
    this.requireConnected()
    safeId(input.agentSessionId, 'Agent Session id')
    safeId(input.operationId, 'Agent continuity operation id')
    const previous = this.agentContinuityTails.get(input.agentSessionId) ?? Promise.resolve()
    let result!: AgentMuxAgentContinuityResult
    const operation = previous.catch(() => {}).then(async () => {
      result = await this.performAgentContinuity(input)
    })
    const tail = operation.then(() => {}, () => {})
    this.agentContinuityTails.set(input.agentSessionId, tail)
    try {
      await operation
      return result
    } finally {
      if (this.agentContinuityTails.get(input.agentSessionId) === tail) {
        this.agentContinuityTails.delete(input.agentSessionId)
      }
    }
  }

  async resumeAgent(input: AgentMuxAgentResumeInput): Promise<AgentMuxAgentSession> {
    const prompt = input.prompt.trim()
    if (!prompt) throw new AgentMuxError('Agent resume prompt cannot be empty.', 'INVALID_AGENT_PROMPT')
    assertAgentPromptSize(prompt)
    return await this.resumeAgentRun({ ...input, prompt })
  }

  private async resumeAgentRun(
    input: AgentMuxAgentResumeOperationInput,
    expectedRun?: AgentMuxRunRef,
    knownCapability?: AgentCapabilitySnapshot
  ): Promise<AgentMuxAgentSession> {
    this.requireConnected()
    const current = this.requireAgentSession(input.agentSessionId)
    if (expectedRun && !sameRun(current.run, expectedRun)) {
      throw new AgentMuxError(
        'Agent Session changed before native resume.',
        'STALE_AGENT_SESSION'
      )
    }
    const trimmedPrompt = input.prompt?.trim()
    // resume 是纯用户话：非空时经唯一出口产出，不加 amux 信封——用户原文逐字节透传。
    const prompt = trimmedPrompt ? composeOutboundMessage({ user: trimmedPrompt }) : undefined
    const lifecycleOperationId = agentLifecycleOperationIdentity(
      'resume',
      current.agentSessionId,
      safeId(input.operationId, 'Agent resume operation id')
    )
    const reservation = await this.registry.reserveExisting(
      'resume',
      current.agentSessionId,
      current.run,
      lifecycleOperationId
    )
    let hookBinding: AgentHookBinding | null = null
    let persisted: AgentMuxStoredAgentSession | null = null
    let abandonedRun: AgentMuxRunRef | null = null
    let operationError: unknown = null
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
      const provider = this.providers.get(current.providerId)
      // resume 换了 Run，就换一枚凭证——旧 Run 的那枚随之作废，不能再以此 Agent 名义说话。
      const invocationCapability = issueAgentCapability()
      const capability = knownCapability ?? await this.probeAgent(current.providerId, input.commandOverride)
      if (!capability.installed) {
        throw new AgentMuxError(`${provider.label} is not installed on this host.`, 'AGENT_NOT_FOUND')
      }
      // Re-resolve the posture the create fixed and append it to the resume args exactly as createAgent
      // does, so the sandbox/approval/permission-mode flags survive the stop/resume boundary rather than
      // reverting to the Provider's more permissive default. buildResumeArgs orders these per provider
      // (codex places them after the positional prompt, claude before) and the positional prompt is a
      // distinct token, so intermixing the option flags stays CLI-valid.
      const resumeLaunchOptionArgv = provider.resolveLaunchArgv(current.launchOptions ?? {})
      const plan = provider.buildResumeLaunch({
        workspacePath: current.workspacePath,
        nativeHandle: current.nativeHandle,
        ...(prompt ? { prompt } : {}),
        args: [...(input.args ?? []), ...resumeLaunchOptionArgv],
        env: input.env ?? {},
        ...(input.commandOverride === undefined ? {} : { commandOverride: input.commandOverride })
      })
      await this.requireHookIngressOwner()
      await this.hookBindings.get(current.run.runId)?.close()
      this.hookBindings.delete(current.run.runId)
      hookBinding = this.hookServer.createBinding(
        current.agentSessionId,
        current.providerId,
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
          current.providerId,
          current.executorId,
          hookBinding,
          lifecycleOperationId,
          invocationCapability
        ),
        ...(input.cols === undefined ? {} : { cols: input.cols }),
        ...(input.rows === undefined ? {} : { rows: input.rows })
      })
      const next: AgentMuxStoredAgentSession = {
        ...current,
        run: runRef(run.runId),
        retiredRuns: [...current.retiredRuns, current.run].slice(-16),
        hookBindingId: hookBinding.bindingId,
        hookToken: hookBinding.endpoint.token,
        // 新 Run 换新凭证：旧 Run 的那枚从此认不出来，无法再以此 Agent 名义说话。
        capabilityHash: hashAgentCapability(invocationCapability),
        outputCursorBytes: 0,
        updatedAt: Date.now(),
        nativeHandle: structuredClone(current.nativeHandle)
      }
      delete next.hookReceipt
      delete next.terminalHandshake
      delete next.terminalCapability
      delete next.terminalPromptReadiness
      delete next.terminalPromptSubmission
      delete next.terminalPromptDelivery
      delete next.semanticStatus
      delete next.pendingInteraction
      if (
        !prompt &&
        (input.args?.length ?? 0) === 0 &&
        provider.terminalHandshake &&
        provider.terminalPromptRender
      ) {
        const handshakeOperationId = terminalHandshakeOperationIdentity(
          next.providerId,
          next.run.runId,
          provider.terminalHandshake
        )
        next.terminalPromptReadiness = {
          source: 'initial-composer',
          id: terminalInitialPromptReadinessIdentity(next, handshakeOperationId),
          run: { ...next.run },
          outputCursorBytes: 0
        }
      }
      let readySession = next
      try {
        persisted = await this.registry.commitLifecycle(reservation, next)
        await hookBinding.bindRun(run.runId)
        // 同 launch：超时降级，只有 run 退出才回滚。
        readySession = await this.ensureTerminalHandshakeOrDegrade(next, run)
      } catch (error) {
        const rollbackErrors: unknown[] = [error]
        try {
          await hookBinding.close()
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
      if (prompt) {
        await this.recordPromptAfterSideEffect(
          readySession,
          `prompt:${lifecycleOperationId}`,
          'Resume prompt',
          prompt,
          Date.now()
        )
      }
      return cloneSession(readySession)
    } catch (error) {
      operationError = error
      throw error
    } finally {
      const cleanupErrors: unknown[] = []
      if (hookBinding && ![...this.hookBindings.values()].includes(hookBinding)) {
        try {
          await hookBinding.close()
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      try {
        await this.registry.releaseLifecycle(reservation, abandonedRun ? [abandonedRun] : [])
      } catch (error) {
        cleanupErrors.push(error)
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          operationError === null ? cleanupErrors : [operationError, ...cleanupErrors],
          'Resume lifecycle cleanup failed.'
        )
      }
    }
  }

  private async performAgentContinuity(
    input: AgentMuxAgentContinuityInput
  ): Promise<AgentMuxAgentContinuityResult> {
    let current: AgentMuxStoredAgentSession | null = null
    try {
      current = this.registry.get(input.agentSessionId)
    } catch (error) {
      if (!(error instanceof AgentMuxError) || error.code !== 'UNKNOWN_AGENT_SESSION') throw error
    }

    if (current && !sameRun(current.run, input.expectedRun)) {
      return {
        kind: 'conflict',
        agentSessionId: input.agentSessionId,
        previousRun: { ...input.expectedRun },
        currentRun: { ...current.run },
        reason: 'session-run-changed',
        evidence: { kind: 'agent-session-store' }
      }
    }

    let run: AgentMuxRun | null = null
    if (current) {
      try {
        const observed = await this.kernel.status(current.run.runId)
        this.assertAgentRun(current, observed)
        run = projectRun(observed, current)
      } catch (error) {
        if (!(error instanceof AgentMuxError) || error.code !== 'CTXMUX_run_not_found') throw error
      }
    }

    const catalog = current ? this.providers.get(current.providerId).catalog : null
    // A Session can be absent here after an explicit stop while its retirement record still proves
    // that this exact identity was intentionally retired.  Preserve that record's Host when feeding
    // the continuity decision; hard-coding `local` makes a remote retirement look like an unrelated
    // unknown Session and loses the only honest terminal classification.
    const retirement = this.registry.retiredAgentSession(
      input.agentSessionId,
      input.expectedRun
    )
    const handle = current?.nativeHandle
    const canProbe = catalog?.resumeStrategy.kind === 'provider-native' &&
      handle?.kind === 'provider' &&
      handle.providerId === current?.providerId &&
      (catalog.resumeStrategy.locator !== 'transcript-path' || Boolean(handle.transcriptPath))
    const capability = canProbe
      ? await this.probeAgent(current!.providerId, input.commandOverride)
      : null
    const decision = decideAgentSessionContinuity({
      agentSessionId: input.agentSessionId,
      hostId: current?.hostId ?? retirement?.hostId ?? 'local',
      expectedRun: input.expectedRun,
      observedAt: Date.now(),
      session: current ? cloneSession(current) : null,
      retirement: retirement ? structuredClone(retirement) : null,
      run,
      catalog,
      capability
    })
    if (decision.kind !== 'resume') return decision

    try {
      await this.requireHookIngressOwner()
    } catch (error) {
      if (error instanceof AgentMuxError && error.code === 'HOOK_INGRESS_BUSY') {
        return {
          kind: 'conflict',
          agentSessionId: input.agentSessionId,
          previousRun: { ...input.expectedRun },
          reason: 'lifecycle-busy',
          evidence: { kind: 'hook-ingress-owner' }
        }
      }
      throw error
    }

    try {
      const session = await this.resumeAgentRun({
        agentSessionId: input.agentSessionId,
        operationId: input.operationId,
        ...(input.args === undefined ? {} : { args: input.args }),
        ...(input.env === undefined ? {} : { env: input.env }),
        ...(input.commandOverride === undefined ? {} : { commandOverride: input.commandOverride }),
        ...(input.cols === undefined ? {} : { cols: input.cols }),
        ...(input.rows === undefined ? {} : { rows: input.rows })
      }, input.expectedRun, capability ?? undefined)
      return {
        kind: 'resumed',
        session,
        previousRun: { ...input.expectedRun },
        run: { ...session.run },
        evidence: {
          kind: 'provider-native',
          providerId: decision.nativeHandle.providerId,
          nativeSessionId: decision.nativeHandle.sessionId,
          previousRun: decision.evidence
        }
      }
    } catch (error) {
      if (
        error instanceof AgentMuxError &&
        (
          error.code === 'AGENT_SESSION_BUSY' ||
          error.code === 'STALE_AGENT_SESSION' ||
          error.code === 'UNKNOWN_AGENT_SESSION'
        )
      ) {
        if (error.code !== 'AGENT_SESSION_BUSY') await this.registry.load('local')
        const retired = this.registry.retiredAgentSession(
          input.agentSessionId,
          input.expectedRun
        )
        if (retired) {
          return {
            kind: 'retired',
            agentSessionId: input.agentSessionId,
            previousRun: { ...input.expectedRun },
            evidence: { kind: 'user-retired', observedAt: retired.observedAt }
          }
        }
        let latest: AgentMuxStoredAgentSession | null = null
        try {
          latest = this.registry.get(input.agentSessionId)
        } catch {}
        return {
          kind: 'conflict',
          agentSessionId: input.agentSessionId,
          previousRun: { ...input.expectedRun },
          ...(latest ? { currentRun: { ...latest.run } } : {}),
          reason: 'lifecycle-busy',
          evidence: { kind: 'agent-session-store' }
        }
      }
      throw error
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
      providerId: previous.providerId,
      executorId: previous.executorId,
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
    assertAgentPromptSize(content)
    // send 是纯用户话：出站文本经唯一出口产出，但不加 amux 信封——用户原文逐字节透传。
    const outbound = composeOutboundMessage({ user: content })
    const operationId = safeId(input.operationId, 'Agent prompt operation id')
    // 握手绝不做发 prompt 的前置门。这里不是生命周期路径——run 早就活着，用户此刻正在提交。
    // 而 `[?u` 是 codex 一次性的启动输出，对一个几分钟前启动的 run 早已不可达，于是一旦拦在
    // 这里，**那个 run 之后的每一条 prompt 都被永久挡住**。栅栏起点由 daemon 的权威
    // acceptedInputBytes 兜底（submitInputPlan 本来就这么取），不依赖握手是否完成。
    const session = this.requireAgentSession(input.agentSessionId)
    const plan = this.providers.get(session.providerId).planPromptInput(outbound)
    await this.serializeAgentInput(session, async (current, run) => {
      if (current.pendingInteraction) {
        throw new AgentMuxError(
          'Answer the pending Agent interaction before submitting another prompt.',
          'AGENT_INTERACTION_PENDING'
        )
      }
      await this.promptSubmission.submitInputPlan(current, run, operationId, outbound, plan)
    })
    await this.recordPromptAfterSideEffect(
      this.requireAgentSession(input.agentSessionId),
      `prompt:${operationId}`,
      'Prompt',
      outbound,
      Date.now()
    )
  }

  async respondAgentInteraction(input: AgentMuxAgentInteractionInput): Promise<void> {
    this.requireConnected()
    const requestedSession = this.requireAgentSession(input.agentSessionId)
    if (!sameRun(requestedSession.run, input.expectedRun)) {
      throw new AgentMuxError(
        'Agent Session changed before its interaction was answered.',
        'STALE_AGENT_SESSION'
      )
    }
    const pending = requestedSession.pendingInteraction
    if (!pending || pending.request.id !== input.response.requestId) {
      throw new AgentMuxError('Agent interaction is not pending.', 'UNKNOWN_AGENT_INTERACTION')
    }
    const response = normalizeAgentInteractionResponse(pending.request, input.response)
    if (pending.request.evidence.source === 'acp') {
      if (response.kind !== 'permission') {
        throw new AgentMuxError('ACP question responses are unsupported.', 'AGENT_INTERACTION_UNSUPPORTED')
      }
      await this.acp.respondPermission(input.agentSessionId, pending.request.id, response.decision)
      return
    }
    const provider = this.providers.get(requestedSession.providerId)
    const plan = provider.planInteractionResponse(pending.request, response)
    if (!plan.data) {
      throw new AgentMuxError('Provider interaction response bytes cannot be empty.', 'INVALID_AGENT_PROVIDER')
    }
    const responseDigest = digestInteractionResponse(response)
    const operationId = agentInteractionOperationIdentity(
      requestedSession,
      pending.request.id,
      responseDigest,
      plan.data
    )
    await this.serializeAgentInput(requestedSession, async (session, run) => {
      await this.submitNativeInteractionResponse(
        session,
        run,
        pending.request,
        response,
        responseDigest,
        operationId,
        plan.data
      )
    })
  }

  /**
   * Set an Agent's live security posture in-band. The renderer sends a mode id; the Provider resolves that
   * mode's declared keystroke core-side (its bytes never cross IPC), and it is written over the SAME
   * PTY-input transport a prompt uses. It is not a launch flag: it drives the Provider's own in-band
   * control, so it takes effect on the running process rather than silently no-oping. Fails closed on a
   * Provider that declares no posture control or a mode it does not declare.
   */
  async setAgentPosture(input: AgentMuxAgentPostureInput): Promise<void> {
    this.requireConnected()
    const session = this.requireAgentSession(input.agentSessionId)
    if (!sameRun(session.run, input.expectedRun)) {
      throw new AgentMuxError(
        'Agent Session changed before its posture was set.',
        'STALE_AGENT_SESSION'
      )
    }
    const plan = this.providers.get(session.providerId).planPostureSet(input.modeId)
    if (!plan.data) {
      throw new AgentMuxError('Provider posture keystroke cannot be empty.', 'INVALID_AGENT_PROVIDER')
    }
    await this.writeAgentInput(session, plan.data)
  }

  async resizeAgent(
    agentSessionId: string,
    expectedRun: AgentMuxRunRef,
    cols: number,
    rows: number
  ): Promise<AgentMuxRunAppliedSize> {
    this.requireConnected()
    const session = this.requireAgentSession(agentSessionId)
    if (!sameRun(session.run, expectedRun)) {
      throw new AgentMuxError(
        'Agent Session changed before its Run was resized.',
        'STALE_AGENT_SESSION'
      )
    }
    const applied = await this.resizeTerminal(expectedRun, cols, rows)
    // 屏幕几何变了，长命屏幕证据随之失效；下一次观察按新尺寸重建。
    this.screenEvidence.discard(agentSessionId)
    return applied
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

  async stopAgent(agentSessionId: string, expectedRun: AgentMuxRunRef): Promise<void> {
    this.requireConnected()
    const session = this.requireAgentSession(agentSessionId)
    if (!sameRun(session.run, expectedRun)) {
      throw new AgentMuxError(
        'Agent Session changed before its Run was stopped.',
        'STALE_AGENT_SESSION'
      )
    }
    // 停止意图落台账。用户主动停止走的干净路径是 run-removed（下方），但进程可能在我们的 stop 生效前就
    // 自退——那条 exit 事件会先到 acceptKernelEvent；先记意图，才能让它诚实归为 user-stopped 而非 crashed。
    this.stopRequestedRuns.add(expectedRun.runId)
    const lifecycleOperationId = agentLifecycleOperationIdentity(
      'stop',
      agentSessionId,
      randomUUID()
    )
    const stopOperation: CtxmuxAdapterStopOperation = await this.kernel.prepareStop(
      expectedRun.runId,
      lifecycleOperationId
    )
    const reservation = await this.registry.reserveExisting(
      'stop',
      agentSessionId,
      expectedRun,
      lifecycleOperationId,
      stopOperation
    )
    let preserveReservation = false
    try {
      let run: CtxmuxAdapterRun | null = null
      try {
        run = await this.requireCurrentAgentRun(session)
      } catch (error) {
        if (!(error instanceof AgentMuxError) || error.code !== 'STALE_AGENT_SESSION_BINDING') {
          throw error
        }
      }
      if (run?.state.type === 'running') {
        try {
          await this.kernel.stop(stopOperation)
        } catch (error) {
          preserveReservation = error instanceof AgentMuxError && error.detail === 'unknown'
          throw error
        }
        preserveReservation = true
      }
      else if (run) await this.releaseRunAttachment(session.run)
      await this.hookBindings.get(session.run.runId)?.close()
      this.hookBindings.delete(session.run.runId)
      const cleanup = await Promise.allSettled([
        this.acp.unbind(agentSessionId),
        this.registry.commitLifecycle(reservation, null)
      ])
      preserveReservation ||= cleanup[1]?.status === 'rejected'
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
      if (!preserveReservation) await this.registry.releaseLifecycle(reservation)
    }
  }

  async bindAcp(agentSessionId: string, binding: AgentMuxAcpBinding): Promise<void> {
    this.requireConnected()
    const session = this.requireAgentSession(agentSessionId)
    if (this.providers.get(session.providerId).catalog.acpStrategy.kind !== 'adapter') {
      throw new AgentMuxError('Provider does not declare an ACP adapter.', 'ACP_UNSUPPORTED')
    }
    await this.acp.bind(agentSessionId, binding)
  }

  private async recoverStaleLifecycles(): Promise<void> {
    const reservations = await this.registry.claimStaleLifecycles()
    if (reservations.length === 0) return
    const runs = await this.kernel.list()
    for (const reservation of reservations) {
      if (reservation.kind === 'stop') {
        let run: CtxmuxAdapterRun | null = null
        try {
          run = await this.kernel.status(reservation.expectedRun.runId)
        } catch (error) {
          if (!(error instanceof AgentMuxError) || error.code !== 'CTXMUX_run_not_found') throw error
        }
        if (run?.state.type === 'running') await this.kernel.stop(reservation.stopOperation)
        await this.registry.commitLifecycle(reservation, null)
        continue
      }
      let retiredRuns: AgentMuxRunRef[] = []
      const candidates = runs.filter(
        (run) => run.lifecycleOperationId === reservation.operationId
      )
      for (const run of candidates) await this.retireUncommittedRun(run.runId)
      retiredRuns = candidates.map((run) => runRef(run.runId))
      await this.registry.releaseLifecycle(reservation, retiredRuns)
    }
  }

  private async recoverPendingInteractionResponses(
    runs: readonly CtxmuxAdapterRun[]
  ): Promise<void> {
    for (const session of this.registry.list()) {
      const pending = session.pendingInteraction
      if (!pending) continue
      if (pending.request.evidence.source === 'acp') {
        if (!this.acp.hasPendingPermission(session.agentSessionId, pending.request.id)) {
          const settled = await this.clearPendingInteraction(session, pending.request.id)
          this.publisher.publish({ type: 'agent-session', session: cloneSession(settled) })
        }
        continue
      }
      const response = pending?.response
      const run = runs.find((candidate) => candidate.runId === session.run.runId)
      if (!response || pending.request.evidence.source !== 'native-hook') continue
      if (!run) {
        throw new AgentMuxError(
          'A persisted Agent interaction response points to a missing CtxMux Run.',
          'AGENT_INTERACTION_STATE_INVALID'
        )
      }
      const acceptedInputBytes = run.acceptedInputBytes
      if (
        acceptedInputBytes === null ||
        acceptedInputBytes < response.inputByteRange.startByte ||
        (
          acceptedInputBytes > response.inputByteRange.startByte &&
          acceptedInputBytes < response.inputByteRange.endByte
        )
      ) {
        throw new AgentMuxError(
          'CtxMux Input cursor cannot reconcile the persisted Agent interaction response.',
          'AGENT_INTERACTION_STATE_INVALID'
        )
      }
      const normalized = normalizeAgentInteractionResponse(pending.request, response.value)
      const plan = this.providers.get(session.providerId).planInteractionResponse(
        pending.request,
        normalized
      )
      const recover = async (current: AgentMuxAgentSession, currentRun: CtxmuxAdapterRun) => {
        await this.submitNativeInteractionResponse(
          current,
          currentRun,
          pending.request,
          normalized,
          digestInteractionResponse(normalized),
          agentInteractionOperationIdentity(
            current,
            pending.request.id,
            digestInteractionResponse(normalized),
            plan.data
          ),
          plan.data
        )
      }
      if (run.state.type === 'running') {
        await this.serializeAgentInput(session, recover)
        continue
      }
      try {
        await recover(session, run)
      } catch (error) {
        if (
          error instanceof AgentMuxError &&
          error.detail === 'not_applied' &&
          acceptedInputBytes === response.inputByteRange.startByte
        ) {
          const settled = await this.clearPendingInteraction(session, pending.request.id)
          this.publisher.publish({ type: 'agent-session', session: cloneSession(settled) })
          continue
        }
        throw error
      }
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
    // 恢复期主动停掉的 uncommitted run 也是「我们关的」——记下意图，让其退出事件同样归为 user-stopped。
    this.stopRequestedRuns.add(runId)
    await this.kernel.stop(await this.kernel.prepareStop(runId))
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
        session.providerId,
        session.hookBindingId,
        session.hookToken
      )
      try {
        await binding.bindRun(session.run.runId)
        this.hookBindings.set(session.run.runId, binding)
      } catch (error) {
        await binding.close()
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

  private agentSessionStorePath(): string | undefined {
    // Only a file-backed store has a durable path worth telling spawned processes about. A memory store
    // (checkHost probes, tests) has none, and the CLI reaching it would be meaningless — leave the
    // variable unset so nothing is misdirected.
    return this.store instanceof AgentMuxFileAgentSessionStore ? this.store.path : undefined
  }

  private agentEnvironment(
    environment: Readonly<Record<string, string>>,
    agentSessionId: string,
    providerId: AgentProviderId,
    executorId: AgentExecutorId,
    binding: AgentHookBinding,
    lifecycleOperationId: string,
    capability: string
  ): Record<string, string> {
    // usage 能力是 catalog 的 SSOT——在这里从 catalog 读出该 Provider 的 transcript 格式并注入 hook 环境，
    // 好让轻量的 hook 命令进程不必导入整个 Provider registry 就知道「要不要读 transcript、按什么格式读」。
    // 未声明 usage 的 Provider 不注入这个变量，hook 进程因此对它们连一次尾部读都不做。
    const usage = this.providers.get(providerId).catalog.capabilities.usage
    return {
      ...terminalEnvironment(environment, this.agentSessionStorePath()),
      AGENTMUX_HOOK_URL: binding.endpoint.url,
      AGENTMUX_HOOK_TOKEN: binding.endpoint.token,
      AGENTMUX_AGENT_SESSION_ID: agentSessionId,
      AGENTMUX_PROVIDER_ID: providerId,
      AGENTMUX_EXECUTOR_ID: executorId,
      AGENTMUX_LIFECYCLE_OPERATION_ID: lifecycleOperationId,
      // 这枚凭证是这个 Agent 说话时的身份证明。Core 只留它的 hash；公开的
      // AGENTMUX_AGENT_SESSION_ID 只是上下文提示，改一下就能冒充，故不能用于认证。
      AGENTMUX_AGENT_CAPABILITY: capability,
      ...(usage ? { AGENTMUX_USAGE_TRANSCRIPT_FORMAT: usage.transcriptFormat } : {})
    }
  }

  /**
   * 握手的降级包装：超时不再中止任何东西，其余照旧抛。
   *
   * 四个调用点里有三个（connect 循环、launch、resume）过去把任何握手错误都当成致命：connect
   * 会 `kernel.disconnect()` 拆掉整条连接，launch/resume 会回滚——**用一次慢探测杀掉一个刚
   * 启动好的、健康的 Agent**。这里只吃掉超时那一类：Agent 还在跑，我们没等到 `[?u` 而已。
   *
   * 降级时做两件事，一件都不能少：
   * 1. 从 daemon 播种输入游标（与无握手 provider 同一条兜底），否则首条 prompt 的栅栏起点是错的。
   * 2. 发一条 agent-session 事件把降级说出去。**绝不静默**——静默降级本身就是原则 11 的违例，
   *    用户必须看得见自己在降级状态里。
   *
   * 绝不做的一件事：伪造受据。没送出 `[?0u` 就不写 `acknowledged: true`，`terminalHandshake`
   * 保持未设（状态＝未知，而不是编一个）。伪造会撞上 `acceptedInputBytes >= endByte` 的断言，
   * 并污染崩溃恢复的幂等性。
   */
  private async ensureTerminalHandshakeOrDegrade(
    requestedSession: AgentMuxStoredAgentSession,
    knownRun?: CtxmuxAdapterRun
  ): Promise<AgentMuxStoredAgentSession> {
    try {
      return await this.ensureTerminalHandshake(requestedSession, knownRun)
    } catch (error) {
      // Any exact-Run disappearance during attach, boundary status, or capability Input is a real
      // failure for this Session but not a reason to guess that an unrelated Session is unhealthy.
      // Normalize it before classification so `open()` can contain the blast radius per Session.
      error = mapVanishedTerminalHandshakeRun(error)
      const outcome = classifyTerminalHandshakeFailure(error)
      if (outcome.kind === 'abort') throw error
      // A timeout is only degradable while the exact Run is still alive. The Run returned by
      // `list()`/`start()` is a useful hint, but it may already be stale by the time the timer fires;
      // ask CtxMux for the authoritative state before allowing the lifecycle to continue.
      const run = await this.requireRunningTerminalHandshakeRun(requestedSession)
      const cursor = degradedInputCursor(run.acceptedInputBytes)
      if (cursor === undefined) {
        // Without the daemon cursor we cannot fence the next input write. This is a broken CtxMux
        // contract, not a Provider capability timeout, so fail closed instead of guessing zero.
        throw new AgentMuxError(
          'CtxMux omitted its accepted Input byte cursor while terminal capability was degraded.',
          'CTXMUX_INPUT_CURSOR_MISSING'
        )
      }
      this.agentInputCursors.set(requestedSession.agentSessionId, cursor)
      const observedAt = Date.now()
      const degraded: AgentTerminalCapabilityState = {
        state: 'unknown',
        mode: 'degraded',
        reason: 'handshake-timeout',
        run: { ...requestedSession.run },
        observedAt
      }
      let next: AgentMuxStoredAgentSession
      try {
        next = await this.persistTerminalCapabilityState(requestedSession, degraded)
      } catch (error) {
        // The Store is an observability/continuity surface, not the Agent's input transport. A
        // transient lock, disk, or permission failure must not make create/resume roll back a Run
        // that CtxMux just proved is still running. Keep the marker for this call only, and report
        // that it cannot survive a restart. Identity/data conflicts remain fatal below: returning a
        // marker for a different Session would be worse than blocking honestly.
        if (
          error instanceof AgentMuxError &&
          ['STALE_AGENT_SESSION', 'UNKNOWN_AGENT_SESSION', 'STALE_AGENT_SESSION_BINDING',
            'AGENT_SESSION_BUSY', 'INVALID_AGENT_SESSION_STORE'].includes(error.code)
        ) {
          throw error
        }
        const canonical = this.requireAgentSession(requestedSession.agentSessionId)
        if (!sameRun(canonical.run, requestedSession.run)) {
          throw new AgentMuxError(
            'Agent Session changed while terminal capability degradation was being persisted.',
            'STALE_AGENT_SESSION'
          )
        }
        // A concurrent acknowledgement is stronger evidence than this timeout. Preserve it if the
        // Store did manage to apply that other write; only attach an ephemeral marker to an otherwise
        // unacknowledged canonical Session.
        next = canonical.terminalHandshake?.acknowledged
          ? canonical
          : {
              ...structuredClone(canonical),
              terminalCapability: structuredClone(degraded),
              updatedAt: Math.max(canonical.updatedAt, degraded.observedAt)
            }
        if (!canonical.terminalHandshake?.acknowledged) {
          this.publisher.publish({
            type: 'agent-error',
            // Deliberately omit agentSessionId. The renderer's agent-error reducer treats a scoped
            // error as a semantic Agent failure; this is only a Store diagnostic and the Agent remains
            // healthy. The adjacent agent-session projection carries the actionable marker.
            code: AGENT_TERMINAL_CAPABILITY_PERSIST_FAILED,
            message: `Terminal capability degradation could not be persisted; continuing with an in-memory warning. ${
              error instanceof Error ? error.message : String(error)
            }`,
            evidence: {
              source: 'user',
              observedAt,
              run: { ...requestedSession.run }
            }
          })
        }
      }
      // The session event is the Core-owned projection seam consumed by Desktop. Do not surface this
      // as an ordinary agent-error: the Agent is still healthy and must not be painted as failed.
      this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
      return next
    }
  }

  /**
   * Resolve the Run state after a degradable timeout. A stale `knownRun` must never turn an exited
   * Agent into a supposedly live degraded Session.
   */
  private async requireRunningTerminalHandshakeRun(
    session: AgentMuxStoredAgentSession
  ): Promise<CtxmuxAdapterRun> {
    let run: CtxmuxAdapterRun
    try {
      run = await this.kernel.status(session.run.runId)
    } catch (error) {
      // A timeout raced with Run removal. Keep this branch in the same fatal bucket as an observed
      // exited state; callers must not leak a transport-specific `run_not_found` through the
      // handshake contract or accidentally treat a missing Run as a healthy degraded Agent.
      if (error instanceof AgentMuxError && error.code === 'CTXMUX_run_not_found') {
        throw mapVanishedTerminalHandshakeRun(error)
      }
      throw error
    }
    this.assertAgentRun(session, run)
    if (run.state.type !== 'running') {
      throw new AgentMuxError(
        'Agent Run exited before its terminal capability query was observed.',
        AGENT_TERMINAL_HANDSHAKE_FAILED
      )
    }
    return run
  }

  private async persistTerminalCapabilityState(
    requestedSession: AgentMuxStoredAgentSession,
    degraded: AgentTerminalCapabilityState
  ): Promise<AgentMuxStoredAgentSession> {
    return await this.updateExactAgentSession(
      requestedSession.agentSessionId,
      requestedSession.run,
      (current) => {
        // A concurrent handshake may have acknowledged while the timeout was being classified. Its
        // receipt is stronger evidence; clear the stale degraded marker and preserve the receipt.
        if (current.terminalHandshake?.acknowledged) {
          if (!current.terminalCapability) return current
          const next = { ...current }
          delete next.terminalCapability
          return { ...next, updatedAt: Math.max(next.updatedAt, degraded.observedAt) }
        }
        if (
          current.terminalCapability &&
          current.terminalCapability.observedAt >= degraded.observedAt
        ) return current
        return {
          ...current,
          terminalCapability: structuredClone(degraded),
          updatedAt: Math.max(current.updatedAt, degraded.observedAt)
        }
      }
    )
  }

  private async clearTerminalCapability(
    requestedSession: AgentMuxStoredAgentSession
  ): Promise<AgentMuxStoredAgentSession> {
    if (!requestedSession.terminalCapability) return requestedSession
    const next = await this.updateExactAgentSession(
      requestedSession.agentSessionId,
      requestedSession.run,
      (current) => {
        if (!current.terminalCapability) return current
        const cleared = { ...current }
        delete cleared.terminalCapability
        return { ...cleared, updatedAt: Math.max(cleared.updatedAt, Date.now()) }
      }
    )
    if (next !== requestedSession) {
      this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
    }
    return next
  }

  private async ensureTerminalHandshake(
    requestedSession: AgentMuxStoredAgentSession,
    knownRun?: CtxmuxAdapterRun
  ): Promise<AgentMuxStoredAgentSession> {
    const provider = this.providers.get(requestedSession.providerId)
    const handshake = provider.terminalHandshake
    if (!handshake) {
      if (knownRun?.acceptedInputBytes !== null && knownRun?.acceptedInputBytes !== undefined) {
        this.agentInputCursors.set(requestedSession.agentSessionId, knownRun.acceptedInputBytes)
      }
      return await this.clearTerminalCapability(
        this.requireAgentSession(requestedSession.agentSessionId)
      )
    }

    const session = this.requireAgentSession(requestedSession.agentSessionId)
    if (!sameRun(session.run, requestedSession.run)) {
      throw new AgentMuxError(
        'Agent Session changed before terminal handshake completed.',
        'STALE_AGENT_SESSION'
      )
    }
    // A prior timeout is durable evidence that this exact Run's capability is unknown. Do not arm a
    // second ten-second observer on every reconnect/prompt; the Run remains usable and its input
    // fencing is owned by CtxMux. A later Run gets a fresh field (resume clears it below).
    if (
      session.terminalCapability &&
      !session.terminalHandshake?.acknowledged
    ) {
      const cursor = degradedInputCursor(knownRun?.acceptedInputBytes)
      if (cursor !== undefined) this.agentInputCursors.set(session.agentSessionId, cursor)
      return session
    }
    const operationId = terminalHandshakeOperationIdentity(
      session.providerId,
      session.run.runId,
      handshake
    )
    const initialReadinessId = terminalInitialPromptReadinessIdentity(session, operationId)
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
    const observeReadiness = (current: AgentMuxStoredAgentSession): void => {
      if (!provider.terminalPromptRender) return
      const readiness = current.terminalPromptReadiness
      if (!readiness) return
      if (
        readiness.source === 'initial-composer' &&
        readiness.id !== initialReadinessId
      ) {
        throw new AgentMuxError(
          'Initial terminal prompt readiness does not match the Provider and exact Run.',
          'AGENT_TERMINAL_HANDSHAKE_STATE_INVALID'
        )
      }
      if (
        readiness.readyThroughByte === undefined &&
        readiness.consumedBySubmissionId === undefined
      ) {
        this.promptSubmission.observeReadiness(current, readiness)
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
        const readySession = session.terminalCapability
          ? await this.clearTerminalCapability(session)
          : session
        observeReadiness(readySession)
        return readySession
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
          AGENT_TERMINAL_HANDSHAKE_FAILED
        ))
      }
    })
    const timer = setTimeout(() => {
      rejectQuery(new AgentMuxError(
        'Timed out waiting for the Provider terminal capability query.',
        AGENT_TERMINAL_HANDSHAKE_TIMEOUT
      ))
    }, TERMINAL_HANDSHAKE_TIMEOUT_MS)
    let attached = false
    try {
      const attachment = await this.kernel.attach(session.run.runId, 0)
      attached = true
      for (const event of attachment.replay) observe(event.data)
      if (!queryObserved) await query

      const boundaryRun = await this.kernel.status(session.run.runId)
      this.assertAgentRun(session, boundaryRun)
      const startByte = boundaryRun.acceptedInputBytes
      if (startByte === null) {
        throw new AgentMuxError(
          'CtxMux omitted its accepted Input byte cursor.',
          'CTXMUX_INPUT_CURSOR_MISSING'
        )
      }

      const claimHandshake = (current: AgentMuxStoredAgentSession): AgentMuxStoredAgentSession => {
        if (current.terminalHandshake) {
          assertState(current.terminalHandshake)
          return current
        }
        const initialReadiness = current.terminalPromptReadiness?.source === 'initial-composer'
          ? current.terminalPromptReadiness
          : undefined
        if (
          initialReadiness &&
          (
            initialReadiness.id !== initialReadinessId ||
            initialReadiness.readyThroughByte !== undefined ||
            initialReadiness.consumedBySubmissionId !== undefined
          )
        ) {
          throw new AgentMuxError(
            'Initial terminal prompt readiness is invalid before handshake acknowledgement.',
            'AGENT_TERMINAL_HANDSHAKE_STATE_INVALID'
          )
        }
        const next: AgentMuxStoredAgentSession = {
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
          ...(initialReadiness
            ? {
                terminalPromptReadiness: {
                  ...initialReadiness,
                  outputCursorBytes: boundaryRun.latestOutputBytes
                }
              }
            : {}),
          updatedAt: Date.now()
        }
        delete next.terminalCapability
        return next
      }
      let claimed: AgentMuxStoredAgentSession
      try {
        claimed = await this.registry.update(
          session.agentSessionId,
          session.run,
          claimHandshake
        )
      } catch (error) {
        if (!(error instanceof AgentMuxError) || error.code !== 'STALE_AGENT_SESSION') throw error
        await this.registry.load(session.hostId)
        const canonical = this.requireAgentSession(session.agentSessionId)
        if (!sameRun(canonical.run, session.run)) {
          throw new AgentMuxError(
            'Agent Session changed while adopting its terminal handshake.',
            'STALE_AGENT_SESSION'
          )
        }
        claimed = canonical.terminalHandshake
          ? canonical
          : await this.registry.update(
              session.agentSessionId,
              session.run,
              claimHandshake
            )
      }
      const state = claimed.terminalHandshake
      if (!state) {
        throw new AgentMuxError(
          'Terminal handshake claim was not persisted.',
          'AGENT_TERMINAL_HANDSHAKE_STATE_INVALID'
        )
      }
      assertState(state)
      if (state.acknowledged) {
        const currentRun = await this.kernel.status(session.run.runId)
        this.assertAgentRun(session, currentRun)
        const acceptedInputBytes = currentRun.acceptedInputBytes
        if (acceptedInputBytes === null || acceptedInputBytes < state.inputByteRange.endByte) {
          throw new AgentMuxError(
            'CtxMux Input cursor precedes the persisted terminal handshake receipt.',
            'AGENT_TERMINAL_HANDSHAKE_STATE_INVALID'
          )
        }
        this.agentInputCursors.set(session.agentSessionId, acceptedInputBytes)
        observeReadiness(claimed)
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
      const acknowledgeHandshake = (
        current: AgentMuxStoredAgentSession
      ): AgentMuxStoredAgentSession => {
        if (!current.terminalHandshake) {
          throw new AgentMuxError(
            'Terminal handshake claim disappeared before acknowledgement.',
            'AGENT_TERMINAL_HANDSHAKE_STATE_INVALID'
          )
        }
        assertState(current.terminalHandshake)
        if (current.terminalHandshake.acknowledged) return current
        const next: AgentMuxStoredAgentSession = {
          ...current,
          terminalHandshake: {
            ...current.terminalHandshake,
            acknowledged: true
          },
          updatedAt: Date.now()
        }
        delete next.terminalCapability
        return next
      }
      let ready: AgentMuxStoredAgentSession
      try {
        ready = await this.registry.update(
          session.agentSessionId,
          session.run,
          acknowledgeHandshake
        )
      } catch (error) {
        if (!(error instanceof AgentMuxError) || error.code !== 'STALE_AGENT_SESSION') throw error
        await this.registry.load(session.hostId)
        const canonical = this.requireAgentSession(session.agentSessionId)
        if (!sameRun(canonical.run, session.run)) {
          throw new AgentMuxError(
            'Agent Session changed while adopting its terminal handshake acknowledgement.',
            'STALE_AGENT_SESSION'
          )
        }
        ready = canonical.terminalHandshake?.acknowledged
          ? canonical
          : await this.registry.update(
              session.agentSessionId,
              session.run,
              acknowledgeHandshake
            )
      }
      this.agentInputCursors.set(session.agentSessionId, accepted.run.acceptedInputBytes)
      observeReadiness(ready)
      return ready
    } finally {
      clearTimeout(timer)
      unsubscribe()
      if (attached) {
        try {
          await this.kernel.detach(session.run.runId)
        } catch {}
      }
    }
  }

  private async recordPromptAfterSideEffect(
    session: AgentMuxAgentSession,
    itemId: string,
    title: string,
    content: string,
    observedAt: number
  ): Promise<void> {
    const mutation: AgentTimelineMutation = {
      type: 'append',
      agentSessionId: session.agentSessionId,
      item: {
        id: itemId,
        agentSessionId: session.agentSessionId,
        kind: 'user_message',
        status: 'complete',
        source: 'user',
        createdAt: observedAt,
        updatedAt: observedAt,
        title,
        content
      }
    }
    const evidence = { source: 'user' as const, observedAt, run: { ...session.run } }
    try {
      await this.persistAndPublishTimeline(mutation, evidence)
    } catch (error) {
      this.publisher.publish({
        type: 'agent-error',
        agentSessionId: session.agentSessionId,
        code: error instanceof AgentMuxError ? error.code : 'AGENT_TIMELINE_PERSIST_FAILED',
        message: error instanceof Error ? error.message : String(error),
        evidence
      })
    }
  }

  private async updateExactAgentSession(
    agentSessionId: string,
    expectedRun: AgentMuxRunRef,
    update: (current: AgentMuxStoredAgentSession) => AgentMuxStoredAgentSession
  ): Promise<AgentMuxStoredAgentSession> {
    try {
      return await this.registry.update(agentSessionId, expectedRun, update)
    } catch (error) {
      if (!(error instanceof AgentMuxError) || error.code !== 'STALE_AGENT_SESSION') throw error
      const hostId = this.requireAgentSession(agentSessionId).hostId
      await this.registry.load(hostId)
      const canonical = this.requireAgentSession(agentSessionId)
      if (!sameRun(canonical.run, expectedRun)) {
        throw new AgentMuxError('Agent Session changed while semantic state was persisted.', 'STALE_AGENT_SESSION')
      }
      return await this.registry.update(agentSessionId, expectedRun, update)
    }
  }

  private async persistSemanticStatus(
    agentSessionId: string,
    expectedRun: AgentMuxRunRef,
    status: AgentStatus
  ): Promise<AgentMuxStoredAgentSession> {
    const next = await this.updateExactAgentSession(agentSessionId, expectedRun, (current) => {
      if (
        current.semanticStatus &&
        current.semanticStatus.observedAt > status.observedAt
      ) return current
      return {
        ...current,
        semanticStatus: structuredClone(status),
        updatedAt: Math.max(current.updatedAt, status.observedAt)
      }
    })
    this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
    return next
  }

  private async persistPendingInteraction(
    request: AgentMuxInteractionRequest
  ): Promise<AgentMuxStoredAgentSession> {
    const expectedRun = request.evidence.run
    if (!expectedRun) {
      throw new AgentMuxError('Agent interaction omitted its exact Run.', 'INVALID_AGENT_INTERACTION')
    }
    return await this.updateExactAgentSession(request.agentSessionId, expectedRun, (current) => {
      const existing = current.pendingInteraction
      if (existing) {
        if (existing.request.id !== request.id) {
          throw new AgentMuxError(
            'Another Agent interaction is already pending.',
            'AGENT_INTERACTION_BUSY'
          )
        }
        return current
      }
      return {
        ...current,
        pendingInteraction: { request: structuredClone(request) },
        updatedAt: Math.max(current.updatedAt, request.evidence.observedAt)
      }
    })
  }

  private async clearPendingInteraction(
    session: AgentMuxAgentSession,
    requestId: string
  ): Promise<AgentMuxStoredAgentSession> {
    return await this.updateExactAgentSession(session.agentSessionId, session.run, (current) => {
      if (!current.pendingInteraction) return current
      if (current.pendingInteraction.request.id !== requestId) {
        throw new AgentMuxError('Agent interaction changed before settlement.', 'UNKNOWN_AGENT_INTERACTION')
      }
      const next = { ...current, updatedAt: Date.now() }
      delete next.pendingInteraction
      return next
    })
  }

  private async submitNativeInteractionResponse(
    session: AgentMuxAgentSession,
    run: CtxmuxAdapterRun,
    request: AgentMuxInteractionRequest,
    response: AgentMuxInteractionResponse,
    responseDigest: string,
    operationId: string,
    data: string
  ): Promise<void> {
    if (
      request.agentSessionId !== session.agentSessionId ||
      request.evidence.source !== 'native-hook' ||
      request.evidence.run?.runId !== session.run.runId
    ) {
      throw new AgentMuxError(
        'Native Agent interaction does not match the exact Session and Run.',
        'INVALID_AGENT_INTERACTION'
      )
    }
    const bytes = Buffer.byteLength(data)
    const expectedByte = this.agentInputCursors.get(session.agentSessionId) ?? run.acceptedInputBytes
    if (expectedByte === null) {
      throw new AgentMuxError('CtxMux omitted its accepted Input byte cursor.', 'CTXMUX_INPUT_CURSOR_MISSING')
    }
    const assertResponse = (
      state: NonNullable<NonNullable<AgentMuxAgentSession['pendingInteraction']>['response']>
    ): void => {
      if (
        state.responseDigest !== responseDigest ||
        state.operationId !== operationId ||
        state.inputByteRange.endByte - state.inputByteRange.startByte !== bytes ||
        JSON.stringify(state.value) !== JSON.stringify(response)
      ) {
        throw new AgentMuxError(
          'Agent interaction was answered with conflicting content.',
          'AGENT_INTERACTION_RESPONSE_CONFLICT'
        )
      }
    }
    let current = await this.updateExactAgentSession(
      session.agentSessionId,
      session.run,
      (stored) => {
        const pending = stored.pendingInteraction
        if (!pending || pending.request.id !== request.id) {
          throw new AgentMuxError('Agent interaction is not pending.', 'UNKNOWN_AGENT_INTERACTION')
        }
        if (pending.response) {
          assertResponse(pending.response)
          return stored
        }
        return {
          ...stored,
          pendingInteraction: {
            request: pending.request,
            response: {
              value: structuredClone(response),
              responseDigest,
              operationId,
              inputByteRange: {
                startByte: expectedByte,
                endByte: expectedByte + bytes
              },
              acknowledged: false
            }
          },
          updatedAt: Date.now()
        }
      }
    )
    let state = current.pendingInteraction?.response
    if (!state) {
      throw new AgentMuxError(
        'Agent interaction response claim was not persisted.',
        'AGENT_INTERACTION_STATE_INVALID'
      )
    }
    assertResponse(state)
    let acceptedInputBytes = run.acceptedInputBytes
    if (!state.acknowledged) {
      const accepted = await this.kernel.input(session.run.runId, {
        ownerInstanceId: this.kernel.identity().daemonInstanceId,
        operationId: state.operationId,
        expectedByte: state.inputByteRange.startByte,
        data
      })
      if (
        accepted.appliedByteRange.startByte !== state.inputByteRange.startByte ||
        accepted.appliedByteRange.endByte !== state.inputByteRange.endByte ||
        accepted.run.acceptedInputBytes === null ||
        accepted.run.acceptedInputBytes < state.inputByteRange.endByte
      ) {
        throw new AgentMuxError(
          'CtxMux interaction receipt does not match the persisted Input claim.',
          'AGENT_INTERACTION_RECEIPT_MISMATCH'
        )
      }
      acceptedInputBytes = accepted.run.acceptedInputBytes
      current = await this.updateExactAgentSession(
        session.agentSessionId,
        session.run,
        (stored) => {
          const responseState = stored.pendingInteraction?.response
          if (!responseState) {
            throw new AgentMuxError(
              'Agent interaction response claim disappeared.',
              'AGENT_INTERACTION_STATE_INVALID'
            )
          }
          assertResponse(responseState)
          if (responseState.acknowledged) return stored
          return {
            ...stored,
            pendingInteraction: {
              request: stored.pendingInteraction!.request,
              response: { ...responseState, acknowledged: true }
            },
            updatedAt: Date.now()
          }
        }
      )
      state = current.pendingInteraction?.response
    }
    if (
      !state?.acknowledged ||
      acceptedInputBytes === null ||
      acceptedInputBytes < state.inputByteRange.endByte
    ) {
      throw new AgentMuxError(
        'CtxMux Input cursor precedes the persisted interaction receipt.',
        'AGENT_INTERACTION_STATE_INVALID'
      )
    }
    this.agentInputCursors.set(session.agentSessionId, acceptedInputBytes)
    const settled = await this.clearPendingInteraction(current, request.id)
    this.publisher.publish({ type: 'agent-session', session: cloneSession(settled) })
  }

  private async writeAgentInput(
    requestedSession: AgentMuxAgentSession,
    data: string
  ): Promise<AgentMuxRunInputAck> {
    return await this.serializeAgentInput(requestedSession, async (session, run) => {
      if (session.pendingInteraction) {
        throw new AgentMuxError(
          'Answer the pending Agent interaction through the typed response API.',
          'AGENT_INTERACTION_PENDING'
        )
      }
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
      if (run.state.type !== 'running') {
        throw new AgentMuxError(
          'Agent Run exited before Input could be accepted.',
          'STALE_AGENT_SESSION'
        )
      }
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

  private requireAgentSession(agentSessionId: string): AgentMuxStoredAgentSession {
    return this.registry.get(agentSessionId)
  }

  private async acceptHookEvent(envelope: NativeHookEnvelope, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const session = this.registry.findByRun(runRef(envelope.runId))
    if (
      !session ||
      session.agentSessionId !== envelope.agentSessionId ||
      session.providerId !== envelope.providerId
    ) return
    const normalized = this.providers.get(envelope.providerId).normalizeHook(envelope)
    const stopRun = normalized.eventName === 'Stop'
      ? await this.kernel.status(session.run.runId)
      : null
    const receipt = {
      id: envelope.receiptId,
      providerId: session.providerId,
      agentSessionId: session.agentSessionId,
      run: { ...session.run },
      eventName: normalized.eventName,
      observedAt: normalized.status.observedAt,
      ...(stopRun ? { outputCursorBytes: stopRun.latestOutputBytes } : {})
    }
    const persistReceipt = (
      current: AgentMuxStoredAgentSession
    ): AgentMuxStoredAgentSession => {
      signal.throwIfAborted()
      const existingReadiness = (
        current.terminalPromptReadiness?.source === 'native-stop' &&
        current.terminalPromptReadiness.id === receipt.id
      )
        ? current.terminalPromptReadiness
        : undefined
      const persistedReceipt = existingReadiness
        ? { ...receipt, outputCursorBytes: existingReadiness.outputCursorBytes }
        : receipt
      const { turnUsage: _staleTurnUsage, ...currentBase } = current
      const next: AgentMuxStoredAgentSession = {
        ...currentBase,
        updatedAt: Math.max(current.updatedAt, normalized.status.observedAt),
        hookReceipt: persistedReceipt,
        ...(normalized.semanticState === 'unknown'
          ? {}
          : { semanticStatus: structuredClone(normalized.status) }),
        ...(stopRun
          ? {
              terminalPromptReadiness: existingReadiness ?? {
                source: 'native-stop' as const,
                id: receipt.id,
                run: { ...current.run },
                outputCursorBytes: stopRun.latestOutputBytes
              }
            }
          : {}),
        ...(normalized.nativeHandle ? { nativeHandle: normalized.nativeHandle } : {}),
        // turnUsage 三分支权威解析。清空这一半与上面把 turnUsage 从 ...currentBase 里 destructure 掉
        // 的那半成对（同 fix #1 陷阱）：turnUsage 已从基础展开剔出，此处「不写入」等于「清掉」，而非「保留」。
        // 1) 本条回执带 usage → 用新的（fresh number wins）。
        // 2) 无 usage 且属收尾事件（USAGE_FINALIZATION_EVENTS = Stop/StopFailure，两侧共用 SSOT）→ 清掉：
        //    收尾本该带用量，它没带说明这一 turn 的用量读取失败（读 transcript 失败/竞态截断/记录落在
        //    256KiB 窗口外），把上一 turn 的数字继续挂在「Last turn」标签下是撒谎，清掉让 UI 落回等待记号「—」。
        // 3) 无 usage 且是 mid-turn 事件 → 保留上一 turn 的值：迟到的不带 usage 事件不该抹掉刚采到的那一 turn。
        ...(normalized.turnUsage
          ? { turnUsage: normalized.turnUsage }
          : USAGE_FINALIZATION_EVENTS.has(normalized.eventName)
            ? {}
            : current.turnUsage
              ? { turnUsage: current.turnUsage }
              : {})
      }
      if (normalized.interaction) {
        const interaction = normalized.interaction
        if (
          interaction.agentSessionId !== current.agentSessionId ||
          interaction.evidence.source !== 'native-hook' ||
          interaction.evidence.run?.runId !== current.run.runId ||
          interaction.evidence.hookReceiptId !== receipt.id
        ) {
          throw new AgentMuxError(
            'Provider interaction does not match its native Hook receipt.',
            'INVALID_AGENT_INTERACTION'
          )
        }
        if (
          current.pendingInteraction &&
          current.pendingInteraction.request.id !== interaction.id
        ) {
          throw new AgentMuxError(
            'Another Agent interaction is already pending.',
            'AGENT_INTERACTION_BUSY'
          )
        }
        next.pendingInteraction = current.pendingInteraction ?? {
          request: structuredClone(interaction)
        }
      }
      return next
    }
    let next: AgentMuxStoredAgentSession
    try {
      next = await this.registry.update(
        session.agentSessionId,
        session.run,
        persistReceipt,
        signal
      )
    } catch (error) {
      if (!(error instanceof AgentMuxError) || error.code !== 'STALE_AGENT_SESSION') throw error
      await this.registry.load(session.hostId)
      signal.throwIfAborted()
      const canonical = this.requireAgentSession(session.agentSessionId)
      if (!sameRun(canonical.run, session.run)) {
        throw new AgentMuxError(
          'Agent Session changed while adopting its native Hook receipt.',
          'STALE_AGENT_SESSION'
        )
      }
      next = canonical.hookReceipt?.id === receipt.id
        ? canonical
        : await this.registry.update(
            session.agentSessionId,
            session.run,
            persistReceipt,
            signal
          )
    }
    signal.throwIfAborted()
    const persistedReceipt = next.hookReceipt
    if (!persistedReceipt) {
      throw new AgentMuxError('Native Hook receipt was not persisted.', 'HOOK_RECEIPT_INVALID')
    }
    const evidence = {
      source: 'native-hook' as const,
      observedAt: normalized.status.observedAt,
      run: { ...next.run },
      hookReceiptId: persistedReceipt.id
    }
    for (const mutation of normalized.timeline) {
      await this.persistAndPublishTimeline(mutation, evidence, signal)
    }
    this.publisher.publishHook(next, normalized, persistedReceipt)
    if (normalized.interaction) {
      const request = next.pendingInteraction?.request
      if (!request || request.id !== normalized.interaction.id) {
        throw new AgentMuxError(
          'Native Agent interaction was not persisted.',
          'AGENT_INTERACTION_STATE_INVALID'
        )
      }
      this.publisher.publishInteraction(request)
    }
    this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
    if (
      normalized.eventName === 'Stop' &&
      next.terminalPromptReadiness &&
      next.terminalPromptReadiness.readyThroughByte === undefined &&
      next.terminalPromptReadiness.consumedBySubmissionId === undefined
    ) {
      this.promptSubmission.observeReadiness(next, next.terminalPromptReadiness)
    }
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

  private async persistAndPublishTimeline(
    mutation: AgentTimelineMutation,
    evidence: Parameters<AgentMuxClientEventPublisher['publishTimeline']>[1],
    signal?: AbortSignal
  ): Promise<void> {
    const commit = await this.store.applyTimelineMutation(mutation, signal)
    if (commit.changed) this.publisher.publishTimeline(commit, evidence)
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
    // run 进程终结是「这个 run 再不会有 hook 事件」的权威终点。子代理若被信号/OOM 杀死、或其
    // SubagentStop 投递失败，normalizer 的花名册里那条 id 永不删除、Map 条目随进程泄漏。在此清掉，
    // 给「子代理事件丢失」一个终结路径——否则那个 runId 的记账会长驻内存。
    releaseSubagentRoster(event.runId)
    // 退出时把停止意图（我们记的）与观察到的 code/signal（内核报的）合成诚实的 exitReason。意图是一次性的：
    // 一个 runId 只退出一次，读完即删，绝不留驻。非 exited 的终结（interrupted）不参与本分类。
    const stopRequested = this.stopRequestedRuns.delete(event.runId)
    const exitReason = event.state.type === 'exited'
      ? classifyRunExit({
          stopRequested,
          exitCode: event.state.code,
          ...(event.state.signal === null ? {} : { exitSignal: event.state.signal })
        })
      : undefined
    this.publisher.publish({
      type: 'process-state',
      ...(agentSession ? { agentSessionId: agentSession.agentSessionId } : {}),
      run: runRef(event.runId),
      state: event.state.type,
      pid: this.runPids.get(event.runId) ?? null,
      ...(event.state.type === 'exited'
        ? {
            exitCode: event.state.code,
            ...(event.state.signal === null ? {} : { exitSignal: event.state.signal }),
            ...(exitReason ? { exitReason } : {})
          }
        : event.state.type === 'interrupted'
          ? { interruptionReason: event.state.reason }
          : {}),
      evidence: {
        source: 'run-process',
        observedAt: event.observedAt,
        run: runRef(event.runId)
      }
    })
  }
}
