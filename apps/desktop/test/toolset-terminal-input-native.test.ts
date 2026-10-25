import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises'
import { activateRuntime, defineRun } from '@ctxmux/sdk'
import { expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../../../packages/core/src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../../../packages/core/src/agent-session-store.js'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client.js'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service.js'
import { decodeHostedValue } from '../../../packages/core/src/hosted-value.js'
import type { AgentMuxHostedInvocation, AgentMuxHostedRpcPort } from '../../../packages/core/src/hosted-client-contract.js'
import type { InputPerformanceSnapshot } from '../../../packages/core/src/performance-diagnostics.js'
import type { AgentMuxStoredAgentSession } from '../../../packages/core/src/types.js'
import { RuntimeController } from '../src/main/runtime-controller.js'

vi.mock('electron', () => ({ app: {}, nativeImage: {} }))

// Read the caller's explicit artifact selection before the private-state setup clears Runtime env.
const binary = process.env.AGENTMUX_TEST_INPUT_DAEMON ?? fileURLToPath(new URL(
  `../../../packages/core/vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`, import.meta.url))
const evidence = process.env.TOOLSET_INPUT_EVIDENCE
const deferred = () => {
  let resolve!: () => void, settled = false
  const promise = new Promise<void>(done => { resolve = () => { settled = true; done() } })
  return { promise, resolve, get settled() { return settled } }
}
async function observe<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 2000
  let value = await read()
  while (!ready(value) && Date.now() < deadline) { await delay(5); value = await read() }
  return value
}
function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

it('Main terminal bytes share native admission with Agent input without serial ACKs or retained completed work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-toolset-input-'))
  const stateDir = join(root, 'state'), socketPath = join(root, 'native.sock'), proxyPath = join(root, 'ctxmux.sock')
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', root)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', stateDir)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const sockets = new Set<Socket>(), held: Array<{ socket: Socket; line: string }> = []
  const nativeRequests: string[] = [], originalResults: unknown[] = []
  let automatic = false
  const forward = (frame: { socket: Socket; line: string }) => { if (!frame.socket.destroyed) frame.socket.write(frame.line) }
  const flush = () => { automatic = true; for (const frame of held.splice(0)) forward(frame) }
  const server = createServer(socket => {
    const upstream = createConnection(socketPath)
    for (const stream of [socket, upstream]) { sockets.add(stream); stream.setEncoding('utf8'); stream.on('error', () => {}); stream.on('close', () => sockets.delete(stream)) }
    let input = '', output = ''
    socket.on('data', part => {
      input += part
      while (input.includes('\n')) {
        const end = input.indexOf('\n'), line = input.slice(0, end + 1); input = input.slice(end + 1)
        const frame = JSON.parse(line)
        nativeRequests.push(frame.type === 'request' ? frame.request.type : frame.type)
        upstream.write(line)
      }
    })
    upstream.on('data', part => {
      output += part
      while (output.includes('\n')) {
        const end = output.indexOf('\n'), line = output.slice(0, end + 1); output = output.slice(end + 1)
        const frame = JSON.parse(line)
        if (frame.type === 'command_result') {
          originalResults.push(frame)
          if (!automatic) { held.push({ socket, line }); continue }
        }
        socket.write(line)
      }
    })
    upstream.on('end', () => socket.end()); socket.on('close', () => upstream.destroy())
  })
  const work: Promise<unknown>[] = []
  const track = <T,>(promise: Promise<T>): Promise<T> => { work.push(promise); void promise.catch(() => {}); return promise }
  const authority = deferred(), atAgentAuthority = deferred(), atTerminalInvocation = deferred()
  let discoveryGate: ReturnType<typeof deferred> | undefined
  let core: AgentMuxClient | undefined, service: AgentMuxHostedRuntimeService | undefined
  let controller: RuntimeController | undefined, hosted: Awaited<ReturnType<typeof connectHostedAgentMux>> | undefined
  let activation: Awaited<ReturnType<typeof activateRuntime>> | undefined, runPid: number | undefined
  const receipt: Record<string, unknown> = { daemonSHA256: createHash('sha256').update(await readFile(binary)).digest('hex') }
  try {
    await mkdir(join(stateDir, 'ctxmux'), { recursive: true, mode: 0o700 })
    activation = await activateRuntime({ executable: binary, socketPath, stateDir: join(stateDir, 'ctxmux'), timeoutMs: 5000,
      env: { AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined },
      childDisposition: { mode: 'detached', stdout: 'ignore', stderr: 'pipe' } })
    receipt.runtime = await activation.client.runtimeInfo(); receipt.daemonPid = activation.childPid
    server.listen(proxyPath); await once(server, 'listening')
    const native = activation.client
    const run = await native.start(defineRun('/bin/sh', { args: ['-c', 'stty raw -echo; printf READY; exec cat'], cwd: root }))
    runPid = run.pid
    const readOutput = async () => {
      const view = await native.attach(run.id)
      try { return Buffer.concat(view.snapshot.replay.chunks.map(chunk => Buffer.from(chunk.data))).toString('utf8') }
      finally { await view.detach() }
    }
    expect(await observe(readOutput, text => text === 'READY')).toBe('READY')
    const store = new AgentMuxMemoryAgentSessionStore()
    const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'private-input-agent', providerId: 'claude', executorId: 'claude',
      hostId: 'local', workspacePath: root, run: { runId: run.id }, retiredRuns: [], hookBindingId: 'private-hook', hookToken: 'private-token', createdAt: 1, updatedAt: 2 }
    await store.compareAndSwap(null, session)
    core = new AgentMuxClient({ store }); await core.connectRuntime()
    const owner = { runtimeId: 'private-runtime', ownerInstanceId: 'private-host', protocolVersion: 2 as const,
      processId: process.pid, availability: 'connected' as const, ctxmux: core.runtimeIdentity() }
    service = new AgentMuxHostedRuntimeService(core, null, () => owner)
    const calls: string[] = [], receipts: Array<{ method: string; data: string; value: { appliedByteRange: { startByte: number; endByte: number }; acceptedThroughByte: number } }> = []
    const projected = deferred()
    const json = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
    const port = {
      call: async (method: string, params: { invocation?: unknown }, options?: { signal?: AbortSignal }) => {
        const invocation = params.invocation ? decodeHostedValue(params.invocation) as AgentMuxHostedInvocation : undefined
        calls.push(invocation?.method ?? method)
        if (method === 'runtime.owner.identity' && discoveryGate) await discoveryGate.promise
        const data = invocation?.method === 'writeAgent' ? (invocation.args[0] as { data: string }).data
          : invocation?.method === 'writeTerminalBytes' ? invocation.args[1] as string : undefined
        if (data === 'b') atTerminalInvocation.resolve()
        let authorCalls = 0
        try {
          const result = await service!.call(method, json(params), { ...options, assertCurrent: async () => {
            authorCalls++
            // Freeze final authority after waitWritable. Both entry points must share that admission.
            if (data === 'a' && authorCalls === 2) { atAgentAuthority.resolve(); await authority.promise }
            if (data === 'b') await authority.promise
          } })
          if (data !== undefined) receipts.push({ method: invocation!.method, data, value: decodeHostedValue((result as { value: unknown }).value) as never })
          return json(result)
        } finally { if (invocation?.method === 'runtimeProjection') projected.resolve() }
      },
      subscribe: async (method: string, params: unknown, handlers: { onInitial(value: unknown): void; onEvent(value: unknown): void; signal?: AbortSignal }) => {
        const stream = await service!.subscribe(method, json(params), event => handlers.onEvent(json(event)), { signal: handlers.signal })
        handlers.onInitial(json(stream.initial)); await stream.start?.()
        return { dispose: () => stream.dispose() }
      }
    } as unknown as AgentMuxHostedRpcPort
    hosted = await connectHostedAgentMux({ rpc: port })
    expect(await observe(async () => projected.settled, value => value)).toBe(true)
    controller = new RuntimeController(store, async () => { throw new Error('The selected Host is already configured') })
    // Only the existing configured-Host record is supplied. Main connection, tracking and dispatch stay real.
    const main = controller as unknown as { hosts: Map<string, unknown>; hostOperations: Map<string, Set<Promise<void>>>;
      waitForHostQuiescence(hostId: string): Promise<void>; inputPerformance: { snapshot(): InputPerformanceSnapshot } }
    main.hosts.set('local', { client: hosted, config: { id: 'local' }, executionHost: { dispose: async () => {} }, unsubscribe: () => {}, historyObservationDisposers: new Set() })
    const inner = core as unknown as { agentInputLanes: Map<string, { pending: Set<Promise<void>> }>;
      rawInputAdmissions: Map<string, Promise<void>>; inputPerformance: { snapshot(): InputPerformanceSnapshot } }
    const terminal = { kind: 'terminal' as const, hostId: 'local', runId: run.id, run: { runId: run.id } }
    const agent = { kind: 'agent' as const, hostId: 'local', agentSessionId: session.agentSessionId, runId: run.id, run: { runId: run.id } }
    let sequence = 0
    const observation = (source: 'user' | 'protocol' | 'paste' = 'user') => ({ observerId: '11111111-1111-4111-8111-111111111111', source, sequence: ++sequence })
    const write = (data: string, target = terminal as typeof terminal | typeof agent) => track(controller!.write(target, data, 'user', observation()))
    const startCalls = calls.length, startNative = nativeRequests.length
    let firstSettled = false
    const initial = Array.from({ length: 63 }, (_, index) => write(String.fromCharCode(65 + index % 26)))
    void initial[0]!.then(() => { firstSettled = true }, () => {})
    const filled = await observe(() => native.status(run.id), value => value.applied_input_bytes === 63)
    receipt.beforeEarlierAck = filled.applied_input_bytes
    expect(filled.applied_input_bytes, 'Later Main writes must reach the actual PTY before the first ACK').toBe(63)
    expect(firstSettled).toBe(false)
    const mixedAgent = write('a', agent)
    expect(await observe(async () => atAgentAuthority.settled, value => value)).toBe(true)
    const mixedTerminal = write('b')
    expect(await observe(async () => atTerminalInvocation.settled, value => value)).toBe(true)
    // Drain this transport turn, allowing an incorrectly split owner to reach the same final authority gate.
    await turn(); await turn()
    authority.resolve()
    const full = await observe(() => native.status(run.id), value => value.applied_input_bytes === 64)
    expect(full.applied_input_bytes).toBe(64)
    expect(firstSettled).toBe(false)
    await observe(async () => held.length, count => count === 64)
    expect(held).toHaveLength(64)
    const first = held.shift()!; forward(first)
    const credit = await observe(() => native.status(run.id), value => value.applied_input_bytes === 65)
    receipt.afterOneCredit = credit.applied_input_bytes
    flush()
    const settled = await Promise.allSettled([...initial, mixedAgent, mixedTerminal])
    expect(settled.filter(value => value.status === 'rejected'), 'Mixed Agent/Terminal capacity cannot discard an admitted byte').toEqual([])
    expect(credit.applied_input_bytes).toBe(65)
    await Promise.all(Array.from({ length: 69 }, () => write('z')))
    const ordered = [...receipts].sort((a, b) => a.value.appliedByteRange.startByte - b.value.appliedByteRange.startByte)
    expect(ordered).toHaveLength(134)
    expect(ordered.map(item => item.value.appliedByteRange)).toEqual(Array.from({ length: 134 }, (_, index) => ({ startByte: index, endByte: index + 1 })))
    expect(ordered.every(item => item.value.acceptedThroughByte === item.value.appliedByteRange.endByte)).toBe(true)
    let expected = 'READY' + Array.from({ length: 63 }, (_, index) => String.fromCharCode(65 + index % 26)).join('') + 'ab' + 'z'.repeat(69)
    expect(await observe(readOutput, text => text === expected)).toBe(expected)
    expect(calls.slice(startCalls).filter(method => method === 'connectRuntime'), 'Main must not add a Hosted Native preflight to every byte').toEqual([])
    expect(nativeRequests.slice(startNative).filter(method => method === 'status'), 'Raw dispatch must not query a cursor before every byte').toEqual([])

    // A real Core output attachment is independent of the already-open input channel.
    await core.reattachAgent(session.agentSessionId)
    await core.releaseRunAttachment(session.run)
    const inputOpenings = nativeRequests.filter(method => method === 'open_input').length
    automatic = false; discoveryGate = deferred()
    const slow = write('s', agent)
    expect(main.hostOperations.get('local')?.size, 'Host reconfiguration must see input before discovery finishes').toBe(1)
    let quiet = false
    const quiescence = main.waitForHostQuiescence('local').then(() => { quiet = true })
    await turn(); expect(quiet).toBe(false)
    discoveryGate.resolve(); discoveryGate = undefined
    await observe(async () => held.length, count => count === 1)
    expect(held).toHaveLength(1)
    const delayed = held[0]!
    automatic = true
    await Promise.all(Array.from({ length: 8 }, (_, index) => write('y', index % 2 ? agent : terminal)))
    const paste = '\u001b[200~界\u001b[201~', parent = observation('paste')
    await track(controller.paste(terminal, '界', paste, parent))
    const pendingOnly = { main: main.hostOperations.get('local')?.size, agent: inner.agentInputLanes.get(session.agentSessionId)?.pending.size,
      core: inner.inputPerformance.snapshot().pending, admissionOwners: inner.rawInputAdmissions.size }
    expect(pendingOnly).toEqual({ main: 1, agent: 1, core: 1, admissionOwners: 0 })
    expect(quiet).toBe(false)
    held.shift(); forward(delayed); await slow; await quiescence
    expect(main.hostOperations.size).toBe(0); expect(inner.agentInputLanes.size).toBe(0)
    expect(nativeRequests.filter(method => method === 'open_input')).toHaveLength(inputOpenings)
    expected += 's' + 'y'.repeat(8) + paste
    expect(await observe(readOutput, text => text === expected)).toBe(expected)
    const mainEntry = main.inputPerformance.snapshot().recent.find(entry => entry.parent?.sequence === parent.sequence)
    const coreEntry = inner.inputPerformance.snapshot().recent.find(entry => entry.parent?.sequence === parent.sequence)
    expect(mainEntry).toMatchObject({ hostId: 'local', runId: run.id, kind: 'paste', parent, result: 'completed' })
    expect(coreEntry).toMatchObject({ runId: run.id, ownerInstanceId: owner.ctxmux.instanceId, kind: 'terminal', parent, result: 'completed' })
    expect(receipts.find(item => item.data === paste)?.value.appliedByteRange).toEqual({ startByte: 143, endByte: 143 + Buffer.byteLength(paste) })
    Object.assign(receipt, { acceptedBurst: 134, pendingOnly, inputOpenings, outputBytes: Buffer.byteLength(expected),
      outputSHA256: createHash('sha256').update(expected).digest('hex'), receipts, originalResults, mainEntry, coreEntry,
      publicNativePreflights: calls.slice(startCalls).filter(method => method === 'connectRuntime').length })
  } finally {
    authority.resolve(); discoveryGate?.resolve(); flush()
    const cleanupErrors: unknown[] = []
    const clean = async (action: () => Promise<unknown>) => { try { await action() } catch (error) { cleanupErrors.push(error) } }
    await clean(async () => { await controller?.dispose(); if (!controller) await hosted?.dispose() })
    await clean(async () => await service?.dispose())
    await clean(async () => await core?.dispose())
    for (const socket of sockets) socket.destroy()
    if (server.listening) await clean(() => new Promise<void>(resolve => server.close(() => resolve())))
    await clean(async () => { if (activation) for (const run of await activation.client.list()) {
      if (run.state.type === 'running') await activation.client.stop(await activation.client.prepareStop(run.id))
      await activation.client.remove(run.id)
    } })
    await clean(async () => await activation?.shutdown())
    await clean(async () => await activation?.dispose())
    await Promise.allSettled(work)
    receipt.cleanup = { daemonPid: activation?.childPid, daemonAlive: alive(activation?.childPid), runPid, runAlive: alive(runPid),
      proxyListening: server.listening, errors: cleanupErrors.map(String) }
    await rm(root, { recursive: true, force: true })
    if (evidence) await writeFile(evidence, JSON.stringify(receipt, null, 2))
    expect(receipt.cleanup).toMatchObject({ daemonAlive: false, runAlive: false, proxyListening: false, errors: [] })
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Private input fixture cleanup failed')
  }
}, 25_000)
