import { describe, expect, it, vi } from 'vitest'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { randomUUID } from 'node:crypto'
import type { AgentMuxClientEvent, AgentMuxRun, AgentMuxTerminalCreateInput } from '@agentmux/core'
import { parseToolkitSnapshot, type ToolkitRunInput, type ToolkitScriptSnapshot, type ToolkitInlineToolConfiguration } from '@agentmux/core/control'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { ConfigOwner } from '../src/main/config-owner.js'
import { CustomToolkitOwner } from '../src/main/toolkit-custom-owner.js'
import { prepareToolkitConfig } from '../src/main/toolkit-config.js'
import type { ToolkitRunPort } from '../src/main/toolkit-run-port.js'

vi.mock('electron', () => ({ app: { getPath: () => process.cwd(), getAppPath: () => process.cwd() } }))
vi.mock('@agentmux/core/toolkit-result-channel', () => ({ openToolkitResultChannel: vi.fn(() => { throw new Error('TUI must not open a machine result channel') }) }))

const definition: ToolkitInlineToolConfiguration = { id: 'interactive-tool', revision: 'initial', mode: 'tui', name: 'Interactive tool',
  icon: 'terminal', enabled: true, statusBar: 'icon', workspacePath: fixturePath('tmp'),
  script: 'printf "%s\\n" "$1"; read answer; printf "%s\\n" "$answer"', args: ['ready'], actions: [] }
const flush = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve)) }
function fixture(tools: ToolkitInlineToolConfiguration[] = [definition]) {
  let config = { ...structuredClone(DEFAULT_CONFIG), toolkit: { tools: structuredClone(tools) } }
  const receipts = new Map<string, unknown>(), runs = new Map<string, AgentMuxRun>(), creates = new Map<string, string>()
  const listeners = new Map<string, Set<(event: AgentMuxClientEvent) => void>>()
  const storage = { read: vi.fn(async (id: string) => receipts.get(id) ?? null), save: vi.fn(async (id: string, value: unknown) => { receipts.set(id, structuredClone(value)) }) }
  function emit(event: AgentMuxClientEvent) {
    if ('run' in event) for (const listener of [...listeners.get(event.run.runId) ?? []]) listener(event)
    else for (const group of listeners.values()) for (const listener of [...group]) listener(event)
  }
  const create = vi.fn(async (input: AgentMuxTerminalCreateInput, _listener: (event: AgentMuxClientEvent) => void, _output?: 'raw' | 'terminal') => {
    const runId = creates.get(input.createOperationId!) ?? randomUUID()
    creates.set(input.createOperationId!, runId)
    const run = runs.get(runId) ?? { runId, kind: 'terminal', providerId: null, executorId: null, agentSessionId: null,
      workspacePath: input.workspacePath, state: 'running', pid: null, cols: input.cols!, rows: input.rows!,
      observedAt: fixtureEpoch(0, 0, 1), latestOutputBytes: 0, acceptedInputBytes: 0 } as AgentMuxRun
    runs.set(runId, run)
    return structuredClone(run)
  })
  const port: ToolkitRunPort = { create,
    observe: vi.fn((ref, listener) => {
      const group = listeners.get(ref.runId) ?? new Set(); group.add(listener); listeners.set(ref.runId, group)
      return () => { group.delete(listener); if (!group.size) listeners.delete(ref.runId) }
    }),
    status: vi.fn(async ref => structuredClone(runs.get(ref.runId) ?? null)),
    attach: vi.fn(async () => { throw new Error('TUI must not acquire a raw Attachment') }),
    replay: vi.fn(async () => { throw new Error('TUI must not collect raw replay') }),
    release: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    stop: vi.fn(async ref => {
      const run = runs.get(ref.runId)!
      runs.set(ref.runId, { ...run, state: 'exited', exitCode: 0 })
      emit({ type: 'process-state', run: ref, state: 'exited', exitCode: 0 } as AgentMuxClientEvent)
    }) }
  let custom!: CustomToolkitOwner
  const owner = new ConfigOwner({ read: () => config,
    prepare: (current, next) => prepareToolkitConfig(current, next, id => custom.guardDelete(id)),
    save: async next => structuredClone(next), publish: saved => { config = saved as typeof config; custom.configurationChanged() } })
  const makeOwner = () => new CustomToolkitOwner({ config: owner, receipts: storage, openRunPort: async () => port,
    runner: process.execPath, env: {}, now: () => fixtureEpoch(0, 0, 2) })
  custom = makeOwner()
  async function snapshot(id = definition.id): Promise<ToolkitScriptSnapshot> {
    const value = await custom.get(id)
    expect(value.kind).toBe('script')
    expect(parseToolkitSnapshot(value)).toEqual(value)
    return value as ToolkitScriptSnapshot
  }
  function input(snapshot: ToolkitScriptSnapshot): ToolkitRunInput {
    return { invocationId: randomUUID(), expectedRevision: snapshot.definition.revision,
      expectedLatestExecutionId: snapshot.admission?.executionId ?? snapshot.latestConfirmed?.executionId ?? null }
  }
  return { owner, storage, receipts, runs, listeners, port, create, snapshot, input, emit,
    get custom() { return custom }, get config() { return config },
    reopen: async () => { await custom.dispose(); custom = makeOwner(); return custom },
    edit: async (change: Partial<ToolkitInlineToolConfiguration>) => {
      await owner.update(current => ({ ...current, toolkit: { ...current.toolkit, tools: current.toolkit!.tools!.map(tool => tool.id === definition.id && !('kind' in tool) ? { ...tool, ...change } : tool) } }))
      await custom.loadConfigured()
    },
    exit: (runId: string, code = 0) => {
      runs.set(runId, { ...runs.get(runId)!, state: 'exited', exitCode: code })
      emit({ type: 'process-state', run: { runId }, state: 'exited', exitCode: code } as AgentMuxClientEvent)
    } }
}

describe('Toolkit TUI lifecycle on the existing admission owner', () => {
  it('loads once, preserves the shell arguments, and never collects terminal bytes', async () => {
    const f = fixture()
    await Promise.all([f.custom.loadConfigured(), f.custom.loadConfigured()])
    const first = await f.snapshot(), execution = first.admission!
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.create.mock.calls[0]?.[0]).toMatchObject({ createOperationId: execution.executionId, command: '/bin/sh',
      args: ['-lc', definition.script, 'agentmux-toolkit', ...definition.args], workspacePath: definition.workspacePath })
    expect(f.create.mock.calls[0]?.[2]).toBe('terminal')
    const saved = f.storage.save.mock.calls.length
    await f.snapshot(); await f.snapshot()
    expect(f.storage.save).toHaveBeenCalledTimes(saved)
    f.create.mock.calls[0]![1]({ type: 'terminal-output', run: { runId: execution.run!.runId }, dataBytes: Buffer.alloc(65536), data: '',
      evidence: { source: 'terminal-output', observedAt: fixtureEpoch(0, 0, 3), outputByteRange: { startByte: 0, endByte: 65536 } } })
    const reader = await f.custom.subscribe(definition.id, vi.fn(), vi.fn(), new AbortController().signal)
    reader.dispose()
    await f.owner.update(current => ({ ...current, toolkit: { ...current.toolkit, performance: { enabled: false } } }))
    await f.custom.loadConfigured()
    expect(await f.snapshot()).toMatchObject({ state: 'running', admission: { executionId: execution.executionId, text: '' } })
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.port.attach).not.toHaveBeenCalled(); expect(f.port.replay).not.toHaveBeenCalled()
    expect(f.port.stop).not.toHaveBeenCalled(); expect(f.port.remove).not.toHaveBeenCalled()
    await f.custom.dispose()
    expect(f.port.stop).not.toHaveBeenCalled(); expect(f.port.release).not.toHaveBeenCalled()
    expect(f.listeners.size).toBe(0)
  })

  it('keeps captured cwd and mode while disabled and allows an exact stop', async () => {
    const f = fixture()
    await f.custom.loadConfigured()
    const original = (await f.snapshot()).admission!
    await f.edit({ enabled: false, script: 'printf changed', workspacePath: fixturePath('tmp/changed') })
    expect((await f.snapshot()).admission).toMatchObject({ executionId: original.executionId, definition: original.definition, target: original.target })
    expect(f.create).toHaveBeenCalledOnce(); expect(f.port.stop).not.toHaveBeenCalled()
    const stopped = await f.custom.stop(definition.id, original.executionId)
    expect(stopped).toMatchObject({ admission: null, latestConfirmed: { state: 'stopped', run: original.run, text: '' } })
    expect(f.port.remove).not.toHaveBeenCalled()
    await f.edit({ enabled: true })
    expect(f.create).toHaveBeenCalledTimes(2)
    expect((await f.snapshot()).admission!.target.workspacePath).toBe(fixturePath('tmp/changed'))
    await f.custom.dispose()
  })

  it('reconnects the same running execution after owner disposal without replaying creation', async () => {
    const f = fixture()
    await f.custom.loadConfigured()
    const original = (await f.snapshot()).admission!
    await f.reopen(); await f.custom.loadConfigured()
    expect((await f.snapshot()).admission).toMatchObject({ executionId: original.executionId, invocationId: original.invocationId, run: original.run, state: 'running' })
    expect(f.create).toHaveBeenCalledOnce(); expect(f.port.stop).not.toHaveBeenCalled()
    expect(f.port.attach).not.toHaveBeenCalled(); expect(f.listeners.get(original.run!.runId)?.size).toBe(1)
    await f.custom.dispose()
  })

  it('preserves unknown creation across load and only continues the original explicit invocation', async () => {
    const f = fixture(), create = f.create.getMockImplementation()!
    f.create.mockImplementationOnce(async (...args) => { await create(...args); throw new Error('creation reply lost') })
    await f.custom.loadConfigured()
    const original = (await f.snapshot()).admission!
    expect(original).toMatchObject({ state: 'unknown', run: null })
    await f.reopen(); await f.custom.loadConfigured()
    await f.custom.subscribe(definition.id, vi.fn(), vi.fn(), new AbortController().signal).then(reader => reader.dispose())
    expect(f.create).toHaveBeenCalledOnce()
    await f.custom.run(definition.id, { invocationId: original.invocationId, expectedRevision: original.definition.revision,
      expectedLatestExecutionId: original.expectedLatestExecutionId }, new AbortController().signal)
    expect(f.create).toHaveBeenCalledTimes(2)
    expect(f.runs.size).toBe(1)
    expect(f.create.mock.calls.map(([intent]) => intent)).toEqual([f.create.mock.calls[0]![0], f.create.mock.calls[0]![0]])
    expect((await f.snapshot()).admission).toMatchObject({ executionId: original.executionId, state: 'running' })
    await f.custom.dispose()
  })

  it('retains the Runtime-confirmed Stop reason when the previous owner missed the terminal event', async () => {
    const f = fixture()
    await f.custom.loadConfigured()
    const original = (await f.snapshot()).admission!, run = f.runs.get(original.run!.runId)!
    f.runs.set(run.runId, { ...run, state: 'exited', exitCode: 0, exitReason: 'user-stopped' })
    await f.reopen(); await f.custom.loadConfigured()
    expect(await f.snapshot()).toMatchObject({ admission: null, latestConfirmed: { state: 'stopped', run: original.run } })
    expect(f.create).toHaveBeenCalledOnce()
    await f.custom.dispose()
  })

  it('retains an unknown original request instead of rebuilding its missing creation intent', async () => {
    const f = fixture(), create = f.create.getMockImplementation()!
    f.create.mockImplementationOnce(async (...args) => { await create(...args); throw new Error('creation reply lost') })
    await f.custom.loadConfigured()
    const original = (await f.snapshot()).admission!
    const receipt = structuredClone(f.receipts.get(definition.id)) as Record<string, unknown>
    delete receipt.createIntent
    f.receipts.set(definition.id, receipt)
    await f.reopen(); await f.custom.loadConfigured()
    const continued = await f.custom.run(definition.id, { invocationId: original.invocationId, expectedRevision: original.definition.revision,
      expectedLatestExecutionId: original.expectedLatestExecutionId }, new AbortController().signal)
    expect(continued).toMatchObject({ state: 'unknown', admission: { executionId: original.executionId,
      invocationId: original.invocationId, definition: original.definition, run: null, state: 'unknown' } })
    expect(continued.reason).toContain('Original TUI creation intent is missing')
    expect(f.create).toHaveBeenCalledOnce(); expect(f.port.stop).not.toHaveBeenCalled()
    expect([...f.runs.values()]).toMatchObject([{ state: 'running' }])
    expect(f.receipts.get(definition.id)).not.toHaveProperty('createIntent')
    await f.custom.dispose()
  })

  it('keeps a confirmed terminal readable until a new host loading cycle admits another execution', async () => {
    const f = fixture()
    await f.custom.loadConfigured()
    const original = (await f.snapshot()).admission!
    const observed = vi.fn()
    const reader = await f.custom.subscribe(definition.id, observed, vi.fn(), new AbortController().signal)
    observed.mockClear()
    f.exit(original.run!.runId); await flush()
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ state: 'succeeded', admission: null }))
    reader.dispose()
    const finished = await f.snapshot()
    expect(finished).toMatchObject({ state: 'succeeded', admission: null, latestConfirmed: { executionId: original.executionId, run: original.run } })
    await f.custom.loadConfigured()
    expect(f.create).toHaveBeenCalledOnce(); expect(f.port.remove).not.toHaveBeenCalled()
    await f.reopen(); await f.custom.loadConfigured()
    const next = await f.snapshot()
    expect(f.create).toHaveBeenCalledTimes(2)
    expect(next.latestConfirmed).toEqual(finished.latestConfirmed)
    expect(next.admission!.run).not.toEqual(original.run)
    await f.custom.dispose()
  })

  it('keeps a healthy Run through observation failure and restores it through an explicit check', async () => {
    const f = fixture()
    await f.custom.loadConfigured()
    const original = (await f.snapshot()).admission!
    vi.mocked(f.port.status).mockRejectedValueOnce(new Error('status unavailable'))
    expect(await f.snapshot()).toMatchObject({ state: 'unknown', admission: { run: original.run } })
    expect(f.port.stop).not.toHaveBeenCalled()
    expect(await f.snapshot()).toMatchObject({ state: 'running', admission: { run: original.run } })
    f.runs.delete(original.run!.runId)
    expect(await f.snapshot()).toMatchObject({ state: 'unknown', admission: { run: original.run } })
    await f.custom.loadConfigured()
    expect(f.create).toHaveBeenCalledOnce(); expect(f.port.remove).not.toHaveBeenCalled()
    await f.custom.dispose()
  })

  it('observes an exit that arrives while the original status read is pending', async () => {
    const f = fixture()
    await f.custom.loadConfigured()
    const original = (await f.snapshot()).admission!, running = structuredClone(f.runs.get(original.run!.runId)!)
    let release!: () => void
    vi.mocked(f.port.status).mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve }); return running })
    const reading = f.snapshot()
    await flush(); f.exit(original.run!.runId); release()
    expect(await reading).toMatchObject({ state: 'succeeded', admission: null, latestConfirmed: { run: original.run } })
    expect(await f.snapshot()).toMatchObject({ state: 'succeeded', admission: null, latestConfirmed: { run: original.run } })
    expect(f.port.remove).not.toHaveBeenCalled()
    await f.custom.dispose()
  })

  it('confirms a short-lived Run that exits before lifecycle observation is installed', async () => {
    const f = fixture(), create = f.create.getMockImplementation()!
    f.create.mockImplementationOnce(async (...args) => {
      const run = await create(...args)
      f.exit(run.runId)
      return structuredClone(f.runs.get(run.runId)!)
    })
    await f.custom.loadConfigured()
    expect(await f.snapshot()).toMatchObject({ state: 'succeeded', admission: null, latestConfirmed: { text: '' } })
    expect(f.port.remove).not.toHaveBeenCalled()
    await f.custom.dispose()
  })

  it('preserves a rejected Stop and its healthy Run without acquiring a raw Attachment', async () => {
    const f = fixture()
    await f.custom.loadConfigured()
    const original = (await f.snapshot()).admission!
    vi.mocked(f.port.stop).mockRejectedValueOnce(new Error('stop rejected'))
    await expect(f.custom.stop(definition.id, original.executionId)).rejects.toThrow('stop rejected')
    expect(f.port.attach).not.toHaveBeenCalled(); expect(f.port.release).not.toHaveBeenCalled()
    expect(f.listeners.get(original.run!.runId)?.size).toBe(1)
    expect(await f.snapshot()).toMatchObject({ state: 'running', admission: { executionId: original.executionId, run: original.run } })
    f.exit(original.run!.runId); await flush()
    expect(await f.snapshot()).toMatchObject({ latestConfirmed: { state: 'succeeded', run: original.run } })
    await f.custom.dispose()
  })

  it('retains an ended Run when its result cannot yet be persisted', async () => {
    const f = fixture()
    await f.custom.loadConfigured()
    const original = (await f.snapshot()).admission!
    const observed = vi.fn(), reader = await f.custom.subscribe(definition.id, observed, vi.fn(), new AbortController().signal)
    f.storage.save.mockRejectedValueOnce(new Error('receipt write failed'))
    f.exit(original.run!.runId); await flush()
    expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'unknown',
      admission: expect.objectContaining({ executionId: original.executionId, run: original.run }), latestConfirmed: null }))
    expect(f.port.remove).not.toHaveBeenCalled(); expect(f.port.stop).not.toHaveBeenCalled()
    expect(await f.snapshot()).toMatchObject({ state: 'succeeded', admission: null, latestConfirmed: { run: original.run } })
    reader.dispose(); await f.custom.dispose()
  })

  it('isolates a failed tool load and does not start ordinary scripts', async () => {
    const ordinary = { ...definition, id: 'ordinary', mode: 'script' as const, script: 'console.log("ordinary")' }
    const another = { ...definition, id: 'another' }
    const f = fixture([definition, ordinary, another])
    f.storage.read.mockImplementation(async id => { if (id === definition.id) throw new Error('receipt unavailable'); return null })
    await f.custom.loadConfigured()
    expect(f.create).toHaveBeenCalledOnce()
    expect(await f.snapshot(definition.id)).toMatchObject({ state: 'unknown', admission: null })
    expect(await f.snapshot(ordinary.id)).toMatchObject({ state: 'idle', admission: null })
    expect(await f.snapshot(another.id)).toMatchObject({ state: 'running' })
    await f.custom.dispose()
  })

  it('preserves every public snapshot when an explicit Run wins admission during loading', async () => {
    const f = fixture(), seen: unknown[] = []
    const reader = await f.custom.subscribe(definition.id, snapshot => { seen.push(snapshot) }, vi.fn(), new AbortController().signal)
    const inspect = f.owner.inspect.bind(f.owner)
    let release!: () => void, entered!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve }), waiting = new Promise<void>(resolve => { entered = resolve })
    vi.spyOn(f.owner, 'inspect').mockImplementationOnce(async read => {
      entered(); await blocked
      return await inspect(read)
    })
    const loading = f.custom.loadConfigured()
    await waiting
    const manual = await f.custom.run(definition.id, { invocationId: randomUUID(), expectedRevision: definition.revision,
      expectedLatestExecutionId: null }, new AbortController().signal)
    expect(manual).toMatchObject({ state: 'running', admission: { state: 'running' } })
    release(); await loading
    expect(seen.length).toBeGreaterThan(1)
    for (const snapshot of seen) expect(parseToolkitSnapshot(snapshot)).toEqual(snapshot)
    expect(await f.snapshot()).toMatchObject({ state: 'running', admission: { state: 'running' } })
    expect(f.create).toHaveBeenCalledOnce()
    reader.dispose(); await f.custom.dispose()
  })

  it('keeps explicit Start available when automatic loading fails before admission', async () => {
    const f = fixture()
    vi.spyOn(f.owner, 'inspect').mockRejectedValueOnce(new Error('configuration read unavailable'))
    await f.custom.loadConfigured()
    const before = await f.snapshot()
    expect(before).toMatchObject({ state: 'idle', admission: null, latestConfirmed: null })
    expect(before.reason).toContain('configuration read unavailable')
    expect(f.create).not.toHaveBeenCalled()
    await f.custom.run(definition.id, f.input(before), new AbortController().signal)
    expect(await f.snapshot()).toMatchObject({ state: 'running', reason: null, admission: { state: 'running' } })
    expect(f.create).toHaveBeenCalledOnce()
    await f.custom.dispose()
  })
})
