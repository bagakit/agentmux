// Load the real public transport with the fixture, outside the socket operation deadline.
import '../src/public-rpc-client.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, createConnection, Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createAgentMuxRpcFrameStream } from '../src/agentmux-rpc-stdio.js'
import { AgentExecutionRpcFrontend, AgentExecutionRpcResource, gateExecutionAgentRpc } from '../src/agent-execution-rpc-relay.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const caller = { agentSessionId: 'original-agent', capability: 'r'.repeat(64) }
const request = (params: unknown = { caller }, id: string | number = 1) => ({ jsonrpc: '2.0', id, method: 'whoami', params })

describe('Agent-only execution RPC frames', () => {
  it('qualifies every exact caller before replacing it with the fixed invocation credential', () => {
    const original = [request(), request({ caller }, '1')], replacement = { ...caller, capability: 'private-b-capability' }
    const qualified = gateExecutionAgentRpc(original, caller, replacement, { runtimeId: 'owner', ownerInstanceId: 'instance' })
    expect(qualified).toEqual(original.map(value => ({ ...value, params: { caller: replacement, runtimeFence: { runtimeId: 'owner', ownerInstanceId: 'instance' } } })))
    expect(original[0]!.params).toEqual({ caller })
  })
  it.each([{}, { caller: { ...caller, capability: 'another' } }, { caller: { ...caller, agentSessionId: 'another' } },
    { caller: { ...caller, principal: 'user' } }, { caller, runtimeFence: { runtimeId: 'foreign' } }])('rejects missing or changed authority in an entire batch: %j', params => {
    expect(() => gateExecutionAgentRpc([request(), request(params, 2)], caller)).toThrow('exact original managed Agent caller')
  })
  it('rejects duplicate IDs in a new batch before forwarding its first member', () => {
    expect(() => gateExecutionAgentRpc([request({ caller }, 'same'), request({ caller }, 'same')], caller)).toThrow('distinct original requests')
  })
  it('retains ingress reservations through asynchronous consumption and releases them after completion or malformed input', async () => {
    let held = 0, peak = 0, release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const budget = { reserve(bytes: number) { held += bytes; peak = Math.max(peak, held) }, release(bytes: number) { held -= bytes } }
    const stream = createAgentMuxRpcFrameStream(async () => { await pending }, budget)
    const encoded = JSON.stringify(request()) + '\n'
    const completed = new Promise<void>((resolve, reject) => { stream.write(encoded, error => error ? reject(error) : resolve()) })
    await vi.waitFor(() => expect(held).toBe(Buffer.byteLength(encoded)))
    release(); await completed
    expect(held).toBe(0); expect(peak).toBe(Buffer.byteLength(encoded)); stream.destroy()
    const malformed = createAgentMuxRpcFrameStream(() => {}, budget)
    const errored = new Promise<void>(resolve => malformed.once('error', () => resolve()))
    malformed.write('not-json\n'); await errored
    expect(held).toBe(0)
  })
  it('rejects a device or Runtime authority request even with a correct relay credential', () => {
    expect(() => gateExecutionAgentRpc({ ...request(), method: 'runtime.owner.identity' }, caller)).toThrow()
    expect(() => gateExecutionAgentRpc([], caller)).toThrow()
  })

  it('keeps private credentials at B and forwards through the original Unix connection without callerless elevation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amux-relay-test-')), endpointPath = join(root, 'owner.sock')
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const accepted: Array<Record<string, any>> = [], sockets = new Set<Socket>()
    let held: { socket: Socket; value: any } | undefined, pauseResponse: Promise<void> | undefined
    const owner = { runtimeId: 'semantic-owner', ownerInstanceId: 'semantic-instance', protocolVersion: 2, processId: 1, availability: 'connected', ctxmux: { protocolVersion: 5, buildIdentity: 'fixture', hostId: 'local', processId: 2, instanceId: 'native-instance' } }
    const server = createServer(socket => {
      sockets.add(socket); socket.once('close', () => sockets.delete(socket))
      const lines = createInterface({ input: socket })
      lines.on('line', line => {
        const value = JSON.parse(line)
        if (value.method === 'runtime.owner.identity') socket.write(JSON.stringify({ jsonrpc: '2.0', id: value.id, result: { owner } }) + '\n')
        else {
          accepted.push(value)
          if (value.params.hold) { held = { socket, value }; return }
          socket.write(JSON.stringify({ jsonrpc: '2.0', id: value.id, result: { agentSessionId: value.params.caller.agentSessionId } }) + '\n')
        }
      })
      socket.once('close', () => lines.close())
    })
    await new Promise<void>(resolve => server.listen(endpointPath, resolve))
    cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
    const frames: unknown[] = [], errors: Error[] = []
    const resource = new AgentExecutionRpcResource(caller.agentSessionId, error => errors.push(error))
    let frontend!: AgentExecutionRpcFrontend
    const toFrontend = async (frame: unknown) => { frames.push(frame); await frontend.receive(frame) }
    frontend = new AgentExecutionRpcFrontend({ agentSessionId: caller.agentSessionId, onError: error => errors.push(error),
      send: async frame => { if ((frame as any).type === 'agent-rpc-response') await pauseResponse; frames.push(frame); await resource.receive(frame, toFrontend) } })
    cleanup.push(async () => { frontend.close(); await resource.close() })
    const invocation = { agentSessionId: caller.agentSessionId, capability: 'private-b-capability', lifecycleOperationId: 'original-invocation', endpointPath,
      runtimeId: owner.runtimeId, ctxmuxInstanceId: owner.ctxmux.instanceId }
    const token = await frontend.register(invocation)
    expect(await frontend.register({ ...invocation })).toBe(token)
    await expect(frontend.register({ ...invocation, capability: 'replacement' })).rejects.toThrow()
    const context = frontend.claim(token, 'original-generation')
    expect(() => frontend.claim(token, 'another-generation')).toThrow()
    await frontend.begin(context.generation, true)
    await resource.receive({ type: 'agent-rpc-context', ...context }, toFrontend)
    const env = resource.environment(context.generation)!
    expect(env.AGENTMUX_AGENT_CAPABILITY).not.toBe(invocation.capability)
    expect(env.AGENTMUX_CLI).toContain('/bin/amux')
    const local = createConnection({ path: env.AGENTMUX_RPC_ENDPOINT!.slice(5) })
    const replies: Array<Record<string, any>> = [], lines = createInterface({ input: local })
    lines.on('line', line => replies.push(JSON.parse(line)))
    cleanup.push(async () => { local.destroy(); lines.close() })
    await new Promise<void>(resolve => local.once('connect', resolve))
    local.write(JSON.stringify(request({}, 'missing')) + '\n')
    local.write(JSON.stringify(request({ caller: { agentSessionId: context.agentSessionId, capability: context.credential } }, 'authorized')) + '\n')
    const deadline = Date.now() + 3000
    while (replies.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    expect(replies).toHaveLength(2)
    expect(replies[0]!.error.data.code).toBe('AGENT_CAPABILITY_INVALID')
    expect(replies[1]!.result.agentSessionId).toBe(caller.agentSessionId)
    expect(accepted).toHaveLength(1)
    expect(accepted[0]!.params.caller.capability).toBe(invocation.capability)
    expect(accepted[0]!.params.runtimeFence).toEqual({ runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId })
    expect(JSON.stringify(frames)).not.toContain(invocation.capability)
    expect(errors).toEqual([])
    expect(frames.filter((frame: any) => frame.type === 'agent-control-state')).toEqual([
      { type: 'agent-control-state', generation: context.generation, state: 'unverified' },
      { type: 'agent-control-state', generation: context.generation, state: 'available' }
    ])
    const originalRequests = accepted.length
    await frontend.receive({ type: 'agent-rpc-request', generation: context.generation, connectionId: 'forged', credential: context.credential, payload: request({}) })
    expect(accepted).toHaveLength(originalRequests)
    local.write(JSON.stringify(request({ caller: { agentSessionId: context.agentSessionId, capability: context.credential }, hold: true }, 'pending')) + '\n')
    await vi.waitFor(() => expect(held).toBeDefined())
    const inFlight = (frames as any[]).find(frame => frame.type === 'agent-rpc-request' && frame.payload?.id === 'pending')
    const duplicateCursor = frames.length
    await frontend.receive({ ...inFlight, payload: request({}, 'pending') })
    expect(frames.slice(duplicateCursor)).toContainEqual({ type: 'agent-rpc-diagnostic', generation: context.generation, connectionId: inFlight.connectionId, code: 'DUPLICATE_PENDING_RPC_ID' })
    local.write(JSON.stringify(request({}, 'pending')) + '\n')
    await vi.waitFor(() => expect(frames.slice(duplicateCursor).filter((frame: any) => frame.type === 'agent-rpc-diagnostic')).toHaveLength(2))
    expect(replies.some(value => value.id === 'pending')).toBe(false)
    expect(accepted.filter(value => value.id === 'pending')).toHaveLength(1)
    let release!: () => void
    pauseResponse = new Promise<void>(resolve => { release = resolve })
    const nextToken = await frontend.register({ ...invocation, lifecycleOperationId: 'next-invocation', capability: 'next-private-b-capability' })
    const nextContext = frontend.claim(nextToken, 'next-generation')
    await frontend.begin(nextContext.generation, true)
    await resource.receive({ type: 'agent-rpc-context', ...nextContext }, toFrontend)
    held!.socket.write(JSON.stringify({ jsonrpc: '2.0', id: held!.value.id, result: { completed: true } }) + '\n')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(local.destroyed).toBe(false)
    expect(replies.some(value => value.id === 'pending')).toBe(false)
    release(); pauseResponse = undefined
    await vi.waitFor(() => expect(replies.find(value => value.id === 'pending')?.result).toEqual({ completed: true }))
    expect(accepted.filter(value => value.id === 'pending')).toHaveLength(1)
    expect(frames.filter((frame: any) => frame.type === 'agent-control-state')).toEqual([
      { type: 'agent-control-state', generation: context.generation, state: 'unverified' },
      { type: 'agent-control-state', generation: context.generation, state: 'available' },
      { type: 'agent-control-state', generation: nextContext.generation, state: 'unverified' }
    ])
    local.destroy()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(frames.filter((frame: any) => frame.type === 'agent-control-state')).toHaveLength(3)
    const originalConnection = (frames as any[]).find(frame => frame.type === 'agent-rpc-request' && frame.payload?.id === 'authorized')
    const replayCursor = frames.length
    await frontend.receive(originalConnection)
    await vi.waitFor(() => expect(frames.slice(replayCursor).find((frame: any) => frame.type === 'agent-rpc-response' && frame.payload?.id === 'authorized')).toBeDefined())
    expect((frames.slice(replayCursor).find((frame: any) => frame.type === 'agent-rpc-response' && frame.payload?.id === 'authorized') as any).payload.error?.data?.code).toBe('AGENT_TOOL_CONTEXT_UNAVAILABLE')
    expect(accepted.filter(value => value.id === 'authorized')).toHaveLength(1)
    owner.ownerInstanceId = 'replacement-owner'
    const nextEnv = resource.environment(nextContext.generation)!
    const fresh = createConnection({ path: nextEnv.AGENTMUX_RPC_ENDPOINT!.slice(5) })
    cleanup.push(async () => { fresh.destroy() })
    const outcome = new Promise<any>(resolve => { fresh.once('close', () => resolve({ closed: true })); fresh.once('data', bytes => resolve(JSON.parse(String(bytes)))) })
    fresh.once('connect', () => fresh.write(JSON.stringify(request({ caller: { agentSessionId: nextContext.agentSessionId, capability: nextContext.credential } }, 'owner-changed')) + '\n'))
    const changed = await outcome
    if (!changed.closed) expect(changed.error?.data?.code).toBe('AGENT_TOOL_CONTEXT_UNAVAILABLE')
    expect(accepted.some(value => value.id === 'owner-changed')).toBe(false)
    await vi.waitFor(() => expect((frames.filter((frame: any) => frame.type === 'agent-control-state').at(-1) as any)).toEqual({ type: 'agent-control-state', generation: nextContext.generation, state: 'unavailable' }))
    // A transport write callback cannot prove that previously sent bytes were unapplied.
    owner.ownerInstanceId = 'semantic-instance'
    const writeOriginal = Socket.prototype.write
    let attempted = 0
    const writeSpy = vi.spyOn(Socket.prototype, 'write').mockImplementation(function(this: Socket, chunk: any, ...args: any[]) {
      if (String(chunk).includes('"id":"write-unknown"') && String(chunk).includes(invocation.capability.replace('private-b', 'next-private-b'))) {
        attempted++
        const callback = args.at(-1)
        return Reflect.apply(writeOriginal, this, [chunk, () => callback(new Error('injected transport failure after dispatch'))])
      }
      return Reflect.apply(writeOriginal, this, [chunk, ...args])
    } as any)
    const uncertain = createConnection({ path: nextEnv.AGENTMUX_RPC_ENDPOINT!.slice(5) })
    const uncertainReplies: Buffer[] = []
    uncertain.on('data', bytes => uncertainReplies.push(bytes))
    const uncertainSettled = new Promise<void>(resolve => { uncertain.once('close', () => resolve()); uncertain.once('data', () => resolve()) })
    try {
      uncertain.once('connect', () => uncertain.write(JSON.stringify(request({ caller: { agentSessionId: nextContext.agentSessionId, capability: nextContext.credential }, hold: true }, 'write-unknown')) + '\n'))
      await uncertainSettled
      expect(attempted).toBe(1)
      expect(uncertainReplies).toEqual([])
      expect(frames.some((frame: any) => frame.type === 'agent-rpc-response' && frame.payload?.id === 'write-unknown')).toBe(false)
      expect(errors.map((error: any) => error.code)).toEqual(['AGENT_TOOL_CONTEXT_UNAVAILABLE'])
    } finally { writeSpy.mockRestore(); uncertain.destroy() }

  }, 15000)
})
