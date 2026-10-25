import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { createExecutionFrameChannel } from './agent-execution-channel.js'
import { AgentExecutionJournal, type AgentExecutionOperationKey } from './agent-execution-journal.js'
import type { AgentExecutionIntent, AgentExecutionMessage, AgentExecutionProtocol } from './agent-execution-protocol.js'

type Request = Extract<AgentExecutionMessage, { kind: 'request' }>
type Channel = ReturnType<typeof createExecutionFrameChannel>
type Pending = { key: AgentExecutionOperationKey; digest: string; request: Request; response?: Uint8Array }
type Generation = {
  id: string; child: ChildProcessWithoutNullStreams; channel: Channel; alive: boolean; initialized: boolean; initializing: boolean
  pending: Map<string, Pending>; handles: Set<string>; creating: Set<string>; notifications: Set<string>
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const requestKey = (id: string | number) => JSON.stringify(id)
const handleKey = (handle: NonNullable<AgentExecutionIntent['handle']>) => JSON.stringify([handle.kind, handle.id])

/**
 * One resource binding's Provider connections, inside its existing ctxmux helper Run.
 * The Core attaches that original Run; it must not recreate a helper with this
 * binding after native-process loss. No PTY, Run state or replay is owned here.
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
  let active: Generation | null = null, disposed = false
  const closed = new Set<string>()
  const children = new Map<string, Generation>()
  const retained = new Map<string, Map<string, Pending>>()
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
  const respond = (generation: string, bytes: Uint8Array) => channel.send({ type: 'response', generation, payload: JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown })
  const completed = (key: AgentExecutionOperationKey) => channel.send({ type: 'operation-completed', generation: key.streamGeneration, operation: key })
  const settle = async (state: Generation, pending: Pending): Promise<void> => {
    if (!pending.response) return
    try {
      await options.journal.complete(pending.key, pending.digest, pending.response)
    } catch {
      await report(state.id, 'RESPONSE_STORAGE_UNCONFIRMED', pending.key)
      return
    }
    const payload: unknown = JSON.parse(Buffer.from(pending.response).toString('utf8'))
    const success = object(payload) && Object.hasOwn(payload, 'result')
    const handle = pending.request.intent.handle
    if (handle?.action === 'create') {
      state.creating.delete(handleKey(handle))
      if (success) state.handles.add(handleKey(handle))
    } else if (handle?.action === 'close' && success) state.handles.delete(handleKey(handle))
    if (pending.request.intent.initialize) { state.initializing = false; if (success) state.initialized = true }
    state.pending.delete(requestKey(pending.key.nativeRequestId))
    if (!state.pending.size) retained.delete(state.id)
    await completed(pending.key)
    await respond(state.id, pending.response)
  }
  const start = (generation: string): Generation => {
    const spec = options.protocol.executor
    // stderr is never connected to the helper Run's machine-protocol stdout.
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: { ...process.env, ...spec.env, ...options.control?.environment(generation) }, stdio: ['pipe', 'pipe', 'pipe'] })
    if (options.stderr) child.stderr.pipe(options.stderr, { end: false })
    else child.stderr.resume()
    const state: Generation = { id: generation, child, channel: undefined as unknown as Channel, alive: true, initialized: false, initializing: false,
      pending: new Map(), handles: new Set(), creating: new Set(), notifications: new Set() }
    state.channel = createExecutionFrameChannel({ input: child.stdout, output: child.stdin,
      onError: () => { void report(generation, 'NATIVE_PROTOCOL_OBSERVATION_UNCONFIRMED') },
      async onFrame(payload, rawLine) {
        try {
        const message = options.protocol.parseServer(payload)
        if (message.kind === 'notification') {
          await channel.send({ type: 'response', generation, payload: message.payload }); return
        }
        if (message.kind !== 'response') { await report(generation, 'UNEXPECTED_NATIVE_MESSAGE'); return }
        const pending = state.pending.get(requestKey(message.requestId))
        if (!pending) { await report(generation, 'UNMATCHED_NATIVE_RESPONSE'); return }
        if (pending.response && !Buffer.from(pending.response).equals(rawLine)) {
          await report(generation, 'CONFLICTING_NATIVE_RESPONSE', pending.key); return
        }
        pending.response = Uint8Array.from(rawLine)
        await settle(state, pending)
        } catch { await report(generation, 'NATIVE_RESPONSE_OBSERVATION_UNCONFIRMED') }
      } })
    const ended = () => {
      if (!state.alive) return
      state.alive = false; closed.add(generation); state.handles.clear(); state.creating.clear(); children.delete(generation)
      const wasActive = active === state
      if (wasActive) active = null
      void (async () => {
        for (const pending of state.pending.values()) {
          try { await options.journal.markUnknown(pending.key, pending.digest) } catch { /* The original journal receipt remains authoritative. */ }
          await report(generation, 'NATIVE_CONNECTION_ENDED_OUTCOME_UNKNOWN', pending.key)
        }
        if (wasActive) await report(generation, 'NATIVE_CONNECTION_ENDED')
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
    active = state
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
          if (active?.id === frame.generation) active = null
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
        if (!active?.alive || active.id !== generation || !active.initialized) { await report(generation, 'NATIVE_CONNECTION_NOT_INITIALIZED'); return }
        const hash = createHash('sha256').update(JSON.stringify(message.payload)).digest('hex')
        if (!active.notifications.has(hash)) {
          active.notifications.add(hash)
          try { await active.channel.send(message.payload) } catch { await report(generation, 'NATIVE_NOTIFICATION_DELIVERY_UNCONFIRMED') }
        }
        return
      }
      try { await options.authorize({ bindingId, generation, intent: message.intent }) }
      catch { await reject(generation, message.requestId, -32001, 'The requested execution binding permission was not granted'); return }
      const key: AgentExecutionOperationKey = { bindingId, streamGeneration: generation, nativeRequestId: message.requestId }
      const bytes = Buffer.from(JSON.stringify(message.payload))
      const previous = await options.journal.inspect(key)
      if (previous) {
        let operation
        try { operation = await options.journal.prepare(key, bytes) }
        catch { await report(generation, 'ORIGINAL_REQUEST_CONFLICT_OR_STORAGE_UNCONFIRMED', key); return }
        if (operation.phase === 'completed') {
          const result = await options.journal.readResult(key, operation.payloadDigest)
          await completed(key)
          if (result) await respond(generation, result)
          return
        }
        if (operation.phase !== 'prepared') {
          const pending = retained.get(generation)?.get(requestKey(message.requestId))
          if (pending?.response) {
            const original = children.get(generation)
            if (original) await settle(original, pending)
            else {
              await options.journal.complete(key, pending.digest, pending.response)
              retained.get(generation)?.delete(requestKey(message.requestId))
              await completed(key)
              await respond(generation, pending.response)
            }
          } else if (!pending || closed.has(generation)) await report(generation, 'ORIGINAL_OPERATION_OUTCOME_UNKNOWN', key)
          // A live pending request waits for its original native response.
          return
        }
      }
      if (active?.id !== generation) {
        if (active?.alive || closed.has(generation) || !message.intent.initialize || message.intent.resumeSessionId != null) {
          await reject(generation, message.requestId, -32002, 'The exact original native connection is unavailable for this request'); return
        }
      } else if (message.intent.initialize ? active.initialized || active.initializing : !active.initialized) {
        await reject(generation, message.requestId, -32002, 'The original native connection has not accepted this initialization state'); return
      }
      const handle = message.intent.handle
      if (handle && (handle.action === 'create' ? active?.handles.has(handleKey(handle)) || active?.creating.has(handleKey(handle)) : !active?.handles.has(handleKey(handle)))) {
        await reject(generation, message.requestId, -32003, 'The native handle is not owned by this execution generation'); return
      }
      let prepared
      try { prepared = await options.journal.prepare(key, bytes) }
      catch { await report(generation, 'ORIGINAL_REQUEST_STORAGE_UNCONFIRMED', key); return }
      const state = active ?? start(generation)
      let dispatch
      try { dispatch = await options.journal.dispatch(key, prepared.payloadDigest) }
      catch { await report(generation, 'ORIGINAL_DISPATCH_STORAGE_UNCONFIRMED', key); return }
      if (!dispatch.dispatch) { await report(generation, 'ORIGINAL_OPERATION_OUTCOME_UNKNOWN', key); return }
      const pending: Pending = { key, digest: prepared.payloadDigest, request: message }
      state.pending.set(requestKey(message.requestId), pending); retained.set(generation, state.pending)
      if (message.intent.initialize) state.initializing = true
      if (handle?.action === 'create') state.creating.add(handleKey(handle))
      try { await state.channel.send(message.payload) }
      catch {
        try { await options.journal.markUnknown(key, prepared.payloadDigest) } catch { /* Never infer a second dispatch from a failed receipt. */ }
        await report(generation, 'NATIVE_REQUEST_DELIVERY_UNCONFIRMED', key)
      }
      } catch { await report(object(frame) && typeof frame.generation === 'string' ? frame.generation : '', 'REQUEST_OBSERVATION_UNCONFIRMED') }
    } })
  return {
    // Only observation ends. Core detach cannot stop this child or change its generation.
    closeObservation() { channel.close() },
    async dispose() {
      disposed = true; channel.close()
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
