import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { chmod } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { JSONRPCErrorException } from 'json-rpc-2.0'
import { acpRecord, initializeAntigravityAcp, launchAntigravityAcp, type AcpWireServices } from './acp-process.js'
import { readAntigravityAcpHandshake } from './acp-probe.js'

export const ANTIGRAVITY_ACP_ACTOR_PROTOCOL = 'antigravity-acp.v1'
export const ACP_ACTOR_TOKEN = 'AGENTMUX_ACP_ACTOR_TOKEN'
export const ACP_ACTOR_ID = 'AGENTMUX_ACP_ACTOR_ID'
export const ACP_ACTOR_LIFECYCLE = 'AGENTMUX_ACP_ACTOR_LIFECYCLE'

type ActorRequest = { method: 'session.inspect' } |
  { method: 'prompt.start'; sessionId: string; requestId: string; prompt: string } |
  { method: 'prompt.cancel'; sessionId: string; requestId: string }

type ActorIdentity = { actorId: string; lifecycleOperationId: string; processId: number }
type AcpActorPlan = { command: string; args: string[]; cwd: string; resumeSessionId?: string }
type AcpActorSnapshot = { state: 'initializing' } | { state: 'ready'; sessionId: string; activePromptId?: string } |
  { state: 'authentication-required' | 'initialization-unconfirmed'; stage: 'launch' | 'initialize' | 'session/new' | 'session/load' | 'session/resume' }

const signature = (token: string, body: unknown) => createHmac('sha256', token).update(JSON.stringify(body)).digest('hex')
const verifies = (expected: string, observed: unknown) => typeof observed === 'string' && observed.length === expected.length &&
  /^[a-f0-9]{64}$/u.test(observed) && timingSafeEqual(Buffer.from(expected), Buffer.from(observed))
const socketPath = (token: string) => `/tmp/amxa-${createHash('sha256').update(token).digest('hex').slice(0, 32)}.sock`

type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'
type TurnResult = { state: 'stopped'; stopReason: StopReason } | { state: 'unconfirmed' }
const stopReasons = new Set<unknown>(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'])
type ActorTurn = {
  requestId: string
  completion: Promise<TurnResult>
  result?: TurnResult
  cancel?: Promise<void>
}

export function createAntigravityAcpActor(services: AcpWireServices & {
  AgentMuxError: new (message: string, code: string) => Error
}) {
  const { AgentMuxError, AgentMuxRpcLines, rpcEncode, observeRead } = services
  const unavailable = () => new AgentMuxError('The original ACP actor could not be observed.', 'AGENT_ACP_ACTOR_UNCONFIRMED')

  async function acpActorCall(identity: ActorIdentity, token: string, command: ActorRequest, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted()
    const request = { ...identity, nonce: randomBytes(32).toString('hex'), command }
    const socket = createConnection(socketPath(token))
    const lines = new AgentMuxRpcLines()
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once('connect', () => socket.end(rpcEncode({ ...request, proof: signature(token, request) })))
      socket.once('error', () => reject(unavailable()))
      socket.once('close', () => reject(unavailable()))
      socket.on('data', (chunk: Buffer) => {
        try {
          lines.accept(chunk, value => {
            const frame = acpRecord(value)
            const result = acpRecord(frame?.result)
            if (!result || !verifies(signature(token, { request, result }), frame?.proof)) throw unavailable()
            resolve(result)
          })
        } catch { reject(unavailable()) }
      })
    })
    try { return await observeRead(result, signal) }
    finally { socket.destroy() }
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
    const apply = async (command: Record<string, unknown>): Promise<unknown> => {
      if (command.method === 'session.inspect') return snapshot.state === 'ready' && turn && !turn.result
        ? { ...snapshot, activePromptId: turn.requestId } : snapshot
      if (snapshot.state !== 'ready' || !native || command.sessionId !== snapshot.sessionId ||
          typeof command.requestId !== 'string' || !/^acp-prompt-[a-f0-9]{64}$/u.test(command.requestId)) return { state: 'not-applied' }
      const { requestId, sessionId } = { requestId: command.requestId, sessionId: snapshot.sessionId }
      if (command.method === 'prompt.cancel') {
        if (!turn || turn.requestId !== requestId) return { state: 'not-applied' }
        const original = turn
        if (!original.result) {
          // The notification alone is no completion. Wait only for the matching prompt response.
          original.cancel ??= native.cancel(sessionId)
          await original.cancel
        }
        return { ...await original.completion, requestId }
      }
      if (command.method !== 'prompt.start' || typeof command.prompt !== 'string' || !command.prompt.trim()) return { state: 'not-applied' }
      if (turn?.requestId === requestId) return { state: 'accepted', requestId }
      if (turn && !turn.result) return { state: 'busy' }
      if (turn?.result?.state === 'unconfirmed') return { state: 'busy' }
      const completion = native.prompt(requestId, { sessionId, prompt: [{ type: 'text', text: command.prompt }] }).then((response): TurnResult => {
        const reason = acpRecord(response.result)?.stopReason
        return stopReasons.has(reason) ? { state: 'stopped', stopReason: reason as StopReason } : { state: 'unconfirmed' }
      }, (): TurnResult => ({ state: 'unconfirmed' }))
      const next: ActorTurn = { requestId, completion }
      turn = next
      void completion.then(result => { next.result = result })
      return { state: 'accepted', requestId }
    }
    const sockets = new Set<import('node:net').Socket>()
    const server = createServer({ allowHalfOpen: true }, socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      const lines = new AgentMuxRpcLines()
      socket.setTimeout(5_000, () => socket.destroy())
      socket.on('error', () => socket.destroy())
      let accepted = false
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
            void apply(command).then(result => {
              if (!socket.destroyed) socket.end(rpcEncode({ result, proof: signature(token, { request: signed, result }) }))
            }).catch(() => socket.destroy())
          })
        } catch { socket.destroy() }
      })
      socket.once('end', () => { if (!accepted && !socket.writableEnded) socket.end() })
    })
    const path = socketPath(token)
    server.listen(path)
    await once(server, 'listening')
    try {
      await chmod(path, 0o600)
      const { [ACP_ACTOR_TOKEN]: _token, [ACP_ACTOR_ID]: _actor, [ACP_ACTOR_LIFECYCLE]: _operation,
        AGENTMUX_HOOK_TOKEN: _hookToken, AGENTMUX_HOOK_URL: _hookUrl, ...env } = process.env
      const child = native = launchAntigravityAcp(services, { command: plan.command, args: plan.args, cwd: plan.cwd, env })
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
  return { inspect: inspectAntigravityAcpActor, submitPrompt: submitAntigravityAcpPrompt, cancelPrompt: cancelAntigravityAcpPrompt, run: runAcpActor }
}
