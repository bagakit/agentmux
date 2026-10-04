import { AgentMuxError } from './errors.js'
import type {
  AgentHookReceipt,
  AgentMuxAcpEvent,
  AgentMuxAgentSession,
  AgentMuxClientEvent,
  AgentMuxClientEventListener,
  AgentMuxClientEventListenerOptions,
  AgentMuxEvidence,
  AgentMuxInteractionRequest,
  AgentMuxObservationOrigin,
  AgentMuxRun,
  AgentMuxRunDataEvent,
  AgentMuxRunExitEvent,
  AgentMuxNativeService,
  AgentTimelineCommit,
  NormalizedHookEvent
} from './types.js'

function runRef(value: { runId: string }) {
  return { runId: value.runId }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function reportConsole(error: unknown): void {
  try { console.error(error) } catch { /* Diagnostic sinks cannot take over healthy publication. */ }
}

export class AgentMuxClientEventPublisher {
  private readonly listeners = new Map<(event: AgentMuxClientEvent) => unknown, AgentMuxClientEventListenerOptions>()
  private readonly statusListeners = new Map<(event: AgentMuxClientEvent) => unknown, AgentMuxClientEventListenerOptions>()
  private publishingDiagnostic = false

  /** Low-frequency owner facts; these listeners never join ordered-byte dispatch. */
  onStatusEvent<Result>(listener: AgentMuxClientEventListener<Result>, options: AgentMuxClientEventListenerOptions = {}): () => void {
    this.statusListeners.set(listener, options)
    return () => { this.statusListeners.delete(listener) }
  }

  onEvent<Result>(listener: AgentMuxClientEventListener<Result>, options: AgentMuxClientEventListenerOptions = {}): () => void {
    this.listeners.set(listener, options)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void {
    this.listeners.clear()
    this.statusListeners.clear()
  }

  publish(event: AgentMuxClientEvent): void {
    const listeners = event.type === 'agent-error' || event.type === 'connection-state'
      ? [...this.listeners, ...this.statusListeners] : [...this.listeners]
    const failures: AgentMuxError[] = []
    for (const [listener, options] of listeners) {
      let failure: AgentMuxError | undefined
      try {
        const result = listener(event)
        if (isPromiseLike(result)) {
          // Own no async queue and contain rejection from callers that bypass the type contract.
          void Promise.resolve(result).catch(() => {})
          failure = new AgentMuxError('This event Consumer returned a Promise and was detached. Agent and Runtime capabilities remain available. Move async work into a Consumer-owned bounded queue, then explicitly subscribe again.', 'CLIENT_EVENT_LISTENER_ASYNC')
        }
      } catch {
        // A synchronous Consumer failure is local to this event; retain its subscription.
        continue
      }
      if (!failure) continue
      this.listeners.delete(listener)
      this.statusListeners.delete(listener)
      failures.push(failure)
      // Report directly to this Consumer even when it is the only subscriber. Reporting
      // itself cannot take over publication or create an unhandled rejected Promise.
      try {
        if (!options.onError) reportConsole(failure)
        else {
          const result = (options.onError as (error: AgentMuxError) => unknown)(failure)
          if (isPromiseLike(result)) void Promise.resolve(result).catch(error => { reportConsole(error) })
        }
      } catch (error) { reportConsole(error) }
    }
    if (this.publishingDiagnostic || !failures.length) return
    this.publishingDiagnostic = true
    try {
      for (const failure of failures) this.publish({ type: 'agent-error', code: failure.code,
        message: failure.message, evidence: { source: 'agentmux', observedAt: Date.now() } })
    } finally { this.publishingDiagnostic = false }
  }

  publishRunState(run: AgentMuxRun, agentSessionId?: string, observationOrigin?: AgentMuxObservationOrigin): void {
    this.publish({
      type: 'process-state',
      ...(observationOrigin ? { observationOrigin } : {}),
      ...(agentSessionId === undefined ? {} : { agentSessionId }),
      run: runRef(run),
      state: run.state,
      pid: run.pid,
      ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
      ...(run.exitSignal === undefined ? {} : { exitSignal: run.exitSignal }),
      evidence: {
        source: 'run-process',
        observedAt: run.observedAt,
        run: runRef(run)
      }
    })
    if (run.nativeService !== null) this.publishRunService(run, run.nativeService, run.observedAt, agentSessionId)
  }

  publishRunService(run: { runId: string }, nativeService: AgentMuxNativeService, observedAt: number, agentSessionId?: string): void {
    const evidence: AgentMuxEvidence = { source: 'run-process', observedAt, run: runRef(run) }
    const scope = agentSessionId === undefined ? {} : { agentSessionId }
    this.publish({ type: 'run-service', ...scope, run: runRef(run), nativeService, evidence })
    const unavailable = nativeService.owner.type === 'stopped' && nativeService.owner.reason !== 'historical' ||
      nativeService.output.type === 'unavailable' && nativeService.output.reason !== 'historical' ||
      nativeService.input.phase.type === 'unavailable' && nativeService.input.phase.reason !== 'historical'
    if (unavailable) this.publish({
      type: 'agent-error', ...scope, code: 'CTXMUX_NATIVE_SERVICE_UNAVAILABLE',
      message: `Run ${run.runId} native service cannot fully serve: owner=${nativeService.owner.type}, output=${nativeService.output.type}, input=${nativeService.input.phase.type}. These facts do not confirm child exit or input delivery. Keep this Run and restore the unavailable lane; inspect the original input result before sending more bytes and do not replay unconfirmed input.`,
      evidence
    })
    if (nativeService.terminalFault) this.publish({
      type: 'agent-error', ...scope, code: 'CTXMUX_TERMINAL_DERIVED_FAULT',
      message: `Run ${run.runId} terminal view failed during ${nativeService.terminalFault.stage} at output byte ${nativeService.terminalFault.throughByte}. Original output and child lifecycle remain independent. Keep this Run and read original output; reattach the terminal view after its derived service is restored.`,
      evidence: { ...evidence, source: 'terminal-output' }
    })
  }

  publishRunEvent(
    event: AgentMuxRunDataEvent | AgentMuxRunExitEvent,
    agentSession?: AgentMuxAgentSession
  ): void {
    if (event.type === 'data') {
      const evidence: Extract<AgentMuxClientEvent, { type: 'terminal-output' }>['evidence'] = {
        source: 'terminal-output',
        observedAt: Date.now(),
        run: runRef(event),
        outputByteRange: { startByte: event.startByte, endByte: event.endByte }
      }
      this.publish({
        type: 'terminal-output',
        ...(agentSession ? { agentSessionId: agentSession.agentSessionId } : {}),
        run: runRef(event),
        dataBytes: event.dataBytes,
        data: event.data,
        evidence
      })
      return
    }
    this.publish({
      type: 'process-state',
      ...(agentSession ? { agentSessionId: agentSession.agentSessionId } : {}),
      run: runRef(event),
      state: 'exited',
      pid: event.pid,
      exitCode: event.exitCode,
      ...(event.exitSignal === undefined ? {} : { exitSignal: event.exitSignal }),
      evidence: {
        source: 'run-process',
        observedAt: event.observedAt,
        run: runRef(event)
      }
    })
  }

  publishHook(
    session: AgentMuxAgentSession,
    normalized: NormalizedHookEvent,
    receipt: AgentHookReceipt
  ): void {
    const evidence: AgentMuxEvidence = {
      source: 'native-hook',
      observedAt: normalized.status.observedAt,
      run: { ...session.run },
      hookReceiptId: receipt.id
    }
    this.publish({
      type: 'agent-status',
      agentSessionId: session.agentSessionId,
      state: normalized.semanticState,
      detail: normalized.eventName,
      evidence
    })
  }

  publishTimeline(commit: AgentTimelineCommit, evidence: AgentMuxEvidence): void {
    this.publish({
      type: 'agent-timeline',
      agentSessionId: commit.agentSessionId,
      revision: commit.revision,
      mutation: commit.mutation,
      evidence
    })
  }

  publishAcp(
    agentSessionId: string,
    event: AgentMuxAcpEvent,
    evidence: AgentMuxEvidence
  ): void {
    if (event.type === 'status') {
      this.publish({
        type: 'agent-status',
        agentSessionId,
        state: event.state,
        ...(event.detail === undefined ? {} : { detail: event.detail }),
        evidence
      })
      return
    }
  }

  publishInteraction(request: AgentMuxInteractionRequest): void {
    this.publish({ type: 'interaction', request: structuredClone(request) })
  }
}
