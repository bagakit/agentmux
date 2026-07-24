import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type {
  AgentMuxDaemonDataEvent,
  AgentMuxDaemonExitEvent,
  AgentMuxDaemonSession
} from './daemon-protocol.js'
import type {
  AgentHookReceipt,
  AgentMuxAcpEvent,
  AgentMuxClientEvent,
  AgentMuxEvidence,
  AgentMuxPermissionRequest,
  AgentMuxSemanticSession,
  NormalizedHookEvent
} from './types.js'

function runRef(value: { sessionId: string; incarnationId: string }) {
  return { sessionId: value.sessionId, incarnationId: value.incarnationId }
}

export class AgentMuxClientEventPublisher {
  private readonly events = new EventEmitter()

  onEvent(listener: (event: AgentMuxClientEvent) => void): () => void {
    this.events.on('event', listener)
    return () => this.events.off('event', listener)
  }

  dispose(): void {
    this.events.removeAllListeners()
  }

  publish(event: AgentMuxClientEvent): void {
    this.events.emit('event', event)
  }

  publishProcessState(run: AgentMuxDaemonSession, semanticSessionId?: string): void {
    this.publish({
      type: 'process-state',
      ...(semanticSessionId === undefined ? {} : { semanticSessionId }),
      daemonSession: runRef(run),
      state: run.state,
      pid: run.pid,
      ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
      ...(run.exitSignal === undefined ? {} : { exitSignal: run.exitSignal }),
      evidence: {
        source: 'daemon-process',
        observedAt: run.state === 'running' ? Date.now() : run.exitedAt ?? run.lostAt ?? Date.now(),
        daemonSession: runRef(run)
      }
    })
  }

  publishDaemonEvent(
    event: AgentMuxDaemonDataEvent | AgentMuxDaemonExitEvent,
    semantic?: AgentMuxSemanticSession
  ): void {
    if (event.type === 'data') {
      const evidence: AgentMuxEvidence = {
        source: 'terminal-output',
        observedAt: Date.now(),
        daemonSession: runRef(event),
        outputSequence: { start: event.startSequence, end: event.endSequence }
      }
      this.publish({
        type: 'terminal-output',
        ...(semantic ? { semanticSessionId: semantic.semanticSessionId } : {}),
        daemonSession: runRef(event),
        data: event.data,
        evidence
      })
      return
    }
    this.publish({
      type: 'process-state',
      ...(semantic ? { semanticSessionId: semantic.semanticSessionId } : {}),
      daemonSession: runRef(event),
      state: 'exited',
      pid: event.pid,
      exitCode: event.exitCode,
      ...(event.exitSignal === undefined ? {} : { exitSignal: event.exitSignal }),
      evidence: {
        source: 'daemon-process',
        observedAt: event.observedAt,
        daemonSession: runRef(event)
      }
    })
  }

  publishHook(
    session: AgentMuxSemanticSession,
    normalized: NormalizedHookEvent,
    receipt: AgentHookReceipt
  ): void {
    const evidence: AgentMuxEvidence = {
      source: 'native-hook',
      observedAt: normalized.status.observedAt,
      daemonSession: { ...session.daemonSession },
      hookReceiptId: receipt.id
    }
    this.publish({
      type: 'semantic-status',
      semanticSessionId: session.semanticSessionId,
      state: normalized.semanticState,
      detail: normalized.eventName,
      evidence
    })
    for (const activity of normalized.activities) {
      const { sessionId: _sessionId, source: _source, ...publicActivity } = activity
      this.publish({
        type: 'semantic-activity',
        semanticSessionId: session.semanticSessionId,
        activity: publicActivity,
        evidence
      })
    }
  }

  publishAcp(
    semanticSessionId: string,
    event: AgentMuxAcpEvent,
    evidence: AgentMuxEvidence
  ): void {
    if (event.type === 'status') {
      this.publish({
        type: 'semantic-status',
        semanticSessionId,
        state: event.state,
        ...(event.detail === undefined ? {} : { detail: event.detail }),
        evidence
      })
      return
    }
    if (event.type === 'activity') {
      this.publish({
        type: 'semantic-activity',
        semanticSessionId,
        activity: {
          id: randomUUID(),
          kind: event.kind,
          createdAt: evidence.observedAt,
          title: event.title,
          ...(event.content === undefined ? {} : { content: event.content }),
          ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
          ...(event.toolInput === undefined ? {} : { toolInput: event.toolInput })
        },
        evidence
      })
      return
    }
    if (event.type === 'permission') {
      const request: AgentMuxPermissionRequest = {
        id: event.requestId,
        semanticSessionId,
        title: event.title,
        options: event.options.map((option) => ({ ...option })),
        evidence,
        ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
        ...(event.toolInput === undefined ? {} : { toolInput: event.toolInput })
      }
      this.publish({ type: 'permission', request })
    }
  }
}
