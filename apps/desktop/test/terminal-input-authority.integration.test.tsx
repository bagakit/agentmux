const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Terminal as BrowserTerminal } from '@xterm/xterm'
import { readFile, writeFile } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxFileAgentSessionStore, AgentMuxError } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture'
import { bridge, owningBridge } from './helpers/first-execution-ipc-bridge'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { TerminalView } from '../src/renderer/src/components/TerminalView'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { readTerminalViewObservation } from '../src/renderer/src/lib/terminal-view-observation'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import type { AppConfig, SessionControl, SessionSnapshot } from '../src/shared/contracts'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false))
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
  fixture.terminals.length = 0
  scope = await headlessFixture()
  vi.stubEnv('HOME', scope.env.HOME!)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', scope.env.AGENTMUX_STATE_DIRECTORY!)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', scope.env.AGENTMUX_RUNTIME_DIRECTORY!)
  vi.stubEnv('AGENTMUX_SPATIAL_STATE_STORE', join(scope.root, 'spatial.json'))
  const client = await scope.client()
  config = { ...structuredClone(DEFAULT_CONFIG), hosts: [{ id: 'local', kind: 'local', label: 'Private proof' }],
    workspaces: [{ id: 'private', kind: 'folder', hostId: 'local', name: 'Private proof', path: scope.root }] }
  owner = await owningBridge({ client: client as never,
    store: new AgentMuxFileAgentSessionStore(scope.env.AGENTMUX_AGENT_SESSION_STORE!), config })
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
  return session!
}
async function mount(session: SessionSnapshot, readOnly = false) {
  const tab = createWorkbenchTab(origin.tabId, { regionId: origin.regionId, kind: session.kind,
    phase: 'attached', workspaceId: origin.workspaceId, sessionId: session.id })
  useAppStore.setState({ sessions: [session], config, tabs: { [tab.id]: tab },
    layouts: { private: createWorkspaceLayout(origin.tabGroupId, [tab.id]) }, activeWorkspaceId: 'private',
    closingWorkbenchViews: {}, regionCaretFocus: null, timelines: {}, pendingAgentLaunches: {}, recoveryCandidates: [], viewModes: {} })
  await act(async () => root.render(createElement(TerminalView, { session, readOnly, interactiveResize: false,
    visible: true, autoFocus: false, themeId: config.appearance.terminalTheme, linkOrigin: origin })))
  await until(() => fixture.terminals[0]?.textarea, Boolean, 'real mounted xterm textarea')
  return fixture.terminals[0]!
}
async function bytes(expected: Buffer) {
  const observed = await until(() => readFile(received), value => value.length >= expected.length, 'original PTY received input', 5_000)
    .catch(() => readFile(received))
  expect(observed).toEqual(expected)
}

it.each(['terminal', 'agent'] as const)('keeps actual %s keyboard/paste/binary and ACKs while its output attach is pending, retaining read-only and historical protocol guards', async kind => {
  const session = await create(kind)
  const attach = owner.runtime.attachSession.bind(owner.runtime)
  let entering = false
  const held = new Promise<void>(yes => { release = yes })
  vi.spyOn(owner.runtime, 'attachSession').mockImplementation(async (...args) => { entering = true; await held; return attach(...args) })
  const terminal = await mount(session)
  await until(() => entering, Boolean, 'real Main output attachment remains pending')
  expect(readTerminalViewObservation({ regionId: origin.regionId, sessionId: session.id, runId: run.runId }))
    .toMatchObject({ liveReady: false, acceptsInput: true })
  // Public xterm user input feeds the real mounted subscriptions. Parser replies stay historical.
  await act(async () => terminal.input('key'))
  const paste = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(paste, 'clipboardData', { value: { getData: () => 'paste\nline' } })
  await act(async () => { terminal.textarea!.dispatchEvent(paste) })
  expect(paste.defaultPrevented).toBe(true)
  // xterm's real binary/user event source; synthetic mouse coordinates are not this proof.
  await act(async () => { (terminal as unknown as { _core: { coreService: {
    triggerBinaryEvent(value: string): void } } })._core.coreService.triggerBinaryEvent('\x1b[M\x20\x80\xff') })
  // The original Codex Provider encodes Agent paste independently of xterm's Terminal mode.
  const expected = Buffer.concat([Buffer.from(kind === 'agent' ? 'key\x1b[200~paste\nline\x1b[201~' : 'keypaste\rline'), Buffer.from([27, 91, 77, 32, 128, 255])])
  await bytes(expected)
  await act(async () => await new Promise<void>(yes => terminal.write('\x1b[6n', yes)))
  expect(await readFile(received)).toEqual(expected)
  const confirmed = await (owner.client as Awaited<ReturnType<typeof scope.client>>).readRunReplay({ runId: run.runId })
  expect(confirmed.run.acceptedInputBytes).toBe(expected.length)
  expect(confirmed.run.pid).toBe(run.pid)
  const calls = bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:write' || call[0] === 'sessions:paste')
  expect(calls.map(call => call[0])).toEqual(['sessions:write', 'sessions:paste', 'sessions:write'])
  expect(calls.every(call => JSON.stringify(call[1]) === JSON.stringify(session.control))).toBe(true)
  await act(async () => root.render(createElement(TerminalView, { session, readOnly: true, interactiveResize: false,
    visible: true, autoFocus: false, themeId: config.appearance.terminalTheme, linkOrigin: origin })))
  await act(async () => { terminal.input('blocked'); terminal.textarea!.dispatchEvent(paste) })
  expect(await readFile(received)).toEqual(expected)
  records.push({ kind, runId: run.runId, pid: run.pid, expectedHex: expected.toString('hex'), acceptedInputBytes: confirmed.run.acceptedInputBytes,
    liveOutputReady: false, originalControl: session.control, boundary: 'Actual Renderer/xterm→production api→preload→registered Main→Hosted public Core→private official ctxmux PTY. DOM paste and public xterm user input; binary triggered at real xterm event source. Addons/canvas and Electron transport are fixtures. No vendor/model or user Run claim.' })
}, 90_000)

it('preserves typed original observation failures across Error-stripping IPC; human missing text does not recover the Agent', async () => {
  const session = await create('agent')
  const recovery = vi.spyOn(useAppStore.getState(), 'recoverSession').mockResolvedValue(undefined)
  const attach = vi.spyOn(owner.runtime, 'attachSession').mockRejectedValue(new AgentMuxError('Run original does not exist', 'CONTROL_UNAVAILABLE'))
  await mount(session)
  await act(async () => await until(() => container.querySelector('.terminal-service-window'), Boolean, 'unconfirmed attach service window'))
  expect(recovery).not.toHaveBeenCalled()
  await expect(api.sessions.attach(session.control)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE', message: 'Run original does not exist' })
  await act(async () => root.unmount()); root = createRoot(container); fixture.terminals.length = 0
  attach.mockRejectedValue(new AgentMuxError('Exact original Runtime missing', 'CTXMUX_run_not_found'))
  await mount(session)
  await act(async () => await until(() => recovery.mock.calls.length, value => value === 1, 'typed missing triggers original Session recovery'))
  expect(recovery.mock.calls).toEqual([[session.id]])
  await expect(api.sessions.attach(session.control)).rejects.toMatchObject({ code: 'CTXMUX_run_not_found' })
  for (const [method, args] of [['refreshAttachment', [session.control, null, 0]], ['replay', ['private-lease', 0]]] as const) {
    vi.spyOn(owner.runtime, method === 'replay' ? 'readSessionReplay' : 'refreshSessionAttachment')
      .mockRejectedValue(new AgentMuxError('Original typed missing', 'CTXMUX_run_not_found'))
    await expect((api.sessions[method] as (...args: unknown[]) => Promise<unknown>)(...args)).rejects.toMatchObject({ code: 'CTXMUX_run_not_found' })
  }
  records.push({ kind: 'typed-observation', humanTextRecoveryCalls: 0, typedMissingRecovery: session.id,
    channels: ['sessions:attach', 'sessions:refreshAttachment', 'sessions:replay'], source: 'Injected typed Core-style failure at the actual Main owner boundary; private real Run remains healthy. This case verifies transport/classification, not Runtime disappearance.' })
}, 90_000)

it('consumes a nonempty incomplete Main catalogue without removing original workfaces; reconnects them after a real private owner process restart and consumes exact Terminal removal', async () => {
  const agent = await create('agent')
  const agentRun = { ...run }
  const originalReceived = received
  const client = owner.client as Awaited<ReturnType<typeof scope.client>>
  const terminalRun = await client.createTerminal({ createOperationId: 'saved-terminal', workspacePath: scope.root,
    command: process.execPath, args: [resolve('apps/desktop/test/fixtures/input-authority-pty.mjs'), join(scope.root, 'terminal.bytes')], cols: 80, rows: 24 })
  const terminalControl: SessionControl = { kind: 'terminal', hostId: 'local', runId: terminalRun.runId, run: { runId: terminalRun.runId } }
  const terminal = await owner.runtime.refresh(terminalControl, config)
  expect(terminal).toBeDefined()
  const savedPath = join(scope.root, 'renderer-workbench.json')
  useAppStore.persist.setOptions({ storage: {
    getItem: () => { try { return JSON.parse(readFileSync(savedPath, 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error } },
    setItem: (_name, value) => writeFileSync(savedPath, JSON.stringify(value)), removeItem: () => {}
  } })
  disposeUi = await useAppStore.getState().initialize()
  expect(useAppStore.getState().sessions.map(session => session.id)).toContain(agent.id)
  await mount(agent)
  const savedTab = addWorkbenchRegion(addWorkbenchRegion(useAppStore.getState().tabs[origin.tabId]!, origin.regionId, 'right', {
    regionId: 'saved-terminal-region', kind: 'terminal', phase: 'attached', workspaceId: 'private', sessionId: terminal!.id
  }), origin.regionId, 'down', { regionId: 'saved-file-region', kind: 'file', workspaceId: 'private', path: 'original.md' })
  expect(Object.keys(savedTab.regions)).toEqual([origin.regionId, 'saved-terminal-region', 'saved-file-region'])
  const focus = { execution: { sessionId: agent.id, history: [{ sessionId: agent.id, focusedAt: _reshape_fixtureEpoch(0, 0, 1) }] }, pmo: { sessionId: null } }
  useAppStore.setState({ sessions: [agent, terminal!], tabs: { [origin.tabId]: savedTab }, agentFocus: focus,
    agentComposerDrafts: { [agent.id]: 'original draft survives' } })
  const originalLayout = structuredClone(useAppStore.getState().layouts.private)
  const snapshot = owner.runtime.snapshot.bind(owner.runtime)
  let incompleteReads = 0
  const catalogue = vi.spyOn(owner.runtime, 'snapshot').mockImplementation(async (...args) => {
    incompleteReads++
    const actual = await snapshot(...args)
    const sessions = actual.sessions.filter(session => session.id !== agent.id && session.id !== terminal!.id)
    return { ...actual, sessions, timelines: Object.fromEntries(Object.entries(actual.timelines).filter(([id]) => id !== agent.id)) }
  })
  const other = await client.createAgent({ createOperationId: 'unrelated-agent', providerId: 'codex', executorId: 'codex',
    workspacePath: scope.root, commandOverride: process.execPath,
    args: [resolve('apps/desktop/test/fixtures/input-authority-pty.mjs'), join(scope.root, 'unrelated.bytes')], injectAgentMuxGuide: false })
  await until(() => incompleteReads, count => count > 0, 'real unknown Agent event reaches Store membership reader')
  await until(() => useAppStore.getState().sessions.some(session => session.id === other.agentSessionId), Boolean, 'positive membership merged')
  expect(useAppStore.getState().tabs[origin.tabId]).toMatchObject(savedTab)
  expect(useAppStore.getState().layouts.private).toEqual(originalLayout)
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(expect.arrayContaining([agent.id, terminal!.id]))
  expect(useAppStore.getState().agentFocus).toEqual(focus)
  expect(useAppStore.getState().agentComposerDrafts[agent.id]).toBe('original draft survives')
  const saved = JSON.parse(await readFile(savedPath, 'utf8'))
  const savedSpatial = await until(() => api.spatial.read(), value => value?.graph.regions.some(region => region.regionId === 'saved-file-region') === true, 'original split durably committed by Core spatial owner')
  expect(savedSpatial!.graph.regions.map(region => region.regionId)).toEqual(expect.arrayContaining([origin.regionId, 'saved-terminal-region', 'saved-file-region']))
  expect(saved.state.agentComposerDrafts[agent.id]).toBe('original draft survives')
  catalogue.mockRestore()
  await act(async () => root.unmount()); root = createRoot(container); fixture.terminals.length = 0
  disposeUi(); disposeUi = undefined
  await owner.dispose()
  const beforeOwner = scope.owner.ownerInstanceId
  const beforeOwnerPid = scope.owner.processId
  await scope.restart()
  expect(scope.owner.ownerInstanceId).not.toBe(beforeOwner)
  expect(scope.owner.processId).not.toBe(beforeOwnerPid)
  expect(() => process.kill(beforeOwnerPid, 0)).toThrow()
  const restarted = await scope.client()
  const originalStatus = await restarted.statusAgent(agent.id)
  expect(originalStatus.session.run.runId).toBe(agentRun.runId)
  expect(originalStatus.run.pid).toBe(agentRun.pid)
  owner = await owningBridge({ client: restarted as never, store: new AgentMuxFileAgentSessionStore(scope.env.AGENTMUX_AGENT_SESSION_STORE!), config })
  // Hydrate the actual durable Store after the real Runtime owner exited. This is not an Electron restart.
  useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
  useAppStore.setState(original, true)
  useAppStore.persist.setOptions({ storage: { getItem: () => saved, setItem: (_name, value) => writeFileSync(savedPath, JSON.stringify(value)), removeItem: () => {} } })
  await useAppStore.persist.rehydrate()
  disposeUi = await useAppStore.getState().initialize()
  expect(useAppStore.getState().tabs[origin.tabId]).toMatchObject(savedTab)
  expect(useAppStore.getState().layouts.private).toEqual(originalLayout)
  expect(useAppStore.getState().agentFocus).toEqual(focus)
  expect(useAppStore.getState().agentComposerDrafts[agent.id]).toBe('original draft survives')
  const reattached = useAppStore.getState().sessions.find(session => session.id === agent.id)!
  expect(reattached.control).toEqual(agent.control)
  const xterm = await mount(reattached)
  received = originalReceived
  await act(async () => xterm.input('after-owner-restart'))
  await bytes(Buffer.from('after-owner-restart'))
  // mount's helper intentionally installs one original View; restore the checked split before exact removal.
  useAppStore.setState({ sessions: [reattached, terminal!], tabs: { [origin.tabId]: savedTab }, layouts: { private: originalLayout! } })
  await restarted.stopTerminal(terminalControl.run)
  await until(() => restarted.readRunReplay(terminalControl.run), value => value.run.state === 'exited', 'private original Terminal ended')
  await restarted.removeTerminal(terminalControl.run)
  await until(() => useAppStore.getState().tabs[origin.tabId]?.regions['saved-terminal-region'], value => value === undefined,
    'real exact original run-removed receipt closes only its Terminal Region')
  expect(useAppStore.getState().tabs[origin.tabId]?.regions[origin.regionId]).toMatchObject({ sessionId: agent.id })
  expect(useAppStore.getState().tabs[origin.tabId]?.regions['saved-file-region']).toMatchObject({ path: 'original.md' })
  records.push({ kind: 'membership-and-owner-restart', incompleteReads, agentRun, beforeOwner, beforeOwnerPid, afterOwnerPid: scope.owner.processId, afterOwner: scope.owner.ownerInstanceId,
    originalControl: agent.control, originalTabId: origin.tabId, originalRegionId: origin.regionId, terminalRemoved: terminalControl,
    actualRuntimeOwnerRestart: true, actualElectronRestart: false, freshRendererProcess: false,
    boundary: 'Actual Main catalogue positive/incomplete cut→production preload/API→Store resync/persist; real private Headless owner exited/restarted while original ctxmux Agent PID remained; production Store hydration and mounted input reconnect. Incomplete catalogue is deliberate Main-boundary fault injection. No vendor/model claim.' })
}, 90_000)

afterEach(async () => {
  const destination = process.env.AGENTMUX_INPUT_AUTHORITY_CONSUMER_RECEIPT
  if (destination) await writeFile(destination, JSON.stringify({ records, private: true, userRunTouched: false }, null, 2) + '\n')
})
