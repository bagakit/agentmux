import { AgentMuxError } from './errors.js'
import type {
  AgentHookReceipt,
  AgentMuxAcpEvent,
  AgentMuxAgentSession,
  AgentMuxClientEvent,
  AgentMuxEvidence,
  AgentMuxInteractionRequest,
  AgentMuxRun,
  AgentMuxRunDataEvent,
  AgentMuxRunExitEvent,
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

  publishRunState(run: AgentMuxRun, agentSessionId?: string): void {
    this.publish({
      type: 'process-state',
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
  }

  publishRunEvent(
    event: AgentMuxRunDataEvent | AgentMuxRunExitEvent,
    agentSession?: AgentMuxAgentSession
  ): void {
    if (event.type === 'data') {
      const evidence: AgentMuxEvidence = {
        source: 'terminal-output',
        observedAt: Date.now(),
        run: runRef(event),
        outputByteRange: { startByte: event.startByte, endByte: event.endByte }
      }
      this.publish({
        type: 'terminal-output',
        ...(agentSession ? { agentSessionId: agentSession.agentSessionId } : {}),
        run: runRef(event),
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
