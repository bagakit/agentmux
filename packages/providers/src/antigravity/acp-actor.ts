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

type ActorIdentity = { actorId: string; lifecycleOperationId: string; processId: number }
type AcpActorPlan = { command: string; args: string[]; cwd: string; resumeSessionId?: string }
type AcpActorSnapshot = { state: 'initializing' } | { state: 'ready'; sessionId: string } |
  { state: 'authentication-required' | 'initialization-unconfirmed'; stage: 'launch' | 'initialize' | 'session/new' | 'session/load' | 'session/resume' }

const signature = (token: string, body: unknown) => createHmac('sha256', token).update(JSON.stringify(body)).digest('hex')
const verifies = (expected: string, observed: unknown) => typeof observed === 'string' && observed.length === expected.length &&
  /^[a-f0-9]{64}$/u.test(observed) && timingSafeEqual(Buffer.from(expected), Buffer.from(observed))
const socketPath = (token: string) => `/tmp/amxa-${createHash('sha256').update(token).digest('hex').slice(0, 32)}.sock`
export function createAntigravityAcpActor(services: AcpWireServices & {
  AgentMuxError: new (message: string, code: string) => Error
}) {
  const { AgentMuxError, AgentMuxRpcLines, rpcEncode, observeRead } = services
  const unavailable = () => new AgentMuxError('The original ACP actor could not be observed.', 'AGENT_ACP_ACTOR_UNCONFIRMED')

  async function inspectAntigravityAcpActor(identity: ActorIdentity, token: string, signal: AbortSignal): Promise<AcpActorSnapshot> {
    signal.throwIfAborted()
    const request = { ...identity, nonce: randomBytes(32).toString('hex'), method: 'session.inspect' }
    const socket = createConnection(socketPath(token))
    const lines = new AgentMuxRpcLines()
    const result = new Promise<AcpActorSnapshot>((resolve, reject) => {
      socket.once('connect', () => socket.end(rpcEncode({ ...request, proof: signature(token, request) })))
      socket.once('error', () => reject(unavailable()))
      socket.once('close', () => reject(unavailable()))
      socket.on('data', (chunk: Buffer) => {
        try {
          lines.accept(chunk, value => {
            const frame = acpRecord(value)
            const snapshot = acpRecord(frame?.snapshot)
            if (!verifies(signature(token, { request, snapshot }), frame?.proof)) throw unavailable()
            if (snapshot?.state === 'initializing') resolve({ state: 'initializing' })
            else if (snapshot?.state === 'ready' && typeof snapshot.sessionId === 'string' && snapshot.sessionId.trim().length > 0) {
              resolve({ state: 'ready', sessionId: snapshot.sessionId })
            } else if ((snapshot?.state === 'initialization-unconfirmed' || snapshot?.state === 'authentication-required') &&
              (snapshot.stage === 'launch' || snapshot.stage === 'initialize' || snapshot.stage === 'session/new' ||
                snapshot.stage === 'session/load' || snapshot.stage === 'session/resume')) {
              resolve({ state: snapshot.state, stage: snapshot.stage })
            } else throw unavailable()
          })
        } catch { reject(unavailable()) }
      })
    })
    try { return await observeRead(result, signal) }
    finally { socket.destroy() }
  }

  async function runAcpActor(plan: AcpActorPlan): Promise<number> {
    const token = process.env[ACP_ACTOR_TOKEN], actorId = process.env[ACP_ACTOR_ID], lifecycleOperationId = process.env[ACP_ACTOR_LIFECYCLE]
    if (!token || !/^[a-f0-9]{64}$/u.test(token) || !actorId || !lifecycleOperationId) throw unavailable()
    const identity = { actorId, lifecycleOperationId, processId: process.pid }
    let snapshot: AcpActorSnapshot = { state: 'initializing' }
    const sockets = new Set<import('node:net').Socket>()
    const server = createServer({ allowHalfOpen: true }, socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      const lines = new AgentMuxRpcLines()
      socket.setTimeout(5_000, () => socket.destroy())
      socket.on('error', () => socket.destroy())
      socket.on('data', (chunk: Buffer) => {
        try {
          lines.accept(chunk, value => {
            const request = acpRecord(value)
            if (request?.method !== 'session.inspect' || request?.actorId !== identity.actorId ||
                request?.lifecycleOperationId !== identity.lifecycleOperationId || request?.processId !== identity.processId ||
                typeof request.nonce !== 'string' || !/^[a-f0-9]{64}$/u.test(request.nonce)) { socket.destroy(); return }
            const signed = { ...identity, nonce: request.nonce, method: request.method }
            if (!verifies(signature(token, signed), request.proof)) { socket.destroy(); return }
            socket.end(rpcEncode({ snapshot, proof: signature(token, { request: signed, snapshot }) }))
          })
        } catch { socket.destroy() }
      })
      socket.once('end', () => { if (!socket.writableEnded) socket.end() })
    })
    const path = socketPath(token)
    server.listen(path)
    await once(server, 'listening')
    try {
      await chmod(path, 0o600)
      const { [ACP_ACTOR_TOKEN]: _token, [ACP_ACTOR_ID]: _actor, [ACP_ACTOR_LIFECYCLE]: _operation,
        AGENTMUX_HOOK_TOKEN: _hookToken, AGENTMUX_HOOK_URL: _hookUrl, ...env } = process.env
      const child = launchAntigravityAcp(services, { command: plan.command, args: plan.args, cwd: plan.cwd, env })
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
  return { inspect: inspectAntigravityAcpActor, run: runAcpActor }
}
