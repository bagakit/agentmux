// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import type { Terminal as BrowserTerminal } from '@xterm/xterm'
import type { AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { SpaceMemberWorkface } from '../src/renderer/src/components/MountedSpaceAgent'
import { DesktopClientUiProvider } from '../src/renderer/src/components/DesktopClientUiProvider'
import * as readingPublication from '../src/renderer/src/lib/reading-diagnostic-publication'
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture'
import { AgentProviderRegistry } from '../../../packages/core/src/agent-provider'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { spaceMountTransport } from './helpers/space-mount-fixture'
import { spaceMountKey } from '../src/shared/space-mount'
import { originalSourceInputOwnerKey } from '../src/renderer/src/lib/original-space-navigation'
import { promptCarrierWaiting } from './helpers/prompt-carrier-receipt'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
// Only glyph/DOM measurement and Native leaves are controlled. Production TerminalView,
// shared synchronizer, Source owner, actual Unix RPC, trusted Main/Preload and rich composer run.
const paint = vi.hoisted(() => ({ terminals: [] as BrowserTerminal[], grid: { cols: 117, rows: 31 }, observe: [] as Array<() => void>, refresh: null as null | (() => Promise<void>) }))
vi.mock('../src/renderer/src/components/TerminalView', async () => {
  const actual = await vi.importActual<typeof import('../src/renderer/src/components/TerminalView')>('../src/renderer/src/components/TerminalView')
  return { ...actual, TerminalView: (props: import('react').ComponentProps<typeof actual.TerminalView>) =>
    <actual.TerminalView {...props} onObservationRefresh={refresh => { paint.refresh = refresh; props.onObservationRefresh?.(refresh) }} /> }
})
vi.mock('@xterm/xterm', async () => {
  const { Terminal } = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm')
  return { Terminal: class extends Terminal {
    element: HTMLElement | undefined = undefined
    constructor(options: ConstructorParameters<typeof Terminal>[0]) { super(options); paint.terminals.push(this) }
    open(root: HTMLElement) { this.element = document.createElement('div'); root.append(this.element) }
    focus() {} refresh() {} onRender = () => ({ dispose() {} })
    onSelectionChange = () => ({ dispose() {} }); getSelection() { return '' }; hasSelection() { return false }
    registerLinkProvider() { return { dispose() {} } }; attachCustomKeyEventHandler() {}
  } }
})
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {
  terminal?: BrowserTerminal; activate(terminal: BrowserTerminal) { this.terminal = terminal }; dispose() {}
  fit() { this.terminal?.resize(paint.grid.cols, paint.grid.rows) }; proposeDimensions() { return paint.grid }
} }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { activate() {} dispose() {} onDidChangeResults() { return { dispose() {} } } } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { activate() {} dispose() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { activate() {} dispose() {} onContextLoss() { return { dispose() {} } } } }))
vi.mock('../src/renderer/src/components/TerminalContextMenu', () => ({ TerminalContextMenu: ({ children }: { children: ReactNode }) => children }))
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})
const before = useAppStore.getState()
let root: Root, container: HTMLDivElement
const cleanup: Array<() => unknown | Promise<unknown>> = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  paint.terminals.length = 0; paint.observe.length = 0; paint.refresh = null; paint.grid = { cols: 117, rows: 31 }
  vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { paint.observe.push(cb) }; observe() {}; disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = paint.grid.cols * 8, height = paint.grid.rows * 16
    return { x: 0, y: 0, top: 0, left: 0, width, height, right: width, bottom: height, toJSON() {} }
  })
  useAppStore.setState({ config: structuredClone(DEFAULT_CONFIG), sessions: [], mountedSpaceInputs: { schemaVersion: 1, entries: [] } as never })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  for (const close of cleanup.splice(0).reverse()) await close()
  useAppStore.setState(before, true); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function fixture(suffix = 'a') {
  const f = await createSpaceSessionsFixture(cleanup), sid = 'original-member-' + suffix
  f.d.core.providers.register(new AgentProviderRegistry().get('codex'))
  const original = await f.d.put(sid), admitted = await f.admit('D-in-B', f.d.owner.runtimeId, sid, 'original-creation-' + suffix)
  await f.b.spatial.settleAgentOpen('original-creation-' + suffix, original, { workspaceId: 'original-b-project', phase: 'attached', agentPresentation: { sessionId: sid, agentSessionId: sid, hostId: 'D-in-B', runtimeId: f.d.owner.runtimeId } })
  // The fixture controls Native connectivity; durable Session facts still come
  // from the actual original registry when its attachment reader opens.
  vi.spyOn(f.d.core.metadata, 'resolveRaw').mockImplementation(async id => {
    const session = await f.d.core.readAgentSession(id); if (!session) throw Error('Original fixture Session is absent'); return session
  })
  const subject = await f.d.core.runtimeSubject({ kind: 'agent-session', agentSessionId: sid }); if (subject.kind !== 'agent') throw Error('Expected original member')
  const data = 'Original private terminal ' + suffix + '\r\n', dataBytes = new TextEncoder().encode(data)
  const attach = vi.spyOn(f.d.core, 'refreshRunAttachment').mockResolvedValue({ run: subject.run, gap: null, resizeRevision: 0,
    terminal: { type: 'unknown', reason: 'origin_unknown' }, replay: [{ type: 'data', runId: original.run.runId, startByte: 0, endByte: dataBytes.length, data, dataBytes }] })
  const release = vi.spyOn(f.d.core, 'releaseRunAttachment').mockResolvedValue()
  const resize = vi.spyOn(f.d.core, 'resizeTerminal').mockImplementation(async (_run, cols, rows) => ({ ...subject.run, cols, rows }))
  const writes = vi.spyOn(f.d.core, 'writeAgent').mockRejectedValue(Error('This observation must not send input'))
  const prompt = vi.spyOn(f.d.core, 'submitAgentPrompt').mockRejectedValue(Error('This observation must not send a prompt'))
  const main = spaceMountTransport(cleanup, [{ id: 'source-carrier-' + suffix, carrier: { forwardRpc: f.b.rpc.call.bind(f.b.rpc), subscribeRpc: f.b.rpc.subscribe.bind(f.b.rpc) } }], structuredClone(DEFAULT_CONFIG))
  vi.spyOn(api.spaceMounts, 'member').mockImplementation(main.api.member)
  const target = { hostId: 'source-carrier-' + suffix, target: { reference: f.reference, regionId: admitted.address.regionId, runtimeId: f.d.owner.runtimeId, agentSessionId: sid, expectedRun: original.run } }
  const key = spaceMountKey(f.reference), tabId = admitted.address.tabId!; const zoneId = admitted.address.zoneId!
  useAppStore.getState().mountSpace({ hostId: target.hostId, reference: f.reference, zoneId, workspaceId: 'original-b-project' })
  useAppStore.getState().setAgentComposerDraft(originalSourceInputOwnerKey(target.target.runtimeId, sid), 'Private draft remains unsent ' + suffix)
  const view = (visible = true, interactiveResize = false) => <DesktopClientUiProvider><SpaceMemberWorkface target={target} visible={visible} active={visible} interactiveResize={interactiveResize} sourceTabId={tabId} /></DesktopClientUiProvider>
  return { ...f, sid, original, subject, attach, release, resize, writes, prompt, main, target, key, tabId, view }
}
async function click(label: string) {
  const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent === label)
  expect(button, label).toBeDefined(); await act(async () => button!.click())
}

it('the original member stream updates only its canonical input queue and frozen admission', async () => {
  const f = await fixture('input-receipt'), target = { ...f.target, target: { ...f.target.target,
    expectedAdmission: { kind: 'creation' as const, operationId: 'original-creation-input-receipt' } } }
  const owner = originalSourceInputOwnerKey(target.target.runtimeId, f.sid), operationId = 'original-live-input'
  const waiting = promptCarrierWaiting(f.sid, f.original.run.runId, operationId)
  const entry = { operationId, text: 'Original pending input', status: 'deferred' as const, promptCondition: null,
    runId: f.original.run.runId, originalMember: target, inputReceipt: waiting,
    directInputControl: { kind: 'agent' as const, hostId: 'local', agentSessionId: f.sid, run: f.original.run },
    directInputBinding: { expectedRun: f.original.run, admissionIntent: { kind: 'manual-actor' as const } } }
  const otherOwner = originalSourceInputOwnerKey('unrelated-runtime', f.sid)
  useAppStore.setState({ agentSteerQueues: { [owner]: [entry], [otherOwner]: [{ ...entry,
    originalMember: { ...target, target: { ...target.target, runtimeId: 'unrelated-runtime' } } }] } })
  let observed: Parameters<typeof api.spaceMounts.member>[1] | undefined
  const open = vi.mocked(api.spaceMounts.member).getMockImplementation()!
  vi.mocked(api.spaceMounts.member).mockImplementation((request, listener, signal) => {
    observed = listener; return open(request, listener, signal)
  })
  await act(async () => root.render(<DesktopClientUiProvider><SpaceMemberWorkface target={target} visible active /></DesktopClientUiProvider>))
  await vi.waitFor(() => expect(f.resize).toHaveBeenCalled())
  const ref = { key: waiting.key, waitGeneration: 2 }
  const stopped = { ...waiting, ref, status: 'stopped' as const, observation: 'closed' as const,
    control: { ref, state: 'stopped-before-dispatch' as const, at: 2 } }
  const publisher = (f.d.core as unknown as { publisher: { publish(event: unknown): void } }).publisher
  await act(async () => publisher.publish({ type: 'agent-input', receipt: stopped }))
  await vi.waitFor(() => expect(useAppStore.getState().agentSteerQueues[owner]![0]!.inputReceipt).toEqual(stopped))
  expect(useAppStore.getState().agentSteerQueues[otherOwner]![0]!.inputReceipt).toEqual(waiting)
  const replacement = { ...target, target: { ...target.target,
    expectedAdmission: { kind: 'creation' as const, operationId: 'another-original-creation' } } }
  useAppStore.setState({ agentSteerQueues: { [owner]: [{ ...entry, originalMember: replacement }] } })
  await act(async () => publisher.publish({ type: 'agent-input', receipt: stopped }))
  await new Promise(done => setTimeout(done, 40))
  expect(useAppStore.getState().agentSteerQueues[owner]![0]!.inputReceipt).toEqual(waiting)
  await act(async () => root.render(null))
  await act(async () => observed!({ type: 'runtime', event: { type: 'core', hostId: target.hostId,
    event: { type: 'agent-input', receipt: stopped } } }))
  expect(useAppStore.getState().agentSteerQueues[owner]![0]!.inputReceipt).toEqual(waiting)
  expect(f.writes).not.toHaveBeenCalled(); expect(f.prompt).not.toHaveBeenCalled()
})

it('settles the actual original member viewport, suspends only during drag and resumes same-Run resize after show', async () => {
  const f = await fixture(), sessions = useAppStore.getState().sessions
  await act(async () => root.render(f.view()))
  await vi.waitFor(() => expect(f.resize).toHaveBeenCalledWith(f.original.run, 117, 31))
  expect(paint.terminals).toHaveLength(1)
  expect(container.textContent).toContain('Agent activity has not been observed yet')
  await new Promise(done => setTimeout(done, 100))
  const count = f.resize.mock.calls.length
  await act(async () => root.render(f.view(true, true)))
  paint.grid = { cols: 93, rows: 27 }; await act(async () => paint.observe.forEach(fn => fn()))
  await new Promise(done => setTimeout(done, 80)); expect(f.resize).toHaveBeenCalledTimes(count)
  await act(async () => root.render(f.view(true, false)))
  await vi.waitFor(() => expect(f.resize).toHaveBeenLastCalledWith(f.original.run, 93, 27))
  await act(async () => root.render(f.view(false)))
  await vi.waitFor(() => expect(f.release).toHaveBeenCalled())
  paint.grid = { cols: 124, rows: 34 }
  await act(async () => root.render(f.view(true)))
  await vi.waitFor(() => expect(f.resize).toHaveBeenLastCalledWith(f.original.run, 124, 34))
  expect(f.attach.mock.calls.every(([run]) => run.runId === f.original.run.runId)).toBe(true)
  expect(useAppStore.getState().sessions).toBe(sessions)
  expect(f.writes).not.toHaveBeenCalled(); expect(f.prompt).not.toHaveBeenCalled()
  expect(container.querySelector('[role="textbox"]')?.textContent).toContain('Private draft remains unsent')
})

it('the common ActivityView reads actual original conversation through Main/Preload/Source while same-SID local IO is untouched', async () => {
  const diagnostics = vi.spyOn(readingPublication, 'publishReadingDiagnostic').mockImplementation(() => {})
  const f = await fixture('conversation'), sessions = useAppStore.getState().sessions
  await f.b.put(f.sid)
  const store = (f.d.core as unknown as { store: AgentMuxMemoryAgentSessionStore }).store
  await store.applyTimelineMutation({ type: 'append', agentSessionId: f.sid, item: { id: 'original-message', agentSessionId: f.sid,
    kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Original result', content: 'Actual Source conversation, original D answer.', createdAt: Date.now(), updatedAt: Date.now() } })
  const localRead = vi.spyOn(api.conversation, 'readAgentConversation').mockRejectedValue(Error('Observer-local conversation must not be read'))
  const otherCoreRead = vi.spyOn(f.b.core, 'readAgentConversation').mockRejectedValue(Error('Source carrier same SID must not supply original content'))
  const originalRead = vi.spyOn(f.d.core, 'readAgentConversation')
  const changesRead = vi.spyOn(f.d.core, 'readConversationChanges')
  await act(async () => root.render(f.view()))
  await vi.waitFor(() => expect(f.resize).toHaveBeenCalled())
  const originalSurface = await vi.mocked(api.spaceMounts.member).mock.results[0]!.value
  const calls = vi.spyOn(originalSurface, 'call')
  await click('Conversation')
  await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain('Actual Source conversation, original D answer.') })
  await vi.waitFor(() => expect(calls.mock.calls.some(([method, input]) => method === 'conversationWatch' && Boolean((input as {view?:string}).view))).toBe(true))
  await calls.mock.results[calls.mock.calls.findIndex(([method, input]) => method === 'conversationWatch' && Boolean((input as {view?:string}).view))]!.value
  await act(async () => { await Promise.resolve() })
  expect(originalRead).toHaveBeenCalled(); expect(localRead).not.toHaveBeenCalled(); expect(otherCoreRead).not.toHaveBeenCalled()
  if (process.env.AGENTMUX_MEMBER_WORKFACE_VISUAL_INPUT) {
    const { writeFile } = await import('node:fs/promises')
    const sourceTarget = { hostId: f.target.hostId, reference: f.reference }
    const snapshot = await f.main.api.call('snapshot', sourceTarget)
    const metadataFrames: unknown[] = []
    const metadata = await f.main.api.sessions(sourceTarget, event => metadataFrames.push(event))
    await vi.waitFor(() => expect(metadataFrames.some((event: any) => event.type === 'observation' && event.observation.type === 'member' && event.observation.state.status === 'observed')).toBe(true))
    const surface = await vi.mocked(api.spaceMounts.member).mock.results[0]!.value
    const full = await surface.call('read', {})
    const page = await f.d.core.readAgentConversation({ hostId: 'local', agentSessionId: f.sid })
    await writeFile(process.env.AGENTMUX_MEMBER_WORKFACE_VISUAL_INPUT, JSON.stringify({ target: { ...sourceTarget, workspaceId: 'original-b-project', zoneId: snapshot.scope.zones[0]!.zoneId }, snapshot, metadata: metadata.initial, metadataFrames, full, page }, null, 2))
    metadata.dispose()
  }
  expect(container.querySelector('.activity-feed')).not.toBeNull()
  // Controlled hook-ingestion leaf, then actual Core publication/Source stream/Main/Reader consumer.
  const readsBeforeLive = originalRead.mock.calls.length + changesRead.mock.calls.length
  const ingestion = f.d.core as unknown as { persistAndPublishTimeline(mutation: unknown, evidence: unknown, hostId: string): Promise<void> }
  await ingestion.persistAndPublishTimeline({ type: 'append', agentSessionId: f.sid, item: { id: 'live-original-message', agentSessionId: f.sid, kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Live original result', content: 'Live original answer reaches the common Reader.', createdAt: Date.now(), updatedAt: Date.now() } }, { source: 'native-hook', run: f.original.run, observedAt: Date.now() }, 'local')
  await vi.waitFor(async () => { await act(async () => {}); expect(originalRead.mock.calls.length + changesRead.mock.calls.length).toBeGreaterThan(readsBeforeLive); expect(container.textContent).toContain('Live original answer reaches the common Reader.'); expect(diagnostics.mock.calls.some(([record]) => record.scope.agentSessionId === f.sid && record.events.some(event => event.phase === 'invalidation-received'))).toBe(true) })
  expect(container.querySelector('[role="textbox"]')?.textContent).toContain('Private draft remains unsent conversation')
  await click('Terminal')
  await vi.waitFor(() => expect(container.querySelector('.activity-feed')).toBeNull())
  expect(paint.terminals).toHaveLength(1)
  expect(useAppStore.getState().sessions).toBe(sessions); expect(f.prompt).not.toHaveBeenCalled(); expect(f.writes).not.toHaveBeenCalled()
})

it('a failed conversation read preserves the original Terminal, draft and input capability without falling back to local history', async () => {
  const f = await fixture('read-failed')
  vi.spyOn(f.d.core, 'readAgentConversation').mockRejectedValue(Error('Original conversation temporarily unavailable'))
  const local = vi.spyOn(api.conversation, 'readAgentConversation').mockRejectedValue(Error('No local fallback'))
  await act(async () => root.render(f.view()))
  await vi.waitFor(() => expect(f.resize).toHaveBeenCalled())
  await click('Conversation')
  await vi.waitFor(() => expect(container.textContent).toContain('Original conversation temporarily unavailable'))
  await click('Terminal')
  expect(container.querySelector('.mounted-space-agent__terminal')?.hasAttribute('hidden')).toBe(false)
  expect(container.querySelector('.composer-send')).not.toBeNull()
  expect(container.querySelector('[role="textbox"]')?.textContent).toContain('Private draft remains unsent read-failed')
  expect(local).not.toHaveBeenCalled(); expect(f.writes).not.toHaveBeenCalled(); expect(f.prompt).not.toHaveBeenCalled()
})

async function privateNativeFixture() {
  const { spawn } = await import('node:child_process')
  const { mkdir, writeFile } = await import('node:fs/promises'), { join, resolve } = await import('node:path')
  const f = await createSpaceSessionsFixture(cleanup)
  const runtime = join(f.d.root, 'runtime'); await mkdir(runtime, { recursive: true }); await mkdir(join(f.d.root, 'state', 'ctxmux'), { recursive: true, mode: 0o700 })
  const daemon = spawn(resolve('packages/core/vendor/ctxmux', process.platform + '-' + process.arch, 'bin/ctxmuxd'),
    ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(f.d.root, 'state', 'ctxmux'), '--readiness-fd', '3'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let errors = ''; daemon.stderr!.on('data', value => { errors += value })
  let runId: string | undefined
  cleanup.push(async () => {
    if (runId) await f.d.core.stopTerminal({ runId }).catch(() => {})
    await f.d.core.dispose()
    if (daemon.exitCode === null && daemon.signalCode === null) { const ended = once(daemon, 'exit'); daemon.kill('SIGTERM'); await ended }
  })
  await Promise.race([once(daemon.stdio[3]!, 'data'), once(daemon, 'exit').then(() => { throw Error('Private Native failed: ' + errors) })])
  vi.mocked(f.d.core.connectRuntime).mockRestore(); vi.mocked(f.d.core.runtimeSubject).mockRestore()
  await f.d.core.connect()
  f.d.core.providers.register(new AgentProviderRegistry().get('codex'))
  const run = await f.d.core.createTerminal({ workspacePath: f.d.root, command: '/bin/cat', args: [], cols: 80, rows: 24 }); runId = run.runId
  // Session registration is the explicit fixture leaf; PTY/attachment/resize are real Native.
  // This is not native vendor readiness or initial-input acceptance proof.
  const sid = 'private-native-member', original = { ...await f.d.put(sid, Date.now(), run.runId), workspacePath: f.d.root }
  await (f.d.core as unknown as { registry: import('../../../packages/core/src/agent-session-registry').AgentMuxAgentSessionRegistry }).registry.put(original, original.run)
  const admission = (await f.b.spatial.admitAgentOpen({ request: { schemaVersion: 5, requestId: 'private-native-creation', operation: 'agent.open', content: { kind: 'new-agent', executorId: 'test-executor', agentTarget: { hostId: 'D-in-B', runtimeId: f.d.owner.runtimeId } }, destination: { spaceId: f.reference.spaceId, newTab: true }, focus: false }, agentSessionId: sid,
    execution: { hostId: 'D-in-B', runtimeId: f.d.owner.runtimeId, executorRevision: 'original-executor-revision', workspacePath: f.d.root, workspaceId: null }, placement: { runtimeId: f.b.owner.runtimeId, hostId: 'local', workspacePath: '/b/project', workspaceId: 'original-b-project' }, regionResource: {} })).record
  let metadataUnavailable = false
  const forward: typeof f.b.rpc.call = (method, input, options) => {
    if (metadataUnavailable && method === 'space.member.call' && (input as { call?: { method?: string } }).call?.method === 'runtime.bootstrap')
      return Promise.reject(new Error('Original supplemental metadata unavailable'))
    return f.b.rpc.call(method, input, options)
  }
  const main = spaceMountTransport(cleanup, [{ id: 'private-source-carrier', carrier: { forwardRpc: forward, subscribeRpc: f.b.rpc.subscribe.bind(f.b.rpc) } }], structuredClone(DEFAULT_CONFIG))
  vi.spyOn(api.spaceMounts, 'member').mockImplementation(main.api.member)
  const key = spaceMountKey(f.reference), target = { hostId: 'private-source-carrier', target: { reference: f.reference, regionId: admission.address.regionId, runtimeId: f.d.owner.runtimeId, agentSessionId: sid, expectedRun: original.run } }
  useAppStore.getState().mountSpace({ hostId: target.hostId, reference: f.reference, zoneId: admission.address.zoneId!, workspaceId: 'original-b-project' })
  useAppStore.getState().setAgentComposerDraft(originalSourceInputOwnerKey(f.d.owner.runtimeId, sid), 'Private Native proof draft')
  const sessions = useAppStore.getState().sessions
  const view = (visible = true, interactiveResize = false) => <DesktopClientUiProvider><SpaceMemberWorkface target={target} visible={visible} active={visible} interactiveResize={interactiveResize} sourceTabId={admission.address.tabId!} /></DesktopClientUiProvider>
  return { ...f, original, run, target, sid, main, sessions, view, daemon, admission, metadataUnavailable: (value: boolean) => { metadataUnavailable = value } }
}

it('Source history returns original retained byte ranges after a real Native terminal checkpoint', async () => {
  const f = await privateNativeFixture(), target = { ...f.target, target: { ...f.target.target,
    expectedAdmission: { kind: 'creation' as const, operationId: f.admission.requestId } } }
  const surface = await f.main.api.member(target, () => {}, new AbortController().signal)
  try {
    const attached = await surface.call('attach', { afterByte: 0 }), data = 'Retained Source history λ\r'
    await surface.call('write', { data, source: 'user' })
    await vi.waitFor(async () => {
      const raw = await f.d.core.readRunReplay(f.original.run, 0, 'raw')
      expect(raw.run.acceptedInputBytes).toBe(Buffer.byteLength(data))
      expect(raw.replay.map(chunk => chunk.data).join('')).toContain('Retained Source history λ')
    })
    const checkpoint = await f.d.core.readRunReplay(f.original.run, 0, 'terminal')
    expect(checkpoint.terminal.type).toBe('basic-vt')
    if (checkpoint.terminal.type !== 'basic-vt') throw Error('Expected the original Native terminal checkpoint')
    expect(checkpoint.terminal.checkpoint.throughByte).toBeGreaterThan(0)
    const replay = await surface.call('replay', { attachmentId: attached.attachmentId, afterByte: 0 })
    expect(replay.gap).toBeNull()
    expect(replay.replay.map(chunk => chunk.data).join('')).toContain('Retained Source history λ')
    let cursor = 0
    for (const chunk of replay.replay) {
      expect(chunk.runId).toBe(f.run.runId)
      expect(chunk.startByte).toBe(cursor)
      expect(chunk.endByte - chunk.startByte).toBe(chunk.dataBytes.length)
      cursor = chunk.endByte
    }
    expect(cursor).toBeGreaterThanOrEqual(checkpoint.terminal.checkpoint.throughByte)
    const current = await f.d.core.readRunReplay(f.original.run, cursor, 'raw')
    expect({ runId: current.run.runId, pid: current.run.pid, state: current.run.state,
      acceptedInputBytes: current.run.acceptedInputBytes }).toEqual({ runId: f.run.runId, pid: f.run.pid,
      state: 'running', acceptedInputBytes: Buffer.byteLength(data) })
  } finally {
    await surface.dispose()
    await f.d.core.signalAgent(f.sid, f.original.run, 'SIGINT')
  }
})

it('actual private Native retains the original Run/PID and receives settled and post-drag dimensions through Source Main and Preload', async () => {
  const f = await privateNativeFixture(), { run, sessions, view, original, sid, daemon } = f
  const { writeFile } = await import('node:fs/promises')
  const facts: unknown[] = []
  async function sameGrid(cols: number, rows: number) {
    await vi.waitFor(async () => {
      const replay = await f.d.core.readRunReplay({ runId: run.runId }, 0, 'raw')
      expect({ runId: replay.run.runId, pid: replay.run.pid, state: replay.run.state, cols: replay.run.cols, rows: replay.run.rows, acceptedInputBytes: replay.run.acceptedInputBytes }, JSON.stringify({ original: run, current: replay.run, workface: container.textContent })).toEqual({ runId: run.runId, pid: run.pid, state: 'running', cols, rows, acceptedInputBytes: 0 })
    })
    const confirmed = await f.d.core.readRunReplay({ runId: run.runId }, 0, 'raw'); facts.push(confirmed.run)
  }
  await act(async () => root.render(view())); await sameGrid(117, 31)
  await act(async () => root.render(view(true, true)))
  paint.grid = { cols: 99, rows: 28 }; await act(async () => paint.observe.forEach(fn => fn()))
  await new Promise(done => setTimeout(done, 80)); await sameGrid(117, 31)
  await act(async () => root.render(view(true, false))); await sameGrid(99, 28)
  await act(async () => root.render(view(false)))
  paint.grid = { cols: 128, rows: 39 }
  await act(async () => root.render(view())); await sameGrid(128, 39)
  expect(useAppStore.getState().sessions).toBe(sessions)
  expect(container.querySelector('[role="textbox"]')?.textContent).toContain('Private Native proof draft')
  const evidence = process.env.AGENTMUX_MEMBER_WORKFACE_NATIVE_EVIDENCE
  if (evidence) await writeFile(evidence, JSON.stringify({ passed: true, original: { sid, cid: 'private-native-creation', runId: run.runId, pid: run.pid }, facts,
    nativeDaemonPid: daemon.pid, privateRoots: [f.b.root, f.d.root], scope: 'Actual pinned Native/Core/Source UnixRPC/Main/Preload/Renderer TerminalView synchronizer. DOM measurement and original Agent registry metadata are controlled leaves; /bin/cat is not a vendor Agent. No production or Native-vendor semantic recovery claim.' }, null, 2))
})

it('a typed original status event refreshes the private snapshot using the same reader and leaves the local Session store alone', async () => {
  const f = await fixture('status'), sessions = useAppStore.getState().sessions
  await act(async () => root.render(f.view()))
  await vi.waitFor(() => expect(f.resize).toHaveBeenCalled())
  const core = f.d.core as unknown as { registry: import('../../../packages/core/src/agent-session-registry').AgentMuxAgentSessionRegistry; publisher: { publish(event: unknown): void } }
  const observedAt = Date.now()
  // Controlled original Hook persistence + protocol event, consumed over actual Source/RPC/Main.
  await core.registry.put({ ...f.original, updatedAt: observedAt, semanticStatus: { state: 'working', source: 'native-hook', observedAt } }, f.original.run)
  await act(async () => core.publisher.publish({ type: 'agent-status', agentSessionId: f.sid, state: 'working', evidence: { source: 'native-hook', run: f.original.run, observedAt } }))
  await vi.waitFor(() => expect(container.querySelector('.mounted-space-agent__heading')?.textContent).toContain('Working'))
  expect(container.textContent).not.toContain('Agent activity has not been observed yet')
  expect(paint.terminals).toHaveLength(1); expect(useAppStore.getState().sessions).toBe(sessions)
  expect(f.writes).not.toHaveBeenCalled(); expect(f.prompt).not.toHaveBeenCalled()
})

it('late prior-Run session events cannot replace the new original target or erase its unsent draft', async () => {
  const f = await fixture('scope'), open = vi.mocked(api.spaceMounts.member).getMockImplementation()!
  let priorListener: Parameters<typeof api.spaceMounts.member>[1] | undefined
  vi.mocked(api.spaceMounts.member).mockImplementation((target, listener, signal) => { priorListener ??= listener; return open(target, listener, signal) })
  await act(async () => root.render(f.view()))
  await vi.waitFor(() => expect(f.resize).toHaveBeenCalled())
  const priorSurface = await vi.mocked(api.spaceMounts.member).mock.results[0]!.value
  const priorSnapshot = await priorSurface.call('read', {})
  const next = await f.d.put(f.sid, Date.now(), 'new-current-original-run')
  const data = 'Current Run terminal', dataBytes = new TextEncoder().encode(data)
  f.attach.mockResolvedValue({ run: { ...f.subject.run, runId: next.run.runId }, gap: null, resizeRevision: 0, terminal: { type: 'unknown', reason: 'origin_unknown' },
    replay: [{ type: 'data', runId: next.run.runId, startByte: 0, endByte: dataBytes.length, data, dataBytes }] })
  const target = { ...f.target, target: { ...f.target.target, expectedRun: next.run } }
  await act(async () => root.render(<DesktopClientUiProvider><SpaceMemberWorkface target={target} visible active sourceTabId={f.tabId} /></DesktopClientUiProvider>))
  await vi.waitFor(() => expect(f.resize).toHaveBeenCalledWith(next.run, 117, 31))
  await act(async () => priorListener!({ type: 'session', session: { ...priorSnapshot, label: 'Late old Run must not appear' } }))
  expect(container.textContent).not.toContain('Late old Run must not appear')
  expect(container.querySelector('[role="textbox"]')?.textContent).toContain('Private draft remains unsent scope')
  expect(useAppStore.getState().sessions).toEqual([]); expect(f.writes).not.toHaveBeenCalled(); expect(f.prompt).not.toHaveBeenCalled()
})

it('updates received during an in-flight original snapshot read are coalesced into one final authoritative read', async () => {
  const f = await fixture('coalesced')
  await act(async () => root.render(f.view())); await vi.waitFor(() => expect(f.resize).toHaveBeenCalled())
  const core = f.d.core as unknown as { registry: import('../../../packages/core/src/agent-session-registry').AgentMuxAgentSessionRegistry; publisher: { publish(event: unknown): void } }
  const subject = vi.mocked(f.d.core.runtimeSubject), originalRead = subject.getMockImplementation()!
  let release: (() => void) | undefined, captured = false
  subject.mockImplementation(async target => {
    const snapshot = await originalRead(target)
    if (!captured) { captured = true; await new Promise<void>(resolve => { release = resolve }) }
    return snapshot
  })
  const at = Date.now()
  const status = async (state: 'working' | 'done', observedAt: number) => {
    await core.registry.put({ ...f.original, updatedAt: observedAt, semanticStatus: { state, source: 'native-hook', observedAt } }, f.original.run)
    await act(async () => core.publisher.publish({ type: 'agent-status', agentSessionId: f.sid, state, evidence: { source: 'native-hook', run: f.original.run, observedAt } }))
  }
  await status('working', at); await vi.waitFor(() => expect(release).toBeDefined())
  await status('done', at + 1)
  await act(async () => release!())
  await vi.waitFor(() => expect(container.querySelector('.mounted-space-agent__heading')?.textContent).toContain('Idle'))
  expect(f.writes).not.toHaveBeenCalled(); expect(f.prompt).not.toHaveBeenCalled(); expect(paint.terminals).toHaveLength(1)
})

it('public view changes the actual ordinary foreign workface without borrowing a same-SID local mode', async () => {
  vi.spyOn(readingPublication, 'publishReadingDiagnostic').mockImplementation(() => {})
  const f = await fixture('ordinary-public-view')
  const { desktopWorkbenchFromSpatial } = await import('../src/renderer/src/lib/desktop-spatial-state')
  const { ordinarySpaceMember } = await import('../src/renderer/src/lib/ordinary-space-member')
  const { executeWorkfaceAgentView } = await import('../src/renderer/src/lib/workface-agent-view')
  const { composerSession } = await import('./helpers/composer-dom-fixture')
  const document = (await f.b.spatial.readForLayout())!, workbench = desktopWorkbenchFromSpatial(document.graph)
  const local = { ...composerSession(), id: f.sid, control: { kind: 'agent' as const, hostId: 'local', agentSessionId: f.sid, run: { runId: 'different-local-run' } } }
  useAppStore.setState({ ...workbench, originalSpatialGraph: document.graph, sessions: [local], viewModes: { [f.sid]: 'terminal' },
    config: { ...structuredClone(DEFAULT_CONFIG), hosts: [{ id: f.target.hostId, kind: 'local', label: 'Original Core carrier' }] } })
  const reference = { tabId: f.tabId, regionId: f.target.target.regionId, sessionId: f.sid }
  const occurrence = ordinarySpaceMember(document.graph, reference, f.target.hostId, local)
  expect(occurrence.kind).toBe('foreign')
  if (occurrence.kind !== 'foreign') throw Error('Expected actual ordinary foreign admission')
  expect(useAppStore.getState().tabs[f.tabId]?.source).toBeUndefined()
  expect(useAppStore.getState().tabs[f.tabId]?.regions[reference.regionId]).toMatchObject({ sessionId: f.sid })
  const owner = originalSourceInputOwnerKey(f.target.target.runtimeId, f.sid)
  useAppStore.getState().setAgentComposerDraft(f.sid, 'Keep local same-SID draft')
  const protectedState = useAppStore.getState()
  const sourceStore = (f.d.core as unknown as { store: AgentMuxMemoryAgentSessionStore }).store
  await sourceStore.applyTimelineMutation({ type: 'append', agentSessionId: f.sid, item: { id: 'ordinary-original-message', agentSessionId: f.sid,
    kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Original result', content: 'Ordinary foreign original conversation.', createdAt: 1, updatedAt: 1 } })
  vi.spyOn(api.spaceMounts, 'reading').mockImplementation(f.main.api.reading)
  const localRead = vi.spyOn(api.conversation, 'readAgentConversation').mockRejectedValue(Error('Local same-SID reading is not this target'))
  const carrierRead = vi.spyOn(f.b.core, 'readAgentConversation').mockRejectedValue(Error('Carrier same-SID reading is not this target'))
  const originalRead = vi.spyOn(f.d.core, 'readAgentConversation')
  const lifecycle = [f.b, f.d].flatMap(source => (['createAgent', 'resumeAgent', 'restartAgent', 'reopenAgent'] as const).map(method => vi.spyOn(source.core, method)))
  await act(async () => root.render(<DesktopClientUiProvider><SpaceMemberWorkface target={occurrence.member} sourceTabId={f.tabId} visible active /></DesktopClientUiProvider>))
  const workface = () => container.querySelector<HTMLElement>('[aria-label="Original member workface"]')!
  await vi.waitFor(() => expect(workface()?.dataset.agentSurfaceMode).toBe('terminal'))
  const save = vi.fn(async () => ({ layoutApplied: false, clientStateWritten: false, storageFlushRequested: false,
    diskDurability: 'unconfirmed' as const, reason: 'Private test has no confirmed Desktop save owner.' }))
  const change = async (runtimeId: string | undefined, mode: 'activity' | 'terminal') => {
    let result!: Awaited<ReturnType<typeof executeWorkfaceAgentView>>
    await act(async () => { result = await executeWorkfaceAgentView({ get: useAppStore.getState,
      setViewMode: (id, next, options) => useAppStore.getState().setViewMode(id, next, options), save },
    { schemaVersion: 5, requestId: 'ordinary-view-' + mode + '-' + (runtimeId ?? 'bare'), operation: 'agent.view', agentSessionId: f.sid, ...(runtimeId ? { runtimeId } : {}), mode }) })
    return result
  }
  const first = await change(f.d.owner.runtimeId, 'activity')
  expect(first).toMatchObject({ runtimeId: f.d.owner.runtimeId,
    outcome: 'partial', changed: true, effectiveMode: 'activity', sessionFacts: 'unconfirmed', issues: [{ code: 'SPACE_SAVE_UNCONFIRMED' }] })
  expect(first.regions).toEqual([expect.objectContaining({ tabId: f.tabId, regionId: reference.regionId, agentSessionId: f.sid,
    runId: f.original.run.runId, execution: expect.objectContaining({ runtimeId: f.d.owner.runtimeId, hostId: 'D-in-B' }) })])
  await vi.waitFor(() => {
    expect(workface().dataset.agentSurfaceMode).toBe('activity')
    expect(workface().querySelector('.activity-feed')?.textContent).toContain('Ordinary foreign original conversation.')
  })
  expect(useAppStore.getState().viewModes).toEqual({ [f.sid]: 'terminal', [owner]: 'activity' })
  const applied = useAppStore.getState().viewModes
  for (const runtime of ['unrelated-execution-runtime', undefined]) {
    expect(await change(runtime, 'terminal')).toMatchObject({ outcome: 'unknown', changed: false, sessionFacts: 'unconfirmed', storedOverride: null, save: null })
    expect(workface().dataset.agentSurfaceMode).toBe('activity')
    expect(useAppStore.getState().viewModes).toBe(applied)
  }
  expect(save).toHaveBeenCalledTimes(1)
  expect(await change(f.d.owner.runtimeId, 'terminal')).toMatchObject({ changed: true, effectiveMode: 'terminal', outcome: 'partial' })
  await vi.waitFor(() => expect(workface().dataset.agentSurfaceMode).toBe('terminal'))
  expect(useAppStore.getState().agentComposerDrafts).toEqual(protectedState.agentComposerDrafts)
  expect(useAppStore.getState().sessions).toBe(protectedState.sessions)
  expect(useAppStore.getState().agentFocus).toBe(protectedState.agentFocus)
  expect(originalRead).toHaveBeenCalled(); expect(localRead).not.toHaveBeenCalled(); expect(carrierRead).not.toHaveBeenCalled()
  expect(f.writes).not.toHaveBeenCalled(); expect(f.prompt).not.toHaveBeenCalled()
  for (const effect of lifecycle) expect(effect).not.toHaveBeenCalled()
})

it('keeps the original attached nonempty terminal when supplemental metadata and status fail after the Native receipt', async () => {
  const f = await privateNativeFixture()
  // Real private PTY bytes and Core attachment projection; only the later optional
  // metadata/status failure is injected, not a fabricated attachment or Session.
  await f.d.core.writeAgent({ agentSessionId: f.sid, expectedRun: f.run, data: 'Original attachment survives\n', source: 'user' })
  const attach = f.d.core.refreshRunAttachment.bind(f.d.core)
  let attached = false
  const status = f.d.core.runtimeSubject.bind(f.d.core)
  const received = vi.spyOn(f.d.core, 'refreshRunAttachment').mockImplementation(async (...args) => {
    const result = await attach(...args)
    expect(result).not.toHaveProperty('agent') // Existing original Core wire shape, no new declaration field.
    f.metadataUnavailable(true); attached = true
    return result
  })
  vi.spyOn(f.d.core, 'runtimeSubject').mockImplementation((...args) => attached ? Promise.reject(new Error('Independent original status unavailable')) : status(...args))
  const results: unknown[] = []
  let initialAttachment: import('../src/shared/contracts').TerminalAttachResult | undefined
  const open = vi.mocked(api.spaceMounts.member).getMockImplementation()!
  vi.mocked(api.spaceMounts.member).mockImplementation(async (...args) => {
    const surface = await open(...args)
    return { ...surface, call: async (method, input, signal) => {
      try { const result = await surface.call(method, input, signal); if (method === 'attach') initialAttachment = result as import('../src/shared/contracts').TerminalAttachResult; results.push({method, ok:true}); return result }
      catch (error) { results.push({method, error:String(error)}); throw error }
    } }
  })
  await act(async () => root.render(f.view()))
  await vi.waitFor(() => expect(paint.terminals.some(terminal => {
    const buffer = terminal.buffer.active
    return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString()).join('\n').includes('Original attachment survives')
  }), JSON.stringify({ text: container.textContent, results, attached: received.mock.calls.length, terminals: paint.terminals.map(t => ({ length: t.buffer.active.length, text: Array.from({length:t.buffer.active.length},(_,i)=>t.buffer.active.getLine(i)?.translateToString()).join('\n') })) })).toBe(true), { timeout: 8000 })
  expect(received).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain('Agent observation unconfirmed')
  const details = container.querySelector('details')
  if (details) await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  expect(container.textContent).toContain('unavailable')
  expect(container.querySelector('[role="textbox"]')?.textContent).toContain('Private Native proof draft')
  expect(useAppStore.getState().sessions).toBe(f.sessions)
  expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent === 'Refresh member observation')).toBe(true)
  await click('Refresh member observation')
  expect(container.textContent).toContain('Agent observation unconfirmed')
  expect(paint.terminals).toHaveLength(1)
  // The same shared TerminalView still sends to this original healthy PTY.
  await act(async () => paint.terminals[0]!.input('Still available after observation gap\r'))
  await vi.waitFor(async () => {
    const replay = await f.d.core.readRunReplay(f.run, 0, 'raw')
    expect(replay.replay.map(event => event.data).join('')).toContain('Still available after observation gap')
    expect(replay.run.runId).toBe(f.run.runId); expect(replay.run.pid).toBe(f.run.pid)
    expect(replay).not.toHaveProperty('agent')
  })
  const surface = await vi.mocked(api.spaceMounts.member).mock.results[0]!.value
  const refreshed = await surface.call('refreshAttachment', { attachmentId: initialAttachment!.attachmentId, afterByte: 0 })
  expect(refreshed.attachmentId).toBe(initialAttachment!.attachmentId)
  expect(refreshed.session.control.run).toEqual(f.original.run)
  expect(refreshed.session.latestOutputBytes).toBeGreaterThan(0)
})


it('keeps raw original replay and attachment available when the Provider declaration is removed', async () => {
  const f = await privateNativeFixture()
  await f.d.core.writeAgent({ agentSessionId: f.sid, expectedRun: f.run, data: 'Retained original bytes\n', source: 'user' })
  await vi.waitFor(async () => expect((await f.d.core.readRunReplay(f.run, 0, 'raw')).replay.map(event => event.data).join('')).toContain('Retained original bytes'))
  f.d.core.providers.unregister('codex')
  const replay = await f.d.core.readRunReplay(f.run, 0, 'raw')
  expect(replay.replay.map(event => event.data).join('')).toContain('Retained original bytes')
  expect(replay).not.toHaveProperty('agent')
  const attachment = await f.d.core.refreshRunAttachment(f.run, 0, 'raw')
  expect(attachment.run).toMatchObject({ runId: f.run.runId, pid: f.run.pid, state: 'running' })
  expect(attachment).not.toHaveProperty('agent')
  await act(async () => root.render(f.view()))
  await vi.waitFor(() => expect(paint.terminals.some(terminal => Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString()).join('\n').includes('Retained original bytes'))).toBe(true))
  await vi.waitFor(() => expect(container.textContent).toContain('Agent observation unconfirmed'))
})

it('rejects a mismatched attachment and wrong admission without stopping the original Run', async () => {
  const f = await privateNativeFixture(), stop = vi.spyOn(f.d.core, 'stopTerminal')
  const attach = f.d.core.refreshRunAttachment.bind(f.d.core)
  const receipt = vi.spyOn(f.d.core, 'refreshRunAttachment').mockImplementation(async (...args) => {
    const result = await attach(...args)
    return { ...result, run: { ...result.run, runId: 'unrelated-original-run' } }
  })
  const malformed = await f.main.api.member(f.target, () => {})
  await expect(malformed.call('attach', { afterByte: 0 })).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION_BINDING' })
  await malformed.dispose()
  expect((await f.d.core.readRunReplay(f.run, 0, 'raw')).run).toMatchObject({ runId: f.run.runId, pid: f.run.pid, state: 'running' })
  receipt.mockImplementation(attach); receipt.mockClear()
  for (const target of [
    { ...f.target, target: { ...f.target.target, expectedRun: { runId: 'not-the-original-run' } } },
    { ...f.target, target: { ...f.target.target, expectedAdmission: { kind: 'creation' as const, operationId: 'not-the-original-creation' } } }
  ]) {
    const surface = await f.main.api.member(target, () => {})
    await expect(surface.call('attach', { afterByte: 0 })).rejects.toMatchObject({ code: expect.stringMatching(/STALE_AGENT_SESSION_BINDING|SPACE_MEMBER_ADMISSION_UNCONFIRMED/) })
    await surface.dispose()
  }
  expect(receipt).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
})

it('does not attach Native when only the persistent Activity mode is opened', async () => {
  const f = await fixture('activity-only')
  useAppStore.getState().setViewMode(originalSourceInputOwnerKey(f.target.target.runtimeId, f.sid), 'activity', { focus: false })
  await act(async () => root.render(f.view()))
  await vi.waitFor(() => expect(container.querySelector('[data-agent-surface-mode="activity"]')).not.toBeNull())
  // Wait for the original fixed read, not a timer or an empty early assertion.
  const surface = await vi.mocked(api.spaceMounts.member).mock.results[0]!.value
  await surface.call('read', {})
  expect(f.attach).not.toHaveBeenCalled(); expect(paint.terminals).toHaveLength(0)
})


it('refreshes the original terminal from its visible action while supplemental Session details remain unavailable', async () => {
  const f = await privateNativeFixture()
  await f.d.core.writeAgent({ agentSessionId: f.sid, expectedRun: f.run, data: 'Original refresh body\n', source: 'user' })
  const attach = f.d.core.refreshRunAttachment.bind(f.d.core)
  // The continuation representation is the controlled leaf here; the retained
  // bytes, original Session/Run, attachment and physical PTY are actual owners.
  const refresh = vi.spyOn(f.d.core, 'refreshRunAttachment').mockImplementation(async (...args) => {
    const result = await attach(...args), raw = await f.d.core.readRunReplay(f.run, 0, 'raw')
    return { ...result, replay: raw.replay, terminal: { type: 'unknown' as const, reason: 'origin_unknown' as const } }
  })
  await act(async () => root.render(f.view()))
  await vi.waitFor(() => expect(container.querySelector('.terminal-service-window')).not.toBeNull())
  await vi.waitFor(() => expect(paint.terminals[0]?.buffer.active.getLine(0)?.translateToString()).toContain('Original refresh body'))
  // Join the real shared component's pending acquisition before the visible
  // action. This callback is an existing product port, not a readiness mock.
  await vi.waitFor(() => expect(paint.refresh).not.toBeNull())
  await act(async () => { await paint.refresh!() })
  const before = refresh.mock.calls.length, terminal = paint.terminals[0]
  f.metadataUnavailable(true)
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('.terminal-service-window button')).find(button => button.textContent === 'Refresh observation')
  expect(button).toBeDefined(); await act(async () => button!.click())
  await vi.waitFor(() => expect(refresh, container.textContent ?? '').toHaveBeenCalledTimes(before + 1), { timeout: 8000 })
  await vi.waitFor(() => expect(container.textContent).toContain('Refreshing Session details'))
  expect(container.textContent).toContain('Original supplemental metadata unavailable')
  expect(paint.terminals[0]).toBe(terminal)
  expect(terminal?.buffer.active.getLine(0)?.translateToString()).toContain('Original refresh body')
  expect(container.querySelector('[role="textbox"]')?.textContent).toContain('Private Native proof draft')
  await act(async () => terminal!.input('Input after manual refresh\r'))
  await vi.waitFor(async () => expect((await f.d.core.readRunReplay(f.run, 0, 'raw')).replay.map(event => event.data).join('')).toContain('Input after manual refresh'))
})


it('requires the original receiver grant before exposing the original attachment to a current viewer', async () => {
  const source = await createSpaceSessionsFixture(cleanup)
  source.b.owner.runtimeId = 'runtime-B'
  const { createHostRouteInventoryFixture } = await import('../../../packages/core/test/helpers/host-route-inventory-fixture')
  const h = await createHostRouteInventoryFixture(cleanup as Array<() => Promise<void>>, { spatialState: source.b.spatial,
    hostedRuntime: () => source.b.hosted, coreClients: () => [{ hostId: 'local', client: source.b.core }] })
  h.native.mockResolvedValue()
  const session = await h.original.client.readAgentSession('recipient'); if (!session) throw Error('Original recipient absent')
  const subject = await h.original.client.runtimeSubject({ kind: 'agent-session', agentSessionId: session.agentSessionId })
  const bytes = new TextEncoder().encode('Original granted output')
  const native = vi.spyOn(h.original.client, 'refreshRunAttachment').mockResolvedValue({ run: subject.run,
    gap: null, resizeRevision: 0, terminal: { type: 'unknown', reason: 'origin_unknown' }, replay: [{ type: 'data',
      runId: session.run.runId, startByte: 0, endByte: bytes.length, data: new TextDecoder().decode(bytes), dataBytes: bytes }] })
  vi.spyOn(h.original.client, 'releaseRunAttachment').mockResolvedValue()
  const admission = await source.admit('collision', h.d.identity.runtimeId, session.agentSessionId, 'routed-attachment-C', h.route, h.original.root)
  const target = { hostId: 'current-viewer-source', target: { reference: { ...source.reference, runtimeId: h.b.identity.runtimeId },
    regionId: admission.address.regionId, runtimeId: h.d.identity.runtimeId, agentSessionId: session.agentSessionId,
    expectedRun: session.run, expectedAdmission: { kind: 'creation' as const, operationId: admission.requestId } } }
  const scopes = ['runtime.owner.identity', 'runtime.attachment-watch', 'runtime.release-consumer']
  await h.configure(h.b, [{ id: 'collision', route: h.route }], [h.grant('current-viewer-member', h.a.identity, h.b.identity, ['space.member.call', 'space.member.watch'])])
  await h.configure(h.c, [], [h.grant('source-terminal', h.b.identity, h.d.identity, scopes)])
  await h.configure(h.d, [], [])
  const main = spaceMountTransport(cleanup, [{ id: target.hostId, carrier: { forwardRpc: h.rpc.call.bind(h.rpc), subscribeRpc: h.rpc.subscribe.bind(h.rpc) } }], structuredClone(DEFAULT_CONFIG))
  const surface = await main.api.member(target, () => {}); cleanup.push(() => surface.dispose())
  await expect(surface.call('attach', { afterByte: 0 })).rejects.toMatchObject({ code: 'HOST_ROUTE_NOT_DELEGATED' })
  expect(native).not.toHaveBeenCalled()
  await h.configure(h.d, [], [h.grant('receiver-terminal', h.c.identity, h.d.identity, scopes)])
  const attached = await surface.call('attach', { afterByte: 0 })
  expect(attached.session.control).toMatchObject({ agentSessionId: session.agentSessionId, run: session.run })
  expect(attached.replay.map(event => event.data).join('')).toBe('Original granted output')
  expect(native).toHaveBeenCalledTimes(1)
  await surface.call('detach', { attachmentId: attached.attachmentId })
  await surface.dispose()
})
