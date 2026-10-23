// @vitest-environment happy-dom
const { fixtureEpoch: _newTailFixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
import { act, useEffect } from 'react'
import { afterAll, afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentMuxControlServer, connectAgentMuxRpc, defaultAgentMuxMessageQueuePath, DurableAgentMuxMessageQueue, type AgentTimelineItem } from '@agentmux/core'
import { consumeConversationWindowPage, conversationItemRef, projectConversationRecords, projectConversationWindow, type ConversationItemRef } from '@agentmux/core/conversation'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'
import { createWorkspaceLayout } from '@agentmux/layout'
import { fixtureTime } from '../scripts/lib/fixture-values.mjs'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { composerDOM, composerSession, composerConfig } from './helpers/composer-dom-fixture'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { readStyleSheet } from './helpers/styles'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import type { MailboxMessageNavigationResult } from '../src/renderer/src/lib/mailbox-message-navigation'

const terminal = vi.hoisted(() => ({ mounted: 0, disposed: 0 }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => {
  useEffect(() => { ++terminal.mounted; return () => { ++terminal.disposed } }, [])
  return <div data-original-terminal />
} }))
// The original writable SessionPane is mounted below at its real occurrence. No copied observation pane.
vi.mock('../src/renderer/src/components/SessionObservationRegions', () => ({ SessionObservationRegions: () => null }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { SessionPane } from '../src/renderer/src/components/SessionPane'

const SESSION = 'original', NOW = fixtureTime(12 * 3_600_000), BODY = 'Same recorded body', mailboxMessageId = 'mailbox'
let directory: string, client: AgentMuxClient, reads: string[], forbidden: ReturnType<typeof vi.spyOn>[]
let nativeRead: Mock<AgentMuxClient['readSessionHistoryPage']>
const closes: Array<() => unknown | Promise<unknown>> = []
// composerDOM registers later: unmount the original React consumers before closing their private sources.
afterEach(async () => {
  useAppStore.getState().conversationRevealIntent?.complete({ kind: 'cancelled' })
  try {
    const failures: unknown[] = []
    for (const close of closes.splice(0).reverse()) { try { await close() } catch (error) { failures.push(error) } }
    if (failures.length) throw new AggregateError(failures, 'Original Focus reading sources failed to close')
  } finally {
    try { await client?.dispose() } finally {
      await rm(directory, { recursive: true, force: true }); vi.useRealTimers(); vi.unstubAllEnvs(); overlay()?.remove()
    }
  }
})
const dom = composerDOM()
const location = { displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'original-tab', regionId: 'original-region' }
const origin = { workspaceId: location.displayWorkspaceId, tabGroupId: location.groupId, tabId: location.tabId, regionId: location.regionId, sessionId: SESSION }
const native = (recordId: string, nativeSessionId = 'native-original'): ConversationItemRef => ({ hostId: 'local', agentSessionId: SESSION, source: { kind: 'native', providerId: 'claude', nativeSessionId, recordId } })
const captured = (recordId: string): ConversationItemRef => ({ hostId: 'local', agentSessionId: SESSION, source: { kind: 'captured', recordId } })
let navigate: ReturnType<typeof vi.fn>
const overlay = () => document.getElementById('agentmux-window-overlay-host')!
const inputRecord = (source: string, recordId: string) => overlay().querySelector<HTMLButtonElement>(`[data-record-source="${source}"][data-record-raw-id="${recordId}"]`)!
const located = () => dom.container.querySelector<HTMLElement>('.activity-feed [data-message-located]')
async function flush() { await act(async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }); await act(async () => new Promise(resolve => setTimeout(resolve, 20))) }
async function wait(check: () => void) {
  await vi.waitFor(async () => {
    // Let each original Reader/IPC result commit before checking its actual DOM.
    await act(async () => { await Promise.resolve() })
    check()
  }, { timeout: 3000, interval: 10 })
}
async function click(button: HTMLElement | null) { expect(button).not.toBeNull(); await act(async () => button!.click()); await flush() }
async function records() { await click(dom.container.querySelector('[aria-label="View conversation records"]')); await wait(() => expect(inputRecord('native', 'untimed')).not.toBeNull()) }
function render(focus = true, pane = true, visible = true) {
  return dom.render(<>{focus ? <GlobalFocusSurface visible={visible} onSelectContext={navigate} /> : null}{pane ? <SessionPane sessionId={SESSION} surfaceKind="agent" visible={visible} interactiveResize={false} linkOrigin={origin} /> : null}</>)
}
function noRuntime() { for (const spy of forbidden) expect(spy).not.toHaveBeenCalled(); expect(api.sessions.historyPage).not.toHaveBeenCalled() }

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW)
  terminal.mounted = terminal.disposed = 0; reads = []; localStorage.clear()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const height = this.classList.contains('activity-feed') ? 300 : 20
    return { x: 0, y: 0, top: 0, left: 0, right: 600, bottom: height, width: 600, height, toJSON() {} }
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  Object.defineProperty(HTMLElement.prototype, 'hidePopover', { configurable: true, value() {
    const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'closed' }); this.dispatchEvent(event)
  } })
  directory = await mkdtemp(join(tmpdir(), 'fr-'))
  const transcriptPath = join(directory, 'original.jsonl')
  await writeFile(transcriptPath, ['same', 'second', 'untimed'].map((uuid, index) => JSON.stringify({ sessionId: 'native-original', uuid,
    type: index === 2 ? 'user' : 'assistant', message: { role: index === 2 ? 'user' : 'assistant', content: index === 2 ? 'Untimed original input' : BODY },
    ...(index === 2 ? {} : { timestamp: new Date(NOW - (index + 1) * 3_600_000).toISOString() }) })).join('\n') + '\n')
  const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json'))
  const nativeHandle = { kind: 'provider' as const, providerId: 'claude', sessionId: 'native-original', transcriptPath }
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: SESSION, providerId: 'claude', executorId: 'claude', hostId: 'local', workspacePath: directory,
    run: { runId: `run-${SESSION}` }, retiredRuns: [], createdAt: _newTailFixtureEpoch(0, 0, 1), updatedAt: _newTailFixtureEpoch(0, 0, 1), hookBindingId: 'original-binding', hookToken: 'fixture-private-token', nativeHandle })
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', '')
  client = new AgentMuxClient({ store })
  const kernel = client['kernel']
  forbidden = (['connect', 'start', 'stop', 'resize', 'attach', 'status', 'input'] as const).map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw new Error(`Unexpected Runtime action: ${name}`) }))
  const originalClient = client
  const nativeOwner = originalClient['readSessionHistoryPage'], nativeDescriptor = Object.getOwnPropertyDescriptor(originalClient, 'readSessionHistoryPage')
  nativeRead = vi.fn<typeof nativeOwner>((...args) => nativeOwner.call(originalClient, ...args))
  client['readSessionHistoryPage'] = (...args) => { reads.push(args[0]); return nativeRead(...args) }
  closes.push(() => { if (nativeDescriptor) Object.defineProperty(originalClient, 'readSessionHistoryPage', nativeDescriptor); else Reflect.deleteProperty(originalClient, 'readSessionHistoryPage') })
  vi.spyOn(api.sessions, 'historyPage')
  const originals: AgentTimelineItem[] = [{ id: 'same', agentSessionId: SESSION, kind: 'assistant_message', source: 'native-hook', status: 'complete', authorAgentSessionId: SESSION, title: 'Original captured reply', content: BODY, createdAt: NOW - 3_600_000, updatedAt: NOW - 3_600_000 },
    { id: 'mailbox', agentSessionId: SESSION, kind: 'user_message', source: 'user', status: 'complete', authorAgentSessionId: 'decoy', publicContent: 'confirmed',
      inputRef: { kind: 'message', agentSessionId: SESSION, messageId: mailboxMessageId, expectedRun: { runId: `run-${SESSION}` } },
      title: 'Original collaboration input', content: 'Original collaboration input', createdAt: NOW - 3_600_000, updatedAt: NOW - 3_600_000 }]
  for (const item of originals) await client['persistAndPublishTimeline']({ type: 'upsert', agentSessionId: SESSION, item }, { source: 'agentmux', observedAt: item.updatedAt }, 'local')
  const journal = new DurableAgentMuxMessageQueue(defaultAgentMuxMessageQueuePath(store.path, ''))
  await journal.append({ messageId: mailboxMessageId, operationId: 'focus-original-mailbox-operation', createdAt: NOW - 3_600_000,
    sender: { kind: 'agent-session', agentSessionId: 'decoy' }, recipient: { kind: 'agent-session', agentSessionId: SESSION },
    senderSessionId: 'decoy', senderRunId: null, recipientSessionId: SESSION, recipientRunId: `run-${SESSION}`,
    threadId: 'focus-original-thread', correlationId: 'focus-original-correlation', replyTo: null, workspaceId: null, body: 'Original collaboration input' })
  const capturedRecords = (await store.readCapturedHistory(SESSION, { limit: 2 })).records.map(record => record.item)
  expect(capturedRecords).toHaveLength(2); expect(capturedRecords).toEqual(expect.arrayContaining(originals))
  expect((await client.readMessage({ messageId: mailboxMessageId }))?.envelope).toMatchObject({ messageId: mailboxMessageId, senderSessionId: 'decoy', recipientSessionId: SESSION })
  await desktopConversationReadBridge({ root: directory, client }, closes)
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(directory, 'conversation.sock') } })
  closes.push(() => rpc.dispose())
  vi.spyOn(api.sessions, 'readHistory').mockImplementation((reference, input, context) => rpc.call('agent.history', { ...input, ...reference }, context?.signal ? { signal: context.signal } : {}))
  vi.spyOn(api.sessions, 'inputMailbox').mockImplementation(async (reference, input = {}) => {
    const { hostId, ...page } = await rpc.call('agent.input.ls', { ...input, ...reference })
    expect(hostId).toBe(reference.hostId)
    return page
  })
  vi.spyOn(api.sessions, 'listMessages').mockImplementation((reference, input) => rpc.call('message.ls', { ...input, hostId: reference.hostId, participantSessionId: reference.agentSessionId }))
  vi.spyOn(api.sessions, 'readMessage').mockImplementation((reference, messageId) => rpc.call('message.read', { hostId: reference.hostId, messageId }))
  const originalTimeline = await client.sessionTimeline(SESSION)
  expect(originalTimeline.sourceHostId).toBe('local'); expect(originalTimeline.items).toHaveLength(2)
  expect(originalTimeline.items).toEqual(expect.arrayContaining(originals))
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: directory })
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  const original = { ...composerSession(SESSION, 'claude'), workspacePath: directory, nativeHandle }
  const tab = addWorkbenchRegion(createWorkbenchTab(location.tabId, { kind: 'agent', phase: 'attached', regionId: location.regionId, workspaceId: 'workspace', sessionId: SESSION }), location.regionId, 'right', { kind: 'agent', phase: 'attached', regionId: 'decoy-region', workspaceId: 'workspace', sessionId: 'decoy' })
  useAppStore.setState({ config: { ...composerConfig, executors: { claude: { ...composerConfig.executors.codex!, providerId: 'claude', command: 'claude' } }, workspaces: [{ ...composerConfig.workspaces[0]!, path: directory }] },
    sessions: [original, { ...composerSession('decoy', 'claude'), workspacePath: directory }], tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('group', [tab.id]) },
    mainSurface: 'agents', activeWorkspaceId: 'workspace', workbenchSpaceSelection: null, agentFocus: { execution: { sessionId: SESSION, history: [] }, pmo: { sessionId: null } },
    timelines: { [SESSION]: originalTimeline },
    viewModes: { [SESSION]: 'terminal' }, agentComposerDrafts: { [SESSION]: 'Keep original draft' }, recoveryCandidates: [], error: null, conversationRevealIntent: null })
  expect(useAppStore.getState().focusExecutionSession(SESSION)).toBe(true)
  navigate = vi.fn((id: string) => useAppStore.getState().focusExecutionSession(id))
})

afterAll(() => vi.unstubAllGlobals())

it('common references preserve original source, record, Host and unknown time without acquiring an identity from text', () => {
  const page = { agentSessionId: SESSION, source: { providerId: 'claude', nativeSessionId: 'native-original' }, items: [{ id: 'same', kind: 'assistant-message' as const, contentParts: [{ kind: 'text' as const, text: BODY }] }] }
  const [unknown] = projectConversationRecords({ agentSessionId: SESSION, historyPage: page })
  expect(unknown!.content).toBe(BODY); expect(unknown!.recordedAt).toBeUndefined(); expect(conversationItemRef(unknown!)).toBeNull()
  const [known] = projectConversationRecords({ agentSessionId: SESSION, executionHostId: 'local', historyPage: page })
  expect(conversationItemRef(known!)).toEqual(native('same'))
  expect(conversationMessageSourceKey(SESSION, native('same').source)).not.toBe(conversationMessageSourceKey(SESSION, captured('same').source))
})

it('the existing public conversation inspect RPC and compiled CLI retain the same exact original references without Runtime control', async () => {
  const rpcRoot = await mkdtemp(join(tmpdir(), 'fr-rpc-')), socketPath = join(rpcRoot, 'control.sock')
  const server = new AgentMuxControlServer({ socketPath, coreClients: () => [{ hostId: 'local', client }] })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  try {
    const input = { hostId: 'local', agentSessionId: SESSION, nativeSource: { providerId: 'claude', nativeSessionId: 'native-original' }, limit: 10 }
    const page = await rpc.call('agent.conversation.inspect', input)
    // happy-dom gives imported modules a browser URL; use the helper's explicit compiled entry.
    vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', join(process.cwd(), 'packages/core/bin/amux'))
    const cli = await runCompiledObjectCli(['--endpoint', `unix:${socketPath}`, 'agent', 'conversation', 'inspect', '--input', '-'],
      objectCliEnvironment(rpcRoot), JSON.stringify(input))
    expect(cli.code, cli.stderr).toBe(0); expect(cli.stderr).toBe('')
    expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true, operation: 'agent.conversation.inspect', result: { items: page.items, scope: page.scope } })
    const accepted = consumeConversationWindowPage(page)
    expect(accepted.kind).toBe('complete')
    if (accepted.kind !== 'complete') throw new Error('The original RPC page did not complete its exact conversation window')
    const refs = projectConversationWindow(accepted.snapshot).records.map(conversationItemRef)
    expect(refs).toEqual(expect.arrayContaining([native('same'), native('second'), native('untimed')]))
    await expect(rpc.call('agent.conversation.inspect', { ...input, hostId: 'unrelated-host' })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    noRuntime()
    const artifact = '.bagakit/feature-tracker/features/f-2wr8fmvnv/artifacts'
    await mkdir(artifact, { recursive: true }); await writeFile(join(artifact, 'T-016-public-reader.json'), JSON.stringify({ method: 'agent.conversation.inspect', input, refs, cliExit: cli.code, cliResult: JSON.parse(cli.stdout), runtimeActions: 0 }, null, 2) + '\n')
  } finally { vi.unstubAllEnvs(); await rpc.dispose(); await server.stop(); await rm(rpcRoot, { recursive: true, force: true }) }
})

it('actual Focus → original spatial selection → public Core reader → SessionPane locates same-body native and captured replies separately', async () => {
  await render(); await records()
  const workface = useAppStore.getState().tabs, run = useAppStore.getState().sessions[0]!.control.run
  const markerRefs = [...dom.container.querySelectorAll<HTMLElement>('[data-conversation-item-refs]')].flatMap(node => JSON.parse(node.dataset.conversationItemRefs!) as ConversationItemRef[])
  expect(markerRefs).toEqual(expect.arrayContaining([native('same'), native('second'), captured('same'), captured('mailbox')]))
  expect(markerRefs).not.toEqual(expect.arrayContaining([native('untimed')]))
  const witnesses: unknown[] = []
  for (const ref of [native('same'), native('second'), captured('same'), native('untimed')]) {
    const before = useAppStore.getState().agentFocus
    await click(inputRecord(ref.source.kind, ref.source.recordId))
    expect(useAppStore.getState().agentFocus).toBe(before)
    expect(JSON.parse(overlay().querySelector('.recent-focus__message-body .log-turn')!.getAttribute('data-conversation-item-ref')!)).toEqual(ref)
    if (ref.source.recordId === 'untimed') expect(overlay().textContent).toContain('Record time unknown')
    const button = [...overlay().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Return to Context')!
    await click(button)
    await wait(() => expect(located()?.dataset.messageSourceKey).toBe(conversationMessageSourceKey(SESSION, ref.source)))
    expect(JSON.parse(located()!.dataset.conversationItemRef!)).toEqual(ref)
    expect(document.activeElement).toBe(located())
    expect(useAppStore.getState().agentFocus.execution.reference).toEqual(location)
    expect(useAppStore.getState().conversationRevealIntent).toBeNull()
    witnesses.push({ itemRef: ref, rendered: located()!.dataset.conversationItemRef, selectedLocation: useAppStore.getState().agentFocus.execution.reference })
    if (ref.source.recordId !== 'untimed') await records()
  }
  expect(navigate.mock.calls).toEqual(Array.from({ length: 4 }, () => [SESSION, undefined]))
  expect(reads.length).toBeGreaterThan(0); expect(new Set(reads)).toEqual(new Set([SESSION]))
  expect(useAppStore.getState().tabs).toBe(workface); expect(useAppStore.getState().sessions[0]!.control.run).toEqual(run)
  expect(dom.draft(SESSION)).toBe('Keep original draft'); expect(terminal).toEqual({ mounted: 1, disposed: 0 }); noRuntime()
  const artifact = '.bagakit/feature-tracker/features/f-2wr8fmvnv/artifacts'
  await mkdir(artifact, { recursive: true }); await writeFile(join(artifact, 'T-016-consumer.json'), JSON.stringify({ witnesses, reads, terminal, runtimeActions: 0,
    chain: 'Mounted GlobalFocusSurface/RecentFocusTimeline/FocusMessagePreview → original Store.focusExecutionSession/selectMainRegion → ephemeral SessionPane intent → target Activity/useSessionConversationWindow/useConversationView → original Renderer conversation API/preload/Main IPC/Unix service → public Core readAgentConversation → built-in Claude JSONL reader and persisted captured originals → actual ConversationView/ConversationMessage row and focus',
    boundary: 'Native transcript and captured timeline fixtures; Terminal leaf controlled. No vendor CLI, physical keyboard, OS restart or installation claim.' }, null, 2) + '\n')
})

it('wrong original source never matches an equal raw ID or equal body and keeps the original Terminal, record and draft', async () => {
  await render(); await records()
  const firstReads = reads.length, firstNativeReads = nativeRead.mock.calls.length
  const originalSession = useAppStore.getState().sessions.find(session => session.id === SESSION)
  if (originalSession?.kind !== 'agent') throw new Error('The original Agent control is unavailable')
  const run = originalSession.control.run
  type Read = typeof api.conversation.readAgentConversation
  const returned: Array<{ input: Parameters<Read>[0]; page: Awaited<ReturnType<Read>> }> = []
  const read = vi.mocked(api.conversation.readAgentConversation).getMockImplementation()!
  vi.mocked(api.conversation.readAgentConversation).mockImplementation(async (...args) => {
    const page = await read(...args); returned.push({ input: args[0], page }); return page
  })
  let outcome: MailboxMessageNavigationResult | undefined
  await act(async () => { void useAppStore.getState().revealConversationItem(native('same', 'different-original-source')).then(result => { outcome = result }) })
  await wait(() => expect(outcome?.kind).toBe('unavailable'))
  expect(outcome?.kind === 'unavailable' && outcome.itemRef).toEqual(native('same', 'different-original-source'))
  expect(useAppStore.getState().viewModes[SESSION]).toBe('terminal'); expect(located()).toBeNull()
  // The cold target Reader must establish its own current source. It may read
  // that original page once, but must never issue the forged exact record read.
  expect(reads).toHaveLength(firstReads + 1)
  const initialized = nativeRead.mock.calls.slice(firstNativeReads)
  expect(initialized).toHaveLength(1)
  expect(initialized[0]![0]).toBe(SESSION); expect(initialized[0]![1].cursor).toBeUndefined()
  expect(initialized[0]![2]).toEqual({ providerId: 'claude', nativeSessionId: 'native-original' })
  const roots = returned.filter(receipt => !receipt.input.cursor)
  expect(roots.length).toBeGreaterThan(0)
  for (const { input } of returned) {
    expect(input).toMatchObject({ hostId: 'local', agentSessionId: SESSION }); expect(input.record).toBeUndefined()
    if (input.nativeSource) expect(input.nativeSource).toEqual({ providerId: 'claude', nativeSessionId: 'native-original' })
  }
  const complete = returned.flatMap(receipt => receipt.page.window.complete ? [receipt.page] : [])
  expect(complete.length).toBeGreaterThan(0)
  for (const page of complete) {
    expect(page.scope.sources.filter(source => source.kind === 'native')).toEqual([{ kind: 'native', providerId: 'claude', nativeSessionId: 'native-original' }])
    const refs = page.items.flatMap(entry => entry.kind === 'item' ? entry.item.records.map(record => {
      expect(record.reference).not.toBeNull()
      if (!record.reference) throw new Error('The actual original source record has no exact reference')
      return record.reference
    }) : [])
    expect(refs).toContainEqual(native('same'))
    expect(refs.filter(ref => ref.source.kind === 'native').every(ref => ref.hostId === 'local' && ref.agentSessionId === SESSION &&
      ref.source.kind === 'native' && ref.source.providerId === 'claude' && ref.source.nativeSessionId === 'native-original')).toBe(true)
    expect(refs).not.toContainEqual(native('same', 'different-original-source'))
  }
  expect(inputRecord('native', 'same').textContent).toContain(BODY)
  expect(useAppStore.getState().conversationRevealIntent).toBeNull(); expect(dom.draft(SESSION)).toBe('Keep original draft')
  const retained = useAppStore.getState().sessions.find(session => session.id === SESSION)
  expect(retained?.kind === 'agent' && retained.control.run).toEqual(run); expect(terminal).toEqual({ mounted: 1, disposed: 0 }); noRuntime()
})

it('a later input cancels an in-flight original read and its late result cannot switch mode or seize focus', async () => {
  await render(false)
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const nativeOwner = nativeRead.getMockImplementation()!
  nativeRead.mockImplementationOnce(async (...args) => { await hold; return nativeOwner(...args) })
  let outcome: MailboxMessageNavigationResult | undefined
  await act(async () => { void useAppStore.getState().revealConversationItem(native('same')).then(result => { outcome = result }) })
  await wait(() => expect(reads).toEqual([SESSION]))
  await act(async () => document.dispatchEvent(new Event('wheel')))
  await wait(() => expect(outcome).toEqual({ kind: 'cancelled' }))
  await act(async () => release()); await flush()
  expect(useAppStore.getState().viewModes[SESSION]).toBe('terminal'); expect(located()).toBeNull(); expect(useAppStore.getState().conversationRevealIntent).toBeNull()
  expect(terminal).toEqual({ mounted: 1, disposed: 0 }); expect(dom.draft(SESSION)).toBe('Keep original draft'); noRuntime()
})

it('an unmounted original occurrence keeps one cancellable intent, freezes its target and never rebinds to later focus', async () => {
  await render(false, false)
  const ref = native('same')
  let outcome: MailboxMessageNavigationResult | undefined
  await act(async () => { void useAppStore.getState().revealConversationItem(ref).then(result => { outcome = result }) })
  expect(useAppStore.getState().conversationRevealIntent?.itemRef).toEqual(ref)
  ref.source.recordId = 'changed-after-click'
  expect(useAppStore.getState().conversationRevealIntent?.itemRef.source.recordId).toBe('same')
  await act(async () => { expect(useAppStore.getState().focusExecutionSession('decoy')).toBe(true) })
  await wait(() => expect(outcome).toEqual({ kind: 'cancelled' }))
  await render(false); await flush()
  expect(useAppStore.getState().conversationRevealIntent).toBeNull(); expect(useAppStore.getState().viewModes[SESSION]).toBe('terminal'); expect(reads).toEqual([]); noRuntime()
})


it('original Mailbox still reveals only its user record through the same owner and never promotes Focus replies into input', async () => {
  await render(false)
  const panel = dom.container.querySelector<HTMLElement>('.composer-mailbox')!
  const tokens = readStyleSheet('./tokens.css')
  for (const name of ['--dur-enter', '--ease-enter']) {
    const value = new RegExp(`${name}:\\s*([^;]+);`, 'u').exec(tokens)?.[1]?.trim()
    expect(value, name).toBeTruthy(); panel.style.setProperty(name, value!)
  }
  let nativeOpen = false
  const matches = panel.matches.bind(panel)
  vi.spyOn(panel, 'matches').mockImplementation(selector => selector === ':popover-open' ? nativeOpen : matches(selector))
  const state = (newState: 'open' | 'closed') => {
    const before = new Event('beforetoggle'); Object.defineProperty(before, 'newState', { value: newState }); panel.dispatchEvent(before)
    nativeOpen = newState === 'open'
    const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: newState }); panel.dispatchEvent(event)
  }
  Object.defineProperties(panel, { showPopover: { configurable: true, value: () => state('open') }, hidePopover: { configurable: true, value: () => state('closed') } })
  await act(async () => panel.showPopover()); await flush()
  await click(panel.querySelector('[id$="-user-tab"]'))
  await wait(() => {
    const inputs = panel.querySelectorAll('.composer-mailbox__row')
    expect(inputs).toHaveLength(1); expect(inputs[0]!.textContent).toContain('Untimed original input')
  })
  expect(panel.querySelector('[data-record-key="timeline:same"]')).toBeNull()
  expect(panel.querySelector('.composer-mailbox__messages')?.textContent).not.toContain(BODY)
  await click(panel.querySelector('[id$="-agents-tab"]')); await click(panel.querySelector('[id$="-inbox-tab"]'))
  let user: HTMLElement | null = null
  await wait(() => { user = panel.querySelector(`[data-record-key="a2a:${mailboxMessageId}"]`); expect(user).not.toBeNull() })
  expect(panel.querySelector('[data-record-key="timeline:same"]')).toBeNull()
  expect(panel.querySelector('[data-record-key="a2a:same"]')).toBeNull()
  await click(user!.parentElement!.querySelector('.composer-mailbox__reveal'))
  await wait(() => expect(located()?.dataset.messageSourceKey).toBe(conversationMessageSourceKey(SESSION, captured('mailbox').source)))
  expect(JSON.parse(located()!.dataset.conversationItemRef!)).toEqual(captured('mailbox'))
  expect(located()!.textContent).toContain('Original collaboration input')
  expect(dom.draft(SESSION)).toBe('Keep original draft'); expect(terminal).toEqual({ mounted: 1, disposed: 0 }); noRuntime()
})


it('Focus keeps pending reading progress cancellable and hiding releases that intent without operating its original Run', async () => {
  await render(true, false)
  await records(); await click(inputRecord('native', 'same'))
  const button = [...overlay().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Return to Context')!
  await click(button)
  expect(overlay().textContent).toContain('Locating original record…')
  const navigation = button.closest('footer')!
  expect(navigation).not.toBeNull()
  expect(navigation.querySelector('[role="status"]')?.textContent).toBe('Locating original record…')
  expect(navigation.contains(overlay().querySelector('.recent-focus__message-body'))).toBe(false)
  expect(overlay().textContent).toContain(BODY)
  expect(useAppStore.getState().conversationRevealIntent?.itemRef).toEqual(native('same'))
  const before = reads.length
  await render(true, false, false); await flush()
  expect(useAppStore.getState().conversationRevealIntent).toBeNull()
  expect(useAppStore.getState().viewModes[SESSION]).toBe('terminal'); expect(reads).toHaveLength(before); noRuntime()
})

it('a failed return from another Context retains the exact original body and source diagnosis until a later explicit selection', async () => {
  expect(useAppStore.getState().focusExecutionSession('decoy')).toBe(true)
  await render(); await click(dom.container.querySelector('[aria-label="View conversation records"]'))
  const context = overlay().querySelector<HTMLSelectElement>('[aria-label="Conversation records Context"]')!
  await act(async () => { context.value = SESSION; context.dispatchEvent(new Event('change', { bubbles: true })) })
  await wait(() => expect(inputRecord('native', 'same')).not.toBeNull())
  await click(inputRecord('native', 'same'))
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === SESSION ? { ...session, providerId: 'codex' } : session) })))
  await click([...overlay().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Return to Context')!)
  await wait(() => expect(overlay().querySelector('.recent-focus__message-body')).not.toBeNull())
  const original = overlay().querySelector<HTMLElement>('.recent-focus__message-body .log-turn')!
  expect(original.textContent).toContain(BODY); expect(JSON.parse(original.dataset.conversationItemRef!)).toEqual(native('same'))
  expect(overlay().textContent).toContain('原生来源已变化')
  const navigation = [...overlay().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Return to Context')!.closest('footer')!
  expect(navigation).not.toBeNull()
  expect(navigation.querySelector('[role="status"]')?.textContent).toContain('原文仍可阅读和复制')
  expect(navigation.contains(original)).toBe(false)
  expect(useAppStore.getState().viewModes[SESSION]).toBe('terminal'); expect(useAppStore.getState().conversationRevealIntent).toBeNull()
  await act(async () => { expect(useAppStore.getState().focusExecutionSession('decoy')).toBe(true) }); await flush()
  expect(overlay().querySelector('.recent-focus__message-preview')).toBeNull(); noRuntime()
})
