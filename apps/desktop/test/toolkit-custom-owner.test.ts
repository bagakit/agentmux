import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getAppPath: () => process.cwd() } }))
import { randomUUID } from 'node:crypto'
import { AgentMuxError } from '@agentmux/core'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { ConfigOwner } from '../src/main/config-owner.js'
import { CustomToolkitOwner } from '../src/main/toolkit-custom-owner.js'
import { executeToolkitConfig, prepareToolkitConfig, toolkitFields } from '../src/main/toolkit-config.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, parseToolkitSnapshot, type ToolkitAdmission, type ToolkitActionInput, type ToolkitRunInput, type ToolkitToolDefinition } from '@agentmux/core/control'
import type { AgentMuxClientEvent, AgentMuxRunAttachment } from '@agentmux/core'
import type { ToolkitRunPort } from '../src/main/toolkit-run-port.js'

const tool: ToolkitToolDefinition = { id: 'quota', revision: 'author-1', name: 'Quota', icon: 'terminal', enabled: true,
  statusBar: 'icon', workspacePath: '/tmp', script: "console.log('工具_ACK')", args: [], actions: [] }
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)) }
const deferred = () => { let resolve!: () => void; return { promise: new Promise<void>(r => { resolve = r }), release: () => resolve() } }
function fixture(output = '工具_ACK', initialState: 'running' | 'exited' = 'exited', definition = tool) {
  let config = { ...structuredClone(DEFAULT_CONFIG), toolkit: { tools: [structuredClone(definition)] } }
  let custom!: CustomToolkitOwner, accept: (event: AgentMuxClientEvent) => void = () => {}
  let state = initialState, bytes = Buffer.from(output), finalBytes = bytes.byteLength
  const receipts = new Map<string, unknown>()
  const storage = { read: vi.fn(async (id: string) => receipts.get(id) ?? null), save: vi.fn(async (id: string, value: unknown) => { receipts.set(id, structuredClone(value)) }) }
  const owner = new ConfigOwner({ read: () => config,
    prepare: (current, next) => prepareToolkitConfig(current, next, id => custom.guardDelete(id)),
    save: vi.fn(async next => structuredClone(next)), publish: saved => { config = saved as typeof config; custom.configurationChanged() } })
  const run = () => ({ runId: 'exact-tool-run', kind: 'terminal', state, exitCode: state === 'exited' ? 0 : undefined, latestOutputBytes: finalBytes })
  const snapshot = () => ({ run: run(), replay: bytes.length ? [{ startByte: 0, endByte: bytes.length, dataBytes: bytes }] : [], gap: null }) as AgentMuxRunAttachment
  const port: ToolkitRunPort = { create: vi.fn(async (_input, listener) => { accept = listener; return run() as any }),
    attach: vi.fn(async (_ref, _after, listener) => {
      if (listener) accept = listener
      // Production attach publishes state before returning replay. This cannot recurse into another attach.
      accept({ type: 'process-state', state, exitCode: state === 'exited' ? 0 : undefined, run: { runId: 'exact-tool-run' } } as any)
      return snapshot()
    }), replay: vi.fn(async () => snapshot()),
    release: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    stop: vi.fn(async () => { state = 'exited'; accept({ type: 'process-state', state: 'exited', exitCode: 0, run: { runId: 'exact-tool-run' } } as any) }) }
  custom = new CustomToolkitOwner({ config: owner, receipts: storage, openRunPort: async () => port, runner: process.execPath, env: {} })
  const input = (latest: string | null = null): ToolkitRunInput => ({ invocationId: randomUUID(), expectedRevision: config.toolkit.tools[0]!.revision, expectedLatestExecutionId: latest })
  return { custom, owner, storage, receipts, port, input, get config() { return config },
    exit: () => { state = 'exited'; accept({ type: 'process-state', state: 'exited', exitCode: 0, run: { runId: 'exact-tool-run' } } as any) },
    begin: () => { state = 'running'; bytes = Buffer.alloc(0); finalBytes = 0 },
    final: (text: string, barrier = Buffer.byteLength(text)) => { bytes = Buffer.from(text); finalBytes = barrier },
    liveBytes: (data: Uint8Array, startByte: number) => accept({ type: 'terminal-output', run: { runId: 'exact-tool-run' }, dataBytes: data,
      evidence: { outputByteRange: { startByte, endByte: startByte + data.byteLength } } } as any) }
}

describe('custom Toolkit owner admission and terminal facts', () => {
  it('keeps get/watch read-only and captures an extremely fast script final snapshot without LF or recursive attach', async () => {
    const f = fixture(), seen = vi.fn()
    const reader = await f.custom.subscribe('quota', seen, vi.fn(), new AbortController().signal)
    expect((await f.custom.get('quota')).latestConfirmed).toBeNull()
    expect(f.port.create).not.toHaveBeenCalled(); expect(seen).toHaveBeenCalledOnce()
    const input = f.input(), value = await f.custom.run('quota', input, new AbortController().signal)
    expect(value).toMatchObject({ kind: 'script', state: 'succeeded', admission: null,
      latestConfirmed: { invocationId: input.invocationId, text: '工具_ACK', exitCode: 0, definition: { revision: 'author-1' } } })
    expect(f.port.attach).toHaveBeenCalledTimes(1); expect(f.port.remove).toHaveBeenCalledTimes(1)
    expect(parseToolkitSnapshot(value)).toEqual(value)
    await f.custom.run('quota', input, new AbortController().signal)
    expect(f.port.create).toHaveBeenCalledTimes(1)
    reader.dispose(); await f.custom.dispose()
  })
  it('waits for admission durability before create and confirms durability before exact removal', async () => {
    const f = fixture(), admission = deferred(), result = deferred()
    let saves = 0
    f.storage.save.mockImplementation(async (id, value) => {
      saves++; if (saves === 1) await admission.promise; if (saves === 3) await result.promise
      f.receipts.set(id, structuredClone(value))
    })
    const running = f.custom.run('quota', f.input(), new AbortController().signal)
    await flush(); expect(f.port.create).not.toHaveBeenCalled()
    await expect(f.owner.update(current => ({ ...current, toolkit: { ...current.toolkit, tools: [] } }))).rejects.toMatchObject({ code: 'SETTING_RESOURCE_IN_USE' })
    admission.release(); await flush()
    expect(f.port.create).toHaveBeenCalledTimes(1); expect(f.port.remove).not.toHaveBeenCalled()
    result.release(); await running
    expect(f.port.remove).toHaveBeenCalledTimes(1); expect(saves).toBe(4)
    await f.owner.update(current => ({ ...current, toolkit: { ...current.toolkit, tools: [] } }))
    expect(f.config.toolkit.tools).toEqual([])
  })
  it('captures configuration only after a prior durable delete completes, rather than admitting its old target', async () => {
    const f = fixture(), saving = deferred()
    const save = (f.owner as any).ports.save
    save.mockImplementation(async (next: any) => { await saving.promise; return next })
    const deleting = f.owner.update(current => ({ ...current, toolkit: { ...current.toolkit, tools: [] } }))
    await flush()
    const running = f.custom.run('quota', f.input(), new AbortController().signal)
    // Attach rejection immediately; this is a real outcome, not an unhandled setup error.
    const rejected = expect(running).rejects.toMatchObject({ code: 'SETTING_RESOURCE_NOT_FOUND' })
    await flush(); expect(f.port.create).not.toHaveBeenCalled()
    saving.release(); await deleting; await rejected
    expect(f.port.create).not.toHaveBeenCalled(); expect(f.storage.save).not.toHaveBeenCalled()
  })
  it('uses terminal replay as final byte barrier when exit precedes tail bytes and flushes split UTF8', async () => {
    const f = fixture('', 'running')
    await f.custom.run('quota', f.input(), new AbortController().signal)
    const bytes = Buffer.from('末尾_ACK')
    f.liveBytes(bytes.subarray(0, 1), 0)
    f.final('末尾_ACK'); f.exit(); await flush()
    const value = await f.custom.get('quota')
    expect(value).toMatchObject({ state: 'succeeded', latestConfirmed: { text: '末尾_ACK', exitCode: 0 }, admission: null })
    expect(f.port.replay).toHaveBeenCalledTimes(1); expect(f.port.attach).toHaveBeenCalledTimes(1)
  })
  it('refuses guessed completion when authoritative terminal byte barrier is beyond received replay', async () => {
    const f = fixture('', 'running')
    await f.custom.run('quota', f.input(), new AbortController().signal)
    f.final('tail', 99); f.exit(); await flush()
    expect(await f.custom.get('quota')).toMatchObject({ state: 'unknown', latestConfirmed: null, reason: expect.stringContaining('incomplete') })
    expect(f.port.remove).not.toHaveBeenCalled()
  })
  it('keeps the prior confirmed result and exact new admission if exit0 result durability fails, without blocking ordinary prefs', async () => {
    const f = fixture('first')
    const first = await f.custom.run('quota', f.input(), new AbortController().signal)
    expect(first.latestConfirmed?.text).toBe('first')
    f.storage.save.mockRejectedValueOnce(new Error('admission durable unknown'))
    await expect(f.custom.run('quota', f.input(first.latestConfirmed!.executionId), new AbortController().signal)).rejects.toThrow('admission durable unknown')
    expect(await f.custom.get('quota')).toMatchObject({ state: 'unknown', latestConfirmed: { text: 'first' } })
    expect(f.port.create).toHaveBeenCalledTimes(1)
    await f.owner.update(current => ({ ...current, copyPathsAsAbsolute: !current.copyPathsAsAbsolute }))
    expect(f.config.copyPathsAsAbsolute).toBe(!DEFAULT_CONFIG.copyPathsAsAbsolute)
  })
  it('retains old confirmed output when a later exit0 cannot publish durable confirmation', async () => {
    const f = fixture('first'), first = await f.custom.run('quota', f.input(), new AbortController().signal)
    f.final('second')
    let nextWrites = 0
    f.storage.save.mockImplementation(async (id, value) => {
      if (++nextWrites === 3) throw new Error('confirm-write-failed')
      f.receipts.set(id, structuredClone(value))
    })
    const value = await f.custom.run('quota', f.input(first.latestConfirmed!.executionId), new AbortController().signal)
    expect(value).toMatchObject({ state: 'unknown', latestConfirmed: { text: 'first' }, admission: { run: { runId: 'exact-tool-run' } } })
    expect(f.port.create).toHaveBeenCalledTimes(2); expect(f.port.remove).toHaveBeenCalledTimes(1)
  })
  it('does not stop a manual script on reader close, and rejects stale retained invocation after the next execution', async () => {
    const f = fixture('', 'running'), reader = await f.custom.subscribe('quota', vi.fn(), vi.fn(), new AbortController().signal)
    const one = f.input(); const running = await f.custom.run('quota', one, new AbortController().signal)
    expect(running.admission?.state).toBe('running')
    reader.dispose(); expect(f.port.stop).not.toHaveBeenCalled()
    f.final('one'); f.exit(); await flush()
    const first = await f.custom.get('quota')
    expect(first.latestConfirmed?.text).toBe('one')
    f.final('two')
    await f.custom.run('quota', f.input(first.latestConfirmed!.executionId), new AbortController().signal)
    await expect(f.custom.run('quota', one, new AbortController().signal)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
    expect(f.port.create).toHaveBeenCalledTimes(2)
  })
  it('does no snapshot cloning for unobserved output, while get keeps accumulated text and sequence', async () => {
    const f = fixture('', 'running')
    await f.custom.run('quota', f.input(), new AbortController().signal)
    const clone = vi.spyOn(globalThis, 'structuredClone')
    clone.mockClear()
    f.liveBytes(Buffer.from('one'), 0); f.liveBytes(Buffer.from('two'), 3); f.liveBytes(Buffer.from('three'), 6)
    expect(clone).not.toHaveBeenCalled()
    const value = await f.custom.get('quota')
    expect(value.admission?.text).toBe('onetwothree'); expect(value.sequence).toBeGreaterThanOrEqual(5)
    expect(clone).toHaveBeenCalledTimes(1)
    clone.mockRestore()
    await f.custom.dispose()
  })

  it('does not reinterpret an old persisted execution as a deleted and recreated tool definition', async () => {
    const f = fixture('old'), input = f.input(), original = await f.custom.run('quota', input, new AbortController().signal)
    await f.owner.update(current => ({ ...current, toolkit: { ...current.toolkit, tools: [] } }))
    await f.owner.update(current => ({ ...current, toolkit: { ...current.toolkit, tools: [structuredClone(tool)] } }))
    expect(f.config.toolkit.tools[0]!.revision).not.toBe('author-1')
    const value = await f.custom.get('quota')
    expect(value.latestConfirmed?.definition.revision).toBe('author-1')
    expect(value.definition.revision).not.toBe(value.latestConfirmed?.definition.revision)
    await expect(f.custom.run('quota', input, new AbortController().signal)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
    expect(f.port.create).toHaveBeenCalledTimes(1)
    expect(value.latestConfirmed?.executionId).toBe(original.latestConfirmed?.executionId)
    await f.custom.dispose()
  })
  it('keeps encoded error text bounded so an unconfirmed tool still has a valid public snapshot', async () => {
    const f = fixture()
    f.storage.read.mockRejectedValueOnce(new Error('\0'.repeat(2000)))
    const value = await f.custom.get('quota')
    expect(value.state).toBe('unknown')
    expect(parseToolkitSnapshot(value)).toEqual(value)
    expect(f.port.create).not.toHaveBeenCalled()
    await f.owner.update(current => ({ ...current, copyPathsAsAbsolute: !current.copyPathsAsAbsolute }))
    expect(f.config.copyPathsAsAbsolute).toBe(!DEFAULT_CONFIG.copyPathsAsAbsolute)
  })
  it('confirms a fast complete over-budget output as failed with a bounded prefix and retires only its exact Run', async () => {
    const f = fixture('\u0001'.repeat(10_000))
    const value = await f.custom.run('quota', f.input(), new AbortController().signal)
    expect(value).toMatchObject({ state: 'failed', admission: null, latestConfirmed: { state: 'failed', reason: expect.stringContaining('budget') } })
    expect(value.latestConfirmed!.text.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(JSON.stringify(value.latestConfirmed!.text))).toBeLessThanOrEqual(48 * 1024)
    expect(parseToolkitSnapshot(value)).toEqual(value)
    expect(f.port.remove).toHaveBeenCalledWith({ runId: 'exact-tool-run' })
    expect(f.port.remove).toHaveBeenCalledOnce()
  })
  it('confirms terminal decoder flush failure only after the exact complete byte barrier', async () => {
    const f = fixture('', 'running')
    await f.custom.run('quota', f.input(), new AbortController().signal)
    f.liveBytes(Buffer.from([0xe4]), 0)
    f.final('', 1); f.exit(); await flush()
    const value = await f.custom.get('quota')
    expect(value).toMatchObject({ state: 'failed', admission: null, latestConfirmed: { state: 'failed', text: '' } })
    expect(parseToolkitSnapshot(value)).toEqual(value)
    expect(f.port.remove).toHaveBeenCalledOnce()
  })
  it('watch restores only the exact saved Run attachment and never creates a replacement execution', async () => {
    const f = fixture('', 'running')
    const started = await f.custom.run('quota', f.input(), new AbortController().signal)
    expect(started.admission?.run).toEqual({ hostId: 'local', runId: 'exact-tool-run' })
    const restored = new CustomToolkitOwner({ config: f.owner, receipts: f.storage, openRunPort: async () => f.port, runner: process.execPath, env: {} })
    const seen = vi.fn(), reader = await restored.subscribe('quota', seen, vi.fn(), new AbortController().signal)
    expect(seen).toHaveBeenCalledOnce()
    expect(seen.mock.calls[0]![0]).toMatchObject({ state: 'running', admission: { executionId: started.admission!.executionId } })
    expect(f.port.create).toHaveBeenCalledOnce()
    expect(f.port.attach).toHaveBeenCalledTimes(2)
    reader.dispose(); expect(f.port.stop).not.toHaveBeenCalled()
    f.final('recovered_ACK'); f.exit(); await flush()
    expect(await restored.get('quota')).toMatchObject({ state: 'succeeded', admission: null, latestConfirmed: { text: 'recovered_ACK' } })
    expect(f.port.create).toHaveBeenCalledOnce()
    await restored.dispose()
  })
  it('reattaches the same Run if Stop released its stream before terminal metadata, without guessing completion', async () => {
    const f = fixture('', 'running')
    const started = await f.custom.run('quota', f.input(), new AbortController().signal)
    f.port.stop = vi.fn(async () => {})
    const stopping = await f.custom.stop('quota', started.admission!.executionId)
    expect(stopping.admission?.state).toBe('stopping')
    expect(f.port.attach).toHaveBeenCalledTimes(2)
    expect(f.port.remove).not.toHaveBeenCalled()
    expect(f.port.create).toHaveBeenCalledOnce()
    f.final('last_ACK'); f.exit(); await flush()
    expect(await f.custom.get('quota')).toMatchObject({ state: 'stopped', admission: null, latestConfirmed: { text: 'last_ACK' } })
    expect(f.port.remove).toHaveBeenCalledOnce()
  })
  it('waits for held admission save during disposal and never creates a late Run after the owner closes', async () => {
    const f = fixture(), held = deferred()
    let writes = 0, closed = false
    f.storage.save.mockImplementation(async (id, receipt) => {
      if (++writes === 1) await held.promise
      f.receipts.set(id, structuredClone(receipt))
    })
    const running = f.custom.run('quota', f.input(), new AbortController().signal)
    await flush(); expect(writes).toBe(1); expect(f.port.create).not.toHaveBeenCalled()
    const disposing = f.custom.dispose().then(() => { closed = true })
    await flush(); expect(closed).toBe(false)
    held.release(); const [value] = await Promise.all([running, disposing])
    expect(closed).toBe(true)
    expect(value).toMatchObject({ state: 'stopped', admission: null, latestConfirmed: { run: null, state: 'stopped', reason: expect.stringContaining('before') } })
    expect(f.port.create).not.toHaveBeenCalled()
    expect(f.port.remove).not.toHaveBeenCalled()
  })
  it.each(['release', 'remove'] as const)('waits for held exact %s cleanup even after output has ended', async method => {
    const f = fixture(), held = deferred()
    f.port[method] = vi.fn(async () => { await held.promise })
    let closed = false
    const running = f.custom.run('quota', f.input(), new AbortController().signal)
    await flush(); expect(f.port[method]).toHaveBeenCalledOnce()
    const disposing = f.custom.dispose().then(() => { closed = true })
    await flush(); expect(closed).toBe(false)
    held.release(); await Promise.all([running, disposing])
    expect(closed).toBe(true)
    expect((await f.custom.get('quota')).admission).toBeNull()
    expect(f.port.remove).toHaveBeenCalledOnce()
    expect(f.port.stop).not.toHaveBeenCalled()
  })
  it('queries one exact final replay if exit occurs inside attach but its returned snapshot is still running', async () => {
    const f = fixture('', 'running')
    f.port.attach = vi.fn(async () => {
      f.exit()
      return { run: { runId: 'exact-tool-run', kind: 'terminal', state: 'running', latestOutputBytes: 0 }, replay: [], gap: null } as AgentMuxRunAttachment
    })
    f.final('tail_ACK')
    const value = await f.custom.run('quota', f.input(), new AbortController().signal)
    expect(value).toMatchObject({ state: 'succeeded', admission: null, latestConfirmed: { text: 'tail_ACK' } })
    expect(f.port.attach).toHaveBeenCalledOnce()
    expect(f.port.replay).toHaveBeenCalledOnce()
  })
  it('an explicit query retries only the failed recovery attachment and keeps the saved Run identity', async () => {
    const f = fixture('', 'running')
    const first = await f.custom.run('quota', f.input(), new AbortController().signal)
    const originalAttach = f.port.attach
    f.port.attach = vi.fn().mockRejectedValueOnce(new Error('owned-attach-unavailable')).mockImplementation(async (_ref, _after, listener) => {
      // Reuse the production-shape replay and install only the new exact observer.
      return await originalAttach(_ref, _after, listener)
    })
    const restored = new CustomToolkitOwner({ config: f.owner, receipts: f.storage, openRunPort: async () => f.port, runner: process.execPath, env: {} })
    expect(await restored.get('quota')).toMatchObject({ state: 'unknown', admission: { run: first.admission!.run } })
    expect(f.port.release).toHaveBeenCalledOnce()
    expect(await restored.get('quota')).toMatchObject({ state: 'running', admission: { executionId: first.admission!.executionId } })
    expect(f.port.attach).toHaveBeenCalledTimes(2)
    expect(f.port.create).toHaveBeenCalledOnce()
    await restored.stop('quota', first.admission!.executionId)
    expect(f.port.stop).toHaveBeenCalledWith({ runId: 'exact-tool-run' })
    await restored.dispose()
  })
  it('a failed recovery port can be checked again and exact-stopped without recreating the saved script', async () => {
    const f = fixture('', 'running')
    const first = await f.custom.run('quota', f.input(), new AbortController().signal)
    const open = vi.fn().mockRejectedValueOnce(new Error('owned-port-unavailable')).mockResolvedValue(f.port)
    const restored = new CustomToolkitOwner({ config: f.owner, receipts: f.storage, openRunPort: open, runner: process.execPath, env: {} })
    expect(await restored.get('quota')).toMatchObject({ state: 'unknown', admission: { run: first.admission!.run } })
    const value = await restored.stop('quota', first.admission!.executionId)
    expect(value).toMatchObject({ state: 'stopped', admission: null })
    expect(f.port.stop).toHaveBeenCalledWith({ runId: 'exact-tool-run' })
    expect(f.port.create).toHaveBeenCalledOnce()
    await restored.dispose()
  })
  it('disposal waits for held recovery and stops only the saved exact Run after the port is ready', async () => {
    const f = fixture('', 'running'), held = deferred()
    await f.custom.run('quota', f.input(), new AbortController().signal)
    const restored = new CustomToolkitOwner({ config: f.owner, receipts: f.storage, openRunPort: async () => { await held.promise; return f.port }, runner: process.execPath, env: {} })
    const checking = restored.get('quota')
    await flush()
    let closed = false
    const disposing = restored.dispose().then(() => { closed = true })
    await flush(); expect(closed).toBe(false); expect(f.port.stop).not.toHaveBeenCalled()
    held.release(); await Promise.all([checking, disposing])
    expect(closed).toBe(true)
    expect(f.port.stop).toHaveBeenCalledWith({ runId: 'exact-tool-run' })
    expect(f.port.create).toHaveBeenCalledOnce()
    expect(f.port.remove).toHaveBeenCalledOnce()
    expect((await restored.get('quota')).admission).toBeNull()
  })
  it('disposal waits for the complete held recovery attachment before exact stop and removal', async () => {
    const f = fixture('', 'running'), held = deferred(), events: string[] = []
    await f.custom.run('quota', f.input(), new AbortController().signal)
    const originalAttach = f.port.attach
    f.port.attach = vi.fn(async (target, after, listener) => {
      events.push('attach-start')
      const value = await originalAttach(target, after, listener)
      await held.promise
      events.push('attach-return')
      return value
    })
    f.port.release = vi.fn(async () => { events.push('release') })
    f.port.remove = vi.fn(async () => { events.push('remove') })
    const restored = new CustomToolkitOwner({ config: f.owner, receipts: f.storage, openRunPort: async () => f.port, runner: process.execPath, env: {} })
    const checking = restored.get('quota')
    await flush(); expect(f.port.attach).toHaveBeenCalledOnce()
    let closed = false
    const disposing = restored.dispose().then(() => { closed = true; events.push('disposed') })
    await flush()
    const returnedEarly = closed, stopsBeforeAttach = vi.mocked(f.port.stop).mock.calls.length
    held.release(); await Promise.all([checking, disposing])
    expect(returnedEarly).toBe(false)
    expect(stopsBeforeAttach).toBe(0)
    expect(events).toEqual(['attach-start', 'attach-return', 'release', 'remove', 'disposed'])
    expect(f.port.stop).toHaveBeenCalledWith({ runId: 'exact-tool-run' })
    expect(f.port.create).toHaveBeenCalledOnce()
    expect((await restored.get('quota')).admission).toBeNull()
  })
  it('disposal waits for failed recovery attachment release without removing its unconfirmed Run', async () => {
    const f = fixture('', 'running'), held = deferred()
    const started = await f.custom.run('quota', f.input(), new AbortController().signal)
    f.port.attach = vi.fn(async () => { throw new Error('owned-recovery-attach-failed') })
    f.port.release = vi.fn().mockImplementationOnce(async () => { await held.promise }).mockResolvedValue(undefined)
    const restored = new CustomToolkitOwner({ config: f.owner, receipts: f.storage, openRunPort: async () => f.port, runner: process.execPath, env: {} })
    const checking = restored.get('quota')
    await flush(); expect(f.port.release).toHaveBeenCalledOnce()
    let closed = false
    const disposing = restored.dispose().then(() => { closed = true })
    await flush()
    const returnedEarly = closed, stopsBeforeRelease = vi.mocked(f.port.stop).mock.calls.length
    held.release(); await Promise.all([checking, disposing])
    expect(returnedEarly).toBe(false)
    expect(stopsBeforeRelease).toBe(0)
    expect(f.port.release).toHaveBeenCalledOnce()
    expect(f.port.remove).not.toHaveBeenCalled()
    expect(await restored.get('quota')).toMatchObject({ state: 'unknown', admission: { run: started.admission!.run } })
    expect(f.port.create).toHaveBeenCalledOnce()
  })
  it('a throwing reader end cannot turn a ConfigOwner publication into a false failure or stop other readers', async () => {
    const f = fixture(), ended = vi.fn()
    await f.custom.subscribe('quota', vi.fn(), () => { throw new Error('reader-gone') }, new AbortController().signal)
    await f.custom.subscribe('quota', vi.fn(), ended, new AbortController().signal)
    const saved = await f.owner.update(current => ({ ...current, toolkit: { ...current.toolkit, tools: [] } }))
    expect(saved.toolkit!.tools).toEqual([])
    expect(f.config.toolkit.tools).toEqual([])
    expect(ended).toHaveBeenCalledOnce()
    await f.owner.update(current => ({ ...current, copyPathsAsAbsolute: !current.copyPathsAsAbsolute }))
    expect(f.config.copyPathsAsAbsolute).toBe(!DEFAULT_CONFIG.copyPathsAsAbsolute)
    expect(f.port.create).not.toHaveBeenCalled()
  })
  it('a throwing reader end does not interrupt owned disposal or the other reader notification', async () => {
    const f = fixture('', 'running'), ended = vi.fn()
    await f.custom.subscribe('quota', vi.fn(), () => { throw new Error('reader-gone') }, new AbortController().signal)
    await f.custom.subscribe('quota', vi.fn(), ended, new AbortController().signal)
    await f.custom.run('quota', f.input(), new AbortController().signal)
    await f.custom.dispose()
    expect(ended).toHaveBeenCalledOnce()
    expect(f.port.stop).toHaveBeenCalledOnce()
    expect(f.port.remove).toHaveBeenCalledOnce()
    expect((await f.custom.get('quota')).admission).toBeNull()
  })
  it('rejects a late reader after a held receipt read crosses owner disposal', async () => {
    const f = fixture(), held = deferred(), seen = vi.fn()
    f.storage.read.mockImplementation(async () => { await held.promise; return null })
    const opening = f.custom.subscribe('quota', seen, vi.fn(), new AbortController().signal)
    const rejected = expect(opening).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
    await flush(); expect(f.storage.read).toHaveBeenCalledOnce()
    await f.custom.dispose()
    held.release(); await rejected
    expect(seen).not.toHaveBeenCalled()
    expect((await f.custom.get('quota')).consumerCount).toBe(0)
    expect(f.port.create).not.toHaveBeenCalled()
  })
  it('merges a UI preference authored before Toolkit existed without dropping a concurrently added script', async () => {
    const f = fixture(), before = structuredClone(DEFAULT_CONFIG)
    const saved = await f.owner.edit(before, { ...before, toolkit: { performance: { enabled: false } } })
    expect(saved.toolkit?.performance?.enabled).toBe(false)
    expect(saved.toolkit?.tools).toEqual([tool])
    expect(f.port.create).not.toHaveBeenCalled()
  })
  it('maps Toolkit expected conflicts to the public AgentMuxError without changing durable configuration', async () => {
    const f = fixture(), before = structuredClone(f.config)
    for (const request of [
      { operation: 'toolkit.update' as const, changes: { name: 'Changed' }, expected: { name: 'Stale' } },
      { operation: 'toolkit.remove' as const, expected: { ...toolkitFields(tool), name: 'Stale' } }
    ]) {
      const error = await executeToolkitConfig({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID(), toolId: 'quota', ...request }, f.owner).catch(error => error)
      expect(error).toBeInstanceOf(AgentMuxError)
      expect(error).toMatchObject({ code: 'CONFIG_CONFLICT' })
      expect(f.config).toEqual(before)
    }
    expect(f.storage.save).not.toHaveBeenCalled()
    expect(f.port.create).not.toHaveBeenCalled()
  })
  it('maps Main Toolkit schema rejection to INVALID_SETTING_VALUE without changing configuration', async () => {
    const f = fixture(), before = structuredClone(f.config)
    const error = await executeToolkitConfig({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID(),
      operation: 'toolkit.update', toolId: 'quota', changes: { icon: 'unavailable-icon' } }, f.owner).catch(error => error)
    expect(error).toBeInstanceOf(AgentMuxError)
    expect(error).toMatchObject({ code: 'INVALID_SETTING_VALUE' })
    expect(f.config).toEqual(before)
    expect(f.port.create).not.toHaveBeenCalled()
  })
  it('preserves an unknown Toolkit persistence error instead of claiming a typed validation result', async () => {
    const f = fixture(), before = structuredClone(f.config), failure = new Error('owned-durable-write-failed')
    ;(f.owner as any).ports.save.mockRejectedValueOnce(failure)
    await expect(executeToolkitConfig({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID(),
      operation: 'toolkit.update', toolId: 'quota', changes: { name: 'Changed' } }, f.owner)).rejects.toBe(failure)
    expect(f.config).toEqual(before)
    expect(f.port.create).not.toHaveBeenCalled()
  })
  it('reconstructs a persisted nonempty cleanup-pending result from exact replay without duplicating its text', async () => {
    const f = fixture('known_ACK')
    f.port.remove = vi.fn().mockRejectedValueOnce(new Error('owned-remove-unavailable')).mockResolvedValue(undefined)
    const original = await f.custom.run('quota', f.input(), new AbortController().signal)
    expect(original).toMatchObject({ state: 'unknown', admission: { text: 'known_ACK' }, latestConfirmed: { text: 'known_ACK' } })
    expect(f.receipts.get('quota')).toMatchObject({ admission: { text: 'known_ACK' }, latestConfirmed: { text: 'known_ACK' } })
    const restored = new CustomToolkitOwner({ config: f.owner, receipts: f.storage, openRunPort: async () => f.port, runner: process.execPath, env: {},
      now: () => original.latestConfirmed!.endedAt + 1000 })
    const value = await restored.get('quota')
    expect(value.latestConfirmed?.text).toBe('known_ACK')
    expect(value.latestConfirmed?.executionId).toBe(original.latestConfirmed!.executionId)
    expect(value.latestConfirmed).toEqual(original.latestConfirmed)
    expect(value.admission).toBeNull()
    expect(f.port.attach).toHaveBeenLastCalledWith({ runId: 'exact-tool-run' }, 0, expect.any(Function))
    expect(f.port.create).toHaveBeenCalledOnce()
  })
  it('retains known persisted text and the confirmed result while recovery replay is held or fails', async () => {
    const f = fixture('known_ACK'), held = deferred()
    f.port.remove = vi.fn().mockRejectedValueOnce(new Error('owned-remove-unavailable')).mockResolvedValue(undefined)
    const original = await f.custom.run('quota', f.input(), new AbortController().signal)
    f.port.attach = vi.fn(async (_target, _after, listener) => {
      listener?.({ type: 'terminal-output', run: { runId: 'exact-tool-run' }, dataBytes: Buffer.from('known_ACK'),
        evidence: { outputByteRange: { startByte: 0, endByte: 9 } } } as any)
      await held.promise
      throw new Error('owned-attachment-unconfirmed')
    })
    const restored = new CustomToolkitOwner({ config: f.owner, receipts: f.storage, openRunPort: async () => f.port, runner: process.execPath, env: {} })
    const checking = restored.get('quota')
    await flush()
    const during = await restored.get('quota')
    held.release(); const failed = await checking
    expect(during.admission?.text).toBe('known_ACK')
    expect(failed).toMatchObject({ state: 'unknown', admission: { text: 'known_ACK', run: original.admission!.run } })
    expect(failed.latestConfirmed).toEqual(original.latestConfirmed)
    expect(f.port.remove).toHaveBeenCalledOnce()
    expect(f.port.create).toHaveBeenCalledOnce()
  })
  it('refuses inconsistent recovered replay without replacing a known partial or confirmed fact', async () => {
    const f = fixture('known_ACK')
    f.port.remove = vi.fn().mockRejectedValueOnce(new Error('owned-remove-unavailable')).mockResolvedValue(undefined)
    const original = await f.custom.run('quota', f.input(), new AbortController().signal)
    f.final('wrong_ACK')
    const restored = new CustomToolkitOwner({ config: f.owner, receipts: f.storage, openRunPort: async () => f.port, runner: process.execPath, env: {} })
    const value = await restored.get('quota')
    expect(value).toMatchObject({ state: 'unknown', admission: { text: 'known_ACK', run: original.admission!.run } })
    expect(value.latestConfirmed).toEqual(original.latestConfirmed)
    expect(f.port.remove).toHaveBeenCalledOnce()
    expect(f.port.create).toHaveBeenCalledOnce()
  })

})

describe('saved Toolkit actions share captured admission and Raw execution', () => {
  const refresh = { id: 'refresh', label: 'Refresh', script: "console.log('action_ACK')", args: ['captured-arg'] }
  const input = (definition: ToolkitToolDefinition, sourceExecutionId: string): ToolkitActionInput => ({ invocationId: randomUUID(),
    expectedRevision: definition.revision, sourceExecutionId, expectedAdmissionExecutionId: null })
  it('executes only the saved action program without changing the main definition, and retains the exact invocation', async () => {
    const f = fixture('main_ACK', 'exited', { ...tool, actions: [refresh] })
    const first = await f.custom.run('quota', f.input(), new AbortController().signal)
    const request = input(f.config.toolkit.tools[0]!, first.latestConfirmed!.executionId)
    f.final('action_ACK')
    const value = await f.custom.action('quota', 'refresh', request, new AbortController().signal)
    expect(value.latestConfirmed?.executionId).not.toBe(first.latestConfirmed!.executionId)
    expect(value.latestConfirmed).toMatchObject({ action: { id: 'refresh', sourceExecutionId: request.sourceExecutionId,
      expectedAdmissionExecutionId: null }, definition: { script: tool.script, actions: [refresh] }, text: 'action_ACK' })
    expect(vi.mocked(f.port.create).mock.calls[1]![0].args).toEqual(['--input-type=module', '--eval', refresh.script, '--', 'captured-arg'])
    expect(parseToolkitSnapshot(value)).toEqual(value)
    expect((await f.custom.action('quota', 'refresh', request, new AbortController().signal)).latestConfirmed).toEqual(value.latestConfirmed)
    expect(f.port.create).toHaveBeenCalledTimes(2)
    await expect(f.custom.action('quota', 'refresh', { ...request, expectedAdmissionExecutionId: 'another-baseline' }, new AbortController().signal)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
    await expect(f.custom.run('quota', { invocationId: request.invocationId, expectedRevision: request.expectedRevision,
      expectedLatestExecutionId: request.sourceExecutionId }, new AbortController().signal)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
    expect(f.port.create).toHaveBeenCalledTimes(2)
  })
  it('rejects a retained action after another admission replaces its baseline, and rejects the forgotten request after a later result', async () => {
    const f = fixture('main', 'exited', { ...tool, actions: [refresh] })
    const first = await f.custom.run('quota', f.input(), new AbortController().signal)
    const request = input(f.config.toolkit.tools[0]!, first.latestConfirmed!.executionId)
    const action = await f.custom.action('quota', 'refresh', request, new AbortController().signal)
    f.begin()
    await f.custom.run('quota', f.input(action.latestConfirmed!.executionId), new AbortController().signal)
    const staleResult = await f.custom.action('quota', 'refresh', request, new AbortController().signal).then(() => null, error => error)
    expect(staleResult).toMatchObject({ code: 'CONFIG_CONFLICT' })
    expect(f.port.create).toHaveBeenCalledTimes(3)
    f.final('new_result'); f.exit(); await flush()
    await expect(f.custom.action('quota', 'refresh', request, new AbortController().signal)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
    expect(f.port.create).toHaveBeenCalledTimes(3)
  })
  it('returns the same unknown admission for an exact repeated action without creating a second Run', async () => {
    const f = fixture('main', 'exited', { ...tool, actions: [refresh] })
    const first = await f.custom.run('quota', f.input(), new AbortController().signal)
    const request = input(f.config.toolkit.tools[0]!, first.latestConfirmed!.executionId)
    f.port.create = vi.fn().mockRejectedValueOnce(new Error('owned-create-outcome-unconfirmed'))
    const unknown = await f.custom.action('quota', 'refresh', request, new AbortController().signal)
    expect(unknown).toMatchObject({ state: 'unknown', latestConfirmed: first.latestConfirmed,
      admission: { invocationId: request.invocationId, action: { id: 'refresh' } } })
    expect(await f.custom.action('quota', 'refresh', request, new AbortController().signal)).toEqual(unknown)
    expect(f.port.create).toHaveBeenCalledOnce()
    await expect(f.custom.action('quota', 'other', request, new AbortController().signal)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
    expect(f.port.create).toHaveBeenCalledOnce()
  })
  it('rejects actions from stale configuration and same-config replaced results without changing admission', async () => {
    const f = fixture('main', 'exited', { ...tool, actions: [refresh] })
    const first = await f.custom.run('quota', f.input(), new AbortController().signal)
    const request = input(f.config.toolkit.tools[0]!, first.latestConfirmed!.executionId)
    await f.custom.run('quota', f.input(first.latestConfirmed!.executionId), new AbortController().signal)
    await expect(f.custom.action('quota', 'refresh', request, new AbortController().signal)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
    const latest = (await f.custom.get('quota')).latestConfirmed!
    const beforeEdit = input(f.config.toolkit.tools[0]!, latest.executionId)
    await f.owner.update(current => ({ ...current, toolkit: { ...current.toolkit,
      tools: [{ ...current.toolkit!.tools![0]!, workspacePath: '/different-target' }] } }))
    const staleTarget = await f.custom.action('quota', 'refresh', beforeEdit, new AbortController().signal).then(() => null, error => error)
    expect(staleTarget).toMatchObject({ code: 'CONFIG_CONFLICT' })
    expect(f.port.create).toHaveBeenCalledTimes(2)
    expect((await f.custom.get('quota')).admission).toBeNull()
  })
  it('never turns result text into an action program', async () => {
    const f = fixture(JSON.stringify({ actions: [refresh] }))
    const first = await f.custom.run('quota', f.input(), new AbortController().signal)
    const missing = await f.custom.action('quota', 'refresh', input(f.config.toolkit.tools[0]!, first.latestConfirmed!.executionId), new AbortController().signal).then(() => null, error => error)
    expect(missing).toMatchObject({ code: 'SETTING_RESOURCE_NOT_FOUND' })
    expect(f.port.create).toHaveBeenCalledOnce()
    expect((await f.custom.get('quota')).latestConfirmed).toEqual(first.latestConfirmed)
  })
  it('compares absent and empty actions only in Toolkit authored fields without rewriting an unchanged definition', async () => {
    const { actions: _actions, ...plain } = tool
    const f = fixture('main', 'exited', plain)
    const noop = await executeToolkitConfig({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID(),
      operation: 'toolkit.update', toolId: 'quota', changes: { actions: [] }, expected: { actions: [] } }, f.owner)
    expect(noop).toMatchObject({ changed: false, definition: plain })
    expect(f.config.toolkit.tools[0]).toEqual(plain)
    const saved = await executeToolkitConfig({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID(),
      operation: 'toolkit.update', toolId: 'quota', changes: { actions: [refresh] }, expected: { actions: [] } }, f.owner)
    expect(saved).toMatchObject({ changed: true, definition: { actions: [refresh] } })
    await expect(executeToolkitConfig({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID(),
      operation: 'toolkit.update', toolId: 'quota', changes: { actions: [] }, expected: { actions: [] } }, f.owner)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
    expect(f.config.toolkit.tools[0]!.actions).toEqual([refresh])
    expect(f.port.create).not.toHaveBeenCalled()
  })
})
