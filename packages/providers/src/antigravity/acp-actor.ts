import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { chmod } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { JSONRPCErrorException } from 'json-rpc-2.0'
import { acpRecord, initializeAntigravityAcp, launchAntigravityAcp, type AcpWireServices } from './acp-process.js'
import { readAntigravityAcpHandshake } from './acp-probe.js'
import { readAntigravityPermission, readAntigravityUpdate } from './acp-events.js'

export const ANTIGRAVITY_ACP_ACTOR_PROTOCOL = 'antigravity-acp.v1'
export const ACP_ACTOR_TOKEN = 'AGENTMUX_ACP_ACTOR_TOKEN'
export const ACP_ACTOR_ID = 'AGENTMUX_ACP_ACTOR_ID'
export const ACP_ACTOR_LIFECYCLE = 'AGENTMUX_ACP_ACTOR_LIFECYCLE'

type ActorRequest = { method: 'session.inspect' } |
  { method: 'session.watch'; sessionId: string } |
  { method: 'permission.respond'; sessionId: string; requestId: string; decision: PermissionOutcome } |
  { method: 'prompt.start'; sessionId: string; requestId: string; prompt: string } |
  { method: 'prompt.cancel'; sessionId: string; requestId: string }

type PermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }
type ActorActivity = {
  type: 'activity'; operation: 'append'; activityId: string; kind: 'assistant_message' | 'tool_call'
  status: 'streaming' | 'complete' | 'failed'; title: string; content?: string
}
type ActorEvent = ActorActivity | NonNullable<ReturnType<typeof readAntigravityPermission>> |
  { type: 'permission-settled'; requestId: string } | { type: 'observation-gap' } |
  { type: 'status'; state: 'working' | 'done' | 'waiting' | 'error'; detail?: string }
type EventEnvelope = { event: ActorEvent; observedAt: number }
type Permission = {
  nativeId: string | number
  turnId: string
  dispatch?: Promise<void>
  record: EventEnvelope & { event: Extract<ActorEvent, { type: 'permission' }> }
}

type ActorIdentity = { actorId: string; lifecycleOperationId: string; processId: number }
type AcpActorPlan = { command: string; args: string[]; cwd: string; resumeSessionId?: string }
type AcpActorSnapshot = { state: 'initializing' } | { state: 'ready'; sessionId: string; activePromptId?: string } |
  { state: 'authentication-required' | 'initialization-unconfirmed'; stage: 'launch' | 'initialize' | 'session/new' | 'session/load' | 'session/resume' }

const signature = (token: string, body: unknown) => createHmac('sha256', token).update(JSON.stringify(body)).digest('hex')
const verifies = (expected: string, observed: unknown) => typeof observed === 'string' && observed.length === expected.length &&
  /^[a-f0-9]{64}$/u.test(observed) && timingSafeEqual(Buffer.from(expected), Buffer.from(observed))
const socketPath = (token: string) => `/tmp/amxa-${createHash('sha256').update(token).digest('hex').slice(0, 32)}.sock`

type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'
type TurnResult = { state: 'stopped'; stopReason: StopReason } | { state: 'refused' } | { state: 'unconfirmed' }
const stopReasons = new Set<unknown>(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'])
type ActorTurn = {
  requestId: string
  completion: Promise<TurnResult>
  result?: TurnResult
  cancel?: Promise<void>
  assistantItems: Set<string>
  incompleteItems: Set<string>
}

export function createAntigravityAcpActor(services: AcpWireServices & {
  AgentMuxError: new (message: string, code: string) => Error
}) {
  const { AgentMuxError, AgentMuxRpcLines, rpcEncode, observeRead } = services
  const unavailable = () => new AgentMuxError('The original ACP actor could not be observed.', 'AGENT_ACP_ACTOR_UNCONFIRMED')

  function openActorConnection(identity: ActorIdentity, token: string, command: ActorRequest,
    receive: (value: Record<string, unknown>) => void, lost: (error: Error) => void): () => void {
    const request = { ...identity, nonce: randomBytes(32).toString('hex'), command }
    const socket = createConnection(socketPath(token))
    const lines = new AgentMuxRpcLines()
    let closed = false
    const close = () => { closed = true; socket.destroy() }
    const disconnect = () => { if (!closed) { close(); lost(unavailable()) } }
    socket.once('connect', () => {
      const frame = rpcEncode({ ...request, proof: signature(token, request) })
      if (command.method === 'session.watch') socket.write(frame)
      else socket.end(frame)
    })
    socket.once('error', disconnect)
    socket.once('close', disconnect)
    socket.on('data', (chunk: Buffer) => {
      try {
        lines.accept(chunk, value => {
          const frame = acpRecord(value)
          const result = acpRecord(frame?.result)
          if (!result || !verifies(signature(token, { request, result }), frame?.proof)) throw unavailable()
          receive(result)
        })
      } catch { disconnect() }
    })
    return close
  }

  async function acpActorCall(identity: ActorIdentity, token: string, command: ActorRequest, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted()
    let close!: () => void
    const result = new Promise<Record<string, unknown>>((resolve, reject) => { close = openActorConnection(identity, token, command, resolve, reject) })
    try { return await observeRead(result, signal) }
    finally { close() }
  }

  function observeAntigravityAcpActor(identity: ActorIdentity, token: string, sessionId: string,
    receive: (event: ActorEvent, observedAt: number) => void, lost: (error: Error) => void): () => void {
    return openActorConnection(identity, token, { method: 'session.watch', sessionId }, result => {
      const record = acpRecord(result.record)
      if (result.state !== 'observation' || !acpRecord(record?.event) || typeof record?.observedAt !== 'number') throw unavailable()
      receive(record.event as ActorEvent, record.observedAt)
    }, lost)
  }

  async function respondAntigravityAcpPermission(identity: ActorIdentity, token: string, sessionId: string,
    requestId: string, decision: PermissionOutcome, signal: AbortSignal): Promise<void> {
    const result = await acpActorCall(identity, token, { method: 'permission.respond', sessionId, requestId, decision }, signal)
    if (result.state !== 'permission-settled' || result.requestId !== requestId) throw new AgentMuxError(
      'The original ACP permission and its offered decision could not be confirmed.', 'UNKNOWN_AGENT_INTERACTION')
  }

  async function inspectAntigravityAcpActor(identity: ActorIdentity, token: string, signal: AbortSignal): Promise<AcpActorSnapshot> {
    const result = await acpActorCall(identity, token, { method: 'session.inspect' }, signal)
    if (result.state === 'initializing') return { state: 'initializing' }
    if (result.state === 'ready' && typeof result.sessionId === 'string' && result.sessionId.trim()) {
      if (result.activePromptId !== undefined && typeof result.activePromptId !== 'string') throw unavailable()
      return { state: 'ready', sessionId: result.sessionId,
        ...(result.activePromptId === undefined ? {} : { activePromptId: result.activePromptId }) }
    }
    if ((result.state === 'initialization-unconfirmed' || result.state === 'authentication-required') &&
      (result.stage === 'launch' || result.stage === 'initialize' || result.stage === 'session/new' ||
        result.stage === 'session/load' || result.stage === 'session/resume')) return { state: result.state, stage: result.stage }
    throw unavailable()
  }

  async function submitAntigravityAcpPrompt(identity: ActorIdentity, token: string, command: Omit<Extract<ActorRequest, { method: 'prompt.start' }>, 'method'>, signal: AbortSignal) {
    const result = await acpActorCall(identity, token, { method: 'prompt.start', ...command }, signal)
    if (result.state === 'accepted' && result.requestId === command.requestId) return { outcome: 'admitted' as const, requestId: command.requestId }
    if (result.state === 'busy' || result.state === 'not-applied') return { outcome: 'not-applied' as const, errorCode: result.state === 'busy' ? -32003 : -32602 }
    throw unavailable()
  }

  async function cancelAntigravityAcpPrompt(identity: ActorIdentity, token: string, command: Omit<Extract<ActorRequest, { method: 'prompt.cancel' }>, 'method'>, signal: AbortSignal) {
    const result = await acpActorCall(identity, token, { method: 'prompt.cancel', ...command }, signal)
    if (result.state !== 'stopped' || result.stopReason !== 'cancelled' || result.requestId !== command.requestId) {
      throw new AgentMuxError('The original ACP turn did not confirm cancellation. Its Session and Run are retained.', 'AGENT_ACP_CANCEL_UNCONFIRMED')
    }
  }

  async function runAcpActor(plan: AcpActorPlan): Promise<number> {
    const token = process.env[ACP_ACTOR_TOKEN], actorId = process.env[ACP_ACTOR_ID], lifecycleOperationId = process.env[ACP_ACTOR_LIFECYCLE]
    if (!token || !/^[a-f0-9]{64}$/u.test(token) || !actorId || !lifecycleOperationId) throw unavailable()
    const identity = { actorId, lifecycleOperationId, processId: process.pid }
    let snapshot: AcpActorSnapshot = { state: 'initializing' }
    let native: ReturnType<typeof launchAntigravityAcp> | undefined
    let turn: ActorTurn | undefined
    const watches = new Set<(record: EventEnvelope) => void>()
    const observations = new Map<string, EventEnvelope & { bytes: number }>()
    const pending = new Map<string, Permission>()
    const settledPermissions = new Map<string, EventEnvelope>()
    let observationBytes = 0
    let observationGap: EventEnvelope | undefined
    const recordGap = (): void => {
      if (observationGap) return
      observationGap = { event: { type: 'observation-gap' }, observedAt: Date.now() }
      for (const watch of watches) watch(observationGap)
    }
    const stream = (key: string, event: Extract<ActorEvent, { type: 'activity' }>): void => {
      const record = { event, observedAt: Date.now(), bytes: Buffer.byteLength(JSON.stringify(event)) }
      if (record.bytes > 120 * 1024) { recordGap(); return }
      observationBytes += record.bytes - (observations.get(key)?.bytes ?? 0)
      observations.set(key, record)
      while (observations.size > 200 || observationBytes > 2 * 1024 * 1024) {
        const [first, removed] = observations.entries().next().value!
        observations.delete(first)
        observationBytes -= removed.bytes
        turn?.assistantItems.delete(first)
        recordGap()
      }
      for (const watch of watches) watch(record)
    }
    let status: EventEnvelope | undefined
    const observeStatus = (state: 'working' | 'done' | 'waiting' | 'error', detail?: string) => {
      if (status?.event.type === 'status' && status.event.state === state && status.event.detail === detail) return
      status = { event: { type: 'status', state, ...(detail === undefined ? {} : { detail }) }, observedAt: Date.now() }
      for (const watch of watches) watch(status)
    }
    const answer = async (item: Permission, decision: PermissionOutcome): Promise<void> => {
      if (!item.dispatch) {
        item.dispatch = native!.respond(item.nativeId, { outcome: decision.outcome === 'selected'
          ? { outcome: 'selected', optionId: decision.optionId } : { outcome: 'cancelled' } }).then(() => {
          const requestId = item.record.event.requestId
          pending.delete(requestId)
          const record: EventEnvelope = { event: { type: 'permission-settled', requestId }, observedAt: Date.now() }
          settledPermissions.set(requestId, record)
          if (settledPermissions.size > 200) settledPermissions.delete(settledPermissions.keys().next().value!)
          for (const watch of watches) watch(record)
        })
      }
      return await item.dispatch
    }
    const onNativeFrame = ({ method, params, id }: { method: string; params: unknown; id?: string | number | null }): boolean => {
      if (snapshot.state !== 'ready' || !turn || turn.result) return false
      if (method === 'session/request_permission' && id !== undefined && id !== null) {
        if ([...pending.values()].some(item => item.nativeId === id)) return true
        const event = readAntigravityPermission(params, snapshot.sessionId, randomUUID())
        if (!event) return false
        if (Buffer.byteLength(JSON.stringify(event)) > 120 * 1024) return false
        const item = { nativeId: id, turnId: turn.requestId, record: { event, observedAt: Date.now() } }
        pending.set(event.requestId, item)
        if (turn.cancel) void answer(item, { outcome: 'cancelled' }).catch(() => {})
        else for (const watch of watches) watch(item.record)
        return true
      }
      if (method !== 'session/update' || id !== undefined) return false
      const update = readAntigravityUpdate(params, snapshot.sessionId)
      if (!update) return true
      observeStatus('working')
      if (update.kind === 'tool-activity') {
        const event = update.event
        const activityId = JSON.stringify([turn.requestId, event.activityId])
        const previous = observations.get(activityId)?.event
        if (event.operation === 'append') stream(activityId, { ...event, activityId })
        else if (previous?.type === 'activity' && previous.operation === 'append') stream(activityId,
          { ...previous, ...event, operation: 'append', activityId })
      } else {
        const activityId = JSON.stringify([turn.requestId, 'assistant', update.messageId ?? null])
        const previous = observations.get(activityId)?.event
        const content = (previous?.type === 'activity' && previous.operation === 'append' ? previous.content ?? '' : '') + update.text
        if (!turn.incompleteItems.has(activityId)) {
          if (Buffer.byteLength(content) > 96 * 1024) { turn.incompleteItems.add(activityId); recordGap() }
          else {
            turn.assistantItems.add(activityId)
            stream(activityId, { type: 'activity', operation: 'append', activityId, kind: 'assistant_message', title: 'Assistant', status: 'streaming', content })
          }
        }
      }
      return true
    }
    const apply = async (command: Record<string, unknown>): Promise<unknown> => {
      if (command.method === 'session.inspect') return snapshot.state === 'ready' && turn && !turn.result
        ? { ...snapshot, activePromptId: turn.requestId } : snapshot
      if (snapshot.state !== 'ready' || !native || command.sessionId !== snapshot.sessionId ||
          typeof command.requestId !== 'string') return { state: 'not-applied' }
      const { requestId, sessionId } = { requestId: command.requestId, sessionId: snapshot.sessionId }
      if (command.method === 'permission.respond') {
        const permission = pending.get(requestId)
        const decision = acpRecord(command.decision)
        if (!permission || permission.dispatch || turn?.requestId !== permission.turnId ||
            !(decision?.outcome === 'cancelled' || decision?.outcome === 'selected' && typeof decision.optionId === 'string' &&
              permission.record.event.options.some(option => option.id === decision.optionId))) return { state: 'not-applied' }
        await answer(permission, decision as PermissionOutcome)
        return { state: 'permission-settled', requestId }
      }
      if (!/^acp-prompt-[a-f0-9]{64}$/u.test(requestId)) return { state: 'not-applied' }
      if (command.method === 'prompt.cancel') {
        if (!turn || turn.requestId !== requestId) return { state: 'not-applied' }
        const original = turn
        if (!original.result) {
          // The notification alone is no completion. Wait only for the matching prompt response.
          original.cancel ??= (async () => {
            await native!.cancel(sessionId)
            for (const permission of pending.values()) if (permission.turnId === original.requestId) await answer(permission, { outcome: 'cancelled' })
          })()
          await original.cancel
        }
        return { ...await original.completion, requestId }
      }
      if (command.method !== 'prompt.start' || typeof command.prompt !== 'string' || !command.prompt.trim()) return { state: 'not-applied' }
      if (turn?.requestId === requestId) return { state: 'accepted', requestId }
      if (turn && (!turn.result || turn.result.state === 'unconfirmed') || pending.size) return { state: 'busy' }
      const completion = native.prompt(requestId, { sessionId, prompt: [{ type: 'text', text: command.prompt }] }).then((response): TurnResult => {
        if (response.error) return { state: 'refused' }
        const reason = acpRecord(response.result)?.stopReason
        return stopReasons.has(reason) ? { state: 'stopped', stopReason: reason as StopReason } : { state: 'unconfirmed' }
      }, (): TurnResult => ({ state: 'unconfirmed' }))
      const next: ActorTurn = { requestId, completion, assistantItems: new Set(), incompleteItems: new Set() }
      turn = next
      void completion.then(result => {
        next.result = result
        if (result.state === 'stopped') {
          for (const key of next.assistantItems) {
            const event = observations.get(key)?.event
            if (event?.type === 'activity' && event.operation === 'append' && !next.incompleteItems.has(key)) {
              stream(key, { ...event, status: 'complete' })
            }
          }
          observeStatus(result.stopReason === 'end_turn' ? 'done' : 'waiting', result.stopReason)
        } else observeStatus('error', result.state === 'refused' ? 'The ACP prompt was refused.' : 'ACP prompt completion is unconfirmed.')
      })
      return { state: 'accepted', requestId }
    }
    const sockets = new Set<import('node:net').Socket>()
    const server = createServer({ allowHalfOpen: true }, socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      const lines = new AgentMuxRpcLines()
      socket.setTimeout(5_000, () => socket.destroy())
      socket.on('error', () => socket.destroy())
      let accepted = false, watching = false
      socket.on('data', (chunk: Buffer) => {
        try {
          lines.accept(chunk, value => {
            if (accepted) { socket.destroy(); return }
            const request = acpRecord(value)
            const command = acpRecord(request?.command)
            if (!command || request?.actorId !== identity.actorId ||
                request?.lifecycleOperationId !== identity.lifecycleOperationId || request?.processId !== identity.processId ||
                typeof request.nonce !== 'string' || !/^[a-f0-9]{64}$/u.test(request.nonce)) { socket.destroy(); return }
            const signed = { ...identity, nonce: request.nonce, command }
            if (!verifies(signature(token, signed), request.proof)) { socket.destroy(); return }
            accepted = true
            if (command.method === 'session.watch' && snapshot.state === 'ready' && command.sessionId === snapshot.sessionId) {
              watching = true
              socket.setTimeout(0)
              const send = (record: EventEnvelope) => {
                const result = { state: 'observation', record }
                if (socket.destroyed) return
                if (socket.writableLength > 4 * 1024 * 1024) { socket.destroy(); return }
                socket.write(rpcEncode({ result, proof: signature(token, { request: signed, result }) }))
              }
              watches.add(send)
              socket.once('close', () => watches.delete(send))
              for (const record of observations.values()) send(record)
              for (const record of settledPermissions.values()) send(record)
              for (const item of pending.values()) send(item.record)
              if (observationGap) send(observationGap)
              if (status) send(status)
              return
            }
            void apply(command).then(result => {
              if (!socket.destroyed) socket.end(rpcEncode({ result, proof: signature(token, { request: signed, result }) }))
            }).catch(() => socket.destroy())
          })
        } catch { socket.destroy() }
      })
      socket.once('end', () => {
        if (watching) socket.destroy()
        else if (!accepted && !socket.writableEnded) socket.end()
      })
    })
    const path = socketPath(token)
    server.listen(path)
    await once(server, 'listening')
    try {
      await chmod(path, 0o600)
      const { [ACP_ACTOR_TOKEN]: _token, [ACP_ACTOR_ID]: _actor, [ACP_ACTOR_LIFECYCLE]: _operation,
        AGENTMUX_HOOK_TOKEN: _hookToken, AGENTMUX_HOOK_URL: _hookUrl, ...env } = process.env
      const child = native = launchAntigravityAcp(services, { command: plan.command, args: plan.args, cwd: plan.cwd, env, onNativeFrame })
      const stop = () => { void child.close().catch(() => {}) }
      process.on('SIGTERM', stop)
      process.on('SIGINT', stop)
      let stage: Extract<AcpActorSnapshot, { stage: string }>['stage'] = 'launch'
      const initialize = async () => {
        try {
          await child.ready
          stage = 'initialize'
          const handshake = readAntigravityAcpHandshake(await initializeAntigravityAcp(child))
          const params = { cwd: plan.cwd, mcpServers: [] }
          if (plan.resumeSessionId !== undefined) {
            stage = handshake.sessions.resume ? 'session/resume' : 'session/load'
            if (!handshake.sessions.resume && !handshake.sessions.load) throw unavailable()
            const result = acpRecord(await child.request(stage, { ...params, sessionId: plan.resumeSessionId }))
            if (!result || result.sessionId !== undefined && result.sessionId !== plan.resumeSessionId) throw unavailable()
            snapshot = { state: 'ready', sessionId: plan.resumeSessionId }
          } else {
            stage = 'session/new'
            const result = acpRecord(await child.request(stage, params))
            if (typeof result?.sessionId !== 'string' || result.sessionId.trim().length === 0) throw unavailable()
            snapshot = { state: 'ready', sessionId: result.sessionId }
          }
        } catch (error) {
          snapshot = { state: error instanceof JSONRPCErrorException && error.code === -32000 ? 'authentication-required' : 'initialization-unconfirmed', stage }
        }
      }
      try {
        void initialize()
        const end = await child.closed
        return end.code ?? 1
      } finally {
        process.off('SIGTERM', stop)
        process.off('SIGINT', stop)
      }
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
  return { inspect: inspectAntigravityAcpActor, submitPrompt: submitAntigravityAcpPrompt, cancelPrompt: cancelAntigravityAcpPrompt, observe: observeAntigravityAcpActor, respondPermission: respondAntigravityAcpPermission, run: runAcpActor }
}
