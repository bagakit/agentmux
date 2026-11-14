import { appendFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { HostedExecutionHost } from '../src/hosted-execution-host.js'
import { AgentMuxError } from '../src/errors.js'
import { decodeHostedValue, encodeHostedValue, hostedTransfer } from '../src/hosted-value.js'
import { decodePreparedRun } from '../src/prepared-run.js'
import { parsePreparedTerminal } from '../src/terminal-preparation.js'
import type { AgentMuxHostedBootstrap, AgentMuxHostedRpcPort } from '../src/hosted-client-contract.js'
import type { AgentMuxClientEvent, AgentMuxRun, AgentMuxRunAttachment } from '../src/types.js'
import type { AgentMuxTerminalCreateInput } from "../src/client-contract.js";

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
function barrier() { let release!: () => void; const pending = new Promise<void>(done => { release = done }); return { pending, release } }
const checkpoint = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
type Handlers = Parameters<AgentMuxHostedRpcPort['subscribe']>[2]

/** Real Hosted SDK, value/transfer codec, publisher and command consumer. Only the Runtime wire endpoint is controlled. */
async function fixture(options: { attachRace?: boolean; holdCreate?: boolean; holdAttach?: boolean; lostCreateReply?: boolean; lostInputReply?: boolean } = {}) {
  const identity = { hostId: 'local', instanceId: 'original-native', protocolVersion: 1, buildIdentity: 'private-fixture', processId: 123, ownership: 'owned' as const }
  const owner: AgentMuxHostedBootstrap['owner'] = { runtimeId: 'original-runtime', ownerInstanceId: 'original-owner', protocolVersion: 2, processId: 123, availability: 'connected', ctxmux: identity }
  const bootstrap: AgentMuxHostedBootstrap = { owner, connection: null, storePath: null, hostProcessId: 123, catalog: [], sessions: [], messageQueuePath: '/fixture/messages.ndjson' }
  const runs = new Map<string, AgentMuxRun>(), buffers = new Map<string, Buffer>(), tokens = new Map<string, string>(), watches = new Map<string, Handlers>()
  const creations: Array<{ operationId: string; runId: string }> = [], inputs: Array<{ runId: string; operationId: string; data: string }> = [], stops: string[] = [], removed: string[] = [], calls: string[] = []
  const createGate = barrier(), attachGate = barrier(); cleanup.push(createGate.release, attachGate.release)
  let events!: Handlers, transfer = 0, nextRun = 0
  const send = (handlers: Handlers, value: Parameters<typeof hostedTransfer>[0]) => { for (const data of hostedTransfer(value, 'transfer-' + ++transfer)) handlers.onEvent({ type: 'snapshot', data }) }
  const output = (runId: string, text: string) => {
    const dataBytes = Buffer.from(text), startByte = buffers.get(runId)!.length
    buffers.set(runId, Buffer.concat([buffers.get(runId)!, dataBytes])); runs.get(runId)!.latestOutputBytes = startByte + dataBytes.length
    const event: AgentMuxClientEvent = { type: 'terminal-output', run: { runId }, data: text, dataBytes,
      evidence: { source: 'terminal-output', observedAt: 1, run: { runId }, outputByteRange: { startByte, endByte: startByte + dataBytes.length } } }
    send(watches.get(runId)!, { kind: 'event', event })
  }
  const run = (runId: string): AgentMuxRun => ({ runId, kind: 'terminal', providerId: null, executorId: null, agentSessionId: null, workspacePath: '/fixture/project',
    pid: 42, state: 'running', cols: 80, rows: 24, observedAt: 1, latestOutputBytes: 0, acceptedInputBytes: 0, nativeService: null })
  runs.set('unrelated-run', run('unrelated-run')); buffers.set('unrelated-run', Buffer.alloc(0))
  const port = {
    call: async (method: string, params: any) => {
      calls.push(method)
      if (method === 'runtime.owner.identity') return { owner }
      if (method === 'runtime.release-consumer') return { released: true }
      if (method !== 'runtime.invoke') throw new Error('Unexpected wire call ' + method)
      const invocation = decodeHostedValue(params.invocation) as { method: string; args: any[] }, [first, second] = invocation.args
      let result: unknown
      if (invocation.method === 'runtimeProjection') result = { hostId: 'local', subjects: [] }
      else if (invocation.method === 'prepareTerminal') {
        const input = first as AgentMuxTerminalCreateInput
        result = parsePreparedTerminal({ createOperationId: input.createOperationId, workspacePath: input.workspacePath,
          launch: JSON.stringify({ createOperationId: input.createOperationId, request: { program: input.command, args: input.args,
            cwd: input.workspacePath, env: { AGENTMUX_LIFECYCLE_OPERATION_ID: input.createOperationId }, initial_size: { cols: 80, rows: 24 }, declared_inputs: [] } }) })
      } else if (invocation.method === 'createPreparedTerminal') {
        const prepared = decodePreparedRun(first), value = run('command-' + ++nextRun), token = prepared.request.args[3]!
        runs.set(value.runId, value); tokens.set(value.runId, token); buffers.set(value.runId, Buffer.from(token + ':ready\n')); value.latestOutputBytes = buffers.get(value.runId)!.length
        creations.push({ operationId: prepared.prepared.createOperationId, runId: value.runId })
        if (options.holdCreate) await createGate.pending
        if (options.lostCreateReply) throw new AgentMuxError('The original creation reply is unknown.', 'CONTROL_CONNECTION_FAILED')
        result = value
      } else if (invocation.method === 'writeTerminal') {
        inputs.push({ runId: first.runId, operationId: second.operationId, data: second.data })
        if (options.lostInputReply) throw new AgentMuxError('The original input receipt is unknown.', 'CONTROL_CONNECTION_FAILED')
        result = { acceptedThroughByte: second.expectedByte + Buffer.byteLength(second.data) }
      } else if (invocation.method === 'stopTerminal') { stops.push(first.runId); result = undefined }
      else if (invocation.method === 'removeTerminal') { removed.push(first.runId); result = undefined }
      else throw new Error('Unexpected Runtime invocation ' + invocation.method)
      return { value: encodeHostedValue(result) }
    },
    subscribe: async (method: string, params: any, handlers: Handlers) => {
      const transferId = 'initial-' + ++transfer
      handlers.onInitial({ owner, transferId })
      if (method === 'runtime.events') {
        events = handlers
        for (const data of hostedTransfer({ kind: 'initial', value: bootstrap }, transferId)) handlers.onEvent({ type: 'snapshot', data })
        return { dispose: async () => {} }
      }
      expect(['runtime.attachment-watch', 'runtime.replay-watch']).toContain(method)
      const runId = params.target.runId, value = structuredClone(runs.get(runId)!), all = buffers.get(runId)!, race = options.attachRace && method === 'runtime.attachment-watch' && runId !== 'unrelated-run'
      const cut = race ? Math.floor(all.length / 2) : all.length, bytes = all.subarray(params.afterByte, cut)
      value.latestOutputBytes = cut
      const attachment: AgentMuxRunAttachment = { run: value, gap: null, resizeRevision: 0, terminal: { type: 'not-requested' },
        replay: bytes.length ? [{ type: 'data', runId, startByte: params.afterByte, endByte: cut, data: bytes.toString('utf8'), dataBytes: bytes }] : [] }
      for (const data of hostedTransfer({ kind: 'initial', value: attachment }, transferId)) handlers.onEvent({ type: 'snapshot', data })
      if (method === 'runtime.attachment-watch') {
        watches.set(runId, handlers)
        if (race) {
          const overlap = Math.max(0, cut - 3), rest = all.subarray(overlap), event: AgentMuxClientEvent = { type: 'terminal-output', run: { runId }, data: rest.toString('utf8'), dataBytes: rest,
            evidence: { source: 'terminal-output', observedAt: 1, run: { runId }, outputByteRange: { startByte: overlap, endByte: all.length } } }
          send(handlers, { kind: 'event', event })
        }
        if (options.holdAttach && runId !== 'unrelated-run') await attachGate.pending
      }
      return { dispose: async () => { if (watches.get(runId) === handlers) watches.delete(runId) } }
    }
  } as unknown as AgentMuxHostedRpcPort
  const client = await connectHostedAgentMux({ rpc: port }); cleanup.push(() => client.dispose())
  const visited: Array<{ lane: 'run' | 'status' | 'global'; event: AgentMuxClientEvent }> = [], active = { run: 0, status: 0, global: 0 }
  for (const lane of ['run', 'status', 'global'] as const) {
    const method = lane === 'run' ? 'onRunEvent' : lane === 'status' ? 'onStatusEvent' : 'onEvent', original = client[method].bind(client)
    vi.spyOn(client, method).mockImplementation(((...args: any[]) => {
      const index = lane === 'run' ? 1 : 0, listener = args[index]
      args[index] = (event: AgentMuxClientEvent) => { visited.push({ lane, event }); return listener(event) }
      active[lane]++
      const release = (original as (...values: any[]) => () => void)(...args); let released = false
      return () => { if (!released) { released = true; active[lane]--; release() } }
    }) as never)
  }
  const host = new HostedExecutionHost({ id: 'selected-host', label: 'Selected', connect: async () => client })
  return { client, host, visited, active, creations, inputs, stops, removed, calls, runs, createGate, attachGate,
    attachUnrelated: () => client.attachTerminal('unrelated-run', 0, 'raw'),
    unrelated: () => output('unrelated-run', 'x'.repeat(4096)),
    finish(runId: string) {
      const token = tokens.get(runId)!
      output(runId, `${token}:result:0\n${Buffer.from('original stdout').toString('base64')}\n${Buffer.from('original stderr').toString('base64')}\n${token}:done\n`)
      runs.get(runId)!.state = 'exited'
      send(watches.get(runId)!, { kind: 'event', event: { type: 'process-state', run: { runId }, state: 'exited', pid: 42, exitCode: 0,
        evidence: { source: 'run-process', observedAt: 2, run: { runId } } } })
    },
    drop: () => events.onEnd?.(new AgentMuxError('The original wire observation ended.', 'CONTROL_CONNECTION_FAILED')) }
}

it.each([1, 8, 32])('actual Hosted SDK/publisher visits zero command callbacks for 100 unrelated outputs with %i concurrent commands', async count => {
  const f = await fixture(); await f.attachUnrelated()
  const work = Array.from({ length: count }, () => f.host.run('/fixture/controlled-command', [], { timeoutMs: 3000 }).catch(error => error))
  await vi.waitFor(() => expect(f.inputs).toHaveLength(count))
  expect(f.active.run + f.active.status + f.active.global).toBe(count * 2)
  f.visited.length = 0
  for (let i = 0; i < 100; i++) f.unrelated()
  if (process.env.AGENTMUX_COMMAND_DISPATCH_COUNTERS) appendFileSync(process.env.AGENTMUX_COMMAND_DISPATCH_COUNTERS,
    JSON.stringify({ commands: count, unrelatedEvents: 100, bytesPerEvent: 4096, commandCallbacks: f.visited.length }) + '\n')
  expect(f.visited).toHaveLength(0)
  const first = f.creations[0]!
  f.finish(first.runId)
  expect(await work[0]).toEqual({ stdout: 'original stdout', stderr: 'original stderr', exitCode: 0 })
  expect(f.visited.filter(row => row.event.type === 'terminal-output')).toHaveLength(1)
  expect(f.visited.filter(row => row.event.type === 'terminal-output')[0]!.lane).toBe('run')
  if (count > 1) {
    f.visited.length = 0; f.drop()
    const failures = await Promise.all(work.slice(1))
    expect(failures.every(error => error.code === 'COMMAND_UNCONFIRMED' && error.controlFailure.disposition === 'unknown')).toBe(true)
    expect(f.visited.filter(row => row.event.type === 'connection-state')).toHaveLength(count - 1)
    expect(f.visited.every(row => row.lane === 'status')).toBe(true)
    for (let i = 1; i < count; i++) expect(JSON.parse(failures[i - 1].detail)).toMatchObject({ createOperationId: f.creations[i]!.operationId, runId: f.creations[i]!.runId })
  }
  expect(f.creations).toHaveLength(count); expect(f.inputs).toHaveLength(count)
  expect(f.stops).toHaveLength(0); expect(f.removed).toEqual([first.runId]); expect(f.active).toEqual({ run: 0, status: 0, global: 0 })
})

it('indexes before attach and preserves output produced before the create reply plus overlapping initial/live attachment bytes', async () => {
  const f = await fixture({ attachRace: true }), work = f.host.run('/fixture/controlled-command', [], { timeoutMs: 3000 }).catch(error => error)
  await vi.waitFor(() => expect(f.inputs).toHaveLength(1))
  f.finish(f.creations[0]!.runId)
  expect(await work).toEqual({ stdout: 'original stdout', stderr: 'original stderr', exitCode: 0 })
  expect(f.creations).toHaveLength(1); expect(f.inputs).toHaveLength(1); expect(f.active).toEqual({ run: 0, status: 0, global: 0 })
})

it.each(['create', 'attach'] as const)('a connection loss while %s is pending keeps the original operation unknown, sends no later input and releases both listeners', async phase => {
  const f = await fixture({ holdCreate: phase === 'create', holdAttach: phase === 'attach' }), work = f.host.run('/fixture/controlled-command', [], { timeoutMs: 3000 }).catch(error => error)
  await vi.waitFor(() => expect(phase === 'create' ? f.creations.length : f.active.run).toBe(1))
  f.drop(); f.createGate.release(); f.attachGate.release()
  const error = await work
  expect(error).toMatchObject({ code: 'COMMAND_UNCONFIRMED', controlFailure: { disposition: 'unknown' } })
  expect(JSON.parse(error.detail)).toMatchObject({ createOperationId: f.creations[0]!.operationId })
  expect(f.creations).toHaveLength(1); expect(f.inputs).toHaveLength(0); expect(f.stops).toHaveLength(0); expect(f.removed).toHaveLength(0)
  expect(f.active).toEqual({ run: 0, status: 0, global: 0 })
})

it('cancels only its exact command and releases both indexed/status listeners without stopping another attached Run', async () => {
  const f = await fixture(), controller = new AbortController(); await f.attachUnrelated()
  const work = f.host.run('/fixture/controlled-command', [], { signal: controller.signal }).catch(error => error)
  await vi.waitFor(() => expect(f.inputs).toHaveLength(1)); controller.abort()
  expect(await work).toMatchObject({ code: 'COMMAND_ABORTED', controlFailure: { disposition: 'unknown' } })
  expect(f.stops).toEqual([f.creations[0]!.runId]); expect(f.removed).toHaveLength(0); expect(f.runs.get('unrelated-run')!.state).toBe('running')
  expect(f.active).toEqual({ run: 0, status: 0, global: 0 })
})

it('an explicit abort while create is pending stops the returned original Run once without sending input or replaying creation', async () => {
  const f = await fixture({ holdCreate: true }), controller = new AbortController()
  const work = f.host.run('/fixture/controlled-command', [], { signal: controller.signal }).catch(error => error)
  await vi.waitFor(() => expect(f.creations).toHaveLength(1))
  controller.abort()
  expect(f.stops).toHaveLength(0)
  f.createGate.release()
  const error = await work
  expect(error).toMatchObject({ code: 'COMMAND_ABORTED', controlFailure: { disposition: 'unknown' } })
  expect(JSON.parse(error.detail)).toMatchObject({ createOperationId: f.creations[0]!.operationId })
  expect(f.creations).toHaveLength(1); expect(f.inputs).toHaveLength(0)
  expect(f.stops).toEqual([f.creations[0]!.runId]); expect(f.removed).toHaveLength(0); expect(f.active).toEqual({ run: 0, status: 0, global: 0 })
})

it.each(['create', 'input'] as const)('a lost %s reply keeps the original operation IDs without replay or ending an unrelated Run', async phase => {
  const f = await fixture({ lostCreateReply: phase === 'create', lostInputReply: phase === 'input' }); await f.attachUnrelated()
  const error = await f.host.run('/fixture/controlled-command', []).catch(error => error)
  expect(error).toMatchObject({ code: 'CONTROL_CONNECTION_FAILED', controlFailure: { disposition: 'unknown' } })
  expect(JSON.parse(error.detail)).toMatchObject({ createOperationId: f.creations[0]!.operationId, ...(phase === 'input' ? { runId: f.creations[0]!.runId, inputOperationId: f.inputs[0]!.operationId } : {}) })
  expect(f.creations).toHaveLength(1); expect(f.inputs).toHaveLength(phase === 'create' ? 0 : 1); expect(f.stops).toHaveLength(0); expect(f.removed).toHaveLength(0)
  expect(f.active).toEqual({ run: 0, status: 0, global: 0 }); expect(f.runs.get('unrelated-run')!.state).toBe('running')
})
