import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import ts from 'typescript'
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

function fixture() {
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
  const rendererPerformance = createRendererPerformance(() => now, () => 100)
  const access = { accepts: true }, readOnlyRef = { current: false }
  const control = { kind: 'terminal' as const, hostId: 'local', runId: 'original', run: { runId: 'original' } }
  const pending: Array<{ request: Promise<void>; resolve(): void; reject(error: Error): void }> = []
  const request = () => {
    let resolve!: () => void, reject!: (error: Error) => void
    const promise = new Promise<void>((ok, failed) => { resolve = ok; reject = failed })
    pending.push({ request: promise, resolve, reject }); return promise
  }
  const api = { sessions: { write: vi.fn(request), paste: vi.fn(request) } }
  const reportError = vi.fn(), interaction = { observeWriteRequest: vi.fn() }
  const bindings = { terminalInputSender, createTerminalPasteInput, subscribeTerminalInput, installTerminalOscHandlers,
    terminal: terminal as unknown as Terminal, api, session: { kind: 'terminal', control }, rendererPerformance, readOnlyRef,
    acceptsCurrentInput: () => access.accepts, interaction, reportError, copyTextToClipboard: vi.fn() }
  const create = new Function(...Object.keys(bindings), 'const replayingContinuation = false, historicalOutputDepth = 0;\n' + declarations + '\nreturn { input, pasteInput, oscHandlers };')
  const callbacks = create(...Object.values(bindings)) as { input: Disposable; pasteInput: ReturnType<typeof createTerminalPasteInput>; oscHandlers: Disposable }
  owners.push(() => { callbacks.input.dispose(); callbacks.oscHandlers.dispose() })
  return { data, binary: (value: string) => binaryListeners.forEach(listener => listener(value)), osc: (slot: number, value: string) => oscHandlers.get(slot)!(value),
    ...callbacks, rendererPerformance, api, reportError, interaction, control, pending, readOnlyRef, access,
    settle: async (index: number, error?: Error) => { now += 7; if (error) pending[index]!.reject(error); else pending[index]!.resolve(); await Promise.resolve(); await Promise.resolve() } }
}

it('production onData and onBinary keep user bytes/errors while input diagnostics follow pending and settlement', async () => {
  const view = fixture()
  view.data('user-text', true); view.binary('\x80\xff')
  expect(view.api.sessions.write.mock.calls).toEqual([[view.control, 'user-text', 'user'], [view.control, Uint8Array.of(128, 255), 'user']])
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
  const view = fixture()
  view.data('\x1b[0n')
  expect(await view.osc(10, '?')).toBe(true)
  expect(view.api.sessions.write.mock.calls).toEqual([[view.control, '\x1b[0n', 'terminal-protocol'], [view.control, '\x1b]10;rgb:ffff/ffff/ffff\x1b\\', 'terminal-protocol']])
  expect(view.rendererPerformance.snapshot().inputRequests.protocol).toMatchObject({ started: 2, pending: 2, completed: 0, failed: 0 })
  expect(view.interaction.observeWriteRequest).not.toHaveBeenCalled()
  await view.settle(0); const failed = new Error('controlled reply failure'); await view.settle(1, failed)
  expect(view.rendererPerformance.snapshot().inputRequests.protocol).toMatchObject({ pending: 0, completed: 1, failed: 1, wall: { count: 2 } })
  expect(view.reportError).toHaveBeenCalledExactlyOnceWith(failed)
  expect(view.rendererPerformance.snapshot().inputRequests.user.started).toBe(0)
})

it('production paste callback observes one paste request without double user dispatch and retains access gates', async () => {
  const view = fixture()
  view.pasteInput.paste('line\ntwo'); view.pasteInput.paste('next')
  expect(view.api.sessions.paste.mock.calls).toEqual([[view.control, 'line\ntwo', '\x1b[200~line\rtwo\x1b[201~'], [view.control, 'next', '\x1b[200~next\x1b[201~']])
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
