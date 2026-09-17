// @vitest-environment happy-dom
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Terminal as BrowserTerminal } from '@xterm/xterm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CtxmuxClient, type RuntimeIdentity } from '@ctxmux/sdk'
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore, type AgentMuxClientEvent, type AgentMuxRun } from '@agentmux/core'
import type { CtxmuxRunAdapter } from '../../../packages/core/src/ctxmux-run-adapter'
import type { AgentMuxAgentSessionRegistry } from '../../../packages/core/src/agent-session-registry'
import type { RuntimeEvent, AppConfig, SessionAttachResult, SessionSnapshot } from '../src/shared/contracts'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { TerminalView } from '../src/renderer/src/components/TerminalView'
import { readTerminalViewObservation } from '../src/renderer/src/lib/terminal-view-observation'

// Actual private native18 daemon/PTY, SDK socket, public Core operations, TerminalView,
// xterm.open/parser/mouse/viewport and resulting PTY repaint. Artifact verification/connect,
// Electron/Main/preload, OS input and layout/paint are explicit fixture boundaries.
// No generated seed or manual page is fed into the component.
const fixture = vi.hoisted(() => ({ terminals: [] as BrowserTerminal[] }))
vi.mock('@xterm/xterm', async () => {
  const { Terminal } = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm')
  return { Terminal: class extends Terminal {
    constructor(options: ConstructorParameters<typeof Terminal>[0]) { super(options); fixture.terminals.push(this) }
  } }
})
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { activate() {} dispose() {} fit() {} proposeDimensions() { return { cols: 12, rows: 4 } } } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { activate() {} dispose() {} onDidChangeResults() { return { dispose() {} } } } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { activate() {} dispose() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { activate() {} dispose() {} onContextLoss() { return { dispose() {} } } } }))
vi.mock('../src/renderer/src/components/TerminalContextMenu', () => ({ TerminalContextMenu: ({ children }: { children: ReactNode }) => children }))

const binary = '.tmp/ctxmux-terminal-checkpoint-worktree/.tmp/basic-codec/ctxmuxd-basic18'
const initialState = useAppStore.getState()
const origin = { workspaceId: 'native-join', tabGroupId: 'group', tabId: 'tab', regionId: 'native-region' }
const receipts: unknown[] = []
let directory: string
let daemon: ChildProcess
let sdk: CtxmuxClient
let client: AgentMuxClient
let root: Root | undefined
let container: HTMLDivElement
let config: AppConfig
let run: AgentMuxRun | undefined
let inputByte: number
let writes: Array<{ data: string | Uint8Array; startByte: number; endByte: number }>
let attached: Awaited<ReturnType<AgentMuxClient['attachTerminal']>> | undefined
let unsubscribers: Array<() => void>
let pendingWrites: Promise<unknown>[]
let failures: unknown[]

function alive(pid: number): boolean { try { process.kill(pid, 0); return true } catch { return false } }
function contents(terminal: BrowserTerminal): string {
  const buffer = terminal.buffer.active
  return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)!.translateToString(true)).join('\n')
}
function project(source: AgentMuxRun): SessionSnapshot {
  return { id: source.runId, hostId: 'local', workspacePath: directory, label: 'Private native PTY',
    createdAt: source.observedAt, updatedAt: source.observedAt, kind: 'terminal', providerId: null,
    processState: source.state, status: { state: 'running', source: 'run-process', observedAt: source.observedAt },
    latestOutputBytes: source.latestOutputBytes, control: { kind: 'terminal', hostId: 'local', runId: source.runId, run: { runId: source.runId } } }
}
async function send(data: string | Uint8Array): Promise<void> {
  if (!run) throw new Error('Private fixture has no Run')
  const accepted = await client.writeTerminal({ runId: run.runId }, { ownerInstanceId: client.runtimeIdentity().instanceId!,
    operationId: randomUUID(), expectedByte: inputByte, data })
  inputByte = accepted.acceptedThroughByte
  writes.push({ data, ...accepted.appliedByteRange })
}
async function wheel(terminal: BrowserTerminal, deltaY: number): Promise<WheelEvent> {
  const screen = terminal.element!.querySelector('.xterm-screen')!
  expect(screen).toBeInstanceOf(HTMLElement)
  // A real browser computes the default padding as 0px; Happy DOM leaves it empty.
  ;(screen as HTMLElement).style.padding='0px'
  expect(getComputedStyle(screen).getPropertyValue('padding-left')).toBe('0px')
  expect(getComputedStyle(screen).getPropertyValue('padding-top')).toBe('0px')
  const event = new WheelEvent('wheel', { deltaY, deltaMode: 0, clientX: 16, clientY: 16, bubbles: true, cancelable: true })
  // Happy DOM WheelEvent omits the standard inherited MouseEvent coordinates.
  Object.defineProperties(event, { clientX:{value:16},clientY:{value:16},buttons:{value:0},ctrlKey: { value: false }, shiftKey: { value: false }, altKey: { value: false }, metaKey: { value: false } })
  expect([event.clientX,event.clientY]).toEqual([16,16])
  await act(async () => { screen.dispatchEvent(event) })
  return event
}
const python = String.raw`import os,sys,termios,re
attrs=termios.tcgetattr(0);attrs[3]&=~(termios.ICANON|termios.ECHO);attrs[1]&=~termios.OPOST
attrs[6][termios.VMIN]=1;attrs[6][termios.VTIME]=0;termios.tcsetattr(0,termios.TCSANOW,attrs)
os.write(1,b''.join(('ROW%03d\r\n'%i).encode() for i in range(30)))
if sys.argv[1]=='alternate':os.write(1,b'\x1b[?1049h\x1b[?1003h\x1b[?1006h')
os.write(1,b'\x1b[1;1Hframe'*450000+b'\x1b[2;1HREADY500')
index=500;pending=b''
while True:
 chunk=os.read(0,4096)
 if not chunk:break
 pending+=chunk
 while True:
  match=re.search(rb'\x1b\[<(64|65);\d+;\d+M',pending)
  if not match:break
  index+=-1 if match.group(1)==b'64' else 1
  os.write(1,('\x1b[2;1HREADY%03d'%index).encode());pending=pending[match.end():]
 if b'z' in pending:os.write(1,b'\x1b[3;1HZ');pending=pending.replace(b'z',b'')
 if b'q' in pending:break
`

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('OffscreenCanvas', undefined)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ font: '',
    measureText: () => ({ width: 8, actualBoundingBoxDescent: 2, actualBoundingBoxAscent: 10 }) }) as unknown as CanvasRenderingContext2D)
  // Happy DOM has no layout engine. Only DOM glyph and surface geometry are supplied;
  // xterm's viewport, mouse listeners, encoder and buffer state remain unmodified.
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('xterm-char-measure-element') ? 256 : 96 })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(16)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, width: 96, height: 64, right: 96, bottom: 64, toJSON() {} })
  fixture.terminals.length = 0; root = undefined; run = undefined; attached = undefined
  inputByte = 0; writes = []; pendingWrites = []; failures = []; unsubscribers = []
  directory = await mkdtemp(join(tmpdir(), 'amx-native-join-'))
  await mkdir(join(directory, 'private-codex'), { mode: 0o700 })
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', directory)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(directory, 'messages.ndjson'))
  vi.stubEnv('CODEX_HOME', join(directory, 'private-codex'))
  daemon = spawn(binary, ['--socket', join(directory, 'ctxmux.sock'), '--state-dir', join(directory, 'state')], { stdio: 'ignore' })
  await writeFile(join(import.meta.dirname, '../../../.tmp/continuation-join/owned-processes.json'), JSON.stringify({daemonPid:daemon.pid,directory,childPid:null}))
  sdk = new CtxmuxClient({ socketPath: join(directory, 'ctxmux.sock') })
  await vi.waitFor(async () => { expect(daemon.exitCode).toBeNull(); expect((await sdk.runtimeInfo()).protocolGeneration).toBe(18) }, { timeout: 5000 })
  client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
  // Existing Core adapter startup seam only: the real SDK connection and all business
  // methods/events below execute. This does NOT validate the unchanged vendor17 pin.
  const inner = client as unknown as { connected: boolean; kernel: CtxmuxRunAdapter; registry: AgentMuxAgentSessionRegistry;
    acceptKernelEvent(event: unknown): void }
  await inner.registry.load('local')
  const kernel = inner.kernel as unknown as { client: CtxmuxClient; runtime: RuntimeIdentity }
  kernel.client = sdk; kernel.runtime = await sdk.runtimeInfo(); inner.connected = true
  unsubscribers.push(inner.kernel.onEvent(event => inner.acceptKernelEvent(event)))
  unsubscribers.push(inner.kernel.onError(error => { failures.push(error) }))
  vi.spyOn(api.sessions, 'attach').mockImplementation(async control => {
    attached = await client.attachTerminal(control.run.runId, 0, 'terminal')
    return { attachmentId: control.run.runId, session: project(attached.run),
      currentSize: { cols: attached.run.cols!, rows: attached.run.rows! }, gap: attached.gap,
      replay: attached.replay.map(chunk => ({ ...chunk, type: 'data' as const })),
      terminal: attached.terminal, resizeRevision: attached.resizeRevision } satisfies SessionAttachResult
  })
  vi.spyOn(api.sessions, 'detach').mockImplementation(async id => { await client.releaseRunAttachment({ runId: id }) })
  vi.spyOn(api.sessions, 'onEvent').mockImplementation((listener: (event: RuntimeEvent) => void) => {
    const remove = client.onEvent((event: AgentMuxClientEvent) => listener({ type: 'core', hostId: 'local', event }))
    unsubscribers.push(remove); return remove
  })
  vi.spyOn(api.sessions, 'write').mockImplementation((_control, data) => {
    const previous = pendingWrites.at(-1) ?? Promise.resolve()
    const next = previous.then(() => send(data)); pendingWrites.push(next); return next as Promise<void>
  })
  vi.spyOn(api.sessions, 'resize').mockImplementation(async (id, cols, rows) => await client.resizeTerminal({runId:id}, cols, rows))
  vi.spyOn(api.sessions, 'historyPage').mockRejectedValue(new Error('History must not be requested by the terminal fixture'))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  config = await api.config.get()
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  const cleanupErrors: string[] = []
  try { if (root) await act(async () => root!.unmount()) } catch (error) { cleanupErrors.push(String(error)) }
  await Promise.allSettled(pendingWrites)
  if (client) {
    try { if (run) await client.stopTerminal({ runId: run.runId }) } catch (error) { cleanupErrors.push(String(error)) }
    unsubscribers.forEach(dispose => dispose())
    await client.dispose()
  }
  if (daemon?.exitCode === null) {
    const exit = new Promise<void>(resolve => daemon.once('exit', () => resolve()))
    daemon.kill('SIGINT')
    await Promise.race([exit, new Promise<void>(resolve => setTimeout(resolve, 3000))])
    if (daemon.exitCode === null && daemon.signalCode === null) { daemon.kill('SIGKILL'); await exit; cleanupErrors.push('private daemon required SIGKILL') }
  }
  const remaining = [daemon?.pid, run?.pid].filter((pid): pid is number => typeof pid === 'number' && alive(pid))
  receipts.push({ cleanup: { remaining, errors: cleanupErrors }, diagnostics: { writes: writes.map(w => ({...w,data:typeof w.data==='string'?w.data:Array.from(w.data)})), failures: failures.map(String), seed:attached?.terminal.type==='basic-vt'?new TextDecoder().decode(attached.terminal.restoreBytes):null } })
  useAppStore.setState(initialState, true); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs()
  if (!remaining.length) await rm(directory, { recursive: true, force: false })
  await writeFile(join(import.meta.dirname, '../../../.tmp/continuation-join/raw.json'), JSON.stringify(receipts, null, 2) + '\n')
  expect(cleanupErrors).toEqual([]); expect(remaining).toEqual([])
})

it.each(['normal', 'alternate'] as const)('joins real native18 checkpoint through public Core into TerminalView for %s wheel input', async mode => {
  run = await client.createTerminal({ workspacePath: directory, command: '/usr/bin/python3', args: ['-u', '-c', python, mode], cols: 12, rows: 4 })
  const originalPid = run.pid
  await writeFile(join(import.meta.dirname, '../../../.tmp/continuation-join/owned-processes.json'), JSON.stringify({daemonPid:daemon.pid,directory,childPid:originalPid}))
  await vi.waitFor(async () => {
    const native = await sdk.status(run!.runId)
    expect(native.latest_output_bytes).toBeGreaterThan(4_950_250)
    expect(native.first_available_byte).toBeGreaterThan(0)
  }, { timeout: 15000 })
  const session = project(run)
  const tab = createWorkbenchTab(origin.tabId, { regionId: origin.regionId, kind: 'terminal', phase: 'attached', workspaceId: origin.workspaceId, sessionId: session.id })
  useAppStore.setState({ sessions: [session], tabs: { [tab.id]: tab }, layouts: { [origin.workspaceId]: createWorkspaceLayout(origin.tabGroupId, [tab.id]) },
    activeWorkspaceId: origin.workspaceId, config, closingWorkbenchViews: {}, regionCaretFocus: null, timelines: {},
    pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [], viewModes: {}, agentNames: {} })
  await act(async () => root!.render(createElement(TerminalView, { session, interactiveResize: false, visible: true,
    autoFocus: false, themeId: config.appearance.terminalTheme, linkOrigin: origin })))
  await act(async () => await vi.waitFor(() => expect(readTerminalViewObservation({ regionId: origin.regionId, sessionId: session.id,
    runId: run!.runId })).toMatchObject({ liveReady: true }), { timeout: 8000 }))
  expect(fixture.terminals).toHaveLength(1)
  const terminal = fixture.terminals[0]!
  expect(terminal.textarea).toBeInstanceOf(HTMLTextAreaElement)
  expect(attached!.terminal.type).toBe('basic-vt')
  expect(attached!.gap).toBeNull()
  expect(contents(terminal)).toContain('READY500')
  expect(terminal.buffer.normal.getLine(0)!.translateToString(true)).toBe('ROW000')
  expect([terminal.cols, terminal.rows]).toEqual([12, 4])
  const before = terminal.buffer.active.viewportY
  let scroll: {before:number;up:number;down:number} | undefined
  if (mode === 'normal') {
    expect(terminal.buffer.active.type).toBe('normal')
    expect(terminal.modes.mouseTrackingMode).toBe('none')
    expect(before).toBeGreaterThan(0)
    await wheel(terminal, -120)
    await act(async () => await vi.waitFor(() => expect(terminal.buffer.active.viewportY).toBeLessThan(before)))
    const up = terminal.buffer.active.viewportY
    await wheel(terminal, 120)
    await act(async () => await vi.waitFor(() => expect(terminal.buffer.active.viewportY).toBeGreaterThan(up)))
    expect(writes).toEqual([])
    scroll={before,up,down:terminal.buffer.active.viewportY}
  } else {
    expect(terminal.buffer.active.type).toBe('alternate')
    expect(terminal.modes.mouseTrackingMode).toBe('any')
    // 20px is deliberately fractional under xterm's trackpad accumulator. This
    // probe uses a complete 120px gesture and validates real nonempty wire reports.
    const up = await wheel(terminal, -120)
    expect(up.defaultPrevented).toBe(true)
    await Promise.all(pendingWrites)
    expect(writes.length).toBeGreaterThan(0)
    expect(writes.map(write => write.data).join('')).toMatch(/^\x1b\[<64;\d+;\d+M/)
    await act(async () => await vi.waitFor(() => expect(contents(terminal)).toMatch(/READY49\d/), { timeout: 3000 }))
    const reportCount = writes.length
    await wheel(terminal, 120)
    await act(async () => await vi.waitFor(() => expect(contents(terminal)).toContain('READY500'), { timeout: 3000 }))
    expect(writes.length).toBeGreaterThan(reportCount)
  }
  await act(async () => { terminal.input('z'); await Promise.all(pendingWrites) })
  await act(async () => await vi.waitFor(() => expect(contents(terminal)).toContain('Z')))
  expect(writes.at(-1)!.data).toBe('z')
  expect(api.sessions.historyPage).not.toHaveBeenCalled()
  expect(fixture.terminals).toEqual([terminal])
  const after = await sdk.status(run.runId)
  expect(after.pid).toBe(originalPid); expect(after.state).toEqual({ type: 'running' })
  expect(after.applied_input_bytes).toBe(inputByte)
  expect(failures).toEqual([])
  receipts.push({ mode, daemonPid: daemon.pid, childPid: originalPid, runId: run.runId,
    firstAvailableByte: after.first_available_byte, latestOutputBytes: after.latest_output_bytes,
    continuation: attached!.terminal.type, seedBytes: attached!.terminal.type === 'basic-vt' ? attached!.terminal.restoreBytes.length : 0,
    normalRows: terminal.buffer.normal.length, scroll, viewportBefore: before, viewportAfter: terminal.buffer.active.viewportY,
    inputBytes: inputByte, inputCalls: writes.length, historyCalls: 0,
    boundaries: { artifactStartup: 'fixture', MainPreloadElectron: 'not executed', wheel: 'DOM WheelEvent, layout fixture', PTY: 'actual' } })
}, 30000)
