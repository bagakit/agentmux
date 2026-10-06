import { afterEach, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Socket } from 'node:net'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
vi.mock('electron', () => ({ app: { getPath: () => process.cwd(), getAppPath: () => process.cwd() } }))
import { connectToolkitResultChannel } from '../../../packages/core/src/toolkit-result-channel.js'
import { AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS, parseToolkitSnapshot, type ToolkitResultDocument, type ToolkitScriptSnapshot, type ToolkitToolDefinition, type ToolkitToolConfiguration } from '@agentmux/core/control'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { ConfigOwner } from '../src/main/config-owner.js'
import { CustomToolkitOwner } from '../src/main/toolkit-custom-owner.js'
import type { ToolkitRunPort } from '../src/main/toolkit-run-port.js'
import type { AgentMuxClientEvent, AgentMuxRunAttachment } from '@agentmux/core'

const definition = { id: 'document-tool', revision: 'revision', name: 'Document', icon: 'terminal', enabled: true,
  statusBar: 'icon', workspacePath: fixturePath('document-workspace'), script: 'ordinaryScript()', args: [], display: { script: 'displayScript()', args: [] } } satisfies ToolkitToolDefinition
const document: ToolkitResultDocument = { schema: 'agentmux.toolkit.result.v1', summary: '工具', items: [], links: [{ label: 'Open', url: 'https://example.org/#complete-fragment' }], notice: '' }
const frame = JSON.stringify(document) + '\n'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
type Run = { runId: string; kind: 'terminal'; state: 'running' | 'exited'; exitCode: number; latestOutputBytes: number }
const script = (value: unknown) => value as ToolkitScriptSnapshot
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)) }
async function writeDocument(env: Record<string, string>, text = frame, end = true) {
  const socket = await connectToolkitResultChannel({ ...env }); socket.on('error', () => {})
  cleanup.push(async () => { socket.destroy() })
  if (end) { socket.end(text); await once(socket, 'close') }
  else socket.write(text)
  return socket
}
function fixture(producer?: (env: Record<string, string>, run: Run) => Promise<void>, initialState: Run['state'] = 'exited', options: { definition?: ToolkitToolConfiguration; snapshotRoot?: string } = {}) {
  const config = { ...structuredClone(DEFAULT_CONFIG), toolkit: { tools: [structuredClone(options.definition ?? definition)] } }
  const receipts = new Map<string, unknown>(), runs = new Map<string, Run>(), listeners = new Map<string, (event: AgentMuxClientEvent) => void>()
  const text = 'runtime diagnostic\n' + JSON.stringify(document), bytes = Buffer.from(text)
  const storage = { read: vi.fn(async (id: string) => structuredClone(receipts.get(id) ?? null)),
    save: vi.fn(async (id: string, value: unknown) => { receipts.set(id, structuredClone(value)) }) }
  const configOwner = new ConfigOwner({ read: () => config, prepare: async (_current, next) => next, save: async next => next, publish: () => {} })
  const attached = (id: string): AgentMuxRunAttachment => ({ run: { ...runs.get(id)! }, gap: null,
    replay: [{ startByte: 0, endByte: bytes.length, dataBytes: bytes }] }) as unknown as AgentMuxRunAttachment
  const port: ToolkitRunPort = { create: vi.fn(async (input, listener) => {
    const run: Run = { runId: input.createOperationId, kind: 'terminal', state: initialState, exitCode: 0, latestOutputBytes: bytes.length }
    runs.set(run.runId, run); listeners.set(run.runId, listener)
    await producer?.(input.env, run)
    return { ...run } as any
  }), attach: vi.fn(async (ref, _after, listener) => { if (listener) listeners.set(ref.runId, listener); return attached(ref.runId) }),
  replay: vi.fn(async ref => attached(ref.runId)), release: vi.fn(async () => {}), remove: vi.fn(async () => {}),
  stop: vi.fn(async ref => { const run = runs.get(ref.runId)!; run.state = 'exited'; listeners.get(ref.runId)?.({ type: 'process-state', run: ref, state: 'exited', exitCode: 0 } as any) }) }
  const makeOwner = (runner = process.execPath, snapshotRoot = options.snapshotRoot) => { const value = new CustomToolkitOwner({ config: configOwner, receipts: storage, openRunPort: async () => port, runner, env: { EXISTING_ENV: 'kept' }, ...(snapshotRoot ? { snapshotRoot } : {}) }); cleanup.push(() => value.dispose()); return value }
  const owner = makeOwner()
  let invocation = 0
  return { owner, makeOwner, receipts, storage, port, runs, text,
    input: (latest: string | null = null) => ({ invocationId: 'invocation-' + ++invocation, expectedRevision: definition.revision, expectedLatestExecutionId: latest }),
    exit: (runId: string, exitCode = 0) => { const run = runs.get(runId)!; run.state = 'exited'; run.exitCode = exitCode; listeners.get(runId)?.({ type: 'process-state', run: { runId }, state: 'exited', exitCode } as any) } }
}

describe('Custom Toolkit dedicated documents', () => {
  it('binds an early complete authenticated document to the original Run and retains all terminal diagnostics', async () => {
    const f = fixture(async env => { expect(env.EXISTING_ENV).toBe('kept'); await writeDocument(env) })
    const value = script(await f.owner.run(definition.id, f.input(), new AbortController().signal))
    expect(value.latestConfirmed).toMatchObject({ document, text: f.text, run: { runId: value.latestConfirmed!.executionId }, state: 'succeeded', exitCode: 0 })
    expect(parseToolkitSnapshot(value)).toEqual(value)
    expect(f.receipts.get(definition.id)).toMatchObject({ admission: null, latestConfirmed: value.latestConfirmed })
    expect(f.storage.save.mock.calls.every(([, receipt]) => !(receipt as any).admission?.document || (receipt as any).admission.run !== null)).toBe(true)
    expect(f.port.stop).not.toHaveBeenCalled(); expect(f.port.remove).toHaveBeenCalledOnce()
    const env = (f.port.create as any).mock.calls[0][0].env
    await expect(access(env.AGENTMUX_TOOLKIT_RESULT_PATH)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('keeps JSON-looking terminal text as ordinary text when no producer connects', async () => {
    const f = fixture(), value = script(await f.owner.run(definition.id, f.input(), new AbortController().signal))
    expect(value.latestConfirmed!.text).toBe(f.text)
    expect(Object.hasOwn(value.latestConfirmed!, 'document')).toBe(false)
    expect(value.state).toBe('succeeded'); expect(f.port.stop).not.toHaveBeenCalled()
  })
  it('decodes a multibyte frame split across actual channel writes only after complete EOF', async () => {
    const f = fixture(async env => {
      const socket = await connectToolkitResultChannel({ ...env }), bytes = Buffer.from(frame), split = bytes.indexOf(Buffer.from('工')) + 1
      socket.on('error', () => {}); socket.write(bytes.subarray(0, split)); await flush()
      socket.end(bytes.subarray(split)); await once(socket, 'close')
    })
    expect(script(await f.owner.run(definition.id, f.input(), new AbortController().signal)).latestConfirmed!.document).toEqual(document)
  })
  it('drains an authenticated EOF after exact terminal metadata instead of confirming its partial frame', async () => {
    let socket!: Socket
    const f = fixture(async env => { socket = await writeDocument(env, frame, false) })
    const pending = f.owner.run(definition.id, f.input(), new AbortController().signal)
    await vi.waitFor(async () => expect(await f.owner.get(definition.id)).toMatchObject({ state: 'unknown', latestConfirmed: null, admission: { run: { runId: expect.any(String) } } }))
    expect(f.port.stop).not.toHaveBeenCalled(); expect(f.port.remove).not.toHaveBeenCalled()
    socket.end(); const value = script(await pending)
    expect(value.latestConfirmed).toMatchObject({ state: 'succeeded', document, text: f.text }); expect(value.admission).toBeNull()
  })
  it('bounds EOF observation after a terminal Run without blocking a later read-only evaluation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = fixture(async env => { await writeDocument(env, frame, false) })
    const pending = f.owner.evaluate(definition.id, undefined, new AbortController().signal)
    await vi.waitFor(async () => expect(script(await f.owner.get(definition.id)).display).toMatchObject({ state: 'unknown', latestConfirmed: null }))
    await vi.advanceTimersByTimeAsync(AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS); await flush()
    const value = script(await pending)
    expect(value.display).toMatchObject({ state: 'succeeded', admission: null, latestConfirmed: { document: null, exitCode: 0, reason: expect.stringContaining('EOF is unconfirmed') } })
    expect(f.port.stop).not.toHaveBeenCalled(); expect(f.port.remove).toHaveBeenCalledOnce()
    vi.useRealTimers()
    ;(f.port.create as any).mockImplementationOnce(async (input: any) => {
      const run: Run = { runId: input.createOperationId, kind: 'terminal', state: 'exited', exitCode: 0, latestOutputBytes: Buffer.byteLength(f.text) }
      f.runs.set(run.runId, run); await writeDocument(input.env); return run
    })
    expect(script(await f.owner.evaluate(definition.id, undefined, new AbortController().signal)).display!.latestConfirmed!.document).toEqual(document)
    expect(f.port.create).toHaveBeenCalledTimes(2)
  })
  it.each(['no LF', 'two frames', 'wrong shape', 'null producer', 'invalid UTF-8', 'oversized'] as const)('retains the exact terminal outcome with an unavailable %s document', async kind => {
    const payload = kind === 'no LF' ? JSON.stringify(document) : kind === 'two frames' ? frame + frame : kind === 'wrong shape' ? '{}\n' : kind === 'null producer' ? 'null\n' : kind === 'oversized' ? 'x'.repeat(32770) : null
    const f = fixture(async env => {
      if (payload !== null) await writeDocument(env, payload)
      else { const socket = await connectToolkitResultChannel({ ...env }); socket.on('error', () => {}); socket.end(Buffer.from([0xff, 10])); await once(socket, 'close') }
    })
    const value = script(await f.owner.run(definition.id, f.input(), new AbortController().signal))
    expect(value).toMatchObject({ state: 'succeeded', admission: null, latestConfirmed: { document: null, text: f.text, exitCode: 0, reason: expect.stringContaining('machine document is unavailable') } })
    expect(parseToolkitSnapshot(value)).toEqual(value)
    expect(f.port.stop).not.toHaveBeenCalled(); expect(f.port.remove).toHaveBeenCalledOnce()
  })
  it('does not stop a healthy Run when its machine protocol fails and later consumes only its natural exit', async () => {
    const f = fixture(async env => { await writeDocument(env, '{}\n') }, 'running')
    const running = script(await f.owner.run(definition.id, f.input(), new AbortController().signal))
    expect(running).toMatchObject({ state: 'unknown', admission: { document: null, run: { runId: expect.any(String) } }, latestConfirmed: null })
    expect(f.port.stop).not.toHaveBeenCalled(); expect(f.port.remove).not.toHaveBeenCalled()
    f.exit(running.admission!.run!.runId, 7)
    await vi.waitFor(async () => expect(await f.owner.get(definition.id)).toMatchObject({ state: 'failed', admission: null,
      latestConfirmed: { document: null, run: running.admission!.run, exitCode: 7 } }))
    expect(f.port.stop).not.toHaveBeenCalled(); expect(f.port.create).toHaveBeenCalledOnce()
  })
  it('closes an unfinished machine stream during owner shutdown without changing the natural terminal outcome', async () => {
    let path = ''
    const f = fixture(async env => { path = env.AGENTMUX_TOOLKIT_RESULT_PATH!; await writeDocument(env, frame, false) })
    const pending = f.owner.run(definition.id, f.input(), new AbortController().signal)
    await vi.waitFor(async () => expect(await f.owner.get(definition.id)).toMatchObject({ state: 'unknown', latestConfirmed: null }))
    await f.owner.dispose()
    expect(script(await pending)).toMatchObject({ state: 'succeeded', admission: null, latestConfirmed: { document: null, exitCode: 0 } })
    expect(f.port.stop).not.toHaveBeenCalled(); await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('restores the original persisted document without creating a channel or rerunning its action', async () => {
    const f = fixture(async env => { await writeDocument(env) }, 'running')
    const running = script(await f.owner.run(definition.id, f.input(), new AbortController().signal))
    expect(running.admission!.document).toEqual(document)
    const saved = structuredClone(f.receipts.get(definition.id)), restored = f.makeOwner()
    expect(await restored.get(definition.id)).toMatchObject({ admission: { executionId: running.admission!.executionId, document, text: f.text } })
    expect(f.port.create).toHaveBeenCalledOnce(); expect(f.receipts.get(definition.id)).toEqual(saved)
    f.exit(running.admission!.run!.runId); await flush()
    expect(await restored.get(definition.id)).toMatchObject({ state: 'succeeded', admission: null, latestConfirmed: { document, executionId: running.admission!.executionId } })
    expect(f.port.create).toHaveBeenCalledOnce()
  })
  it.each([null, undefined])('keeps an earlier typed display when a later successful result is %s, including restart', async unavailable => {
    let call = 0
    const f = fixture(async env => { if (++call === 1) await writeDocument(env); else if (unavailable === null) await writeDocument(env, '{}\n') })
    const original = script(await f.owner.evaluate(definition.id, undefined, new AbortController().signal)).display!.latestConfirmed!
    const latest = script(await f.owner.evaluate(definition.id, undefined, new AbortController().signal))
    expect(latest.display).toMatchObject({ state: 'succeeded', admission: null, lastSucceeded: original })
    expect(latest.display!.latestConfirmed!.executionId).not.toBe(original.executionId)
    expect(latest.display!.latestConfirmed!.document).toBe(unavailable)
    expect(f.receipts.get(definition.id)).toMatchObject({ display: { lastSucceeded: original } })
    const restored = f.makeOwner()
    expect(script(await restored.get(definition.id)).display).toEqual(latest.display && { ...latest.display, sequence: 0 })
    expect(parseToolkitSnapshot(latest)).toEqual(latest)
    expect(f.port.create).toHaveBeenCalledTimes(2)
  })
  it('durably records the complete private create input before dispatch without exposing credentials', async () => {
    const f = fixture(), save = f.storage.save.getMockImplementation()!
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    f.storage.save.mockImplementation(async (id, value) => { if ((value as any).createIntent && (value as any).admission?.run === null) await held; await save(id, value) })
    const pending = f.owner.run(definition.id, f.input(), new AbortController().signal)
    await vi.waitFor(() => expect(f.storage.save.mock.calls.some(([, value]) => (value as any).createIntent)).toBe(true))
    expect(f.port.create).not.toHaveBeenCalled()
    const publicValue = await f.owner.get(definition.id)
    expect(JSON.stringify(publicValue)).not.toContain('AGENTMUX_TOOLKIT_RESULT_TOKEN')
    release(); const value = await pending
    expect(value).toMatchObject({ state: 'succeeded', admission: null })
    expect(Object.hasOwn(f.receipts.get(definition.id)!, 'createIntent')).toBe(false)
  })
  it('restores an unbound creation with the exact original private input and no replacement socket', async () => {
    const f = fixture(), create = f.port.create, request = f.input()
    f.port.create = vi.fn().mockRejectedValueOnce(new Error('original-create-reply-lost')).mockImplementation(create)
    const original = script(await f.owner.run(definition.id, request, new AbortController().signal))
    const intent = structuredClone((f.receipts.get(definition.id) as any).createIntent)
    expect(intent.createOperationId).toBe(original.admission!.executionId)
    await expect(access(intent.env.AGENTMUX_TOOLKIT_RESULT_PATH)).rejects.toMatchObject({ code: 'ENOENT' })
    const restored = f.makeOwner()
    expect(await restored.get(definition.id)).toMatchObject({ state: 'unknown', admission: { executionId: original.admission!.executionId,
      invocationId: original.admission!.invocationId, run: null, definition: original.admission!.definition } })
    expect(f.port.create).toHaveBeenCalledOnce()
    const result = await restored.run(definition.id, request, new AbortController().signal)
    expect(result).toMatchObject({ state: 'succeeded', latestConfirmed: { executionId: original.admission!.executionId } })
    expect((f.port.create as any).mock.calls.map(([input]: any[]) => input)).toEqual([intent, intent])
    expect(JSON.stringify(result)).not.toContain('createIntent')
    expect(Object.hasOwn(f.receipts.get(definition.id)!, 'createIntent')).toBe(false)
  })
  it.each(['operation', 'target', 'command', 'args', 'env', 'extra'] as const)('retains an original unknown admission when its private %s intent is invalid', async changed => {
    const f = fixture()
    f.port.create = vi.fn().mockRejectedValue(new Error('original-create-reply-lost'))
    const original = script(await f.owner.run(definition.id, f.input(), new AbortController().signal))
    const saved = structuredClone(f.receipts.get(definition.id) as any), intent = saved.createIntent
    if (changed === 'operation') intent.createOperationId = 'another-operation'
    if (changed === 'target') intent.workspacePath = fixturePath('another-workspace')
    if (changed === 'command') intent.command = 'another-program'
    if (changed === 'args') intent.args = ['another-program']
    if (changed === 'env') intent.env = { arbitrary: {} }
    if (changed === 'extra') intent.extra = true
    f.receipts.set(definition.id, saved)
    const restored = f.makeOwner(), value = script(await restored.get(definition.id))
    expect(value).toMatchObject({ state: 'unknown', admission: { executionId: original.admission!.executionId } })
    expect(f.port.create).toHaveBeenCalledOnce()
    expect(f.receipts.get(definition.id)).toEqual(saved)
    expect(await restored.run(definition.id, { invocationId: original.admission!.invocationId,
      expectedRevision: definition.revision, expectedLatestExecutionId: null }, new AbortController().signal)).toMatchObject({
      state: 'unknown', admission: { executionId: original.admission!.executionId }, reason: expect.stringContaining('creation intent is invalid') })
    expect(f.port.create).toHaveBeenCalledOnce()
    expect((f.receipts.get(definition.id) as any).createIntent).toEqual(intent)
  })
  it('does not gate a known healthy Run on an unused original creation intent or the current runner', async () => {
    const f = fixture(async env => { await writeDocument(env) }, 'running')
    const original = script(await f.owner.run(definition.id, f.input(), new AbortController().signal))
    const saved = structuredClone(f.receipts.get(definition.id) as any)
    saved.createIntent.command = 'unavailable-original-runner'; saved.createIntent.args = ['changed-observation']
    f.receipts.set(definition.id, saved)
    const restored = f.makeOwner()
    expect(await restored.get(definition.id)).toMatchObject({ state: 'running', admission: { executionId: original.admission!.executionId,
      run: original.admission!.run, document } })
    expect(f.port.create).toHaveBeenCalledOnce(); expect(f.port.stop).not.toHaveBeenCalled()
    f.exit(original.admission!.run!.runId); await flush()
    expect(await restored.get(definition.id)).toMatchObject({ state: 'succeeded', admission: null, latestConfirmed: { document, run: original.admission!.run } })
    expect(f.port.create).toHaveBeenCalledOnce(); expect(f.port.stop).not.toHaveBeenCalled()
  })
  it('continues the captured original runner after the current runner changes', async () => {
    const f = fixture(), create = f.port.create, request = f.input()
    f.port.create = vi.fn().mockRejectedValueOnce(new Error('original-create-reply-lost')).mockImplementation(create)
    const original = script(await f.owner.run(definition.id, request, new AbortController().signal))
    const intent = structuredClone((f.receipts.get(definition.id) as any).createIntent)
    const restored = f.makeOwner(fixturePath('replacement-runner'))
    expect(await restored.run(definition.id, request, new AbortController().signal)).toMatchObject({ state: 'succeeded',
      latestConfirmed: { executionId: original.admission!.executionId, run: { runId: original.admission!.executionId } } })
    expect((f.port.create as any).mock.calls.map(([input]: any[]) => input)).toEqual([intent, intent])
    expect(f.port.stop).not.toHaveBeenCalled()
  })
  it.each([{ invalid: true }, 0, null])('keeps a healthy ordinary Run readable while an independent display has unused creation material %s', async invalid => {
    const f = fixture(async env => { await writeDocument(env) }, 'running')
    const original = script(await f.owner.run(definition.id, f.input(), new AbortController().signal))
    const saved = structuredClone(f.receipts.get(definition.id) as any)
    saved.display = { latestConfirmed: null, admission: { ...original.admission, executionId: 'unbound-display',
      invocationId: 'unbound-display-invocation', run: null, text: '', state: 'unknown', reason: 'Original display creation is unconfirmed.' }, createIntent: invalid }
    delete saved.display.admission.document
    f.receipts.set(definition.id, saved)
    const restored = f.makeOwner(), seen = vi.fn()
    const reader = await restored.subscribe(definition.id, seen, vi.fn(), new AbortController().signal)
    expect(await restored.get(definition.id)).toMatchObject({ state: 'running', admission: { run: original.admission!.run, document },
      display: { state: 'unknown', admission: { executionId: 'unbound-display', run: null } } })
    expect(f.port.create).toHaveBeenCalledOnce(); expect(f.port.stop).not.toHaveBeenCalled()
    f.exit(original.admission!.run!.runId)
    await vi.waitFor(async () => expect(await restored.get(definition.id)).toMatchObject({ state: 'succeeded', admission: null,
      latestConfirmed: { document, run: original.admission!.run }, display: { admission: { executionId: 'unbound-display' } } }))
    expect(seen).toHaveBeenCalled(); expect(f.port.create).toHaveBeenCalledOnce(); expect(f.port.stop).not.toHaveBeenCalled()
    expect(Object.hasOwn((f.receipts.get(definition.id) as any).display, 'createIntent')).toBe(true)
    expect((f.receipts.get(definition.id) as any).display.createIntent).toEqual(invalid)
    reader.dispose()
  })
  it('keeps the newest confirmed typed display across a restart between confirmation and cleanup', async () => {
    const fresh = { ...document, summary: 'Newest confirmed display' }
    let generation = 0
    const f = fixture(async env => { await writeDocument(env, ++generation === 1 ? frame : generation === 2 ? JSON.stringify(fresh) + '\n' : '{}\n') })
    const old = script(await f.owner.evaluate(definition.id, undefined, new AbortController().signal)).display!.latestConfirmed!
    const save = f.storage.save.getMockImplementation()!
    let failCleanup = true
    f.storage.save.mockImplementation(async (id, value) => {
      const display = (value as any).display
      if (failCleanup && display?.admission === null && display.latestConfirmed?.document?.summary === fresh.summary) {
        failCleanup = false; throw new Error('confirmation-acknowledged-cleanup-unconfirmed')
      }
      await save(id, value)
    })
    const interrupted = script(await f.owner.evaluate(definition.id, undefined, new AbortController().signal))
    expect(interrupted.display!.latestConfirmed!.document).toEqual(fresh)
    expect((f.receipts.get(definition.id) as any).display.lastSucceeded).toEqual(old)
    const restored = f.makeOwner(), seen = vi.fn()
    const reader = await restored.subscribe(definition.id, seen, vi.fn(), new AbortController().signal)
    expect(seen.mock.calls.at(-1)![0].display.latestConfirmed.document).toEqual(fresh)
    expect(seen.mock.calls.at(-1)![0].display.lastSucceeded).toBeUndefined()
    await restored.get(definition.id)
    const next = script(await restored.evaluate(definition.id, undefined, new AbortController().signal))
    expect(next.display!.latestConfirmed!.document).toBeNull()
    expect(next.display!.lastSucceeded!.document).toEqual(fresh)
    reader.dispose()
  })
  it('continues the original captured package snapshot when the current snapshot root changes', async () => {
    const directory = await mkdtemp(fixturePath('tmp/toolkit-original-snapshot-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const packagePath = join(directory, 'package'), originalRoot = join(directory, 'original-snapshots')
    await mkdir(packagePath)
    await writeFile(join(packagePath, 'manifest.json'), JSON.stringify({ schema: 'agentmux.toolkit.package.v1', name: 'Original package', icon: 'terminal', entry: 'entry.mjs', actions: [] }))
    await writeFile(join(packagePath, 'entry.mjs'), "console.log('original-package')")
    const f = fixture(undefined, 'exited', { definition: { id: definition.id, kind: 'package', revision: 'package-revision', packagePath,
      workspacePath: directory, enabled: true, statusBar: 'icon', args: [] }, snapshotRoot: originalRoot })
    const inspected = script(await f.owner.get(definition.id)), request = { invocationId: 'original-package-invocation', expectedRevision: inspected.definition.revision, expectedLatestExecutionId: null }
    const create = f.port.create
    f.port.create = vi.fn().mockRejectedValueOnce(new Error('original-create-reply-lost')).mockImplementation(create)
    const original = script(await f.owner.run(definition.id, request, new AbortController().signal)), intent = structuredClone((f.receipts.get(definition.id) as any).createIntent)
    const restored = f.makeOwner(process.execPath, join(directory, 'replacement-snapshots'))
    const result = await restored.run(definition.id, request, new AbortController().signal)
    expect(result.kind === 'package-unavailable' ? result.retained : result).toMatchObject({ state: 'succeeded',
      latestConfirmed: { executionId: original.admission!.executionId } })
    expect((f.port.create as any).mock.calls.map(([input]: any[]) => input)).toEqual([intent, intent])
    await expect(access(join(originalRoot, original.admission!.executionId))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.port.stop).not.toHaveBeenCalled()
  })
})
