import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { owningBridge, bridge } from './helpers/first-execution-ipc-bridge'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { inputCorrelationCore, flushInput } from '../../../packages/core/test/helpers/input-correlation'
import { unwrapSessionInputWriteResult } from '../src/shared/session-input-result'
import type { SessionControl } from '../src/shared/contracts'
import type { Terminal } from '@xterm/xterm'
import { subscribeTerminalInput, type TerminalInputEventSource } from '../../../packages/client-ui/src/terminal/input'
import { terminalInputSender } from '../src/renderer/src/lib/terminal-reveal'
import { createTerminalPasteInput } from '../src/renderer/src/lib/terminal-paste'
import { installTerminalOscHandlers } from '../src/renderer/src/lib/terminal-capability-replies'
import { createRendererPerformance } from '../src/renderer/src/lib/renderer-performance'

// Execute the actual declarations in the production attach effect. The public xterm event
// source and IPC promises are controlled; no copied input/diagnostic implementation lives here.
// The gate can inject a production source mutant through the same define used by work-bounds.
declare const __AGENTMUX_TERMINAL_VIEW_SOURCE__: string | undefined
const sourcePath = process.env.AGENTMUX_TERMINAL_INPUT_SOURCE_PATH ?? fileURLToPath(new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url))
const source = typeof __AGENTMUX_TERMINAL_VIEW_SOURCE__ === 'string' ? __AGENTMUX_TERMINAL_VIEW_SOURCE__ : readFileSync(sourcePath, 'utf8')
const syntax = ts.createSourceFile('TerminalView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
export const inputObserverId = '11111111-1111-4111-8111-111111111111'
const parent = (source: 'user' | 'protocol' | 'paste', sequence: number) => ({ observerId: inputObserverId, source, sequence })
const names = ['sendInput', 'pasteInput', 'input', 'oscHandlers'] as const
const declarations = names.map(name => {
  const found: ts.VariableDeclaration[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  expect(found, `one actual production declaration ${name}`).toHaveLength(1)
  return ts.transpileModule('const ' + found[0]!.getText(syntax), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
}).join('\n')
const loaded = { path: sourcePath, sourceSHA256: createHash('sha256').update(source).digest('hex'),
  declarations: names, executedDeclarationsSHA256: createHash('sha256').update(declarations).digest('hex') }
if (process.env.AGENTMUX_TERMINAL_INPUT_LOADED) appendFileSync(process.env.AGENTMUX_TERMINAL_INPUT_LOADED, JSON.stringify(loaded) + '\n')

type Disposable = { dispose(): void }
type OscHandler = (data: string) => boolean | Promise<boolean>
const owners: Array<() => void> = []
afterEach(() => { owners.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks() })

export function terminalInputFixture(transport?: { write(...args: any[]): Promise<void>; paste(...args: any[]): Promise<void> }, controlOverride?: SessionControl, nonce: () => string = () => inputObserverId) {
  const userListeners = new Set<() => void>(), dataListeners = new Set<(data: string) => void>(), binaryListeners = new Set<(data: string) => void>()
  const oscHandlers = new Map<number, OscHandler>()
  const subscribe = <T,>(listeners: Set<T>, listener: T): Disposable => { listeners.add(listener); return { dispose: () => { listeners.delete(listener) } } }
  const data = (value: string, user = false) => {
    if (user) userListeners.forEach(listener => listener())
    dataListeners.forEach(listener => listener(value))
  }
  const terminal: TerminalInputEventSource & { paste(text: string): void } = {
    onUserInput: listener => subscribe(userListeners, listener), onData: listener => subscribe(dataListeners, listener),
    onBinary: listener => subscribe(binaryListeners, listener), paste: text => data('\x1b[200~' + text.replace(/\n/g, '\r') + '\x1b[201~', true)
  }
  // Only public event/OSC registration and paste generation cross this fixture boundary.
  Object.assign(terminal, { options: { theme: { foreground: '#ffffff' } }, parser: {
    registerOscHandler: (slot: number, listener: OscHandler) => { oscHandlers.set(slot, listener); return { dispose: () => { oscHandlers.delete(slot) } } }
  } })
  let now = 10
  const rendererPerformance = createRendererPerformance(() => now, () => 100, nonce)
  const access = { accepts: true }, readOnlyRef = { current: false }
  const control = controlOverride ?? { kind: 'terminal' as const, hostId: 'local', runId: 'original', run: { runId: 'original' } }
  const pending: Array<{ request: Promise<void>; resolve(): void; reject(error: Error): void }> = []
  const request = () => {
    let resolve!: () => void, reject!: (error: Error) => void
    const promise = new Promise<void>((ok, failed) => { resolve = ok; reject = failed })
    pending.push({ request: promise, resolve, reject }); return promise
  }
  const api = { sessions: { write: vi.fn(transport?.write ?? request), paste: vi.fn(transport?.paste ?? request) } }
  const reportError = vi.fn(), interaction = { observeWriteRequest: vi.fn() }
  const bindings = { terminalInputSender, createTerminalPasteInput, subscribeTerminalInput, installTerminalOscHandlers,
    terminal: terminal as unknown as Terminal, api, session: { kind: control.kind, control }, rendererPerformance, readOnlyRef,
    acceptsCurrentInput: () => access.accepts, interaction, reportError, copyTextToClipboard: vi.fn() }
  const create = new Function(...Object.keys(bindings), 'const replayingContinuation = false, historicalOutputDepth = 0;\n' + declarations + '\nreturn { input, pasteInput, oscHandlers };')
  const callbacks = create(...Object.values(bindings)) as { input: Disposable; pasteInput: ReturnType<typeof createTerminalPasteInput>; oscHandlers: Disposable }
  owners.push(() => { callbacks.input.dispose(); callbacks.oscHandlers.dispose() })
  return { data, binary: (value: string) => binaryListeners.forEach(listener => listener(value)), osc: (slot: number, value: string) => oscHandlers.get(slot)!(value),
    ...callbacks, rendererPerformance, api, reportError, interaction, control, pending, readOnlyRef, access,
    settle: async (index: number, error?: Error) => { now += 7; if (error) pending[index]!.reject(error); else pending[index]!.resolve(); await Promise.resolve(); await Promise.resolve() } }
}

it('production onData and onBinary keep user bytes/errors while input diagnostics follow pending and settlement', async () => {
  const view = terminalInputFixture()
  view.data('user-text', true); view.binary('\x80\xff')
  expect(view.api.sessions.write.mock.calls).toEqual([[view.control, 'user-text', 'user', parent('user', 1)], [view.control, Uint8Array.of(128, 255), 'user', parent('user', 2)]])
  expect(view.rendererPerformance.snapshot().inputRequests.user).toMatchObject({ started: 2, pending: 2, completed: 0, failed: 0 })
  expect(view.interaction.observeWriteRequest.mock.calls).toEqual([[view.pending[0]!.request, 10], [view.pending[1]!.request, 10]])
  await view.settle(0)
  expect(view.rendererPerformance.snapshot().inputRequests.user).toMatchObject({ pending: 1, completed: 1, failed: 0, wall: { count: 1, totalMs: 7 } })
  const failed = new Error('controlled write failure'); await view.settle(1, failed)
  expect(view.rendererPerformance.snapshot().inputRequests.user).toMatchObject({ pending: 0, completed: 1, failed: 1, wall: { count: 2, totalMs: 21 } })
  expect(view.reportError).toHaveBeenCalledExactlyOnceWith(failed)
  expect(view.rendererPerformance.snapshot().inputRequests.protocol.started).toBe(0)
  expect(view.rendererPerformance.snapshot().inputRequests.paste.started).toBe(0)
})

it('production parser and OSC replies classify protocol requests and preserve their original transport/error path', async () => {
  const view = terminalInputFixture()
  view.data('\x1b[0n')
  expect(await view.osc(10, '?')).toBe(true)
  expect(view.api.sessions.write.mock.calls).toEqual([[view.control, '\x1b[0n', 'terminal-protocol', parent('protocol', 1)], [view.control, '\x1b]10;rgb:ffff/ffff/ffff\x1b\\', 'terminal-protocol', parent('protocol', 2)]])
  expect(view.rendererPerformance.snapshot().inputRequests.protocol).toMatchObject({ started: 2, pending: 2, completed: 0, failed: 0 })
  expect(view.interaction.observeWriteRequest).not.toHaveBeenCalled()
  await view.settle(0); const failed = new Error('controlled reply failure'); await view.settle(1, failed)
  expect(view.rendererPerformance.snapshot().inputRequests.protocol).toMatchObject({ pending: 0, completed: 1, failed: 1, wall: { count: 2 } })
  expect(view.reportError).toHaveBeenCalledExactlyOnceWith(failed)
  expect(view.rendererPerformance.snapshot().inputRequests.user.started).toBe(0)
})

it('production paste callback observes one paste request without double user dispatch and retains access gates', async () => {
  const view = terminalInputFixture()
  view.pasteInput.paste('line\ntwo'); view.pasteInput.paste('next')
  expect(view.api.sessions.paste.mock.calls).toEqual([[view.control, 'line\ntwo', '\x1b[200~line\rtwo\x1b[201~', parent('paste', 1)], [view.control, 'next', '\x1b[200~next\x1b[201~', parent('paste', 2)]])
  expect(view.api.sessions.write).not.toHaveBeenCalled()
  expect(view.rendererPerformance.snapshot().inputRequests.paste).toMatchObject({ started: 2, pending: 2, completed: 0, failed: 0 })
  await view.settle(0); const failed = new Error('controlled paste failure'); await view.settle(1, failed)
  expect(view.rendererPerformance.snapshot().inputRequests.paste).toMatchObject({ pending: 0, completed: 1, failed: 1, wall: { count: 2 } })
  expect(view.reportError).toHaveBeenCalledExactlyOnceWith(failed)
  view.access.accepts = false; view.data('blocked', true); view.pasteInput.paste('blocked')
  view.access.accepts = true; view.readOnlyRef.current = true; view.data('read-only', true); view.pasteInput.paste('read-only')
  expect(view.api.sessions.paste).toHaveBeenCalledTimes(2); expect(view.api.sessions.write).not.toHaveBeenCalled()
  const costs = view.rendererPerformance.snapshot().inputRequests
  expect(costs.user.started).toBe(0); expect(costs.protocol.started).toBe(0); expect(costs.paste.started).toBe(2)
  expect(view.interaction.observeWriteRequest).not.toHaveBeenCalled()
})

it('actual Renderer callback → preload → registered IPC → Main → Hosted/Core preserves bytes, original parent and pending local stages', async () => {
  const f = await inputCorrelationCore(), owner = await owningBridge({ client: f.hosted as never, store: f.store, config: structuredClone(DEFAULT_CONFIG) })
  const { inputDeferred } = await import('../../../packages/core/test/helpers/input-correlation')
  f.gates.connect = inputDeferred(); f.gates.status = inputDeferred(); f.gates.native = inputDeferred()
  try {
    const view = terminalInputFixture({
      write: (...args: Parameters<NonNullable<typeof bridge.api>['sessions']['write']>) => bridge.api!.sessions.write(...args).then(unwrapSessionInputWriteResult),
      paste: (...args: Parameters<NonNullable<typeof bridge.api>['sessions']['paste']>) => bridge.api!.sessions.paste(...args).then(unwrapSessionInputWriteResult)
    })
    view.data('actual-user', true); view.binary('\x80\xff'); view.data('\x1b[0n'); view.pasteInput.paste('line\ntwo')
    await flushInput()
    const waiting = await owner.runtime.performanceDiagnostics(new AbortController().signal)
    expect(waiting.main.input.active.map(entry => entry.stage)).toEqual(Array(4).fill('connected-client'))
    expect(waiting.main.input.active.map(entry => entry.parent)).toEqual([parent('user', 1), parent('user', 2), parent('protocol', 1), parent('paste', 1)])
    expect(waiting.main.input.active.every(entry => entry.sender?.webContentsId === 771 && entry.sender.window?.generation === 0)).toBe(true)
    expect(waiting.main.input.oldestPendingMs).toBeGreaterThanOrEqual(0)
    expect(view.rendererPerformance.snapshot().inputRequestDetails.pending).toBe(4)
    expect(f.input).not.toHaveBeenCalled()
    const firstId = waiting.main.input.active[0]!.id
    f.gates.connect.resolve(); await flushInput()
    const queued = (await owner.runtime.performanceDiagnostics(new AbortController().signal)).main.input
    expect(queued.active[0]).toMatchObject({ id: firstId, stage: 'current-run', ownerInstanceId: 'controlled-daemon', phases: { 'connected-client': expect.any(Number) } })
    expect(queued.active.slice(1).every(entry => entry.stage === 'queued')).toBe(true)
    f.gates.status.resolve(); await flushInput()
    expect((await f.core.clientPerformanceDiagnostics()).input.active[0]).toMatchObject({ parent: parent('user', 1), stage: 'native-input' })
    f.gates.native.resolve()
    await Promise.all([...view.api.sessions.write.mock.results, ...view.api.sessions.paste.mock.results].map(value => value.value)); await flushInput()
    expect(f.input.mock.calls.map(([run, op]) => [run, op.data])).toEqual([
      ['original', 'actual-user'], ['original', Uint8Array.of(128, 255)], ['original', '\x1b[0n'], ['original', '\x1b[200~line\rtwo\x1b[201~']])
    expect((await f.core.clientPerformanceDiagnostics()).input.queueWait.count).toBe(0)
    const complete = (await owner.runtime.performanceDiagnostics(new AbortController().signal)).main.input
    expect(complete.queueWait.count).toBe(4)
    expect(complete).toMatchObject({ started: 4, completed: 4, failed: 0, pending: 0, oldestPendingMs: null })
    expect(complete.recent[0]).toMatchObject({ id: firstId, stage: 'reply-ready', parent: parent('user', 1),
      phases: { 'host-call': expect.any(Number), 'native-input': expect.any(Number), queued: expect.any(Number) } })
    expect(view.rendererPerformance.snapshot().inputRequestDetails.recent.map(entry => entry.parent)).toEqual(complete.recent.map(entry => entry.parent))
    expect((await f.core.clientPerformanceDiagnostics()).input.recent.map(entry => entry.parent)).toEqual(complete.recent.map(entry => entry.parent))
    expect(f.input.mock.calls.every(([, operation]) => !('parent' in operation) && !('observation' in operation))).toBe(true)
    expect(view.reportError).not.toHaveBeenCalled()
    if (process.env.AGENTMUX_TERMINAL_INPUT_LOADED) appendFileSync(process.env.AGENTMUX_TERMINAL_INPUT_LOADED + '.correlation', JSON.stringify({ case: 'actual-renderer-ipc-main-hosted-core',
      main: complete, core: (await f.core.clientPerformanceDiagnostics()).input, renderer: view.rendererPerformance.snapshot().inputRequestDetails,
      nativeCalls: f.input.mock.calls.length, nativeMetadataAbsent: f.input.mock.calls.every(([, operation]) => !('observation' in operation)) }) + '\n')
  } finally { f.gates.connect.resolve(); f.gates.status.resolve(); f.gates.native.resolve(); await owner.dispose(); await f.dispose() }
})

it('actual Agent callbacks keep Core FIFO identity/error and trusted Main window separate from the untrusted label', async () => {
  const f = await inputCorrelationCore(), owner = await owningBridge({ client: f.hosted as never, store: f.store, config: structuredClone(DEFAULT_CONFIG) })
  const { inputDeferred } = await import('../../../packages/core/test/helpers/input-correlation')
  f.gates.status = inputDeferred(); f.gates.native = inputDeferred()
  try {
    const control: SessionControl = { kind: 'agent', hostId: 'local', agentSessionId: 'private-agent', run: { runId: 'original' } }
    const view = terminalInputFixture({
      write: (...args: Parameters<NonNullable<typeof bridge.api>['sessions']['write']>) => bridge.api!.sessions.write(...args).then(unwrapSessionInputWriteResult),
      paste: (...args: Parameters<NonNullable<typeof bridge.api>['sessions']['paste']>) => bridge.api!.sessions.paste(...args).then(unwrapSessionInputWriteResult)
    }, control)
    view.data('first', true); view.data('failure', true)
    await flushInput()
    expect((await owner.runtime.performanceDiagnostics(new AbortController().signal)).main.input.active.map(entry => entry.stage)).toEqual(['host-call', 'host-call'])
    const activeCore = (await f.core.clientPerformanceDiagnostics()).input.active
    expect(activeCore.map(entry => entry.stage)).toEqual(['current-run', 'queued'])
    expect(activeCore.map(entry => entry.parent)).toEqual([parent('user', 1), parent('user', 2)])
    f.gates.status.resolve(); f.gates.native.resolve()
    await Promise.allSettled(view.api.sessions.write.mock.results.map(value => value.value)); await flushInput()
    expect(f.input.mock.calls.map(([, op]) => [op.data, op.expectedByte])).toEqual([['first', 0], ['failure', 5]])
    expect(view.reportError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: f.originalError.message }))
    expect((await owner.runtime.performanceDiagnostics(new AbortController().signal)).main.input).toMatchObject({ started: 2, completed: 1, failed: 1 })
    expect((await f.core.clientPerformanceDiagnostics()).input.recent.at(-1)).toMatchObject({ parent: parent('user', 2), result: 'failed' })
    view.pasteInput.paste('agent paste')
    await view.api.sessions.paste.mock.results[0]!.value
    expect((await f.core.clientPerformanceDiagnostics()).input.recent.at(-1)).toMatchObject({ parent: parent('paste', 1), kind: 'paste', result: 'completed' })
    owner.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    const invalid = { ...parent('user', 3), processId: 9999, window: { generation: 999 } }
    const result = await bridge.api!.sessions.write(control, 'safe', 'user', invalid as never)
    expect(result).toEqual({ ok: true })
    expect((await owner.runtime.performanceDiagnostics(new AbortController().signal)).main.input.recent.at(-1)).toMatchObject({ parent: null,
      sender: { webContentsId: 771, window: { windowId: 77, webContentsId: 771, generation: 1 } } })
    vi.spyOn(owner.sender, 'isLoadingMainFrame').mockImplementation(() => { throw new Error('diagnostic window unavailable') })
    expect(await bridge.api!.sessions.write(control, 'still healthy', 'user', 1n as never)).toEqual({ ok: true })
    expect((await owner.runtime.performanceDiagnostics(new AbortController().signal)).main.input.recent.at(-1)).toMatchObject({ parent: null, sender: { webContentsId: 771, window: null } })
    const uncloneable = await bridge.api!.sessions.write(control, 'optional-function-safe', 'user', (() => undefined) as never).then(value => value, error => ({ unexpected: error }))
    expect(uncloneable).toEqual({ ok: true })
    const changed = await bridge.api!.sessions.write({ ...control, run: { runId: 'wrong' } }, 'must not send', 'user', parent('user', 4))
    expect(changed).toMatchObject({ ok: false, error: { code: 'STALE_AGENT_SESSION' } })
    expect(f.input.mock.calls.map(([, op]) => op.data)).toEqual(['first', 'failure', 'agent paste', 'safe', 'still healthy', 'optional-function-safe'])
  } finally { f.gates.status.resolve(); f.gates.native.resolve(); await owner.dispose(); await f.dispose() }
})


it('actual callbacks retain healthy input when the optional recorder nonce cannot be generated', async () => {
  const view = terminalInputFixture(undefined, undefined, () => { throw new Error('diagnostics unavailable') })
  view.data('original', true)
  expect(view.api.sessions.write.mock.calls).toEqual([[view.control, 'original', 'user', undefined]])
  await view.settle(0)
  expect(view.reportError).not.toHaveBeenCalled()
  expect(view.rendererPerformance.snapshot().inputRequestDetails.recent[0]).toMatchObject({ parent: null, parentMatch: 'absent', result: 'completed' })
})


it('actual callbacks fail reserved diagnostics on synchronous bridge errors and preserve the same thrown error', () => {
  const original = new Error('original synchronous bridge failure')
  const view = terminalInputFixture({ write: () => { throw original }, paste: () => { throw original } })
  let writeFailure: unknown, pasteFailure: unknown
  try { view.data('original', true) } catch (error) { writeFailure = error }
  try { view.pasteInput.paste('original paste') } catch (error) { pasteFailure = error }
  expect(writeFailure).toBe(original); expect(pasteFailure).toBe(original)
  expect(view.rendererPerformance.snapshot().inputRequests.user).toMatchObject({ started: 1, pending: 0, failed: 1 })
  expect(view.rendererPerformance.snapshot().inputRequests.paste).toMatchObject({ started: 1, pending: 0, failed: 1 })
  expect(view.rendererPerformance.snapshot().inputRequestDetails).toMatchObject({ started: 2, pending: 0, failed: 2 })
  expect(view.rendererPerformance.snapshot().inputRequestDetails.recent.every(entry => entry.result === 'failed')).toBe(true)
  expect(view.reportError).not.toHaveBeenCalled()
})


it('actual Main terminal queue captures the owner used by the original operation after connection wait, not the older queued owner', async () => {
  const f = await inputCorrelationCore(), owner = await owningBridge({ client: f.core as never, store: f.store, config: structuredClone(DEFAULT_CONFIG) })
  const { inputDeferred } = await import('../../../packages/core/test/helpers/input-correlation')
  f.gates.status = inputDeferred()
  try {
    const control: SessionControl = { kind: 'terminal', hostId: 'local', runId: 'original', run: { runId: 'original' } }
    const request = bridge.api!.sessions.write(control, 'original', 'user', parent('user', 1)); await flushInput()
    expect((await owner.runtime.performanceDiagnostics(new AbortController().signal)).main.input.active[0]).toMatchObject({ stage: 'current-run', ownerInstanceId: 'controlled-daemon' })
    f.changeDaemon('replacement-daemon'); f.gates.status.resolve()
    expect(await request).toEqual({ ok: true })
    expect((await owner.runtime.performanceDiagnostics(new AbortController().signal)).main.input.recent[0]).toMatchObject({ ownerInstanceId: 'replacement-daemon', parent: parent('user', 1) })
    expect(f.input.mock.calls[0]![1].ownerInstanceId).toBe('replacement-daemon')
  } finally { f.gates.status.resolve(); await owner.dispose(); await f.dispose() }
})
