import { AgentMuxError } from './errors.js'
import { AgentMuxClientEventPublisher } from './client-event-publisher.js'
import type { AgentMuxClientEvent, AgentMuxAgentSession, AgentMuxRunAttachment, AgentMuxRunRef,
  AgentSessionHistoryObservation, AgentSessionHistoryObservationHandle, AgentSessionHistoryObservationOptions } from './types.js'
import { AGENTMUX_HOSTED_METHODS, type AgentMuxHostedClient, type AgentMuxHostedRpcPort,
  type AgentMuxHostedBootstrap, type AgentMuxHostedMethod, type AgentMuxHostedInvocation,
  type AgentMuxHostedSubscription } from './hosted-client-contract.js'
import { decodeHostedValue, encodeHostedValue } from './hosted-value.js'
import { createHostedOutputObservation } from './hosted-output-observer.js'

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof AbortSignal !== 'undefined' && value instanceof AbortSignal
}

/** A consumer connection to the Host. Disposing this object never owns the Core or a Run. */
export async function connectHostedAgentMux(options: {
  rpc: AgentMuxHostedRpcPort; consumerId?: string; waitForReady?: boolean; expectedStorePath?: string
}): Promise<AgentMuxHostedClient> {
  const consumerId = options.consumerId ?? globalThis.crypto.randomUUID(), rpc = options.rpc
  const publisher = new AgentMuxClientEventPublisher()
  let bootstrap: AgentMuxHostedBootstrap | undefined, stream: AgentMuxHostedSubscription | undefined
  let connecting: Promise<void> | undefined, disposed = false, retry: ReturnType<typeof setTimeout> | undefined
  let reconnectDelay = 100
  let reconnectAttempts = 0
  let eventEpoch = 0
  type HistoryRead = {
    id: string; listener(value: AgentSessionHistoryObservation): void; options: AgentSessionHistoryObservationOptions
    source?: AgentSessionHistoryObservationHandle['source']; stream?: AgentMuxHostedSubscription
    epoch: number; disposed: boolean; resume: boolean; attempts: number
    retry?: ReturnType<typeof setTimeout>; acquiring?: Promise<void>; abort?: () => void
  }
  const histories = new Set<HistoryRead>()
  const outputs = new Set<ReturnType<typeof createHostedOutputObservation>>()
  const attached = new Map<string, { run: AgentMuxRunRef; afterByte: number; view: 'raw' | 'terminal' }>()
  const emit = (event: AgentMuxClientEvent): void => {
    if (event.type === 'run-removed' && bootstrap) {
      // A low-level Run stop does not retire its retained Agent Session. Only the
      // Core's explicit Session retirement fact may remove that durable projection.
      if (event.agentSessionId) bootstrap.sessions = bootstrap.sessions.filter(value => !(
        value.run.runId === event.run.runId && value.agentSessionId === event.agentSessionId))
      attached.delete(event.run.runId)
    }
    if (event.type === 'agent-session' && bootstrap) {
      const index = bootstrap.sessions.findIndex(session => session.agentSessionId === event.session.agentSessionId)
      if (index === -1) bootstrap.sessions.push(structuredClone(event.session))
      else bootstrap.sessions[index] = structuredClone(event.session)
    }
    if (event.type === 'terminal-output') {
      const reading = attached.get(event.run.runId)
      if (reading) reading.afterByte = Math.max(reading.afterByte, event.evidence.outputByteRange.endByte)
    }
    publisher.publish(event)
  }
  const connectionState = (state: 'lost' | 'restored' | 'unrecoverable'): void => emit({ type: 'connection-state', state,
    evidence: { source: 'run-process', observedAt: Date.now() } })
  const connectionFailure = (error: unknown): void => emit({ type: 'agent-error',
    code: error instanceof AgentMuxError ? error.code : 'CONTROL_UNAVAILABLE',
    message: `Semantic Host connection is unconfirmed. Original Runs and the durable workbench are retained. ${error instanceof Error ? error.message : String(error)} Reconnect the original Host; unacknowledged input is not resent.`,
    evidence: { source: 'agentmux', observedAt: Date.now() } })
  const requireBootstrap = (): AgentMuxHostedBootstrap => {
    if (!bootstrap) throw new AgentMuxError('The semantic Host identity is not confirmed.', 'CONTROL_UNAVAILABLE')
    return bootstrap
  }
  const session = (id: string): AgentMuxAgentSession => {
    const value = requireBootstrap().sessions.find(value => value.agentSessionId === id)
    if (!value) throw new AgentMuxError('Unknown Agent Session.', 'UNKNOWN_AGENT_SESSION')
    return structuredClone(value)
  }
  const invoke = async (method: AgentMuxHostedMethod, args: unknown[]): Promise<unknown> => {
    if (disposed) throw new AgentMuxError('Hosted consumer is disposed.', 'CONTROL_CANCELLED')
    await connect()
    let signal: AbortSignal | undefined, wireArgs = args
    // Cancellation belongs to the exact SDK field. Ordinary data, including env.signal,
    // crosses unchanged; the value codec never classifies fields by their names.
    if (method === 'submitAgentPrompt') {
      const input = args[0] as Parameters<AgentMuxHostedClient['submitAgentPrompt']>[0]
      if (isAbortSignal(input.signal)) {
        const { signal: cancellation, ...value } = input
        signal = cancellation; wireArgs = [value, ...args.slice(1)]
      }
    }
    const response = await rpc.call('runtime.invoke', { consumerId,
      invocation: encodeHostedValue({ method, args: wireArgs }) as AgentMuxHostedInvocation }, signal ? { signal } : {})
    return decodeHostedValue(response.value)
  }
  const notifyHistory = (read: HistoryRead, observation: AgentSessionHistoryObservation): void => {
    if (disposed || read.disposed) return
    try { read.listener(observation) } catch { /* A readonly consumer callback cannot control the Host. */ }
  }
  const releaseHistory = (read: HistoryRead): void => {
    if (read.disposed) return
    read.disposed = true; read.epoch++; histories.delete(read)
    if (read.retry) clearTimeout(read.retry)
    if (read.abort) read.options.signal?.removeEventListener('abort', read.abort)
    const watch = read.stream; delete read.stream
    void watch?.dispose().catch(error => { if (!disposed) connectionFailure(error) })
  }
  const retryHistory = (read: HistoryRead): void => {
    if (disposed || read.disposed || !read.resume || read.retry || read.acquiring || !stream || read.attempts >= 8) return
    read.retry = setTimeout(() => {
      delete read.retry; read.attempts++
      void openHistory(read).catch(error => {
        notifyHistory(read, { kind: 'unavailable', agentSessionId: read.id,
          ...(read.source ? { source: read.source } : {}), code: 'AGENT_SESSION_HISTORY_CONNECTION_UNCONFIRMED',
          message: `The original history watch is unconfirmed; its existing window is retained. ${error instanceof Error ? error.message : String(error)} Explicitly refresh this source if reconnection does not finish.` })
        retryHistory(read)
      })
    }, Math.min(100 * 2 ** read.attempts, 5000))
    read.retry.unref?.()
  }
  const openHistory = async (read: HistoryRead): Promise<void> => {
    if (read.disposed || disposed) throw new AgentMuxError('History consumer was released.', 'AGENT_SESSION_HISTORY_CANCELLED')
    if (read.stream) return
    if (read.acquiring) return read.acquiring
    const epoch = ++read.epoch, hadSource = read.source !== undefined
    read.acquiring = (async () => {
      let ended = false
      const { signal: cancellation, ...historyOptions } = read.options
      const signal = isAbortSignal(cancellation) ? cancellation : undefined
      const watch = await rpc.subscribe('runtime.history-watch', { consumerId, agentSessionId: read.id,
        options: encodeHostedValue(signal ? historyOptions : read.options) as never }, {
        ...(signal ? { signal } : {}),
        onInitial: value => {
          if (!value.source) throw new AgentMuxError('History watch omitted its exact native source.', 'CONTROL_PROTOCOL_ERROR')
          if (read.source && (read.source.providerId !== value.source.providerId || read.source.nativeSessionId !== value.source.nativeSessionId)) {
            read.resume = false
            notifyHistory(read, { kind: 'unavailable', agentSessionId: read.id, source: read.source,
              code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED', message: 'The original native history identity changed; the previous window is retained. Explicitly refresh its source.' })
            throw new AgentMuxError('Original native history identity changed.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
          }
          read.source = value.source
        },
        onEvent: value => {
          if (read.epoch !== epoch || read.disposed) return
          if (value.type === 'snapshot' && 'observation' in value.data) {
            notifyHistory(read, value.data.observation)
            if (value.data.observation.kind === 'unavailable') { read.resume = false; releaseHistory(read) }
          }
        },
        onEnd: error => {
          ended = true
          if (read.epoch !== epoch || read.disposed || disposed) return
          delete read.stream
          notifyHistory(read, { kind: 'unavailable', agentSessionId: read.id,
            ...(read.source ? { source: read.source } : {}), code: 'AGENT_SESSION_HISTORY_CONNECTION_UNCONFIRMED',
            message: `The original native history watch lost its connection. The previous window is retained; reconnection observes the same source. ${error?.message ?? ''}` })
          retryHistory(read)
        }
      })
      if (ended || read.epoch !== epoch || read.disposed || disposed) {
        await watch.dispose()
        throw new AgentMuxError('History consumer closed during watch admission.', 'AGENT_SESSION_HISTORY_CANCELLED')
      }
      read.stream = watch; read.attempts = 0
      if (hadSource && read.source) notifyHistory(read, { kind: 'invalidated', agentSessionId: read.id, source: read.source })
    })().finally(() => { delete read.acquiring })
    return read.acquiring
  }
  const reconnect = (): void => {
    if (disposed || retry) return
    if (reconnectAttempts >= 8) { connectionState('unrecoverable'); return }
    retry = setTimeout(() => {
      retry = undefined
      reconnectAttempts++
      void connect().catch(error => { connectionFailure(error); reconnectDelay = Math.min(reconnectDelay * 2, 5000); reconnect() })
    }, reconnectDelay)
    retry.unref?.()
  }
  const connect = async (): Promise<void> => {
    if (disposed) throw new AgentMuxError('Hosted consumer is disposed.', 'CONTROL_CANCELLED')
    if (stream) return
    if (connecting) return connecting
    connecting = (async () => {
      const previous = bootstrap
      const epoch = ++eventEpoch
      let ended = false
      const requireObservation = () => {
        if (disposed) throw new AgentMuxError('Hosted consumer was released during connection admission.', 'CONTROL_CANCELLED')
        if (ended || epoch !== eventEpoch) throw new AgentMuxError('The original Host observation ended during connection admission. Retained Session metadata is unchanged; reconnect its original Host.', 'CONTROL_UNAVAILABLE')
      }
      const acquired = await rpc.subscribe('runtime.events', { consumerId }, {
        onInitial: value => {
          requireObservation()
          if (!value.bootstrap) throw new AgentMuxError('Host omitted its identity projection.', 'CONTROL_PROTOCOL_ERROR')
          if (options.expectedStorePath !== undefined && value.bootstrap.storePath !== options.expectedStorePath) {
            throw new AgentMuxError('This Host owns a different durable Session Store. The original workbench is retained; connect its original Host namespace.', 'CONTROL_OWNER_BUSY')
          }
          bootstrap = decodeHostedValue(value.bootstrap) as AgentMuxHostedBootstrap
          for (const retained of bootstrap.sessions) emit({ type: 'agent-session', session: structuredClone(retained) })
          // A restarted Host may adopt the same daemon; a different daemon is an explicit new fact.
        },
        onEvent: value => {
          if (ended || epoch !== eventEpoch || disposed) return
          if (value.type === 'snapshot' && 'event' in value.data) emit(decodeHostedValue(value.data.event) as AgentMuxClientEvent)
        },
        onEnd: error => {
          if (ended) return
          ended = true
          if (epoch !== eventEpoch || disposed) return
          stream = undefined
          if (!disposed) { connectionFailure(error ?? new Error('The Host event subscription ended.')); connectionState('lost'); reconnect() }
        }
      })
      if (disposed || ended || epoch !== eventEpoch) { await acquired.dispose(); requireObservation() }
      stream = acquired
      reconnectDelay = 100
      reconnectAttempts = 0
      try {
        const projectionResponse = await rpc.call('runtime.invoke', { consumerId,
          invocation: { method: 'runtimeProjection', args: [] } })
        const projection = decodeHostedValue(projectionResponse.value) as Awaited<ReturnType<AgentMuxHostedClient['runtimeProjection']>>
        for (const subject of projection.subjects) publisher.publishRunState(subject.run,
          subject.kind === 'agent' ? subject.agentSession.agentSessionId : undefined)
      } catch (error) {
        // Host/Store identity and process observation are separate facts. An unsuccessful read
        // cannot discard the confirmed event lease or withhold writes which the original Core
        // can still validate against the exact Session and Run. Never invent a process-state.
        emit({ type: 'agent-error', code: error instanceof AgentMuxError ? error.code : 'CONTROL_UNAVAILABLE',
          message: `The original Host and Session Store are confirmed; the current process projection is unconfirmed. Session metadata and the saved workbench remain retained. Actual operations are checked by the original Core. Refresh the original Session to confirm process facts. ${error instanceof Error ? error.message : String(error)}`,
          evidence: { source: 'agentmux', observedAt: Date.now() } })
      }
      requireObservation()
      if (previous) {
        // Restore observation only. Never retry an input, Prompt or interaction write after lost ACK.
        for (const reading of [...attached.values()]) {
          requireObservation()
          if (attached.get(reading.run.runId) !== reading) continue
          try {
            const response = await rpc.call('runtime.invoke', { consumerId,
              invocation: { method: 'refreshRunAttachment', args: [reading.run, reading.afterByte, reading.view] } })
            const value = decodeHostedValue(response.value) as AgentMuxRunAttachment
            if (attached.get(reading.run.runId) !== reading) continue
            requireObservation()
            emit({ type: 'terminal-snapshot', ...value, afterByte: reading.afterByte })
          } catch (error) {
            if (attached.get(reading.run.runId) !== reading) continue
            emit({ type: 'agent-error', code: error instanceof AgentMuxError ? error.code : 'CONTROL_UNAVAILABLE',
              message: `Original Run observation could not be restored: ${error instanceof Error ? error.message : String(error)}`,
              evidence: { source: 'run-process', observedAt: Date.now(), run: reading.run } })
          }
        }
        for (const read of histories) {
          requireObservation()
          try { await openHistory(read) }
          catch (error) {
            notifyHistory(read, { kind: 'unavailable', agentSessionId: read.id,
              ...(read.source ? { source: read.source } : {}), code: 'AGENT_SESSION_HISTORY_CONNECTION_UNCONFIRMED',
              message: `The original native history watch could not be restored; the previous window remains. ${error instanceof Error ? error.message : String(error)} Explicitly refresh this source.` })
            retryHistory(read)
          }
        }
        requireObservation()
        connectionState('restored')
      }
    })().finally(() => { connecting = undefined })
    return connecting
  }
  const client: Record<string, unknown> = {
    connect,
    providers: { catalog: () => structuredClone(requireBootstrap().catalog), get: (id: string) => {
      const catalog = requireBootstrap().catalog.find(value => value.id === id)
      if (!catalog) throw new AgentMuxError(`Unknown Agent Provider: ${id}`, 'UNKNOWN_PROVIDER')
      return { catalog: structuredClone(catalog) }
    } },
    catalog: () => structuredClone(requireBootstrap().catalog),
    runtimeIdentity: () => structuredClone(requireBootstrap().identity),
    agentSessions: () => structuredClone(requireBootstrap().sessions), agentSession: session,
    resolveAgentSession: (lookup: Parameters<AgentMuxHostedClient['resolveAgentSession']>[0]) => {
      if (lookup.kind === 'agent-session') return session(lookup.agentSessionId)
      const found = requireBootstrap().sessions.find(value => lookup.kind === 'run' ? value.run.runId === lookup.run.runId
        : lookup.kind === 'provider-native' ? value.nativeHandle?.kind === 'provider' && value.nativeHandle.providerId === lookup.providerId && value.nativeHandle.sessionId === lookup.sessionId
        : value.nativeHandle?.kind === 'acp' && value.nativeHandle.adapterId === lookup.adapterId && value.nativeHandle.sessionId === lookup.sessionId)
      if (found) return structuredClone(found)
      if (lookup.kind === 'run' && requireBootstrap().sessions.some(value => value.retiredRuns.some(run => run.runId === lookup.run.runId))) {
        throw new AgentMuxError('Run binding is retired.', 'STALE_AGENT_SESSION_BINDING')
      }
      throw new AgentMuxError('Agent Session lookup did not match a current binding.', 'UNKNOWN_AGENT_SESSION_BINDING')
    },
    agentMessageQueuePath: () => requireBootstrap().messageQueuePath,
    observeAgentOutput: async (...args: Parameters<AgentMuxHostedClient['observeAgentOutput']>) => {
      await connect()
      if (disposed) throw new AgentMuxError('Hosted consumer is disposed.', 'CONTROL_CANCELLED')
      const output = createHostedOutputObservation(rpc, ...args)
      outputs.add(output)
      try {
        const { initial, replay } = await output.ready
        if (disposed) throw new AgentMuxError('Hosted consumer is disposed.', 'CONTROL_CANCELLED')
        return { session: initial.session, attachment: { run: initial.run, replay, gap: initial.gap,
          terminal: initial.terminal, resizeRevision: initial.resizeRevision },
          close: async () => { outputs.delete(output); await output.close() } }
      } catch (error) { outputs.delete(output); await output.close().catch(() => {}); throw error }
    },
    observeSessionHistory: async (agentSessionId: string, listener: (value: AgentSessionHistoryObservation) => void,
      historyOptions: AgentSessionHistoryObservationOptions = {}) => {
      await connect()
      historyOptions.signal?.throwIfAborted()
      const read: HistoryRead = { id: agentSessionId, listener, options: historyOptions,
        epoch: 0, disposed: false, resume: true, attempts: 0 }
      read.abort = () => releaseHistory(read)
      historyOptions.signal?.addEventListener('abort', read.abort, { once: true })
      histories.add(read)
      try { await openHistory(read) }
      catch (error) { releaseHistory(read); throw error }
      return { source: read.source, dispose: () => releaseHistory(read) }
    },
    dispose: async () => {
      if (disposed) return
      disposed = true; eventEpoch++
      if (retry) clearTimeout(retry)
      const resources = [stream].filter((value): value is AgentMuxHostedSubscription => Boolean(value))
      for (const read of [...histories]) releaseHistory(read)
      const ownedOutputs = [...outputs]; outputs.clear()
      stream = undefined; publisher.dispose()
      await Promise.allSettled([...resources.map(value => value.dispose()), ...ownedOutputs.map(value => value.close())])
      // Event stream cleanup also releases this consumer if this receipt cannot get through.
      await rpc.call('runtime.release-consumer', { consumerId }).catch(() => {})
      attached.clear()
    },
    onEvent: (listener: (event: AgentMuxClientEvent) => void) => publisher.onEvent(listener)
  }
  for (const method of AGENTMUX_HOSTED_METHODS) client[method] = async (...args: unknown[]) => {
    // Closing a viewer withdraws its local reading intent immediately. A missing remote
    // receipt remains an error, but reconnect must not resurrect the closed reader.
    if (method === 'releaseRunAttachment') attached.delete((args[0] as AgentMuxRunRef).runId)
    const value = await invoke(method, args)
    const attachment = method === 'reattachAgent' ? (value as { attachment: AgentMuxRunAttachment }).attachment
      : method === 'attachTerminal' || method === 'refreshRunAttachment' ? value as AgentMuxRunAttachment : undefined
    if (attachment) attached.set(attachment.run.runId, { run: { runId: attachment.run.runId },
      afterByte: attachment.run.latestOutputBytes, view: (args[2] as 'raw' | 'terminal' | undefined) ?? 'raw' })
    if (value && typeof value === 'object') {
      const result = value as { agentSessionId?: string; session?: AgentMuxAgentSession }
      const updated = result.agentSessionId ? value as AgentMuxAgentSession : result.session
      if (updated?.kind === 'agent') emit({ type: 'agent-session', session: updated })
    }
    return value
  }
  if (options.waitForReady === false) {
    void connect().catch(error => { connectionFailure(error); connectionState('lost'); reconnect() })
  } else await connect()
  return client as AgentMuxHostedClient
}
