// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Terminal as BrowserTerminal } from '@xterm/xterm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AgentMuxTerminalResize } from '@agentmux/core'
import type { AppConfig, RuntimeEvent, SessionAttachResult, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { TerminalView } from '../src/renderer/src/components/TerminalView'
import { readTerminalViewObservation } from '../src/renderer/src/lib/terminal-view-observation'
import { rendererPerformance } from '../src/renderer/src/lib/renderer-performance'

// Actual xterm.open/parser/selection and viewport owner; only transport and font/paint are fixture seams.
const fixture = vi.hoisted(() => ({ terminals: [] as BrowserTerminal[] }))
vi.mock('@xterm/xterm', async () => {
  const { Terminal } = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm')
  return { Terminal: class extends Terminal {
    constructor(options: ConstructorParameters<typeof Terminal>[0]) { super(options); fixture.terminals.push(this) }
  } }
})
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { activate() {} dispose() {} fit() {} proposeDimensions() { return { cols: 80, rows: 24 } } } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { activate() {} dispose() {} onDidChangeResults() { return { dispose() {} } } } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { activate() {} dispose() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { activate() {} dispose() {} onContextLoss() { return { dispose() {} } } } }))
vi.mock('../src/renderer/src/components/TerminalContextMenu', () => ({ TerminalContextMenu: ({ children }: { children: ReactNode }) => children }))

const initial = useAppStore.getState(), encoder = new TextEncoder(), fence = 10_000
const origin = { workspaceId: 'reading', tabGroupId: 'group', tabId: 'tab', regionId: 'region' }
const session: SessionSnapshot = { id: 'reading-run', kind: 'terminal', providerId: null,
  hostId: 'local', workspacePath: '/private/reading-fixture', label: 'Private reading', createdAt: 1, updatedAt: 1,
  processState: 'running', status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: fence,
  control: { kind: 'terminal', hostId: 'local', runId: 'reading-run', run: { runId: 'reading-run' } } }
let root: Root, container: HTMLDivElement, configuration: AppConfig
let receive: (event: RuntimeEvent) => void
function attachment(seed: string, tail = '', throughByte = fence, resizes: AgentMuxTerminalResize[] = []): SessionAttachResult {
  const bytes = encoder.encode(tail), latestOutputBytes = throughByte + bytes.length
  return { attachmentId: 'reading-attachment', session: { ...session, latestOutputBytes },
    currentSize: resizes.at(-1)?.size ?? { cols: 80, rows: 24 }, gap: null, resizeRevision: resizes.at(-1)?.resizeRevision ?? 3,
    terminal: { type: 'basic-vt', checkpoint: { runId: session.control.run.runId, throughByte, resizeRevision: 3,
      size: { cols: 80, rows: 24 }, restoreSize: { cols: 80, rows: 24 }, restoreScrollbackRows: null, resizeAfterRestoreBytes: 0 },
      restoreBytes: encoder.encode(seed), resizes },
    replay: bytes.length ? [{ type: 'data', runId: session.control.run.runId, startByte: throughByte,
      endByte: latestOutputBytes, dataBytes: bytes, data: tail }] : [] }
}
function snapshot(value: SessionAttachResult): RuntimeEvent {
  return { type: 'core', hostId: 'local', event: { type: 'terminal-snapshot', afterByte: fence,
    run: { runId: session.id, kind: 'terminal', agentSessionId: null, providerId: null, executorId: null,
      workspacePath: session.workspacePath, pid: 1, state: 'running', cols: value.currentSize?.cols ?? null,
      rows: value.currentSize?.rows ?? null, observedAt: 1, latestOutputBytes: value.session.latestOutputBytes,
      acceptedInputBytes: 0, nativeService: null },
    terminal: value.terminal, replay: value.replay, gap: value.gap, resizeRevision: value.resizeRevision } }
}
function output(startByte: number, data: string): RuntimeEvent {
  const dataBytes = encoder.encode(data)
  return { type: 'core', hostId: 'local', event: { type: 'terminal-output', run: session.control.run,
    data, dataBytes, evidence: { source: 'terminal-output', observedAt: 1,
      outputByteRange: { startByte, endByte: startByte + dataBytes.length } } } }
}
async function idle() {
  await act(async () => {
    await vi.waitFor(() => expect(readTerminalViewObservation({ regionId: origin.regionId,
      sessionId: session.id, runId: session.id })).toMatchObject({ liveReady: true }))
    await vi.waitFor(() => expect(rendererPerformance.snapshot().terminals.find(value => value.runId === session.id))
      .toMatchObject({ queuedItems: 0, inFlightWrites: 0, replaying: false }))
    await new Promise(resolve => setTimeout(resolve, 30))
  })
}
async function deliver(event: RuntimeEvent) { await act(async () => receive(event)); await idle() }
async function ready(value: SessionAttachResult) {
  vi.spyOn(api.sessions, 'attach').mockResolvedValue(value)
  const tab = createWorkbenchTab(origin.tabId, { regionId: origin.regionId, kind: 'terminal', phase: 'attached',
    workspaceId: origin.workspaceId, sessionId: session.id })
  useAppStore.setState({ config: configuration, sessions: [value.session], tabs: { [tab.id]: tab },
    layouts: { reading: createWorkspaceLayout(origin.tabGroupId, [tab.id]) }, activeWorkspaceId: 'reading',
    runtimeEndpointWarnings: [], regionCaretFocus: null, closingWorkbenchViews: {}, timelines: {} })
  await act(async () => root.render(createElement(TerminalView, { session: value.session,
    interactiveResize: false, visible: true, autoFocus: false, themeId: configuration.appearance.terminalTheme,
    linkOrigin: origin })))
  await idle()
  expect(fixture.terminals).toHaveLength(1)
  return fixture.terminals[0]!
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('OffscreenCanvas', undefined)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ font: '',
    measureText: () => ({ width: 8, actualBoundingBoxDescent: 2, actualBoundingBoxAscent: 10 }) }) as unknown as CanvasRenderingContext2D)
  fixture.terminals.length = 0
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => { receive = listener; return () => {} })
  vi.spyOn(api.sessions, 'detach').mockResolvedValue()
  vi.spyOn(api.sessions, 'resize').mockResolvedValue({ cols: 80, rows: 24 })
  vi.spyOn(api.sessions, 'write').mockResolvedValue()
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
  configuration = await api.config.get()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); useAppStore.setState(initial, true)
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const history = '\x1bc' + Array.from({ length: 800 }, (_, index) => 'ROW' + String(index).padStart(3, '0')).join('\r\n')

it.each(['reading', 'latest'] as const)('live reconnect keeps the original %s intent and real selection without reimporting its seed', async intent => {
  const terminal = await ready(attachment(history))
  await act(async () => {
    if (intent === 'reading') terminal.scrollToLine(300)
    terminal.restoreSelection({ anchor: { x: 6, y: 300 }, active: { x: 0, y: 300 }, mode: 'normal', selectAll: false })
  })
  const selected = terminal.getSelectionSnapshot(), text = terminal.getSelection()
  expect(text).toBe('ROW300')
  const writes = vi.spyOn(terminal, 'write')
  await deliver(snapshot(attachment(history, '\r\nNEW-LIVE')))
  expect(writes.mock.calls.length).toBeGreaterThan(0)
  expect(writes.mock.calls.every(([data]) => !new TextDecoder().decode(data as Uint8Array).includes('ROW000'))).toBe(true)
  expect(terminal.getSelection()).toBe(text); expect(terminal.getSelectionSnapshot()).toEqual(selected)
  if (intent === 'reading') {
    expect(terminal.buffer.active.viewportY).toBe(300)
    expect(terminal.buffer.active.getLine(300)?.translateToString(true)).toBe('ROW300')
  } else expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY)
  expect(fixture.terminals).toEqual([terminal]); expect(api.sessions.attach).toHaveBeenCalledTimes(1)
  expect(api.sessions.write).not.toHaveBeenCalled()
})

it('live reconnect keeps the original reading row and selection through ordered grid changes', async () => {
  const terminal = await ready(attachment(history))
  await act(async () => { terminal.scrollToLine(300); terminal.select(0, 300, 6) })
  await deliver(snapshot(attachment(history, '', fence, [
    { throughByte: fence, resizeRevision: 4, size: { cols: 80, rows: 9 } },
    { throughByte: fence, resizeRevision: 5, size: { cols: 40, rows: 24 } }
  ])))
  expect([terminal.cols, terminal.rows]).toEqual([40, 24])
  expect(terminal.buffer.active.getLine(terminal.buffer.active.viewportY)?.translateToString(true)).toBe('ROW300')
  expect(terminal.getSelection()).toBe('ROW300')
  expect(api.sessions.write).not.toHaveBeenCalled()
})

it.each(['ahead', 'unknown', 'late-resize'] as const)('live reconnect retains its honest %s continuation gap instead of signing a retained canvas recovered', async cause => {
  const first = attachment(history, 'old-tail')
  if (cause === 'unknown') {
    const raw = encoder.encode(history + 'old-tail')
    first.terminal = { type: 'unknown', reason: 'origin_unknown' }
    first.replay = [{ type: 'data', runId: session.id, startByte: 0, endByte: raw.length, dataBytes: raw, data: history + 'old-tail' }]
    first.session = { ...first.session, latestOutputBytes: raw.length }
  }
  const terminal = await ready(first)
  await act(async () => { terminal.scrollToLine(300); terminal.select(0, 300, 6) })
  const newer = attachment('\x1bcREPLACEMENT', cause === 'late-resize' ? 'old-tail' : '',
    cause === 'ahead' ? fence + 100 : cause === 'unknown' ? first.session.latestOutputBytes : fence, cause === 'late-resize' ? [
      { throughByte: fence, resizeRevision: 4, size: { cols: 80, rows: 9 } }
    ] : [])
  await deliver(snapshot(newer))
  expect(terminal.buffer.active.getLine(terminal.buffer.active.viewportY)?.translateToString(true)).toBe('ROW300')
  expect(terminal.getSelection()).toBe('ROW300')
  expect(container.textContent).toContain('existing display may be incomplete')
  expect(readTerminalViewObservation({ regionId: origin.regionId, sessionId: session.id, runId: session.id })?.acceptsInput).toBe(true)
  expect(api.sessions.write).not.toHaveBeenCalled()
})

it('live reconnect does not clear an older unfilled Runtime history gap after applying a continuous new suffix', async () => {
  const terminal = await ready(attachment(history))
  vi.spyOn(api.sessions, 'replay').mockResolvedValue({ replay: [], gap: { requestedAfterByte: fence,
    firstAvailableByte: fence + 4 } })
  await deliver(output(fence + 4, 'LIVE'))
  expect(container.textContent).toContain('Earlier scrollback is unavailable')
  await deliver(snapshot(attachment('\x1bcCURRENT-SCREEN', 'NEXT', fence + 8)))
  expect(container.textContent).toContain('Earlier scrollback is unavailable')
  expect(terminal.buffer.normal.getLine(0)?.translateToString(true)).toBe('ROW000')
  expect(api.sessions.write).not.toHaveBeenCalled()
})

it('live reconnect retains a malformed checkpoint failure without changing the canvas or input qualification', async () => {
  const terminal = await ready(attachment(history))
  await act(async () => { terminal.scrollToLine(300); terminal.select(0, 300, 6) })
  const invalid = attachment('\x1bcUNPROVEN')
  invalid.session = { ...invalid.session, latestOutputBytes: fence + 100 }
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await deliver(snapshot(invalid))
  expect(warning).toHaveBeenCalledTimes(1)
  expect(terminal.buffer.active.getLine(terminal.buffer.active.viewportY)?.translateToString(true)).toBe('ROW300')
  expect(terminal.getSelection()).toBe('ROW300')
  expect(container.textContent).toContain('could not validate the terminal checkpoint')
  expect(readTerminalViewObservation({ regionId: origin.regionId, sessionId: session.id, runId: session.id })?.acceptsInput).toBe(true)
  expect(api.sessions.write).not.toHaveBeenCalled()
})

it('live reconnect does not erase an earlier missing resize after a later complete metadata suffix', async () => {
  const terminal = await ready(attachment(history))
  await act(async () => { terminal.scrollToLine(300); terminal.select(0, 300, 6) })
  await deliver({ type: 'core', hostId: 'local', event: { type: 'terminal-resized', run: session.control.run,
    throughByte: fence, resizeRevision: 5, cols: 80, rows: 9 } })
  expect(container.textContent).toContain('cannot prove continuous terminal state')
  await deliver(snapshot(attachment(history, '', fence, [
    { throughByte: fence, resizeRevision: 4, size: { cols: 80, rows: 9 } },
    { throughByte: fence, resizeRevision: 5, size: { cols: 80, rows: 9 } }
  ])))
  expect(container.textContent).toContain('cannot prove continuous terminal state')
  expect(terminal.buffer.active.getLine(terminal.buffer.active.viewportY)?.translateToString(true)).toBe('ROW300')
  expect(terminal.getSelection()).toBe('ROW300')
  expect(api.sessions.write).not.toHaveBeenCalled()
})
