import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { Window } from 'happy-dom'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, defineAgentProvider } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { RuntimeController } from '../../src/main/runtime-controller'

const [mode, directory] = process.argv.slice(2)
assert.ok(mode === 'first' || mode === 'second')
const progress = (stage: string) => process.stderr.write(JSON.stringify({ mode, stage }) + '\n')
const window = new Window({ url: 'http://private-restart.test' })
window.document.write('<!doctype html><html><body></body></html>')
const storagePath = join(directory, 'workbench.json')
Object.defineProperty(window, 'localStorage', { value: {
  getItem(key: string) { return existsSync(storagePath) ? JSON.parse(readFileSync(storagePath, 'utf8'))[key] ?? null : null },
  setItem(key: string, value: string) { const values = existsSync(storagePath) ? JSON.parse(readFileSync(storagePath, 'utf8')) : {}; values[key] = value; writeFileSync(storagePath, JSON.stringify(values)) },
  removeItem(key: string) { const values = existsSync(storagePath) ? JSON.parse(readFileSync(storagePath, 'utf8')) : {}; delete values[key]; writeFileSync(storagePath, JSON.stringify(values)) }
} })
for (const key of ['document', 'navigator', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Text', 'MutationObserver', 'DOMParser', 'CustomEvent', 'KeyboardEvent', 'Event', 'MouseEvent', 'PointerEvent', 'HTMLCanvasElement', 'DOMRect']) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: (window as any)[key] })
}
Object.assign(globalThis, { window, self: window, getComputedStyle: window.getComputedStyle.bind(window), matchMedia: window.matchMedia.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true,
  __preAdmissionRestartTerminals: [] })
Object.defineProperties(window.HTMLElement.prototype, {
  offsetWidth: { configurable: true, get() { return this.classList.contains('xterm-char-measure-element') ? this.textContent!.length * 9 : 800 } },
  offsetHeight: { configurable: true, get() { return this.classList.contains('xterm-char-measure-element') ? 18 : 480 } }
})
window.HTMLCanvasElement.prototype.getContext = (() => ({ font: '', measureText: () => ({ width: 8, actualBoundingBoxDescent: 2, actualBoundingBoxAscent: 10 }) })) as never
const { act } = await import('react')
const { createClientUiRoot } = await import('../helpers/client-ui-render')
const { SessionPane } = await import('../../src/renderer/src/components/SessionPane')
const { api } = await import('../../src/renderer/src/lib/api')
const { useAppStore } = await import('../../src/renderer/src/store')
const { readTerminalViewObservation } = await import('../../src/renderer/src/lib/terminal-view-observation')
const provider = defineAgentProvider({ catalog: { id: 'private-capacity-restart', label: 'Private actual PTY',
  executable: process.execPath, expectedProcess: 'node', promptDelivery: 'positional-argv',
  readySignal: { kind: 'foreground-process', expectedProcess: 'node' }, hookStrategy: { kind: 'none' },
  resumeStrategy: { kind: 'none' }, acpStrategy: { kind: 'none' },
  capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: false, replyCorrelation: 'none' } },
  buildArgs: (prompt, args) => [...args, prompt], hook: { rules: [] } })
let capacityFailures = 0
let capacityFault: { code: string; activeCreations: number } | undefined
const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.sqlite'))
const core = new AgentMuxClient({ store, providers: [provider], prepareExecutionEnvironment: async () => {
  if (mode === 'first' && capacityFailures === 0) {
    capacityFailures++
    const error = Object.assign(new Error('Private preparation ENOSPC'), { code: 'ENOSPC' })
    capacityFault = { code: error.code, activeCreations: (core as any).activeCreations.size }
    throw error
  }
} })
Object.defineProperty((core as any).hookServer, 'port', { value: 0 })
await core.connect()
const counts = { start: 0, input: 0, stop: 0, launch: 0, wait: 0, spatialRead: 0, spatialCommit: 0, spatialSubscribe: 0, attach: 0 }
const kernel = (core as any).kernel
for (const name of ['start', 'input', 'stop'] as const) {
  const original = kernel[name].bind(kernel)
  kernel[name] = (...args: unknown[]) => { counts[name]++; return original(...args) }
}
core.onEvent(event => { if (event.type === 'agent-error' && event.code === 'AGENT_CREATION_WAITING_FOR_STORAGE') counts.wait++ })
const runtime = new RuntimeController(store, async () => { throw new Error('This private proof retains its explicitly committed original local Host') })
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }],
  executors: { fixture: { label: 'Private actual PTY', providerId: provider.id, command: process.execPath,
    args: [join(directory, 'pty.mjs')], env: {}, injectAgentMuxGuide: false } },
  workspaces: [{ id: 'private', name: 'Private', hostId: 'local', path: directory, kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } } as any
runtime.commit({ hosts: [{ id: 'local', client: core, config: config.hosts[0], executionHost: { kind: 'local', dispose: async () => {} } as any }],
  removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
const listeners = new Set<(event: any) => void>()
const sender = Object.assign(new EventEmitter(), { id: mode === 'first' ? 771 : 772, isDestroyed: () => false,
  send: (_channel: string, event: unknown) => { for (const listener of listeners) listener(event) } })
const detach = runtime.attach(sender as never)
const spatial = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
api.spatial.read = () => { counts.spatialRead++; return spatial.readForLayout() }
api.spatial.commit = input => { counts.spatialCommit++; return spatial.commit(input) }
api.spatial.onChange = listener => { counts.spatialSubscribe++; return spatial.subscribe(listener) }
api.spatial.retainLabels = values => spatial.retainDisplayLabels(values)
api.config.get = async () => config
api.sessions.snapshot = async () => ({ ...await runtime.snapshot(config), localHome: join(directory, 'home') })
api.providers.list = ((options?: { observation: true }) => options ? runtime.providerCatalog(options) : runtime.providerCatalog()) as typeof api.providers.list
api.sessions.onEvent = listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
api.sessions.launchAgent = input => { counts.launch++; assert.equal(mode, 'first', 'Restart must not create'); return runtime.launchAgent(input, config) }
api.sessions.refresh = control => runtime.refresh(control, config)
api.sessions.timeline = control => runtime.sessionTimeline(control)
api.sessions.recover = (control, path, operation) => runtime.recoverSession(control, config, path, operation)
api.sessions.attach = (control, afterByte) => { counts.attach++; return runtime.attachSession(sender.id, control, afterByte, config) }
api.sessions.refreshAttachment = (control, id, afterByte) => runtime.refreshSessionAttachment(sender.id, control, id, afterByte, config)
api.sessions.detach = id => runtime.detachSession(sender.id, id)
api.sessions.replay = (id, afterByte) => runtime.readSessionReplay(sender.id, id, afterByte)
api.sessions.resize = (id, cols, rows) => runtime.resizeSessionAttachment(sender.id, id, cols, rows)
api.sessions.write = () => { throw new Error('Restart proof does not authorize PTY input') }
api.sessions.paste = () => { throw new Error('Restart proof does not authorize PTY paste') }
api.ui.requestStorageFlush = async () => {}
const wait = async <T,>(read: () => T | Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> => {
  const deadline = Date.now() + 15_000
  for (;;) { const value = await read(); if (accept(value)) return value
    if (Date.now() > deadline) throw new Error('Private restart deadline: ' + label)
    await new Promise(done => setTimeout(done, 25)) }
}
const container = document.createElement('div'), overlay = document.createElement('div')
overlay.dataset.overlayHost = ''; document.body.append(container, overlay)
const root = createClientUiRoot(container)
const terminalText = () => {
  const terminal = (globalThis as any).__preAdmissionRestartTerminals.at(-1)
  return terminal ? Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true)).join('\n') : ''
}
let disposeUi: (() => void) | undefined
try {
  disposeUi = await useAppStore.getState().initialize()
  progress('initialized')
  let id: string, tabId: string, regionId: string, groupId: string, waitWasVisible = false
  const previous = mode === 'second' ? JSON.parse(readFileSync(join(directory, 'first.json'), 'utf8')) : null
  if (mode === 'first') {
    await useAppStore.getState().selectWorkspace('private')
    useAppStore.getState().openLauncher({ workspaceId: 'private', reveal: true })
    const layout = useAppStore.getState().layouts.private!; groupId = layout.activeGroupId
    tabId = layout.groups.find(group => group.id === groupId)!.activeTabId!
    regionId = useAppStore.getState().tabs[tabId]!.layout.activeRegionId
    useAppStore.getState().splitRegion('private', tabId, regionId, 'right')
    useAppStore.getState().updateRegionSplitRatio('private', tabId, '', 0.63)
    const launch = useAppStore.getState().launchAgent('fixture', 'Original capacity-recovered prompt', groupId, { tabId, regionId })
    void launch.catch(() => {})
    id = await wait(() => Object.keys(useAppStore.getState().pendingAgentLaunches)[0], Boolean, 'original pending SID')
    const mount = () => root.render(<SessionPane sessionId={id} surfaceKind="agent" visible interactiveResize={false}
      linkOrigin={{ workspaceId: 'private', tabGroupId: groupId, tabId, regionId }} />)
    await act(async () => { mount(); await wait(() => counts.wait, n => n === 1, 'one original Core storage wait') })
    progress('wait-mounted')
    await act(async () => { await new Promise(done => setTimeout(done, 25)) })
    assert.match(container.textContent!, /Waiting for storage/); waitWasVisible = true
    assert.match(container.textContent!, /Original capacity-recovered prompt/)
    await act(async () => { await launch })
    progress('recovered')
    assert.equal(counts.start, 1); assert.equal(counts.launch, 1); assert.equal(counts.wait, 1)
    useAppStore.getState().setAgentComposerDraft(regionId, 'Retained original unsent draft')
  } else {
    ({ id, tabId, regionId, groupId } = previous)
    assert.deepEqual(useAppStore.getState().tabs, previous.tabs)
    assert.deepEqual(useAppStore.getState().layouts, previous.layouts)
    assert.equal(useAppStore.getState().agentComposerDrafts[regionId], previous.draft)
    await act(async () => { root.render(<SessionPane sessionId={id} surfaceKind="agent" visible interactiveResize={false}
      linkOrigin={{ workspaceId: 'private', tabGroupId: groupId, tabId, regionId }} />) })
  }
  const session = await wait(() => useAppStore.getState().sessions.find(value => value.id === id), value => value?.kind === 'agent', 'actual startup membership restores original Session')
  assert.ok(session?.kind === 'agent'); assert.equal(session.control.kind, 'agent')
  await act(async () => { await wait(() => readTerminalViewObservation({ regionId, sessionId: id, runId: session.control.run.runId }), value => value?.liveReady === true, 'actual mounted original terminal reader') })
  progress('terminal-ready')
  await act(async () => { await wait(terminalText, text => text.includes('original-history-39') && text.includes('Original capacity-recovered prompt'), 'actual xterm retained original content') })
  if (mode === 'second') {
    writeFileSync(join(directory, 'live-output'), 'after-real-host-restart')
    await act(async () => { await wait(terminalText, text => text.includes('after-real-host-restart'), 'same Run live output after host restart') })
    assert.equal(counts.start, 0); assert.equal(counts.launch, 0)
  }
  await useAppStore.getState().retryWorkbenchSave()
  progress('saved')
  const graph = (await spatial.read())!.graph
  assert.equal(graph.regions.find(region => region.regionId === regionId)?.agentSessionId, session.control.agentSessionId)
  assert.equal(graph.regions.find(region => region.regionId === regionId)?.runId, session.control.run.runId)
  assert.equal(graph.tabLayouts[tabId]!.root.type, 'split')
  assert.equal((graph.tabLayouts[tabId]!.root as any).ratio, 0.63)
  const status = await core.statusAgent(session.control.agentSessionId)
  assert.equal(status.run.acceptedInputBytes, 0); assert.equal(counts.input, 0); assert.equal(counts.stop, 0)
  assert.ok(counts.spatialRead && counts.spatialSubscribe && counts.attach)
  const saved = JSON.parse(readFileSync(storagePath, 'utf8'))
  assert.equal(JSON.parse(saved['agentmux-workbench-v1']).state.agentComposerDrafts[regionId], 'Retained original unsent draft')
  const current = useAppStore.getState(), record = { mode, clientPid: process.pid, id, tabId, regionId, groupId,
    run: status.session.run, childPid: status.run.pid, daemon: core.runtimeIdentity().instanceId,
    acceptedInputBytes: status.run.acceptedInputBytes, counts, waitWasVisible, capacityFailures, capacityFault,
    tabs: current.tabs, layouts: current.layouts, draft: current.agentComposerDrafts[regionId],
    spatialRevision: (await spatial.read())!.revision, terminalRead: terminalText().includes('original-history-39'), liveRead: terminalText().includes('after-real-host-restart'),
    cid: (await store.readMetadata(session.control.agentSessionId))!.creation!.createOperationId }
  if (previous) { assert.deepEqual(record.run, previous.run); assert.equal(record.childPid, previous.childPid); assert.equal(record.daemon, previous.daemon); assert.equal(record.cid, previous.cid) }
  if (mode === 'first') writeFileSync(join(directory, 'first.json'), JSON.stringify(record))
  process.stdout.write(JSON.stringify(record) + '\n')
} finally {
  progress('unmounting')
  await act(async () => root.unmount())
  disposeUi?.(); detach(); progress('disposing-runtime'); await runtime.dispose(); await store.close?.(); progress('closing-window'); await window.happyDOM.close(); progress('closed')
}
// A Node preview host has unrelated mock API timers. All real owners above have
// settled their cleanup; terminate this host just as the Desktop process exits.
await new Promise<void>(done => process.stdout.write('', () => done()))
process.exit(0)
