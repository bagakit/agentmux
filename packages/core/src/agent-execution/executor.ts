import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { createExecutionFrameChannel } from './channel.js'
import { AgentExecutionJournal, type AgentExecutionOperationKey } from './journal.js'
import type { AgentExecutionIntent, AgentExecutionMessage, AgentExecutionProtocol } from './protocol.js'
import { nativeConnectionRecovery } from './native-connection-recovery.js'

type Request = Extract<AgentExecutionMessage, { kind: 'request' }>
type Channel = ReturnType<typeof createExecutionFrameChannel>
type Pending = { key: AgentExecutionOperationKey; digest: string; request: Request; recoverableConnection?: true; response?: Uint8Array;
  nativeDispatch?: true; awaitingDispatch?: true; cancelled?: true }
type Generation = {
  id: string; child: ChildProcessWithoutNullStreams; channel: Channel; alive: boolean; initialized: boolean; initializing: boolean
  handshake?: ReturnType<typeof nativeConnectionRecovery>
  recovery?: Promise<boolean>
  firstRecoveredResult?: true
  pending: Map<string, Pending>; handles: Set<string>; creating: Set<string>; notifications: Set<string>
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const requestKey = (id: string | number) => JSON.stringify(id)
const handleKey = (handle: NonNullable<AgentExecutionIntent['handle']>) => JSON.stringify([handle.kind, handle.id])

/**
 * One resource binding's Provider connections, inside its existing ctxmux helper Run.
 * Core owns the helper Run. This executor owns only its native child transports
 * and the receipt of each operation at the original resource binding.
 */
export function createAgentExecutionExecutor(options: {
  bindingId: string
  journal: AgentExecutionJournal
  protocol: AgentExecutionProtocol
  input: Readable
  output: Writable
  /** Resolve only after the exact resource binding's permission has been established. */
  authorize(target: { bindingId: string; generation: string; intent: AgentExecutionIntent }): Promise<void>
  stderr?: Writable
  control?: {
    receive(frame: unknown, send: (frame: unknown) => Promise<void>): Promise<boolean>
    environment(generation: string): NodeJS.ProcessEnv | undefined
    close(): Promise<void>
  }
  onError(error: Error): void
}): { closeObservation(): void; dispose(): Promise<void> } {
  if (!options.bindingId || typeof options.authorize !== 'function') throw new TypeError('A fixed execution binding and its permission owner are required')
  const bindingId = options.bindingId
  let disposed = false
  const closed = new Set<string>()
  const children = new Map<string, Generation>()
  const retained = new Map<string, Map<string, Pending>>()
  const executions = new Set<Promise<void>>()
  const report = async (generation: string, code: string, operation?: AgentExecutionOperationKey, scope: 'helper' | 'request' | 'generation' = 'generation') => {
    if (disposed) return
    await channel.send({ type: 'diagnostic', scope: operation ? 'operation' : scope, generation, code, ...(operation ? { operation } : {}) }).catch(() => {
      options.onError(new Error('Execution diagnostic delivery is unconfirmed; the original operation remains retained'))
    })
  }
  const reject = async (generation: string, requestId: string | number | undefined, code: number, message: string) => {
    if (requestId === undefined) { await report(generation, 'INVALID_NATIVE_MESSAGE', undefined, 'request'); return }
    await channel.send({ type: 'response', generation, payload: { jsonrpc: '2.0', id: requestId, error: { code, message } } })
  }
  const outcomeUnconfirmed = async (key: AgentExecutionOperationKey, code: string): Promise<void> => {
    try {
      await reject(key.streamGeneration, key.nativeRequestId, -32603,
        `The resource host could not confirm the original tool operation (${code}). Inspect its outcome before repeating it.`)
    } finally {
      await report(key.streamGeneration, code, key)
    }
  }
  const replyCommitted = async (key: AgentExecutionOperationKey, bytes: Uint8Array, request: Request): Promise<void> => {
    const response = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>
    const generation = key.streamGeneration
    await channel.send({ type: 'response', generation, payload: options.protocol.projectResponse?.(request, response) ?? response })
    await completed(key)
  }
  const completed = (key: AgentExecutionOperationKey) => channel.send({ type: 'operation-completed', generation: key.streamGeneration, operation: key }).catch(() => {
    options.onError(new Error('The durable operation completed and its diagnostic delivery is unconfirmed'))
  })
  const settle = async (pending: Pending, state?: Generation): Promise<void> => {
    if (!pending.response) return
    const payload: unknown = JSON.parse(Buffer.from(pending.response).toString('utf8'))
    const success = object(payload) && Object.hasOwn(payload, 'result')
    const generation = pending.key.streamGeneration
    try {
      const recoverable = success && pending.recoverableConnection && pending.request.intent.initialize && !closed.has(generation) &&
        options.protocol.restoreConnection?.(pending.request.payload, payload)
      if (recoverable) {
        try { await options.journal.complete(pending.key, pending.digest, pending.response, pending.request.payload) }
        catch {
          // Commit/reconcile the same response even if optional recovery evidence cannot be saved.
          await options.journal.complete(pending.key, pending.digest, pending.response)
          void report(generation, 'NATIVE_CONNECTION_RECOVERY_EVIDENCE_UNCONFIRMED')
        }
      } else await options.journal.complete(pending.key, pending.digest, pending.response)
    } catch {
      // The reply ends the current wait. The native response stays associated
      // with the original operation for an exact persistence retry.
      await outcomeUnconfirmed(pending.key, 'RESPONSE_STORAGE_UNCONFIRMED')
      return
    }
    if (state) {
      const handle = pending.request.intent.handle
      if (handle?.action === 'create') {
        state.creating.delete(handleKey(handle))
        if (success) state.handles.add(handleKey(handle))
      } else if (handle?.action === 'close' && success) state.handles.delete(handleKey(handle))
      if (pending.request.intent.initialize) {
        state.initializing = false
        if (success) state.initialized = true
      }
    }
    const operations = retained.get(generation)
    operations?.delete(requestKey(pending.key.nativeRequestId))
    if (!operations?.size) retained.delete(generation)
    await replyCommitted(pending.key, pending.response, pending.request)
    if (success && state?.initialized && (pending.request.intent.initialize || state.firstRecoveredResult)) {
      delete state.firstRecoveredResult
      await channel.send({ type: 'native-connection-ready', generation: state.id })
    }
  }
  const start = (generation: string, handshake?: ReturnType<typeof nativeConnectionRecovery>): Generation => {
    const spec = options.protocol.executor
    // stderr is never connected to the helper Run's machine-protocol stdout.
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: { ...process.env, ...spec.env, ...options.control?.environment(generation) }, stdio: ['pipe', 'pipe', 'pipe'] })
    if (options.stderr) child.stderr.pipe(options.stderr, { end: false })
    else child.stderr.resume()
    const state: Generation = { id: generation, child, channel: undefined as unknown as Channel, alive: true, initialized: false, initializing: false,
      ...(handshake ? { handshake } : {}),
      pending: new Map(), handles: new Set(), creating: new Set(), notifications: new Set() }
    state.channel = createExecutionFrameChannel({ input: child.stdout, output: child.stdin,
      onError: () => { void report(generation, 'NATIVE_PROTOCOL_OBSERVATION_UNCONFIRMED') },
      async onFrame(payload, rawLine) {
        try {
        const message = options.protocol.parseServer(payload)
        if (message.kind === 'notification') {
          if (state.handshake) return
          await channel.send({ type: 'response', generation, payload: message.payload }); return
        }
        if (message.kind !== 'response') { await report(generation, 'UNEXPECTED_NATIVE_MESSAGE'); return }
        if (state.handshake?.receive(message.requestId, message.payload)) return
        const pending = state.pending.get(requestKey(message.requestId))
        if (!pending || !pending.nativeDispatch) { await report(generation, 'UNMATCHED_NATIVE_RESPONSE'); return }
        if (pending.response && !Buffer.from(pending.response).equals(rawLine)) {
          await report(generation, 'CONFLICTING_NATIVE_RESPONSE', pending.key); return
        }
        pending.response = Uint8Array.from(rawLine)
        await settle(pending, state)
        } catch { await report(generation, 'NATIVE_RESPONSE_OBSERVATION_UNCONFIRMED') }
      } })
    const ended = () => {
      if (!state.alive) return
      const wasConnected = !closed.has(generation)
      state.handshake?.cancel()
      state.alive = false
      if (!state.handshake) closed.add(generation)
      state.handles.clear(); state.creating.clear(); children.delete(generation)
      void (async () => {
        // Exit can precede the last stdout frames. Let the original reader
        // settle those replies before identifying the operations still missing one.
        await state.channel.drained
        if (disposed) return
        for (const pending of state.pending.values()) {
          if (!pending.nativeDispatch || pending.response) continue
          state.pending.delete(requestKey(pending.key.nativeRequestId))
          try { await options.journal.markUnknown(pending.key, pending.digest) } catch { /* The original journal receipt remains authoritative. */ }
          await outcomeUnconfirmed(pending.key, 'NATIVE_CONNECTION_ENDED_OUTCOME_UNKNOWN')
        }
        if (!state.pending.size) retained.delete(generation)
        if (wasConnected) await report(generation, 'NATIVE_CONNECTION_ENDED')
        else await channel.send({ type: 'generation', generation, state: 'exited' })
      })().catch(() => options.onError(new Error('Native connection-end observation is unconfirmed')))
    }
    child.once('exit', ended)
    child.on('error', () => {
      // A failed spawn has no process. Errors after spawn (including a failed
      // signal) do not prove exit and cannot retire its generation or pending work.
      if (child.pid === undefined) ended()
      else void report(generation, 'NATIVE_PROCESS_ERROR_UNCONFIRMED')
    })
    child.stdin.on('error', () => { void report(generation, 'NATIVE_INPUT_UNCONFIRMED') })
    child.stderr.on('error', () => { void report(generation, 'NATIVE_STDERR_OBSERVATION_UNCONFIRMED') })
    children.set(generation, state)
    if (handshake) {
      state.recovery = handshake.negotiate(frame => state.channel.send(frame)).then(accepted => {
        if (!accepted || !state.alive || closed.has(generation) || disposed) {
          if (state.alive) state.child.kill('SIGTERM')
          return false
        }
        delete state.handshake
        delete state.recovery
        state.initialized = true
        state.firstRecoveredResult = true
        return true
      })
    }
    return state
  }
  const channel = createExecutionFrameChannel({ input: options.input, output: options.output, onError: options.onError,
    async onFrame(frame) {
      try {
      if (disposed) return
      if (await options.control?.receive(frame, value => channel.send(value))) return
      if (!object(frame) || typeof frame.generation !== 'string' || !frame.generation) {
        await report('', 'INVALID_EXECUTION_FRAME', undefined, 'request'); return
      }
      if (frame.type === 'closed') {
        // Only the original frontend's machine receipt closes this generation.
        // Core reader detach is not this fact and cannot terminate its child.
        if (!closed.has(frame.generation)) {
          closed.add(frame.generation)
          children.get(frame.generation)?.handshake?.cancel()
          if (options.protocol.restoreConnection) {
            try { await options.journal.retireConnectionInitialization(bindingId, frame.generation) }
            catch { void report(frame.generation, 'NATIVE_CONNECTION_RECOVERY_EVIDENCE_UNCONFIRMED') }
          }
          await channel.send({ type: 'generation', generation: frame.generation, state: 'detached' })
        }
        return
      }
      if (frame.type !== 'request' || !Object.hasOwn(frame, 'payload')) {
        await report('', 'INVALID_EXECUTION_FRAME', undefined, 'request'); return
      }
      const generation = frame.generation, message = options.protocol.parse(frame.payload)
      if (message.kind === 'rejected') { await reject(generation, message.requestId, message.code, message.reason); return }
      if (message.kind === 'response') { await report(generation, 'UNEXPECTED_CLIENT_RESPONSE'); return }
      if (message.kind === 'notification') {
        const state = children.get(generation)
        if (message.cancels !== undefined) {
          const pending = state?.pending.get(requestKey(message.cancels))
          if (pending?.awaitingDispatch) { pending.cancelled = true; return }
        }
        if (!state?.alive || closed.has(generation) || !state.initialized) { await report(generation, 'NATIVE_CONNECTION_NOT_INITIALIZED'); return }
        const hash = createHash('sha256').update(JSON.stringify(message.payload)).digest('hex')
        if (!state.notifications.has(hash)) {
          state.notifications.add(hash)
          try { await state.channel.send(message.payload) } catch { await report(generation, 'NATIVE_NOTIFICATION_DELIVERY_UNCONFIRMED') }
        }
        return
      }
      try { await options.authorize({ bindingId, generation, intent: message.intent }) }
      catch { await reject(generation, message.requestId, -32001, 'The requested execution binding permission was not granted'); return }
      const key: AgentExecutionOperationKey = { bindingId, streamGeneration: generation, nativeRequestId: message.requestId }
      const bytes = Buffer.from(JSON.stringify(message.payload))
      let previous
      try { previous = await options.journal.inspect(key) }
      catch { await outcomeUnconfirmed(key, 'ORIGINAL_REQUEST_INSPECTION_UNCONFIRMED'); return }
      if (previous) {
        let operation
        try { operation = await options.journal.prepare(key, bytes) }
        catch { await outcomeUnconfirmed(key, 'ORIGINAL_REQUEST_CONFLICT_OR_STORAGE_UNCONFIRMED'); return }
        if (operation.phase === 'completed') {
          let result
          try { result = await options.journal.readResult(key, operation.payloadDigest) }
          catch { await outcomeUnconfirmed(key, 'RESPONSE_READ_UNCONFIRMED'); return }
          if (!result) { await outcomeUnconfirmed(key, 'RESPONSE_READ_UNCONFIRMED'); return }
          await replyCommitted(key, result, message)
          return
        }
        if (operation.phase !== 'prepared') {
          const pending = retained.get(generation)?.get(requestKey(message.requestId))
          if (pending?.response) await settle(pending, children.get(generation))
          else if (!pending) await outcomeUnconfirmed(key, 'ORIGINAL_OPERATION_OUTCOME_UNKNOWN')
          // A live pending request waits for its original native response.
          return
        }
      }
      let current = children.get(generation)
      if (!current) {
        const anotherConnected = !options.protocol.concurrentConnections && [...children.values()].some(value => value.alive && !closed.has(value.id))
        if (!anotherConnected && !closed.has(generation) && !message.intent.initialize && options.protocol.restoreConnection) {
          try {
            const retained = await options.journal.readConnectionInitialization(bindingId, generation)
            const plan = retained && options.protocol.restoreConnection(retained.request, retained.response)
            if (plan) current = start(generation, nativeConnectionRecovery(plan))
          } catch { await report(generation, 'NATIVE_CONNECTION_RECOVERY_EVIDENCE_UNCONFIRMED') }
        }
        if (!current && (anotherConnected || closed.has(generation) || !message.intent.initialize || message.intent.resumeSessionId != null)) {
          await reject(generation, message.requestId, -32002, 'The exact original native connection is unavailable for this request'); return
        }
      } else if (closed.has(generation) || (message.intent.initialize ? current.initialized || current.initializing || current.recovery : !current.initialized && !current.recovery)) {
        await reject(generation, message.requestId, -32002, 'The original native connection has not accepted this initialization state'); return
      }
      const handle = message.intent.handle
      if (handle && (handle.action === 'create' ? current?.handles.has(handleKey(handle)) || current?.creating.has(handleKey(handle)) : !current?.handles.has(handleKey(handle)))) {
        await reject(generation, message.requestId, -32003, 'The native handle is not owned by this execution generation'); return
      }
      let prepared
      try { prepared = await options.journal.prepare(key, bytes) }
      catch { await outcomeUnconfirmed(key, 'ORIGINAL_REQUEST_STORAGE_UNCONFIRMED'); return }
      const state = current ?? start(generation)
      if (state.pending.has(requestKey(message.requestId))) return
      const recovery = state.recovery
      const dispatch = async (admitted?: () => boolean) => {
        try {
          if ((await options.journal.dispatch(key, prepared.payloadDigest, admitted)).dispatch) return true
          if (admitted && !admitted()) {
            if (!disposed && !closed.has(generation)) await reject(generation, message.requestId, -32002, 'The original tool request was cancelled before dispatch')
            return false
          }
          await outcomeUnconfirmed(key, 'ORIGINAL_OPERATION_OUTCOME_UNKNOWN')
        } catch { await outcomeUnconfirmed(key, 'ORIGINAL_DISPATCH_STORAGE_UNCONFIRMED') }
        return false
      }
      if (!recovery && !await dispatch()) return
      const pending: Pending = { key, digest: prepared.payloadDigest, request: message,
        ...(frame.recoverableConnection === true && message.intent.initialize ? { recoverableConnection: true } : {}),
        ...(recovery ? { awaitingDispatch: true } : {}) }
      state.pending.set(requestKey(message.requestId), pending); retained.set(generation, state.pending)
      if (message.intent.initialize) state.initializing = true
      if (handle?.action === 'create') state.creating.add(handleKey(handle))
      const deliver = async () => {
        if (recovery) {
          const ready = await recovery && state.alive && !closed.has(generation) && !disposed
          const admit = () => {
            if (!state.alive || closed.has(generation) || disposed || pending.cancelled) return false
            delete pending.awaitingDispatch
            return true
          }
          if (!ready || !await dispatch(admit)) {
            state.pending.delete(requestKey(message.requestId))
            if (!state.pending.size && retained.get(generation) === state.pending) retained.delete(generation)
            if (!ready && !disposed) await reject(generation, message.requestId, -32002,
              'The original native connection could not be recovered; this tool request was not dispatched')
            return
          }
        }
        try {
          const response = await options.protocol.execute?.(message, generation, { ...options.protocol.executor.env, ...options.control?.environment(generation) })
          if (response !== undefined) {
            const parsed = options.protocol.parseServer(response)
            if (parsed.kind !== 'response' || parsed.requestId !== message.requestId) throw new Error('Provider response does not identify its original operation')
            pending.response = Buffer.from(JSON.stringify(parsed.payload))
            await settle(pending, state)
          } else {
            pending.nativeDispatch = true
            await state.channel.send(message.payload)
          }
        } catch {
          try { await options.journal.markUnknown(key, prepared.payloadDigest) } catch { /* Never infer a second dispatch from a failed receipt. */ }
          await report(generation, 'NATIVE_REQUEST_DELIVERY_UNCONFIRMED', key)
        }
      }
      // A foreground Provider operation must not block delivery of a later
      // TaskStop or another connection's request on the shared machine channel.
      const execution = deliver()
      executions.add(execution)
      void execution.finally(() => executions.delete(execution)).catch(() => {})
      } catch { await report(object(frame) && typeof frame.generation === 'string' ? frame.generation : '', 'REQUEST_OBSERVATION_UNCONFIRMED') }
    } })
  return {
    // Only observation ends. Core detach cannot stop this child or change its generation.
    closeObservation() { channel.close() },
    async dispose() {
      disposed = true; channel.close()
      for (const state of children.values()) state.handshake?.cancel()
      await options.protocol.dispose?.()
      await Promise.all([...executions])
      await options.control?.close()
      // Explicit whole-helper owner shutdown only. Closed frontend sockets do
      // not authorize this; every retained native child remains owned until now.
      await Promise.all([...children.values()].filter(state => state.alive).map(async state => {
        state.channel.close()
        await new Promise<void>(resolve => { state.child.once('exit', () => resolve()); state.child.once('error', () => resolve()); state.child.kill('SIGTERM') })
      }))
    },
  }
}
