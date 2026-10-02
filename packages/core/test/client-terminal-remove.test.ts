import { fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { activateRuntime, type CtxmuxClient, type RuntimeActivation, type RunId } from '@ctxmux/sdk'
import { AgentMuxError } from '../src/errors.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../src/types.js'

it('public terminal removal refuses both current and retired Agent bindings without changing their durable facts',async()=>{
  const store=new AgentMuxMemoryAgentSessionStore()
  const session:AgentMuxStoredAgentSession={kind:'agent',agentSessionId:'semantic-guard',providerId:'codex',executorId:'codex',hostId:'local',
    workspacePath:fixturePath("private/toolkit-remove"),run:{runId:'current-agent'},retiredRuns:[{runId:'retired-agent'}],
    hookBindingId:'binding',hookToken:'token',createdAt:1,updatedAt:1}
  await store.compareAndSwap(null,session)
  const client=new AgentMuxClient({store}),inner=client as unknown as {connected:boolean;registry:AgentMuxAgentSessionRegistry;kernel:{remove(id:string):Promise<void>;isConnected():boolean}}
  await inner.registry.load('local');inner.connected=true
  const remove=vi.spyOn(inner.kernel,'remove').mockResolvedValue(undefined)
  const connected=vi.spyOn(inner.kernel,'isConnected').mockReturnValue(true)
  try {
    const codes=[]
    for(const runId of ['current-agent','retired-agent']) {
      codes.push(await client.removeTerminal({runId}).then(()=>null,error=>error.code))
    }
    expect(codes).toEqual(['RUN_KIND_MISMATCH','RUN_KIND_MISMATCH'])
    expect(remove).not.toHaveBeenCalled();expect(await store.load()).toEqual([session])
    await expect(client.removeTerminal({runId:'actual-terminal'})).resolves.toBeUndefined()
    expect(remove.mock.calls).toEqual([['actual-terminal']])
  } finally {remove.mockRestore();connected.mockRestore();await client.dispose()}
})

it('successful terminal retirement releases only its exact metadata while failed removal preserves authoritative facts',async()=>{
  const client=new AgentMuxClient({store:new AgentMuxMemoryAgentSessionStore()})
  const inner=client as unknown as {connected:boolean;kernel:{remove(id:string):Promise<void>;isConnected():boolean};
    runPids:Map<string,number>;endedRuns:Map<string,unknown>;stopRequestedRuns:Set<string>}
  inner.connected=true
  const connected=vi.spyOn(inner.kernel,'isConnected').mockReturnValue(true)
  const remove=vi.spyOn(inner.kernel,'remove').mockResolvedValue(undefined)
  inner.runPids.set('healthy-agent',7);inner.endedRuns.set('retired-agent',{kind:'completed'})
  inner.stopRequestedRuns.add('healthy-agent')
  try {
    for(let n=0;n<10;n++) {
      const id='terminal-'+n
      inner.runPids.set(id,100+n);inner.endedRuns.set(id,{kind:'user-stopped'});inner.stopRequestedRuns.add(id)
      await expect(client.removeTerminal({runId:id})).resolves.toBeUndefined()
      expect([...inner.runPids]).toEqual([['healthy-agent',7]])
      expect([...inner.endedRuns]).toEqual([['retired-agent',{kind:'completed'}]])
      expect([...inner.stopRequestedRuns]).toEqual(['healthy-agent'])
    }
    inner.runPids.set('pinned',20);inner.endedRuns.set('pinned',{kind:'user-stopped'});inner.stopRequestedRuns.add('pinned')
    remove.mockRejectedValueOnce(Object.assign(new Error('Run pinned'),{code:'CTXMUX_backend_unavailable'}))
    await expect(client.removeTerminal({runId:'pinned'})).rejects.toMatchObject({code:'CTXMUX_backend_unavailable'})
    expect([...inner.runPids]).toEqual([['healthy-agent',7],['pinned',20]])
    expect([...inner.endedRuns]).toEqual([['retired-agent',{kind:'completed'}],['pinned',{kind:'user-stopped'}]])
    expect([...inner.stopRequestedRuns]).toEqual(['healthy-agent','pinned'])
    expect(remove.mock.calls).toHaveLength(11)
  } finally {remove.mockRestore();connected.mockRestore();await client.dispose()}
})

// Actual SDK snapshots are only held after the original owner has produced them.
// The fence must not replace Runtime facts or retain a second removed-Run registry.
async function terminalRuntime(run: (client: AgentMuxClient, sdk: CtxmuxClient, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(fixturePath("tmp/amx-terminal-remove-"))
  let activation: RuntimeActivation | undefined, client: AgentMuxClient | undefined
  try {
    const runtime = join(directory, 'runtime'), state = join(directory, 'state')
    await mkdir(runtime, { mode: 0o700 }); await mkdir(join(state, 'ctxmux'), { recursive: true, mode: 0o700 })
    for (const key of Object.keys(process.env).filter(key => key.startsWith('AGENTMUX_'))) vi.stubEnv(key, undefined)
    for (const [key, value] of Object.entries({ AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state,
      AGENTMUX_AGENT_SESSION_STORE: join(directory, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(directory, 'queue.ndjson') })) vi.stubEnv(key, value)
    activation = await activateRuntime({ executable: fileURLToPath(new URL('../vendor/ctxmux/darwin-arm64/bin/ctxmuxd', import.meta.url)),
      socketPath: join(runtime, 'ctxmux.sock'), stateDir: join(state, 'ctxmux'), timeoutMs: 5000,
      childDisposition: { mode: 'detached', stdout: 'ignore', stderr: 'pipe' } })
    expect(activation.spawned).toBe(true)
    client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() }); await client.connect()
    await run(client, activation.client, directory)
  } finally {
    await client?.dispose()
    if (activation) {
      for (const native of await activation.client.list()) {
        if (native.state.type === 'running') {
          await activation.client.stop(await activation.client.prepareStop(native.id))
          await vi.waitFor(async () => expect((await activation!.client.status(native.id)).state.type).not.toBe('running'))
        }
        await activation.client.remove(native.id)
      }
      await activation.dispose({ shutdown: true })
    }
    await rm(directory, { recursive: true, force: true }); vi.unstubAllEnvs()
  }
}
type TerminalClient = {
  kernel: CtxmuxRunAdapter; runPids: Map<string, number | null>; endedRuns: Map<string, unknown>; stopRequestedRuns: Set<string>
  pendingRunSnapshots: Map<string | null, Set<Set<string>>>; republishLiveRunState(): Promise<void>
}
const metadata = (client: AgentMuxClient) => {
  const inner = client as unknown as TerminalClient
  return { runPids: [...inner.runPids], endedRuns: [...inner.endedRuns], stopRequestedRuns: [...inner.stopRequestedRuns] }
}
async function healthyTerminal(client: AgentMuxClient, directory: string) {
  return await client.createTerminal({ workspacePath: directory, command: process.execPath,
    args: ['-e', "process.stdout.write('READY\\n');process.stdin.on('data',data=>process.stdout.write('ACK:'+data))"] })
}
async function assertHealthy(client: AgentMuxClient, sdk: CtxmuxClient, run: Awaited<ReturnType<typeof healthyTerminal>>) {
  const before = await sdk.status(run.runId as RunId)
  await client.writeTerminal({ runId: run.runId }, { ownerInstanceId: (await sdk.runtimeInfo()).daemonInstanceId,
    operationId: crypto.randomUUID(), expectedByte: before.applied_input_bytes!, data: 'after-remove\n' })
  await vi.waitFor(async () => expect((await client.readRunReplay({ runId: run.runId })).replay
    .map(chunk => Buffer.from(chunk.dataBytes).toString()).join('')).toContain('ACK:after-remove'))
  const after = await sdk.status(run.runId as RunId)
  expect({ runId: after.id, pid: after.pid, state: after.state }).toEqual({ runId: before.id, pid: before.pid, state: before.state })
}

describe.runIf(process.platform === 'darwin' && process.arch === 'arm64')('pending terminal snapshots across actual Runtime removal', () => {
  it.each(['list', 'reconnect', 'replay', 'attach'] as const)('does not republish a removed Run from an earlier actual %s snapshot', async method => {
    await terminalRuntime(async (client, sdk, directory) => {
      const healthy = await healthyTerminal(client, directory), baseline = metadata(client)
      const ended = await client.createTerminal({ workspacePath: directory, command: process.execPath,
        args: ['-e', "process.stdout.write('ENDED')"] })
      await vi.waitFor(async () => expect((await sdk.status(ended.runId as RunId)).state.type).toBe('exited'))
      const inner = client as unknown as TerminalClient, kernel = inner.kernel
      let release!: () => void, entered!: () => void
      const held = new Promise<void>(resolve => { release = resolve }), captured = new Promise<void>(resolve => { entered = resolve })
      const hold = async <T>(read: () => Promise<T>): Promise<T> => { const actual = await read(); entered(); await held; return actual }
      const events: AgentMuxClientEvent[] = [], unsubscribe = client.onEvent(event => events.push(event))
      const originalList = kernel.list.bind(kernel), originalReplay = kernel.replay.bind(kernel), originalAttach = kernel.attach.bind(kernel)
      const spy = method === 'list' || method === 'reconnect' ? vi.spyOn(kernel, 'list').mockImplementation(() => hold(originalList)) :
        method === 'replay' ? vi.spyOn(kernel, 'replay').mockImplementation((...args) => hold(() => originalReplay(...args))) :
          vi.spyOn(kernel, 'attach').mockImplementation((...args) => hold(() => originalAttach(...args)))
      const pending = method === 'list' ? client.listRuns() : method === 'reconnect' ? inner.republishLiveRunState() :
        method === 'replay' ? client.readRunReplay({ runId: ended.runId }) : client.attachTerminal(ended.runId)
      void pending.catch(() => {})
      try {
        await captured; spy.mockRestore()
        await client.removeTerminal({ runId: ended.runId })
        expect((await sdk.list()).map(run => run.id)).not.toContain(ended.runId)
        expect(metadata(client)).toEqual(baseline)
        release()
        if (method === 'replay' || method === 'attach') await expect(pending).rejects.toMatchObject({ code: 'CTXMUX_run_not_found' })
        else {
          const projected = await pending
          if (method === 'list') expect(projected).toEqual([expect.objectContaining({ runId: healthy.runId, pid: healthy.pid })])
          else expect(events.filter(event => event.type === 'process-state').map(event => event.run.runId)).toEqual([healthy.runId])
        }
        expect(metadata(client)).toEqual(baseline)
        expect(inner.pendingRunSnapshots.size).toBe(0)
        await assertHealthy(client, sdk, healthy)
        expect((await client.listRuns()).map(run => run.runId)).toEqual([healthy.runId])
        expect(inner.pendingRunSnapshots.size).toBe(0)
      } finally { spy.mockRestore(); unsubscribe(); release(); await pending.catch(() => {}) }
    })
  }, 20000)

  it.each(['running', 'unknown'] as const)('preserves an actual healthy Run and pending reader when remove is %s', async failure => {
    await terminalRuntime(async (client, sdk, directory) => {
      const healthy = await healthyTerminal(client, directory), sibling = await healthyTerminal(client, directory)
      const baseline = metadata(client), inner = client as unknown as TerminalClient, original = inner.kernel.list.bind(inner.kernel)
      let release!: () => void, entered!: () => void
      const held = new Promise<void>(resolve => { release = resolve }), captured = new Promise<void>(resolve => { entered = resolve })
      const list = vi.spyOn(inner.kernel, 'list').mockImplementation(async () => { const actual = await original(); entered(); await held; return actual })
      const pending = client.listRuns(); void pending.catch(() => {})
      let restoreRemove: (() => void) | undefined
      try {
        await captured; list.mockRestore()
        if (failure === 'unknown') restoreRemove = vi.spyOn(inner.kernel, 'remove').mockRejectedValueOnce(new AgentMuxError('Removal receipt unavailable.', 'CTXMUX_DISCONNECTED')).mockRestore
        await expect(client.removeTerminal({ runId: healthy.runId })).rejects.toMatchObject({ code: failure === 'running' ? 'CTXMUX_invalid_run_state' : 'CTXMUX_DISCONNECTED' })
        expect(metadata(client)).toEqual(baseline)
        release()
        expect((await pending).map(run => run.runId).sort()).toEqual([healthy.runId, sibling.runId].sort())
        expect(metadata(client)).toEqual(baseline)
        expect(inner.pendingRunSnapshots.size).toBe(0)
        await assertHealthy(client, sdk, healthy); await assertHealthy(client, sdk, sibling)
        expect(inner.pendingRunSnapshots.size).toBe(0)
      } finally { restoreRemove?.(); list.mockRestore(); release(); await pending.catch(() => {}) }
    })
  }, 20000)
})
