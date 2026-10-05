import { parseControlEndpointState } from './control-endpoint-state.js'
import { randomClientRequestId } from './client-request-id.js'
import { AgentMuxError } from './errors.js'
import { AgentMuxClientEventPublisher } from './client-event-publisher.js'
import type { AgentMuxClientEvent, AgentMuxClientEventListener, AgentMuxClientEventListenerOptions, AgentMuxAgentSession, AgentMuxRunAttachment, AgentMuxRunRef,
  AgentSessionHistoryObservation, AgentSessionHistoryObservationHandle, AgentSessionHistoryObservationOptions } from './types.js'
import { AGENTMUX_HOSTED_METHODS, type AgentMuxRuntimeOwnerIdentity, type AgentMuxHostedClient, type AgentMuxHostedRpcPort,
  type AgentMuxHostedBootstrap, type AgentMuxHostedMethod, type AgentMuxHostedInvocation,
  type AgentMuxHostedSubscription, type AgentMuxRuntimeFence, type AgentMuxHostedForwardRpc,
  type AgentMuxHostedAttachmentTarget, type AgentMuxHostedStreamValue } from './hosted-client-contract.js'
import { decodeHostedValue, encodeHostedValue, AgentMuxHostedTransferReader, parseHostedBootstrap, parseHostedRuntimeOwnerIdentity } from './hosted-value.js'
import { parseSessionHistoryResourceOptions, parseSessionHistoryResourceReadResult } from './session-history-resource.js'
import { parseOutputGapEvidence } from './output-gap-evidence.js'
import { createHostedOutputObservation } from './hosted-output-observer.js'

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof AbortSignal !== 'undefined' && value instanceof AbortSignal
}

/** A consumer connection to the Host. Disposing this object never owns the Core or a Run. */
export async function connectHostedAgentMux(options: {
  rpc: AgentMuxHostedRpcPort; consumerId?: string; waitForReady?: boolean; expectedStorePath?: string;
  expectedRuntimeId?: string; forwardRpc?: AgentMuxHostedForwardRpc
}): Promise<AgentMuxHostedClient> {
  const consumerId = options.consumerId ?? randomClientRequestId(), rpc = options.rpc
  const publisher = new AgentMuxClientEventPublisher()
  let controlOwner: AgentMuxRuntimeOwnerIdentity | undefined, controlConnecting: Promise<void> | undefined, controlEpoch = 0
  const acceptOwner = (owner: AgentMuxRuntimeOwnerIdentity): void => {
    if (controlOwner && (controlOwner.runtimeId !== owner.runtimeId || controlOwner.ownerInstanceId !== owner.ownerInstanceId)) controlEpoch++
    controlOwner = structuredClone(owner)
  }
  let endpointState: Extract<AgentMuxClientEvent, { type: 'control-endpoint-state' }> | undefined
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
  type Reading = { run: AgentMuxRunRef; afterByte: number; view: 'raw' | 'terminal'; target: AgentMuxHostedAttachmentTarget;
    stream: AgentMuxHostedSubscription; recovering?: Promise<void>; automaticRecoveryAttempted?: boolean; unavailable?: { code: string; message: string } }
  const attached = new Map<string, Reading>()
  const fence = (): AgentMuxRuntimeFence => {
    if (!controlOwner) throw new AgentMuxError('Confirm the original semantic owner before another Runtime intent.', 'RUNTIME_UNAVAILABLE')
    return { runtimeId: controlOwner.runtimeId, ownerInstanceId: controlOwner.ownerInstanceId }
  }
  const discoverControlOwner = async (expectedRuntimeId?: string): Promise<AgentMuxRuntimeOwnerIdentity> => {
    const previous = controlOwner
    try {
      const discovery = await rpc.call('runtime.owner.identity', expectedRuntimeId === undefined ? {} : { expectedRuntimeId })
      return parseHostedRuntimeOwnerIdentity(discovery.owner)
    } catch (error) {
      // A failed control identity read differs from a failed observation lease.
      // Keep its exact fence; a late failure cannot revoke a newer confirmed owner.
      if (!disposed && previous && controlOwner === previous) controlOwner = { ...previous, availability: 'unverified' }
      throw error
    }
  }
  const connectControl = async (refresh = false): Promise<void> => {
    if (disposed) throw new AgentMuxError('Hosted consumer is disposed.', 'CONTROL_CANCELLED')
    if (controlConnecting) return await controlConnecting
    if (controlOwner && !refresh) return
    controlConnecting = (async () => {
      const expectedRuntimeId = options.expectedRuntimeId ?? controlOwner?.runtimeId
      const discovered = await discoverControlOwner(expectedRuntimeId)
      if (disposed) throw new AgentMuxError('Hosted consumer was disposed during owner discovery.', 'CONTROL_CANCELLED')
      acceptOwner(discovered)
    })().finally(() => { controlConnecting = undefined })
    await controlConnecting
  }
  const emit = (event: AgentMuxClientEvent): void => {
    if (event.type === 'control-endpoint-state') {
      try {
        const { type: _type, evidence, ...state } = event
        parseControlEndpointState(state)
        if (!evidence || evidence.source !== 'agentmux' || !Number.isSafeInteger(evidence.observedAt) || evidence.observedAt < 0) throw new AgentMuxError('Invalid control publication evidence.', 'CONTROL_PROTOCOL_ERROR')
      } catch {
        publisher.publish({ type: 'agent-error', code: 'CONTROL_PROTOCOL_ERROR', message: 'The Host supplied invalid control endpoint publication evidence. Its existing connection and input remain available.', evidence: { source: 'agentmux', observedAt: Date.now() } })
        return
      }
      endpointState = structuredClone(event)
    }
    if (event.type === 'agent-error' && event.evidence?.outputGap !== undefined) {
      try { parseOutputGapEvidence(event.evidence) }
      catch (error) {
        // Reject this decoded observation without releasing a healthy Host lease.
        // Invalid evidence cannot establish its claimed Session or Run scope.
        publisher.publish({ type: 'agent-error', code: 'CONTROL_PROTOCOL_ERROR',
          message: 'The Host supplied invalid output Gap evidence. Its connection and input remain available; refresh the output observation.',
          evidence: { source: 'agentmux', observedAt: Date.now() } })
        return
      }
    }
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
  let connectionPhase: 'lost' | 'restored' | 'unrecoverable' | undefined
  const connectionState = (state: 'lost' | 'restored' | 'unrecoverable', error?: unknown): void => {
    // Retries update the same pending observation; they do not lose a second
    // connection. Keep one transition and its original scoped diagnostic.
    if (connectionPhase === state) return
    connectionPhase = state
    emit({ type: 'connection-state', state,
      ...(error instanceof Error ? { diagnostic: { code: error instanceof AgentMuxError ? error.code : 'RUNTIME_UNAVAILABLE',
        message: `${error.message} Existing Session references are retained; reconnect this endpoint to restore observation.` } } : {}),
      evidence: { source: 'run-process', observedAt: Date.now() } })
  }
  const connectionFailure = (error: unknown): void => connectionState(error instanceof AgentMuxError && error.code === 'AGENT_CAPABILITY_INVALID' ? 'unrecoverable' : 'lost', error)
  const attachmentUnavailable = (reading: Reading, error: unknown, step: string): void => {
    reading.unavailable = { code: error instanceof AgentMuxError ? error.code : 'RUNTIME_ATTACHMENT_UNAVAILABLE',
      message: `${step}: ${error instanceof Error ? error.message : String(error)} This reader stopped after byte ${reading.afterByte}; the original Run is retained. Refresh this observation if independent reread does not recover it.` }
    emit({ type: 'attachment-state', state: 'unavailable', run: reading.run, afterByte: reading.afterByte,
      diagnostic: reading.unavailable,
      ...(reading.target.kind === 'agent-session' ? { agentSessionId: reading.target.agentSessionId } : {}),
      evidence: { source: 'agentmux', observedAt: Date.now(), run: reading.run } })
  }
  const requireBootstrap = (): AgentMuxHostedBootstrap => {
    if (!bootstrap) throw new AgentMuxError('The semantic Host identity is not confirmed.', 'CONTROL_UNAVAILABLE')
    return bootstrap
  }
  const session = (id: string): AgentMuxAgentSession => {
    if (!stream) throw new AgentMuxError('Session ownership is unverified while its endpoint is unavailable.', 'RUNTIME_UNAVAILABLE')
    const value = requireBootstrap().sessions.find(value => value.agentSessionId === id)
    if (!value) throw new AgentMuxError('Unknown Agent Session.', 'UNKNOWN_AGENT_SESSION')
    return structuredClone(value)
  }
  const invoke = async (method: AgentMuxHostedMethod, args: unknown[]): Promise<unknown> => {
    if (disposed) throw new AgentMuxError('Hosted consumer is disposed.', 'CONTROL_CANCELLED')
    if (method === 'sessionHistoryResource') {
      const request = parseSessionHistoryResourceOptions(args[1])
      args = [args[0], { ...request, source: { ...request.source },
        ...(request.args ? { args: [...request.args] } : {}), ...(request.env ? { env: { ...request.env } } : {}) }, ...args.slice(2)]
    }
    if (method === 'clientPerformanceDiagnostics') {
      if (!stream || !bootstrap) throw new AgentMuxError('Performance owner is not connected.', 'CONTROL_UNAVAILABLE')
    } else await connectControl(method === 'connectRuntime')
    let signal: AbortSignal | undefined, wireArgs = args
    if (method === 'clientPerformanceDiagnostics') {
      const options = args[0] as { signal?: AbortSignal } | undefined
      if (isAbortSignal(options?.signal)) { signal = options.signal; wireArgs = [] }
    }
    // Cancellation belongs to the exact SDK field. Ordinary data, including env.signal,
    // crosses unchanged; the value codec never classifies fields by their names.
    if (method === 'submitAgentPrompt') {
      const input = args[0] as Parameters<AgentMuxHostedClient['submitAgentPrompt']>[0]
      if (isAbortSignal(input.signal)) {
        const { signal: cancellation, ...value } = input
        signal = cancellation; wireArgs = [value, ...args.slice(1)]
      }
    }
    if (method === 'sessionHistoryPage' || method === 'sessionHistoryResource') {
      const input = args[1] as Parameters<AgentMuxHostedClient['sessionHistoryPage']>[1]
      if (input && isAbortSignal(input.signal)) {
        const { signal: cancellation, ...value } = input
        signal = cancellation; wireArgs = [args[0], value, ...args.slice(2)]
      }
    }
    const response = await rpc.call('runtime.invoke', { consumerId, fence: fence(),
      invocation: encodeHostedValue({ method, args: wireArgs }) as AgentMuxHostedInvocation }, signal ? { signal } : {})
    if (method === 'connectRuntime') await connectControl(true)
    const decoded = decodeHostedValue(response.value)
    if (method === 'sessionHistoryResource') {
      const request = parseSessionHistoryResourceOptions(wireArgs[1])
      if (typeof wireArgs[0] !== 'string' || !decoded || typeof decoded !== 'object' || Array.isArray(decoded))
        throw new AgentMuxError('Invalid recorded resource reply.', 'CONTROL_PROTOCOL_ERROR')
      return parseSessionHistoryResourceReadResult(decoded, wireArgs[0], request)
    }
    return decoded
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
    if (disposed || read.disposed || !read.resume || read.retry || read.acquiring || read.attempts >= 8) return
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
      const transfer = new AgentMuxHostedTransferReader()
      const watch = await rpc.subscribe('runtime.history-watch', { consumerId, fence: fence(), agentSessionId: read.id,
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
          if (value.type === 'error') throw new AgentMuxError(value.error.message, value.error.code)
          if (value.type === 'snapshot') {
            const received = transfer.accept(value.data) as AgentMuxHostedStreamValue | undefined
            if (received?.kind === 'history') {
              notifyHistory(read, received.observation)
              if (received.observation.kind === 'unavailable') { read.resume = false; releaseHistory(read) }
            }
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
    // Retry observation until this consumer is disposed; never replay an invocation.
    retry = setTimeout(() => {
      retry = undefined
      reconnectAttempts++
      void connect().catch(error => { connectionFailure(error); if (error instanceof AgentMuxError && error.code === 'AGENT_CAPABILITY_INVALID') return; reconnectDelay = Math.min(reconnectDelay * 2, 30000); reconnect() })
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
      const expectedRuntimeId = options.expectedRuntimeId ?? previous?.owner.runtimeId
      const owner = await discoverControlOwner(expectedRuntimeId)
      acceptOwner(owner)
      const expected = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }
      const transfer = new AgentMuxHostedTransferReader()
      let initialSeen = false, transferId = ''
      let resolveInitial!: () => void, rejectInitial!: (error: unknown) => void
      const initialReady = new Promise<void>((yes, no) => { resolveInitial = yes; rejectInitial = no })
      void initialReady.catch(() => {})
      const timer = setTimeout(() => rejectInitial(new AgentMuxError('Runtime initial observation did not complete; the saved workbench is retained.', 'CONTROL_TIMEOUT')), 60_000)
      let acquired: AgentMuxHostedSubscription | undefined
      let releasing: Promise<void> | undefined
      const releaseAcquired = (): Promise<void> => {
        if (!acquired) return Promise.resolve()
        // Cache before invoking the transport: dispose may synchronously call onEnd.
        return releasing ??= Promise.resolve().then(() => acquired!.dispose())
      }
      const endObservation = (error: unknown): void => {
        if (ended) return
        ended = true; rejectInitial(error)
        if (epoch !== eventEpoch || disposed) return
        stream = undefined
        connectionState('lost', error)
        // Only this failed observation is released. Retained Sessions and healthy Runs survive.
        void releaseAcquired().catch(connectionFailure).finally(reconnect)
      }
      try {
        acquired = await rpc.subscribe('runtime.events', { consumerId, fence: expected }, {
          onInitial: value => {
            requireObservation()
            if (value.owner.runtimeId !== expected.runtimeId || value.owner.ownerInstanceId !== expected.ownerInstanceId) throw new AgentMuxError('Runtime opening belongs to another owner.', 'RUNTIME_OWNER_CHANGED')
            transferId = value.transferId
          },
          onEvent: value => {
            if (ended || epoch !== eventEpoch || disposed) return
            try {
              if (value.type === 'error') throw new AgentMuxError(value.error.message, value.error.code)
              if (value.type !== 'snapshot') return
              if (!initialSeen && value.data.transferId !== transferId) throw new AgentMuxError('Runtime initial transfer belongs to another observation.', 'CONTROL_PROTOCOL_ERROR')
              const received = transfer.accept(value.data) as AgentMuxHostedStreamValue | undefined
              if (!received) return
              if (received.kind === 'initial') {
                if (initialSeen) throw new AgentMuxError('Runtime repeated its initial observation.', 'CONTROL_PROTOCOL_ERROR')
                const observed = parseHostedBootstrap(received.value)
                if (observed.owner.runtimeId !== expected.runtimeId || observed.owner.ownerInstanceId !== expected.ownerInstanceId) throw new AgentMuxError('Runtime bootstrap belongs to another owner.', 'RUNTIME_OWNER_CHANGED')
                if (options.expectedStorePath !== undefined && observed.storePath !== options.expectedStorePath) throw new AgentMuxError('This Host owns a different durable Session Store. The original workbench is retained.', 'CONTROL_OWNER_BUSY')
                bootstrap = structuredClone(observed); initialSeen = true
                for (const retained of bootstrap.sessions) emit({ type: 'agent-session', session: structuredClone(retained) })
                resolveInitial()
              } else if (received.kind === 'event') {
                if (!initialSeen) throw new AgentMuxError('Runtime mutation preceded its initial observation.', 'CONTROL_PROTOCOL_ERROR')
                if (received.event.type === 'connection-state' && received.event.state === 'restored') {
                  const restored = parseHostedRuntimeOwnerIdentity(received.owner)
                  if (restored.runtimeId !== expected.runtimeId || restored.ownerInstanceId !== expected.ownerInstanceId) throw new AgentMuxError('Runtime restored facts belong to another semantic owner.', 'RUNTIME_OWNER_CHANGED')
                  // Native may restart while this semantic Host and event lease stay
                  // alive. Publish restored only after its current input fence is visible.
                  acceptOwner(restored)
                  bootstrap!.owner = structuredClone(restored)
                  bootstrap!.identity = structuredClone(restored.ctxmux)
                }
                emit(received.event)
              }
            } catch (error) { rejectInitial(error); if (initialSeen) endObservation(error) }
          },
          onEnd: error => endObservation(error ?? new AgentMuxError('Host observation ended.', 'RUNTIME_UNAVAILABLE'))
        })
        await initialReady
      } catch (error) { await releaseAcquired(); throw error }
      finally { clearTimeout(timer) }
      if (disposed || ended || epoch !== eventEpoch) { await releaseAcquired(); requireObservation() }
      stream = { dispose: releaseAcquired }
      reconnectDelay = 100
      reconnectAttempts = 0
      let projectionFailure: unknown
      try {
        const projectionResponse = await rpc.call('runtime.invoke', { consumerId, fence: fence(),
          invocation: { method: 'runtimeProjection', args: [] } })
        const projection = decodeHostedValue(projectionResponse.value) as Awaited<ReturnType<AgentMuxHostedClient['runtimeProjection']>>
        for (const subject of projection.subjects) publisher.publishRunState(subject.run,
          subject.kind === 'agent' ? subject.agentSession.agentSessionId : undefined)
      } catch (error) {
        projectionFailure = error
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
          await reading.recovering
          if (attached.get(reading.run.runId) !== reading || !reading.unavailable) continue
          try {
            const value = await watchAttachment(reading.target, reading.afterByte, reading.view, true, undefined, reading.run.runId)
            if (!attached.has(reading.run.runId)) continue
            requireObservation()
            const observation = 'attachment' in value ? value.attachment : value
            emit({ type: 'terminal-snapshot', ...observation, afterByte: reading.afterByte,
              ...('session' in value ? { agentSessionId: value.session.agentSessionId } : {}) })
          } catch (error) {
            if (attached.get(reading.run.runId) !== reading) continue
            attachmentUnavailable(reading, error, 'Restoring the original Run observation did not complete')
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
        connectionState('restored', projectionFailure)
      } else if (connectionPhase !== undefined) connectionState('restored', projectionFailure)
    })().finally(() => { connecting = undefined })
    return connecting
  }
  const openingReaders = new Map<string, object>()
  const watchAttachment = async (target: AgentMuxHostedAttachmentTarget, afterByte: number, view: 'raw' | 'terminal',
    refresh = false, operationId?: string, readerKey?: string, replayOnly = false): Promise<AgentMuxRunAttachment | { session: AgentMuxAgentSession; attachment: AgentMuxRunAttachment }> => {
    await connectControl()
    let runId = target.runId
    if (!runId && target.kind !== 'agent-session') throw new AgentMuxError('Attachment requires an exact Run or Session.', 'INVALID_CONTROL_REQUEST')
    let key = readerKey ?? runId ?? `session:${target.kind === 'agent-session' ? target.agentSessionId : ''}`
    const previous = attached.get(key), admission = {}, epoch = controlEpoch, expected = fence()
    if (!replayOnly) openingReaders.set(key, admission)
    const transfer = new AgentMuxHostedTransferReader()
    let transferId = '', initialSeen = false, cursor = afterByte, failure: unknown, subscription: AgentMuxHostedSubscription | undefined
    let resolve!: (value: AgentMuxRunAttachment | { session: AgentMuxAgentSession; attachment: AgentMuxRunAttachment }) => void, reject!: (error: unknown) => void
    const ready = new Promise<AgentMuxRunAttachment | { session: AgentMuxAgentSession; attachment: AgentMuxRunAttachment }>((yes, no) => { resolve = yes; reject = no })
    void ready.catch(() => {})
    const failed = (error: unknown) => {
      if (failure !== undefined) return
      failure = error; reject(error)
      const reading = attached.get(key)
      if (!initialSeen || replayOnly || !reading || reading.stream !== subscription || disposed || epoch !== controlEpoch) return
      attachmentUnavailable(reading, error, 'Attachment observation failed')
      if (reading.automaticRecoveryAttempted) return
      reading.automaticRecoveryAttempted = true
      reading.recovering = (async () => {
        await reading.stream.dispose()
        if (attached.get(key) !== reading || disposed || epoch !== controlEpoch) return
        const recovered = await watchAttachment(reading.target, reading.afterByte, reading.view, true, undefined, key)
        const restored = 'attachment' in recovered ? recovered.attachment : recovered
        emit({ type: 'terminal-snapshot', ...restored, afterByte: reading.afterByte,
          ...('session' in recovered ? { agentSessionId: recovered.session.agentSessionId } : {}) })
      })().catch(error => { if (attached.get(key) === reading && !disposed && epoch === controlEpoch)
        attachmentUnavailable(reading, error, 'The independent reread did not complete') }).finally(() => { delete reading.recovering })
    }
    const timer = setTimeout(() => failed(new AgentMuxError('Attachment transfer did not complete; its Run remains live.', 'CONTROL_TIMEOUT')), 60_000)
    try {
      const params = { consumerId, fence: expected, target: { ...target, ...(runId ? { runId } : {}) }, afterByte, view }
      subscription = await rpc.subscribe(replayOnly ? 'runtime.replay-watch' : 'runtime.attachment-watch',
        { ...params, ...(!replayOnly && refresh ? { refresh: true, ...(operationId === undefined ? {} : { operationId }) } : {}) }, {
          onInitial: value => {
            if (value.owner.runtimeId !== expected.runtimeId || value.owner.ownerInstanceId !== expected.ownerInstanceId) throw new AgentMuxError('Attachment belongs to another owner.', 'RUNTIME_OWNER_CHANGED')
            transferId = value.transferId
          },
          onEvent: value => {
            if (disposed || epoch !== controlEpoch) return
            try {
              if (value.type === 'error') throw new AgentMuxError(value.error.message, value.error.code)
              if (value.type !== 'snapshot') return
              if (!initialSeen && value.data.transferId !== transferId) throw new AgentMuxError('Attachment initial transfer changed identity.', 'CONTROL_PROTOCOL_ERROR')
              const received = transfer.accept(value.data) as AgentMuxHostedStreamValue | undefined
              if (!received) return
              if (received.kind === 'initial') {
                if (initialSeen) throw new AgentMuxError('Attachment repeated its initial observation.', 'CONTROL_PROTOCOL_ERROR')
                const result = received.value as AgentMuxRunAttachment | { session: AgentMuxAgentSession; attachment: AgentMuxRunAttachment }
                const attachment = 'attachment' in result ? result.attachment : result
                if (runId !== undefined && attachment.run.runId !== runId || 'session' in result && (target.kind !== 'agent-session' || result.session.agentSessionId !== target.agentSessionId || result.session.run.runId !== attachment.run.runId)) throw new AgentMuxError('Attachment belongs to another Session or Run.', 'STALE_AGENT_SESSION_BINDING')
                if ('session' in result) emit({ type: 'agent-session', session: result.session })
                runId = attachment.run.runId
                cursor = attachment.run.latestOutputBytes; initialSeen = true; resolve(result)
              } else if (received.kind === 'event') {
                if (!initialSeen) throw new AgentMuxError('Attachment mutation preceded its initial observation.', 'CONTROL_PROTOCOL_ERROR')
                let event = received.event
                if (event.type === 'terminal-output') {
                  const range = event.evidence.outputByteRange
                  if (event.run.runId !== runId) throw new AgentMuxError('Output belongs to another Run.', 'STALE_AGENT_SESSION_BINDING')
                  if (range.endByte <= cursor) return
                  if (range.startByte > cursor || range.endByte - range.startByte !== event.dataBytes.length) throw new AgentMuxError('Live output has an unreported byte Gap.', 'CONTROL_PROTOCOL_ERROR')
                  if (range.startByte < cursor) {
                    const dataBytes = event.dataBytes.subarray(cursor - range.startByte)
                    event = { ...event, dataBytes, data: new TextDecoder().decode(dataBytes),
                      evidence: { ...event.evidence, outputByteRange: { startByte: cursor, endByte: range.endByte } } }
                  }
                  cursor = range.endByte
                  const reading = attached.get(key); if (reading && reading.stream === subscription) reading.afterByte = cursor
                }
                emit(event)
              }
            } catch (error) { failed(error) }
          }, onEnd: error => { if (!replayOnly || !initialSeen) failed(error ?? new AgentMuxError('Attachment observation ended.', 'RUNTIME_ATTACHMENT_UNAVAILABLE')) }
        })
      const result = await ready
      if (failure !== undefined) throw failure
      if (disposed || epoch !== controlEpoch || !replayOnly && openingReaders.get(key) !== admission) throw new AgentMuxError('Attachment was cancelled or superseded; its Run remains retained.', 'CONTROL_CANCELLED')
      if (replayOnly) { await subscription.dispose(); return result }
      if (!readerKey && key !== runId) {
        openingReaders.delete(key); key = runId!; openingReaders.set(key, admission)
      }
      const replaced = attached.get(key)
      attached.set(key, { run: { runId: runId! }, afterByte: cursor, view, target: { ...target, runId: runId! }, stream: subscription,
        ...(previous?.automaticRecoveryAttempted ? { automaticRecoveryAttempted: true } : {}) })
      await replaced?.stream.dispose()
      // A valid initial cut cannot confirm a lease which ended while its predecessor released.
      if (failure !== undefined) throw failure
      if (replaced?.unavailable && attached.get(key)?.stream === subscription && !disposed && epoch === controlEpoch) {
        emit({ type: 'attachment-state', state: 'restored', run: { runId: runId! }, afterByte: cursor,
          ...(target.kind === 'agent-session' ? { agentSessionId: target.agentSessionId } : {}),
          evidence: { source: 'agentmux', observedAt: Date.now(), run: { runId: runId! } } })
      }
      return result
    } catch (error) { await subscription?.dispose(); throw error }
    finally { clearTimeout(timer); if (openingReaders.get(key) === admission) openingReaders.delete(key) }
  }
  const client: Record<string, unknown> = {
    connect,
    runtimeOwnerIdentity: () => controlOwner ? structuredClone(controlOwner) : null,
    disconnect: () => { eventEpoch++; controlEpoch++; controlOwner = undefined; openingReaders.clear(); const previous = stream; stream = undefined; void previous?.dispose();
      for (const reading of attached.values()) void reading.stream.dispose(); attached.clear();
      for (const read of [...histories]) releaseHistory(read) },
    ...(options.forwardRpc ? { forwardRpc: async (method: Parameters<AgentMuxHostedForwardRpc>[0], params: Parameters<AgentMuxHostedForwardRpc>[1], context: Parameters<AgentMuxHostedForwardRpc>[2] = {}) => {
      await connectControl(); return await options.forwardRpc!(method, params, { ...context, runtimeFence: fence() }) } } : {}),
    providers: { catalog: () => structuredClone(requireBootstrap().catalog), get: (id: string) => {
      const catalog = requireBootstrap().catalog.find(value => value.id === id)
      if (!catalog) throw new AgentMuxError(`Unknown Agent Provider: ${id}`, 'UNKNOWN_PROVIDER')
      return { catalog: structuredClone(catalog) }
    } },
    catalog: () => structuredClone(bootstrap?.catalog ?? []),
    runtimeIdentity: () => structuredClone(requireBootstrap().identity),
    agentSessions: () => structuredClone(bootstrap?.sessions ?? []), agentSession: session,
    resolveAgentSession: (lookup: Parameters<AgentMuxHostedClient['resolveAgentSession']>[0]) => {
      if (!stream) throw new AgentMuxError('Session lookup is unverified while its endpoint is unavailable.', 'RUNTIME_UNAVAILABLE')
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
      await connectControl()
      if (disposed) throw new AgentMuxError('Hosted consumer is disposed.', 'CONTROL_CANCELLED')
      const output = createHostedOutputObservation({ subscribe: (method, params, handlers) => rpc.subscribe(method, params, { ...handlers, runtimeFence: fence() }) }, ...args)
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
      await connectControl()
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
      disposed = true; eventEpoch++; controlEpoch++; openingReaders.clear()
      if (retry) clearTimeout(retry)
      const finalFence = controlOwner ? { runtimeId: controlOwner.runtimeId, ownerInstanceId: controlOwner.ownerInstanceId } : undefined
      const resources = [stream, ...[...attached.values()].map(value => value.stream)].filter((value): value is AgentMuxHostedSubscription => Boolean(value))
      for (const read of [...histories]) releaseHistory(read)
      const ownedOutputs = [...outputs]; outputs.clear()
      stream = undefined; publisher.dispose()
      await Promise.allSettled([...resources.map(value => value.dispose()), ...ownedOutputs.map(value => value.close())])
      // Explicit client disposal releases all observations owned by this consumer.
      if (finalFence) await rpc.call('runtime.release-consumer', { consumerId, fence: finalFence }).catch(() => {})
      attached.clear()
    },
    onEvent: <Result>(listener: AgentMuxClientEventListener<Result>, options?: AgentMuxClientEventListenerOptions) => publisher.onEvent(listener, options, () => endpointState ? structuredClone(endpointState) : undefined)
  }
  for (const method of AGENTMUX_HOSTED_METHODS) client[method] = async (...args: unknown[]) => {
    if (method === 'releaseRunAttachment') {
      const runId = (args[0] as AgentMuxRunRef).runId, reading = attached.get(runId)
      attached.delete(runId); openingReaders.delete(runId); await reading?.stream.dispose(); return
    }
    if (method === 'reattachAgent') return await watchAttachment({ kind: 'agent-session', agentSessionId: args[0] as string }, (args[1] as number | undefined) ?? 0, (args[2] as 'raw' | 'terminal' | undefined) ?? 'raw')
    if (method === 'attachTerminal') return await watchAttachment({ kind: 'terminal-run', runId: args[0] as string }, (args[1] as number | undefined) ?? 0, (args[2] as 'raw' | 'terminal' | undefined) ?? 'raw')
    if (method === 'refreshRunAttachment') {
      const value = await watchAttachment({ kind: 'terminal-run', runId: (args[0] as AgentMuxRunRef).runId }, (args[1] as number | undefined) ?? 0,
        (args[2] as 'raw' | 'terminal' | undefined) ?? 'raw', true, args[3] as string | undefined)
      return 'attachment' in value ? value.attachment : value
    }
    if (method === 'readRunReplay') return await watchAttachment({ kind: 'terminal-run', runId: (args[0] as AgentMuxRunRef).runId },
      (args[1] as number | undefined) ?? 0, (args[2] as 'raw' | 'terminal' | undefined) ?? 'raw', false, undefined, `replay:${randomClientRequestId()}`, true)
    const value = await invoke(method, args)
    if (value && typeof value === 'object') {
      const result = value as { agentSessionId?: string; session?: AgentMuxAgentSession }
      const updated = result.agentSessionId ? value as AgentMuxAgentSession : result.session
      if (updated?.kind === 'agent') emit({ type: 'agent-session', session: updated })
    }
    return value
  }
  if (options.waitForReady === false) {
    void connect().catch(error => { connectionState('lost', error); reconnect() })
  } else await connect()
  return client as AgentMuxHostedClient
}
