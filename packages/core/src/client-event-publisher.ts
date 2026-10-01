import { AgentMuxError } from './errors.js'
import type {
  AgentHookReceipt,
  AgentMuxAcpEvent,
  AgentMuxAgentSession,
  AgentMuxClientEvent,
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

const MAX_EVENT_LISTENERS = 64

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

export class AgentMuxClientEventPublisher {
  private readonly listeners = new Set<(event: AgentMuxClientEvent) => void>()

  onEvent(listener: (event: AgentMuxClientEvent) => void): () => void {
    if (!this.listeners.has(listener) && this.listeners.size >= MAX_EVENT_LISTENERS) {
      throw new AgentMuxError('AgentMux Client event listener limit reached.', 'CLIENT_EVENT_LISTENER_LIMIT')
    }
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.listeners.clear()
  }

  publish(event: AgentMuxClientEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        const result = (listener as (value: AgentMuxClientEvent) => unknown)(event)
        if (isPromiseLike(result)) {
          this.listeners.delete(listener)
          void Promise.resolve(result).catch(() => {})
        }
      } catch {
        // A Consumer callback cannot become part of Run transport or Agent
        // lifecycle control. The Consumer owns reporting its callback failure.
      }
    }
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
