const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => _hygiene_fixturePath("tmp"), getAppPath: () => process.cwd() } }))
// Text-only admission tests do not own an IPC stream; dedicated document tests use the real channel.
vi.mock('@agentmux/core/toolkit-result-channel', () => ({ openToolkitResultChannel: async () => ({ env: {}, connected: false, close: async () => {} }) }))
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
  statusBar: 'icon', workspacePath: _hygiene_fixturePath("tmp"), script: "console.log('工具_ACK')", args: [], actions: [] }
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)) }
const deferred = () => { let resolve!: () => void; return { promise: new Promise<void>(r => { resolve = r }), release: () => resolve() } }
function fixture(output = '工具_ACK', initialState: 'running' | 'exited' = 'exited', definition = tool) {
  let config = { ...structuredClone(DEFAULT_CONFIG), toolkit: { tools: [structuredClone(definition)] } }
  let custom!: CustomToolkitOwner, accept: (event: AgentMuxClientEvent) => void = () => {}
  let state = initialState, exitCode = 0, bytes = Buffer.from(output), finalBytes = bytes.byteLength
  const receipts = new Map<string, unknown>()
  const storage = { read: vi.fn(async (id: string) => receipts.get(id) ?? null), save: vi.fn(async (id: string, value: unknown) => { receipts.set(id, structuredClone(value)) }) }
  const owner = new ConfigOwner({ read: () => config,
    prepare: (current, next) => prepareToolkitConfig(current, next, id => custom.guardDelete(id)),
    save: vi.fn(async next => structuredClone(next)), publish: saved => { config = saved as typeof config; custom.configurationChanged() } })
  const run = () => ({ runId: 'exact-tool-run', kind: 'terminal', state, exitCode: state === 'exited' ? exitCode : undefined, latestOutputBytes: finalBytes })
  const snapshot = () => ({ run: run(), replay: bytes.length ? [{ startByte: 0, endByte: bytes.length, dataBytes: bytes }] : [], gap: null }) as AgentMuxRunAttachment
  const port: ToolkitRunPort = { create: vi.fn(async (_input, listener) => { accept = listener; return run() as any }),
    attach: vi.fn(async (_ref, _after, listener) => {
      if (listener) accept = listener
      // Production attach publishes state before returning replay. This cannot recurse into another attach.
      accept({ type: 'process-state', state, exitCode: state === 'exited' ? exitCode : undefined, run: { runId: 'exact-tool-run' } } as any)
      return snapshot()
    }), replay: vi.fn(async () => snapshot()),
    release: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    stop: vi.fn(async () => { state = 'exited'; accept({ type: 'process-state', state: 'exited', exitCode: 0, run: { runId: 'exact-tool-run' } } as any) }) }
  custom = new CustomToolkitOwner({ config: owner, receipts: storage, openRunPort: async () => port, runner: process.execPath, env: {} })
  const input = (latest: string | null = null): ToolkitRunInput => ({ invocationId: randomUUID(), expectedRevision: config.toolkit.tools[0]!.revision, expectedLatestExecutionId: latest })
  return { custom, owner, storage, receipts, port, input, get config() { return config },
    exit: (code = 0) => { state = 'exited'; exitCode = code; accept({ type: 'process-state', state: 'exited', exitCode: code, run: { runId: 'exact-tool-run' } } as any) },
    begin: () => { state = 'running'; bytes = Buffer.alloc(0); finalBytes = 0 },
    final: (text: string, barrier = Buffer.byteLength(text)) => { bytes = Buffer.from(text); finalBytes = barrier },
    liveBytes: (data: Uint8Array, startByte: number) => accept({ type: 'terminal-output', run: { runId: 'exact-tool-run' }, dataBytes: data,
      evidence: { outputByteRange: { startByte, endByte: startByte + data.byteLength } } } as any) }
}

describe('Toolkit display evaluation lanes', () => {
  const displayed = { ...tool, display: { script: "console.log('display_ACK')", args: [] } }
  it('keeps undeclared tools and plain watch passive', async () => {
    const f = fixture(), seen = vi.fn()
    const reader = await f.custom.subscribe(tool.id, seen, vi.fn(), new AbortController().signal, { evaluateOnDisplay: true })
    expect(f.port.create).not.toHaveBeenCalled()
    expect((await f.custom.get(tool.id)).display).toBeUndefined()
    await expect(f.custom.evaluate(tool.id, undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'SETTING_RESOURCE_NOT_FOUND' })
    reader.dispose(); await f.custom.dispose()
  })
  it('evaluates current display beside the intact original unknown admission', async () => {
    const f = fixture('current_display_ACK', 'exited', displayed)
    const old: ToolkitAdmission = { executionId: 'original-unconfirmed', invocationId: 'original-invocation', definition: tool,
      expectedLatestExecutionId: null, target: { workspacePath: tool.workspacePath }, run: null, startedAt: _reshape_fixtureEpoch(0, 0, 1), text: '', action: null, state: 'unknown', reason: 'old action unknown' }
    f.receipts.set(tool.id, { admission: old, latestConfirmed: null })
    const before = await f.custom.get(tool.id)
    const reader = await f.custom.subscribe(tool.id, vi.fn(), vi.fn(), new AbortController().signal)
    expect(f.port.create).not.toHaveBeenCalled()
    const evaluation = f.custom.evaluate(tool.id, undefined, new AbortController().signal)
    await expect(evaluation).resolves.toMatchObject({ display: { state: 'succeeded' } })
    const current = await evaluation
    expect(current.admission).toEqual(before.admission)
    expect(current.display).toMatchObject({ state: 'succeeded', admission: null, latestConfirmed: { text: 'current_display_ACK', action: null } })
    expect(f.port.create).toHaveBeenCalledOnce()
    expect((f.port.create as any).mock.calls[0][0].args).toContain(displayed.display.script)
    expect(f.receipts.get(tool.id)).toMatchObject({ admission: before.admission, display: { admission: null, latestConfirmed: { text: 'current_display_ACK' } } })
    reader.dispose(); await f.custom.dispose()
  })
  it('shares exactly one visible cycle across readers and has no hidden polling', async () => {
    const f = fixture('one_cycle', 'exited', displayed), options = { evaluateOnDisplay: true }
    const [one, two] = await Promise.all([f.custom.subscribe(tool.id, vi.fn(), vi.fn(), new AbortController().signal, options),
      f.custom.subscribe(tool.id, vi.fn(), vi.fn(), new AbortController().signal, options)])
    await flush(); expect(f.port.create).toHaveBeenCalledOnce()
    one.dispose()
    const three = await f.custom.subscribe(tool.id, vi.fn(), vi.fn(), new AbortController().signal, options)
    await flush(); expect(f.port.create).toHaveBeenCalledOnce()
    two.dispose(); three.dispose(); await flush(); expect(f.port.create).toHaveBeenCalledOnce()
    const next = await f.custom.subscribe(tool.id, vi.fn(), vi.fn(), new AbortController().signal, options)
    await flush(); expect(f.port.create).toHaveBeenCalledTimes(2)
    next.dispose(); await f.custom.dispose()
  })
  it('continues the original unknown display creation instead of admitting another identity', async () => {
    const f = fixture('retained_display', 'exited', displayed)
    ;(f.port.create as any).mockRejectedValueOnce(new Error('lost-display-create-reply'))
    const unknown = await f.custom.evaluate(tool.id, undefined, new AbortController().signal)
    expect(unknown.display).toMatchObject({ state: 'unknown', admission: { run: null } })
    const original = unknown.display!.admission!
    const resumed = await f.custom.evaluate(tool.id, undefined, new AbortController().signal)
    expect(resumed.display).toMatchObject({ state: 'succeeded', latestConfirmed: { executionId: original.executionId, invocationId: original.invocationId } })
    expect((f.port.create as any).mock.calls.map(([input]: any[]) => input.createOperationId)).toEqual([original.executionId, original.executionId])
    await f.custom.dispose()
  })
  it('retains the last successful display after a failed result and owner restart', async () => {
    const f = fixture('previous_success', 'exited', displayed)
    const success = await f.custom.evaluate(tool.id, undefined, new AbortController().signal)
    f.begin(); f.final('failed_update')
    await f.custom.evaluate(tool.id, undefined, new AbortController().signal)
    f.exit(7); await flush()
    const failure = await f.custom.get(tool.id)
    expect(failure.display).toMatchObject({ state: 'failed', lastSucceeded: success.display!.latestConfirmed, latestConfirmed: { exitCode: 7 } })
    const restored = new CustomToolkitOwner({ config: f.owner, receipts: f.storage, openRunPort: async () => f.port, runner: process.execPath, env: {} })
    expect((await restored.get(tool.id)).display).toMatchObject({ state: 'failed', lastSucceeded: failure.display!.lastSucceeded,
      latestConfirmed: failure.display!.latestConfirmed, admission: null })
    await f.custom.dispose(); await restored.dispose()
  })
  it('coalesces concurrent automatic requests before either admission is registered', async () => {
    const f = fixture('shared_current', 'exited', displayed)
    const [one, two] = await Promise.all([f.custom.evaluate(tool.id, undefined, new AbortController().signal), f.custom.evaluate(tool.id, undefined, new AbortController().signal)])
    expect(f.port.create).toHaveBeenCalledOnce()
    expect(one.display!.latestConfirmed!.executionId).toBe(two.display!.latestConfirmed!.executionId)
    await f.custom.dispose()
  })
  it('never treats an already confirmed stopped display as a success after cleanup recovery', async () => {
    const f = fixture('old_success', 'exited', displayed)
    const first = await f.custom.evaluate(tool.id, undefined, new AbortController().signal)
    f.begin(); f.final('stopped_display')
    const running = await f.custom.evaluate(tool.id, undefined, new AbortController().signal)
    ;(f.port.remove as any).mockRejectedValueOnce(new Error('exact-remove-unconfirmed'))
    await f.custom.stop(tool.id, running.display!.admission!.executionId)
    const incomplete = await f.custom.get(tool.id)
    expect(incomplete.display!.latestConfirmed!.state).toBe('stopped')
    const restored = new CustomToolkitOwner({ config: f.owner, receipts: f.storage, openRunPort: async () => f.port, runner: process.execPath, env: {} })
    const final = await restored.get(tool.id)
    expect(final.display).toMatchObject({ state: 'stopped', admission: null, lastSucceeded: first.display!.latestConfirmed })
    expect(parseToolkitSnapshot(final)).toEqual(final)
    expect((f.receipts.get(tool.id) as any).display.lastSucceeded.state).toBe('succeeded')
    await f.custom.dispose(); await restored.dispose()
  })
  it('does not let the first reader cancellation take away another visible reader evaluation', async () => {
    const f = fixture('shared_visible', 'exited', displayed), held = deferred()
    const saving = f.owner.inspect(async () => { await held.promise })
    const first = new AbortController(), second = new AbortController()
    const one = await f.custom.subscribe(tool.id, vi.fn(), vi.fn(), first.signal, { evaluateOnDisplay: true })
    const two = await f.custom.subscribe(tool.id, vi.fn(), vi.fn(), second.signal, { evaluateOnDisplay: true })
    first.abort(); held.release(); await saving; await flush()
    expect(f.port.create).toHaveBeenCalledOnce()
    expect((await f.custom.get(tool.id)).display).toMatchObject({ state: 'succeeded', latestConfirmed: { text: 'shared_visible' } })
    one.dispose(); two.dispose(); await f.custom.dispose()
  })
})

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
    expect(value.latestConfirmed?.executionId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/)
    expect(parseToolkitSnapshot(value)).toEqual(value)
    await f.custom.run('quota', input, new AbortController().signal)
    expect(f.port.create).toHaveBeenCalledTimes(1)
    reader.dispose(); await f.custom.dispose()
  })
  it('waits for admission durability before create and confirms durability before exact removal', async () => {
    const f = fixture(), admission = deferred(), result = deferred()
    let saves = 0
    f.storage.save.mockImplementation(async (id, value) => {
      saves++; if (saves === 1) await admission.promise; if (saves === 4) await result.promise
      f.receipts.set(id, structuredClone(value))
    })
    const running = f.custom.run('quota', f.input(), new AbortController().signal)
    await flush(); expect(f.port.create).not.toHaveBeenCalled()
    await expect(f.owner.update(current => ({ ...current, toolkit: { ...current.toolkit, tools: [] } }))).rejects.toMatchObject({ code: 'SETTING_RESOURCE_IN_USE' })
    admission.release(); await flush()
    expect(f.port.create).toHaveBeenCalledTimes(1); expect(f.port.remove).not.toHaveBeenCalled()
    result.release(); await running
    expect(f.port.remove).toHaveBeenCalledTimes(1); expect(saves).toBe(5)
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
  it('confirms natural completion after a rejected Stop repairs a previously failed result save', async () => {
    const f = fixture('natural_ACK')
    let saves = 0
    f.storage.save.mockImplementation(async (id, receipt) => {
      if (++saves === 4) throw new Error('result-save-failed')
      f.receipts.set(id, structuredClone(receipt))
    })
    const failedSave = await f.custom.run('quota', f.input(), new AbortController().signal)
    expect(failedSave).toMatchObject({ state: 'unknown', latestConfirmed: null, admission: { text: 'natural_ACK' } })
    const captured = failedSave.admission!
    f.port.stop = vi.fn(async () => { throw new Error('stop-not-accepted') })
    const value = await f.custom.stop('quota', captured.executionId)
    expect(value).toMatchObject({ state: 'succeeded', admission: null, latestConfirmed: {
      executionId: captured.executionId, invocationId: captured.invocationId, definition: captured.definition,
      target: captured.target, run: captured.run, text: 'natural_ACK', exitCode: 0, state: 'succeeded'
    } })
    expect(f.port.create).toHaveBeenCalledOnce()
    expect(f.port.stop).toHaveBeenCalledExactlyOnceWith({ runId: 'exact-tool-run' })
    expect(f.port.remove).toHaveBeenCalledExactlyOnceWith({ runId: 'exact-tool-run' })
  })
  it.each([0, 7])('waits for a rejected Stop submission before confirming natural exit %i', async code => {
    const f = fixture('', 'running'), decision = deferred()
    const started = await f.custom.run('quota', f.input(), new AbortController().signal)
    f.final('terminal_ACK')
    f.port.stop = vi.fn(async () => { f.exit(code); await decision.promise; throw new Error('stop-not-accepted') })
    const writesBeforeStop = f.storage.save.mock.calls.length
    const stopping = f.custom.stop('quota', started.admission!.executionId)
    await flush()
    expect(f.storage.save.mock.calls.length).toBe(writesBeforeStop)
    expect((await f.custom.get('quota')).latestConfirmed).toBeNull()
    expect(f.port.remove).not.toHaveBeenCalled()
    decision.release()
    const value = await stopping, state = code === 0 ? 'succeeded' : 'failed'
    expect(value).toMatchObject({ state, admission: null, latestConfirmed: {
      executionId: started.admission!.executionId, text: 'terminal_ACK', state, exitCode: code
    } })
    expect(f.port.create).toHaveBeenCalledOnce(); expect(f.port.stop).toHaveBeenCalledOnce()
  })
  it('shares one accepted Stop submission and confirms stopped only after its decision', async () => {
    const f = fixture('', 'running'), decision = deferred()
    const started = await f.custom.run('quota', f.input(), new AbortController().signal)
    f.final('stopped_ACK')
    f.port.stop = vi.fn(async () => { f.exit(); await decision.promise })
    const stopping = f.custom.stop('quota', started.admission!.executionId)
    const repeated = f.custom.stop('quota', started.admission!.executionId)
    await flush()
    expect((await f.custom.get('quota')).latestConfirmed).toBeNull()
    expect(f.port.stop).toHaveBeenCalledOnce(); expect(f.port.remove).not.toHaveBeenCalled()
    decision.release()
    const [first, second] = await Promise.all([stopping, repeated])
    expect(first).toMatchObject({ state: 'stopped', admission: null, latestConfirmed: { text: 'stopped_ACK', state: 'stopped' } })
    expect(second).toEqual(first); expect(f.port.remove).toHaveBeenCalledOnce()
  })
  it('keeps rejected live Stop unknown with the original error and prior result, then confirms natural exit', async () => {
    const f = fixture('prior_ACK')
    const first = await f.custom.run('quota', f.input(), new AbortController().signal)
    f.begin()
    const started = await f.custom.run('quota', f.input(first.latestConfirmed!.executionId), new AbortController().signal)
    const rejection = new Error('stop-submission-failed')
    f.port.stop = vi.fn(async () => { throw rejection })
    await expect(f.custom.stop('quota', started.admission!.executionId)).rejects.toBe(rejection)
    expect(await f.custom.get('quota')).toMatchObject({ state: 'unknown', reason: expect.stringContaining(rejection.message),
      admission: { executionId: started.admission!.executionId }, latestConfirmed: first.latestConfirmed })
    expect(f.port.remove).toHaveBeenCalledOnce(); expect(f.port.stop).toHaveBeenCalledOnce()
    expect(f.port.attach).toHaveBeenCalledTimes(3) // prior execution, original live execution, recovered observation
    f.final('natural_tail_ACK'); f.exit(); await flush()
    expect(await f.custom.get('quota')).toMatchObject({ state: 'succeeded', admission: null,
      latestConfirmed: { executionId: started.admission!.executionId, state: 'succeeded', text: 'natural_tail_ACK' } })
    expect(f.port.create).toHaveBeenCalledTimes(2); expect(f.port.stop).toHaveBeenCalledOnce()
  })
  it('preserves rejected Stop and failed replay reasons without removing an unconfirmed execution', async () => {
    const f = fixture('', 'running')
    const started = await f.custom.run('quota', f.input(), new AbortController().signal)
    const rejection = new Error('stop-submission-failed')
    f.port.stop = vi.fn(async () => { throw rejection })
    f.port.replay = vi.fn(async () => { throw new Error('final-replay-failed') })
    await expect(f.custom.stop('quota', started.admission!.executionId)).rejects.toBe(rejection)
    const value = await f.custom.get('quota')
    expect(value).toMatchObject({ state: 'unknown', admission: { executionId: started.admission!.executionId }, latestConfirmed: null })
    expect(value.reason).toContain('stop-submission-failed'); expect(value.reason).toContain('final-replay-failed')
    expect(f.port.remove).not.toHaveBeenCalled(); expect(f.port.stop).toHaveBeenCalledOnce()
    expect(f.port.attach).toHaveBeenCalledOnce()
  })
  it('does not label naturally completed output stopped when disposing after failed confirmation', async () => {
    const f = fixture('natural_ACK')
    let saves = 0
    f.storage.save.mockImplementation(async (id, receipt) => {
      if (++saves === 4) throw new Error('result-save-failed')
      f.receipts.set(id, structuredClone(receipt))
    })
    const value = await f.custom.run('quota', f.input(), new AbortController().signal)
    expect(value.state).toBe('unknown')
    f.port.stop = vi.fn(async () => { throw new Error('stop-not-accepted') })
    await f.custom.dispose()
    expect(await f.custom.get('quota')).toMatchObject({ state: 'succeeded', admission: null,
      latestConfirmed: { executionId: value.admission!.executionId, state: 'succeeded', text: 'natural_ACK' } })
    expect(f.port.create).toHaveBeenCalledOnce(); expect(f.port.remove).toHaveBeenCalledOnce()
  })
  it.each(['release', 'remove'] as const)('waits for already confirmed %s cleanup without submitting Stop', async method => {
    const f = fixture('natural_ACK'), cleanup = deferred()
    f.port[method] = vi.fn(async () => { await cleanup.promise })
    const running = f.custom.run('quota', f.input(), new AbortController().signal)
    await flush()
    const before = await f.custom.get('quota')
    expect(before).toMatchObject({ state: 'stopping', reason: 'Result confirmed; exact Run cleanup pending.',
      latestConfirmed: { state: 'succeeded', text: 'natural_ACK' } })
    expect(before.admission!.executionId).toBe(before.latestConfirmed!.executionId)
    let stopReturned = false
    const stopping = f.custom.stop('quota', before.admission!.executionId).then(value => { stopReturned = true; return value })
    await flush()
    expect(stopReturned).toBe(false); expect(f.port.stop).not.toHaveBeenCalled()
    expect(await f.custom.get('quota')).toEqual(before)
    cleanup.release()
    const [original, stopped] = await Promise.all([running, stopping])
    expect(stopped).toEqual(original)
    expect(stopped).toMatchObject({ state: 'succeeded', admission: null, latestConfirmed: before.latestConfirmed })
    expect(f.port.release).toHaveBeenCalledOnce(); expect(f.port.remove).toHaveBeenCalledOnce()
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

describe('rejected Toolkit Stop observation boundaries', () => {
  const scriptSnapshot = (value: Awaited<ReturnType<CustomToolkitOwner['get']>>) => {
    expect(value.kind).toBe('script')
    if (value.kind !== 'script') throw new Error('Expected the original script snapshot')
    return value
  }
  it.each(['unavailable', 'gap'] as const)('keeps the original Stop error and admission after %s reattachment', async kind => {
    const f = fixture('', 'running'), started = scriptSnapshot(await f.custom.run(tool.id, f.input(), new AbortController().signal))
    const rejection = new Error('original-stop-refused'), attach = f.port.attach
    f.port.stop = vi.fn(async () => { throw rejection })
    f.port.attach = vi.fn(async (...args: Parameters<ToolkitRunPort['attach']>) => {
      if (kind === 'unavailable') throw new Error('original-observation-unavailable')
      return { ...await attach(...args), gap: { firstAvailableByte: 1, requestedAfterByte: 0 } } as any
    })
    await expect(f.custom.stop(tool.id, started.admission!.executionId)).rejects.toBe(rejection)
    const value = await f.custom.get(tool.id)
    expect(value).toMatchObject({ state: 'unknown', admission: { executionId: started.admission!.executionId,
      invocationId: started.admission!.invocationId, run: started.admission!.run, definition: started.admission!.definition }, latestConfirmed: null })
    expect(value.reason).toContain(rejection.message)
    expect(value.reason).toContain(kind === 'unavailable' ? 'original-observation-unavailable' : 'Gap')
    expect(f.port.attach).toHaveBeenCalledOnce(); expect(f.port.create).toHaveBeenCalledOnce(); expect(f.port.stop).toHaveBeenCalledOnce()
    expect(f.port.remove).not.toHaveBeenCalled()
  })
  it('does not restore observation from a replay with a Gap', async () => {
    const f = fixture('', 'running'), started = scriptSnapshot(await f.custom.run(tool.id, f.input(), new AbortController().signal))
    const rejection = new Error('original-stop-refused'), replay = f.port.replay
    f.port.stop = vi.fn(async () => { throw rejection })
    f.port.replay = vi.fn(async (...args: Parameters<ToolkitRunPort['replay']>) => ({ ...await replay(...args), gap: { firstAvailableByte: 1, requestedAfterByte: 0 } } as any))
    await expect(f.custom.stop(tool.id, started.admission!.executionId)).rejects.toBe(rejection)
    expect(await f.custom.get(tool.id)).toMatchObject({ state: 'unknown', admission: { executionId: started.admission!.executionId }, latestConfirmed: null })
    expect(f.port.attach).toHaveBeenCalledOnce(); expect(f.port.remove).not.toHaveBeenCalled()
  })
  it('preserves the prior confirmed result and admission if later natural-result saving fails', async () => {
    const f = fixture('prior_ACK'), first = scriptSnapshot(await f.custom.run(tool.id, f.input(), new AbortController().signal))
    f.begin()
    const started = scriptSnapshot(await f.custom.run(tool.id, f.input(first.latestConfirmed!.executionId), new AbortController().signal))
    const rejection = new Error('original-stop-refused'), save = f.storage.save.getMockImplementation()!
    f.port.stop = vi.fn(async () => { throw rejection })
    await expect(f.custom.stop(tool.id, started.admission!.executionId)).rejects.toBe(rejection)
    f.storage.save.mockImplementation(async (id, value: any) => {
      if (value.latestConfirmed?.executionId === started.admission!.executionId) throw new Error('original-result-save-unconfirmed')
      return await save(id, value)
    })
    f.final('later_original_ACK'); f.exit(); await flush()
    expect(await f.custom.get(tool.id)).toMatchObject({ state: 'unknown', admission: { executionId: started.admission!.executionId,
      run: started.admission!.run, text: 'later_original_ACK' }, latestConfirmed: first.latestConfirmed })
    expect(f.receipts.get(tool.id)).toMatchObject({ admission: { executionId: started.admission!.executionId }, latestConfirmed: first.latestConfirmed })
    expect(f.port.create).toHaveBeenCalledTimes(2); expect(f.port.stop).toHaveBeenCalledOnce(); expect(f.port.remove).toHaveBeenCalledOnce()
  })
  it.each(['replay', 'attach'] as const)('does not borrow a replacement execution after a held %s returns', async held => {
    const f = fixture('', 'running'), started = scriptSnapshot(await f.custom.run(tool.id, f.input(), new AbortController().signal))
    const rejection = new Error('original-stop-refused'), gate = deferred(), operation = f.port[held]
    f.port.stop = vi.fn(async () => { throw rejection })
    const pending = vi.fn(async (...args: any[]) => { await gate.promise; return await (operation as any)(...args) })
    f.port[held] = pending
    const stopping = f.custom.stop(tool.id, started.admission!.executionId)
    // Attach counts include only this controlled held operation, after initial startup.
    await vi.waitFor(() => expect(pending).toHaveBeenCalledOnce())
    const original = (f.custom as any).tools.get(tool.id)
    // Controlled owner replacement exercises the asynchronous fencing boundary;
    // it does not assert that ordinary writes can bypass admission integrity.
    original.admission = { ...structuredClone(started.admission!), executionId: 'replacement-execution', text: '',
      run: { hostId: 'local', runId: 'replacement-run' } }
    original.live = (f.custom as any).execution(original, original.admission)
    const replacement = await f.custom.get(tool.id)
    f.final('old_target_ACK'); f.exit()
    gate.release()
    await expect(stopping).rejects.toBe(rejection)
    expect(await f.custom.get(tool.id)).toMatchObject({ admission: { executionId: 'replacement-execution', run: { runId: 'replacement-run' }, text: '' }, latestConfirmed: null })
    expect(await f.custom.get(tool.id)).toEqual(replacement)
    expect(f.port.release).not.toHaveBeenCalled(); expect(f.port.remove).not.toHaveBeenCalled(); expect(f.port.create).toHaveBeenCalledOnce()
  })
  it('releases only its newly acquired original observation when the owner closes during attach', async () => {
    const f = fixture('', 'running'), started = scriptSnapshot(await f.custom.run(tool.id, f.input(), new AbortController().signal))
    const rejection = new Error('original-stop-refused'), gate = deferred(), attach = f.port.attach
    f.port.stop = vi.fn(async () => { throw rejection })
    f.port.attach = vi.fn(async (...args: Parameters<ToolkitRunPort['attach']>) => { await gate.promise; return await attach(...args) })
    const stopping = f.custom.stop(tool.id, started.admission!.executionId)
    await vi.waitFor(() => expect(f.port.attach).toHaveBeenCalledOnce())
    await f.custom.dispose()
    f.final('late_closed_owner_ACK')
    gate.release()
    await expect(stopping).rejects.toBe(rejection)
    expect(f.port.release).toHaveBeenCalledExactlyOnceWith({ runId: 'exact-tool-run' })
    expect(f.port.create).toHaveBeenCalledOnce(); expect(f.port.stop).toHaveBeenCalledOnce(); expect(f.port.remove).not.toHaveBeenCalled()
    expect(await f.custom.get(tool.id)).toMatchObject({ state: 'unknown', admission: { executionId: started.admission!.executionId, run: started.admission!.run, text: '' }, latestConfirmed: null })
  })
  it('fences a replacement owner while reattachment waits for a terminal-hint replay', async () => {
    const f = fixture('', 'running'), started = scriptSnapshot(await f.custom.run(tool.id, f.input(), new AbortController().signal))
    const rejection = new Error('original-stop-refused'), gate = deferred(), replay = f.port.replay, attach = f.port.attach
    let reads = 0
    f.port.stop = vi.fn(async () => { throw rejection })
    f.port.replay = vi.fn(async (...args: Parameters<ToolkitRunPort['replay']>) => { if (++reads === 2) await gate.promise; return await replay(...args) })
    f.port.attach = vi.fn(async (...args: Parameters<ToolkitRunPort['attach']>) => { const result = await attach(...args); f.exit(); return result })
    const stopping = f.custom.stop(tool.id, started.admission!.executionId)
    await vi.waitFor(() => expect(reads).toBe(2))
    const original = (f.custom as any).tools.get(tool.id)
    original.admission = { ...structuredClone(started.admission!), executionId: 'replacement-execution', text: '', run: { hostId: 'local', runId: 'replacement-run' } }
    original.live = (f.custom as any).execution(original, original.admission)
    const replacement = await f.custom.get(tool.id)
    f.final('old_terminal_hint_ACK'); gate.release()
    await expect(stopping).rejects.toBe(rejection)
    expect(await f.custom.get(tool.id)).toEqual(replacement)
    expect(f.port.release).not.toHaveBeenCalled(); expect(f.port.remove).not.toHaveBeenCalled()
  })
  it('does not confirm an old terminal result after its Stop decision outlives the captured execution', async () => {
    const f = fixture('', 'running'), started = scriptSnapshot(await f.custom.run(tool.id, f.input(), new AbortController().signal))
    const rejection = new Error('original-stop-refused'), gate = deferred()
    f.port.stop = vi.fn(async () => { f.final('old_terminal_ACK'); f.exit(); await gate.promise; throw rejection })
    const stopping = f.custom.stop(tool.id, started.admission!.executionId)
    await flush()
    expect(f.port.replay).toHaveBeenCalledOnce(); expect(f.storage.save).toHaveBeenCalledTimes(3)
    const original = (f.custom as any).tools.get(tool.id)
    original.admission = { ...structuredClone(started.admission!), executionId: 'replacement-execution', text: '', run: { hostId: 'local', runId: 'replacement-run' } }
    original.live = (f.custom as any).execution(original, original.admission)
    const replacement = await f.custom.get(tool.id)
    gate.release()
    await expect(stopping).rejects.toBe(rejection)
    expect(await f.custom.get(tool.id)).toEqual(replacement)
    expect(f.port.remove).not.toHaveBeenCalled(); expect(f.storage.save).toHaveBeenCalledTimes(3)
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
  it('explicitly continues an unknown action with its original creation key and request identities', async () => {
    const f = fixture('main', 'exited', { ...tool, actions: [refresh] })
    const first = await f.custom.run('quota', f.input(), new AbortController().signal)
    const request = input(f.config.toolkit.tools[0]!, first.latestConfirmed!.executionId)
    const create = f.port.create
    f.port.create = vi.fn().mockRejectedValueOnce(new Error('owned-create-outcome-unconfirmed')).mockImplementation(create)
    const unknown = await f.custom.action('quota', 'refresh', request, new AbortController().signal)
    expect(unknown).toMatchObject({ state: 'unknown', latestConfirmed: first.latestConfirmed,
      admission: { invocationId: request.invocationId, action: { id: 'refresh' } } })
    const continued = await f.custom.action('quota', 'refresh', request, new AbortController().signal)
    expect(continued).toMatchObject({ state: 'succeeded', admission: null,
      latestConfirmed: { executionId: unknown.admission!.executionId, invocationId: request.invocationId, action: unknown.admission!.action } })
    expect(f.port.create).toHaveBeenCalledTimes(2)
    expect(vi.mocked(f.port.create).mock.calls.map(([input]) => input.createOperationId)).toEqual([unknown.admission!.executionId, unknown.admission!.executionId])
    await expect(f.custom.action('quota', 'other', request, new AbortController().signal)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
    expect(f.port.create).toHaveBeenCalledTimes(2)
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
      tools: [{ ...current.toolkit!.tools![0]!, workspacePath: _hygiene_fixturePath("different-target") }] } }))
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


describe('explicit original Toolkit creation continuation', () => {
  it('keeps restored unbound entry reads passive and joins concurrent explicit continuation', async () => {
    const f = fixture('original_ACK'), input = f.input(), create = f.port.create
    f.port.create = vi.fn().mockRejectedValueOnce(new Error('lost-create-reply')).mockImplementation(create)
    const unknown = await f.custom.run('quota', input, new AbortController().signal)
    const original = unknown.admission!
    const restored = new CustomToolkitOwner({ config: f.owner, receipts: f.storage, openRunPort: async () => f.port, runner: process.execPath, env: {} })
    expect(await restored.get('quota')).toMatchObject({ state: 'unknown', admission: { executionId: original.executionId, run: null } })
    const reader = await restored.subscribe('quota', vi.fn(), vi.fn(), new AbortController().signal)
    expect(f.port.create).toHaveBeenCalledOnce()
    const held = deferred()
    f.port.create = vi.fn(async (request, listener) => { await held.promise; return await create(request, listener) })
    const one = restored.run('quota', input, new AbortController().signal)
    const two = restored.run('quota', input, new AbortController().signal)
    await flush(); expect(f.port.create).toHaveBeenCalledOnce()
    held.release()
    const results = await Promise.all([one, two])
    for (const value of results) expect(value).toMatchObject({ state: 'succeeded', admission: null,
      latestConfirmed: { executionId: original.executionId, invocationId: input.invocationId, text: 'original_ACK' } })
    expect(f.port.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ createOperationId: original.executionId }), expect.any(Function))
    reader.dispose(); await restored.dispose()
  })
  it('continues the original captured program after configuration changes without using its replacement', async () => {
    const f = fixture('captured_ACK'), input = f.input(), create = f.port.create
    f.port.create = vi.fn().mockRejectedValueOnce(new Error('lost-create')).mockImplementation(create)
    const original = await f.custom.run('quota', input, new AbortController().signal)
    await f.owner.update(current => ({ ...current, toolkit: { ...current.toolkit, tools: [{ ...current.toolkit!.tools![0]!, revision: 'replacement', script: 'replacementProgram()' }] } }))
    const value = await f.custom.run('quota', input, new AbortController().signal)
    expect(value.latestConfirmed?.executionId).toBe(original.admission!.executionId)
    const continued = vi.mocked(f.port.create).mock.calls[1]![0]
    expect(continued.args).toContain(tool.script); expect(continued.args).not.toContain('replacementProgram()')
  })
  it('keeps an original unknown creation when closing before its continuation dispatch', async () => {
    const f = fixture(), input = f.input()
    f.port.create = vi.fn().mockRejectedValue(new Error('lost-original'))
    const original = await f.custom.run('quota', input, new AbortController().signal), held = deferred()
    const restored = new CustomToolkitOwner({ config: f.owner, receipts: f.storage, openRunPort: async () => { await held.promise; return f.port }, runner: process.execPath, env: {} })
    const continuing = restored.run('quota', input, new AbortController().signal)
    await flush(); const closing = restored.dispose(); held.release(); await Promise.all([continuing, closing])
    expect(await restored.get('quota')).toMatchObject({ state: 'unknown', admission: { executionId: original.admission!.executionId, run: null }, latestConfirmed: null })
    expect(f.port.create).toHaveBeenCalledOnce(); expect(f.port.remove).not.toHaveBeenCalled()
  })
  it('reading a confirmed entry never continues a different unknown admission', async () => {
    const f = fixture('original'), originalInput = f.input()
    const first = await f.custom.run('quota', originalInput, new AbortController().signal)
    f.port.create = vi.fn().mockRejectedValue(new Error('lost-next-create'))
    const next = await f.custom.run('quota', f.input(first.latestConfirmed!.executionId), new AbortController().signal)
    const value = await f.custom.run('quota', originalInput, new AbortController().signal)
    expect(value.admission).toEqual(next.admission)
    expect(value.latestConfirmed).toEqual(first.latestConfirmed)
    expect(f.port.create).toHaveBeenCalledOnce()
  })
  it('retains the original unknown admission when an explicit continuation still fails', async () => {
    const f = fixture(), input = f.input()
    f.port.create = vi.fn().mockRejectedValue(new Error('native-creation-conflict'))
    const original = await f.custom.run('quota', input, new AbortController().signal)
    const repeated = await f.custom.run('quota', input, new AbortController().signal)
    expect(repeated).toMatchObject({ state: 'unknown', reason: 'native-creation-conflict', latestConfirmed: null,
      admission: { executionId: original.admission!.executionId, invocationId: input.invocationId, run: null } })
    await expect(f.custom.run('quota', { ...input, expectedLatestExecutionId: 'another-result' }, new AbortController().signal)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
    expect(f.port.create).toHaveBeenCalledTimes(2)
  })
})
