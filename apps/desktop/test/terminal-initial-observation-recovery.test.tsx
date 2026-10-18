const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Terminal as BrowserTerminal } from '@xterm/xterm'
import { readFile, writeFile } from 'node:fs/promises'
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxFileAgentSessionStore, AgentMuxError } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture'
import { bridge, owningBridge } from './fixtures/terminal-observation-bridge'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { TerminalView } from '../src/renderer/src/components/TerminalView'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { readTerminalViewObservation } from '../src/renderer/src/lib/terminal-view-observation'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { SESSION_EVENT_CHANNEL, type AppConfig, type SessionControl, type SessionSnapshot } from '../src/shared/contracts'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false))
const fixture = vi.hoisted(() => ({ terminals: [] as BrowserTerminal[], reports: [] as import('@agentmux/core').AgentMuxClientIncidentReport[] }))
vi.mock('../src/renderer/src/lib/client-incident-recorder', async load => {
  const actual = await load<typeof import('../src/renderer/src/lib/client-incident-recorder')>()
  return { ...actual, createClientIncidentRecorder(input: Parameters<typeof actual.createClientIncidentRecorder>[0]) {
    return actual.createClientIncidentRecorder({ ...input, send: report => { fixture.reports.push(report); input.send(report) } })
  } }
})
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
vi.mock('../src/renderer/src/components/TerminalContextMenu', async () => {
  const { createElement } = await import('react')
  return { TerminalContextMenu: ({ children }: { children: ReactNode }) => createElement('div', null, children) }
})

const original = useAppStore.getState()
const origin = { workspaceId: 'private', tabGroupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }
let scope: Awaited<ReturnType<typeof headlessFixture>>
let owner: Awaited<ReturnType<typeof owningBridge>>
let config: AppConfig, root: Root, container: HTMLDivElement
let run: { runId: string; pid: number | null }, received: string
let release: (() => void) | undefined
let refreshObservation: (() => Promise<void>) | null = null
let disposeUi: (() => void) | undefined
const persistenceOptions = useAppStore.persist.getOptions()
const records: unknown[] = []

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('OffscreenCanvas', undefined)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ font: '',
    measureText: () => ({ width: 8, actualBoundingBoxDescent: 2, actualBoundingBoxAscent: 10 })
  }) as unknown as CanvasRenderingContext2D)
  fixture.terminals.length = 0; fixture.reports.length = 0; refreshObservation = null
  scope = await headlessFixture()
  resource({ event: 'allocated', root: scope.root, nativePid: scope.nativeProcessId, ownerPid: scope.ownerProcess.pid })
  vi.stubEnv('HOME', scope.env.HOME!)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', scope.env.AGENTMUX_STATE_DIRECTORY!)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', scope.env.AGENTMUX_RUNTIME_DIRECTORY!)
  vi.stubEnv('AGENTMUX_SPATIAL_STATE_STORE', join(scope.root, 'spatial.json'))
  const client = await scope.client()
  config = { ...structuredClone(DEFAULT_CONFIG), hosts: [{ id: 'local', kind: 'local', label: 'Private proof' }],
    workspaces: [{ id: 'private', kind: 'folder', hostId: 'local', name: 'Private proof', path: scope.root }] }
  owner = await owningBridge({ client: client as never,
    store: new AgentMuxFileAgentSessionStore(scope.env.AGENTMUX_AGENT_SESSION_STORE!), config })
  resource({ event: 'bridge', root: bridge.directory })
  // Electron strips custom Error fields on rejected invoke. Fulfilled IPC data is copied.
  const invoke = bridge.invoke.getMockImplementation()!
  bridge.invoke.mockImplementation(async (...args) => {
    try { return structuredClone(await invoke(...args)) }
    catch (error) { throw new Error(error instanceof Error ? error.message : String(error)) }
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  disposeUi?.(); disposeUi = undefined
  useAppStore.persist.setOptions(persistenceOptions)
  await act(async () => root?.unmount())
  release?.(); release = undefined
  try { await owner?.dispose() } finally { await scope?.cleanup() }
  resource({ event: 'released', root: scope?.root, nativePid: scope?.nativeProcessId, ownerPid: scope?.ownerProcess.pid })
  if (run?.pid) expect(() => process.kill(run.pid!, 0)).toThrow()
  useAppStore.setState(original, true)
  document.body.replaceChildren(); bridge.listeners.clear(); vi.restoreAllMocks(); vi.unstubAllEnvs()
})

async function create(kind: 'terminal' | 'agent') {
  received = join(scope.root, 'received.bytes')
  const client = owner.client as Awaited<ReturnType<typeof scope.client>>
  const script = resolve('apps/desktop/test/fixtures/input-authority-pty.mjs')
  let control: SessionControl
  if (kind === 'terminal') {
    run = await client.createTerminal({ createOperationId: 'original-terminal', workspacePath: scope.root,
      command: process.execPath, args: [script, received], cols: 80, rows: 24 })
    control = { kind, hostId: 'local', runId: run.runId, run: { runId: run.runId } }
  } else {
    const session = await client.createAgent({ createOperationId: 'original-agent', providerId: 'codex', executorId: 'codex',
      workspacePath: scope.root, commandOverride: process.execPath, args: [script, received], injectAgentMuxGuide: false, cols: 80, rows: 24 })
    run = (await client.listRuns()).find(run => run.runId === session.run.runId)!
    expect(run).toBeDefined()
    control = { kind, hostId: 'local', agentSessionId: session.agentSessionId, run: session.run }
  }
  const session = await owner.runtime.refresh(control, config)
  expect(session).toBeDefined()
  await until(() => readFile(received).catch(() => null), value => value !== null, 'private raw PTY ready')
  resource({ event: 'run', runId: run.runId, pid: run.pid })
  return session!
}
async function mount(session: SessionSnapshot, readOnly = false, visible = true) {
  const tab = createWorkbenchTab(origin.tabId, { regionId: origin.regionId, kind: session.kind,
    phase: 'attached', workspaceId: origin.workspaceId, sessionId: session.id })
  useAppStore.setState({ sessions: [session], config, tabs: { [tab.id]: tab },
    layouts: { private: createWorkspaceLayout(origin.tabGroupId, [tab.id]) }, activeWorkspaceId: 'private',
    closingWorkbenchViews: {}, regionCaretFocus: null, timelines: {}, pendingAgentLaunches: {}, recoveryCandidates: [], viewModes: {} })
  await act(async () => root.render(createElement(TerminalView, { session, readOnly, interactiveResize: false,
    visible, autoFocus: false, themeId: config.appearance.terminalTheme, linkOrigin: origin,
    onObservationRefresh: value => { refreshObservation = value } })))
  await until(() => fixture.terminals[0]?.textarea, Boolean, 'real mounted xterm textarea')
  return fixture.terminals[0]!
}
async function bytes(expected: Buffer) {
  const observed = await until(() => readFile(received), value => value.length >= expected.length, 'original PTY received input', 5_000)
    .catch(() => readFile(received))
  expect(observed).toEqual(expected)
}

function resource(entry: Record<string, unknown>) { if (process.env.TERMINAL_RECOVERY_RESOURCES) appendFileSync(process.env.TERMINAL_RECOVERY_RESOURCES, JSON.stringify({ ...entry, workerPid: process.pid }) + '\n') }
function wait(ms: number) { return new Promise<void>(resolve => setTimeout(resolve, ms)) }
const failure = (code = 'CONTROL_CONNECTION_FAILED') => new AgentMuxError('Original output connection observation failed.', code)
function observation(session: SessionSnapshot) {
  return readTerminalViewObservation({ regionId: origin.regionId, sessionId: session.id, runId: session.control.run.runId })
}

it('automatically restores the original private PTY output through the mounted Main consumer without metadata scans, input or restart', async () => {
  const session = await create('agent'), client = owner.client as Awaited<ReturnType<typeof scope.client>>
  const attach = vi.spyOn(owner.runtime, 'attachSession').mockRejectedValueOnce(failure()).mockRejectedValueOnce(failure())
  const refresh = vi.spyOn(owner.runtime, 'refreshSessionAttachment')
  const metadata = vi.spyOn(useAppStore.getState(), 'refreshSession')
  const recover = vi.spyOn(useAppStore.getState(), 'recoverSession')
  const terminal = await mount(session)
  await act(async () => await vi.waitFor(() => expect(observation(session)?.liveReady).toBe(true), { timeout: 5000 }))
  expect(refresh).toHaveBeenCalledTimes(2)
  expect(refresh.mock.calls.every(call => call[0] === owner.sender.id && JSON.stringify(call[1]) === JSON.stringify(session.control) && call[2] === null && call[3] === 0)).toBe(true)
  expect(attach).toHaveBeenCalledTimes(3)
  expect(metadata).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
  expect(fixture.terminals).toEqual([terminal])
  expect(Array.from({ length: terminal.buffer.active.length }, (_, index) => terminal.buffer.active.getLine(index)?.translateToString(true)).join('\n')).toContain('private-input-owner-ready')
  const original = await client.readRunReplay(session.control.run)
  expect(original.run.pid).toBe(run.pid); expect(original.run.state).toBe('running')
  expect(original.run.acceptedInputBytes).toBe(0)
  expect(useAppStore.getState().tabs[origin.tabId]!.regions[origin.regionId]).toMatchObject({ sessionId: session.id })
  expect(bridge.invoke.mock.calls.filter(call => ['sessions:write', 'sessions:paste', 'sessions:restart', 'sessions:recover'].includes(call[0]))).toEqual([])
  const failed = fixture.reports.filter(report => report.kind === 'terminal-attach-failed')
  const recovered = fixture.reports.find(report => report.kind === 'terminal-recovered')!
  expect(failed).toHaveLength(2)
  expect(recovered.relatedOccurrenceId).toBe(failed[1]!.occurrenceId)
  await act(async () => { await refreshObservation!() })
  const independent = fixture.reports.filter(report => report.kind === 'terminal-refresh' && report.stage === 'refresh-requested').at(-1)!
  expect(independent.relatedOccurrenceId).toBeNull()
  owner.sender.send(SESSION_EVENT_CHANNEL, { type: 'core', hostId: session.hostId, event: { type: 'attachment-state',
    state: 'unavailable', run: session.control.run, afterByte: original.run.latestOutputBytes,
    diagnostic: { code: 'CONTROL_CONNECTION_FAILED', message: 'Established Core observation owns recovery.' } } })
  await act(async () => await wait(600))
  expect(refresh).toHaveBeenCalledTimes(3)
  expect(fixture.reports.filter(report => report.kind === 'terminal-attach-failed').at(-1)!.relatedOccurrenceId).toBeNull()
}, 30000)

it('holds the actual first request slot across manual refresh and a pending reply, then releases a late lease on unmount', async () => {
  const session = await create('terminal'), held = new Promise<void>(resolve => { release = resolve })
  const attach = owner.runtime.attachSession.bind(owner.runtime)
  const attaching = vi.spyOn(owner.runtime, 'attachSession').mockImplementation(async (...args) => { await held; return await attach(...args) })
  const refresh = vi.spyOn(owner.runtime, 'refreshSessionAttachment')
  await mount(session)
  expect(refreshObservation).toBeTypeOf('function')
  const pending = refreshObservation!()
  await act(async () => await wait(650))
  expect(attaching).toHaveBeenCalledTimes(1); expect(refresh).not.toHaveBeenCalled()
  await act(async () => root.unmount()); root = createRoot(container)
  release!(); release = undefined
  await pending
  await vi.waitFor(() => expect(owner.runtime.resourceOwnerCounts()).toEqual({ sessionAttachmentOwners: 0, sessionAttachmentLeases: 0 }))
}, 15000)

it.each(['CONTROL_PROTOCOL_ERROR', 'CONTROL_CANCELLED', 'STALE_AGENT_SESSION_BINDING'])('keeps %s as a persistent service window without automatic reattachment', async code => {
  const session = await create('terminal')
  vi.spyOn(owner.runtime, 'attachSession').mockRejectedValue(failure(code))
  const refresh = vi.spyOn(owner.runtime, 'refreshSessionAttachment')
  await mount(session)
  await act(async () => await wait(650))
  expect(refresh).not.toHaveBeenCalled()
  expect(observation(session)?.liveReady).toBe(false)
  expect(container.querySelector('.terminal-service-window')?.textContent).toContain('Refresh observation')
}, 15000)

it('bounds one failure window and re-arms only after the failed consumer is shown again', async () => {
  const session = await create('terminal')
  vi.spyOn(owner.runtime, 'attachSession').mockRejectedValue(failure())
  const refresh = vi.spyOn(owner.runtime, 'refreshSessionAttachment')
  await mount(session)
  await act(async () => await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(3), { timeout: 5000 }))
  await act(async () => await wait(800))
  expect(refresh).toHaveBeenCalledTimes(3)
  await mount(session, false, false)
  await act(async () => await wait(650))
  expect(refresh).toHaveBeenCalledTimes(3)
  await mount(session)
  await act(async () => await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(4), { timeout: 1600 }))
}, 15000)

it('cancels a hidden or replaced consumer wake', async () => {
  const session = await create('terminal')
  vi.spyOn(owner.runtime, 'attachSession').mockRejectedValue(failure())
  const refresh = vi.spyOn(owner.runtime, 'refreshSessionAttachment')
  await mount(session)
  await mount(session, false, false)
  await act(async () => await wait(650))
  expect(refresh).not.toHaveBeenCalled()
  await act(async () => root.unmount()); root = createRoot(container)
  const changed = { ...session, control: { ...session.control, run: { runId: 'replacement-run' } } }
  await mount(changed)
  await act(async () => root.unmount()); root = createRoot(container)
  await act(async () => await wait(650))
  expect(refresh).not.toHaveBeenCalled()
}, 15000)

it('retains the first returned lease but refuses a foreign Run continuation without retrying or applying its bytes', async () => {
  const session = await create('terminal')
  vi.spyOn(owner.runtime, 'attachSession').mockRejectedValue(failure())
  const foreign = { ...session, control: { ...session.control, run: { runId: 'foreign-run' } } }
  const text = 'FOREIGN-CONTINUATION'
  const refresh = vi.spyOn(owner.runtime, 'refreshSessionAttachment').mockResolvedValue({ attachmentId: 'returned-lease',
    session: foreign, currentSize: { cols: 80, rows: 24 }, gap: null, terminal: { type: 'unknown', reason: 'origin_unknown' }, resizeRevision: 0,
    replay: [{ type: 'data', runId: session.control.run.runId, startByte: 0, endByte: text.length, data: text, dataBytes: new TextEncoder().encode(text) }] })
  const terminal = await mount(session)
  await act(async () => await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1), { timeout: 1500 }))
  await act(async () => await wait(600))
  expect(observation(session)?.liveReady).toBe(false)
  expect(Array.from({ length: terminal.buffer.active.length }, (_, index) => terminal.buffer.active.getLine(index)?.translateToString(true)).join('\n')).not.toContain(text)
  expect(refresh).toHaveBeenCalledTimes(1)
}, 15000)
