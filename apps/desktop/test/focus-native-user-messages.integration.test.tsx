// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentProviderRegistry, defineAgentProvider, agentPromptCondition, loadAgentSessions } from '@agentmux/core'
import * as UserMessages from '@agentmux/core/session-user-messages'
import type { AgentMuxStoredAgentSession, AgentSessionHistoryPage } from '@agentmux/core'
import type { CtxmuxAdapterRun } from '../../../packages/core/src/ctxmux-run-adapter.js'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
import { localDateTime } from '../src/renderer/src/lib/focus-time-window'
// Only the right-side terminal leaf is replaced. The built-in Claude history
// reader, public Client/FileStore, actual Store and Global Focus are real.
// Private recorded files are not a live CLI, physical keyboard, daemon or PTY.
vi.mock('../src/renderer/src/components/SessionObservationRegions', () => ({ SessionObservationRegions: () => createElement('output', { 'data-terminal-leaf': 'controlled' }) }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'

const NOW = Date.parse('2026-10-03T12:00:00Z')
const HOUR = 3_600_000
const A = 'native-focus-a', B = 'native-focus-b', C = 'native-focus-c'
const baseline = useAppStore.getState()
const roots: Root[] = [], nodes: HTMLElement[] = [], clients: AgentMuxClient[] = [], directories: string[] = []
type NativeRecord = { uuid: string; type: string; message: { role: string; content: unknown }; timestamp?: string }
const record = (uuid: string, content: unknown, at: number | null = NOW - HOUR, type = 'user'): NativeRecord => ({ uuid, type, message: { role: type, content }, ...(at === null ? {} : { timestamp: new Date(at).toISOString() }) })
const nativeId = (id: string) => `native:claude:native-${A}:${id}`
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  for (const node of nodes.splice(0)) node.remove()
  for (const client of clients.splice(0)) await client.dispose()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
  document.getElementById('agentmux-window-overlay-host')?.remove()
})

function floating() {
  const node = document.getElementById('agentmux-window-overlay-host')
  expect(node, 'Actual shared overlay host').not.toBeNull(); return node!
}

async function fixture(records: NativeRecord[], captured = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW)
  const directory = await mkdtemp(join(tmpdir(), 'focus-native-inputs-')); directories.push(directory)
  const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json'))
  const writeRecords = (values: NativeRecord[], id = A) => writeFile(join(directory, `${id}.jsonl`), values.map(value => JSON.stringify({ sessionId: `native-${id}`, ...value })).join('\n') + '\n')
  await writeRecords(records); await writeRecords([record('other', 'Another Context input')], B); await writeRecords([record('decoy', 'Same-name Context input')], C)
  const stored: AgentMuxStoredAgentSession[] = [A, C, B].map(id => ({ kind: 'agent', agentSessionId: id, providerId: 'claude', executorId: 'claude', hostId: 'local', workspacePath: directory,
    run: { runId: `${id}-original-run` }, retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: `${id}-binding`, hookToken: `${id}-private`,
    semanticStatus: { state: 'done', source: 'native-hook', observedAt: 1, stateEnteredAt: 1 }, nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: `native-${id}`, transcriptPath: join(directory, `${id}.jsonl`) } }))
  for (const session of stored) await store.compareAndSwap(null, session)
  // The captured-only controlled input adapter has no physical screen. Native
  // records still use the unchanged built-in Claude history contribution.
  const base = new AgentProviderRegistry().get('claude')
  const captureProvider = defineAgentProvider({ catalog: base.catalog, hook: base.hook, buildArgs: (_prompt, args) => [...args],
    planManagedHooks: base.planManagedHooks!, readSessionHistoryPage: base.readSessionHistoryPage! })
  const client = new AgentMuxClient({ store, ...(captured ? { providers: [captureProvider] } : {}) }); clients.push(client)
  const inner = client as unknown as { connected: boolean; registry: { load(host: string): Promise<void> }; kernel: {
    isConnected(): boolean; identity(): object; status(runId: string): Promise<CtxmuxAdapterRun>; input(runId: string, operation: { expectedByte: number; data: string }): Promise<{ run: CtxmuxAdapterRun; appliedByteRange: { startByte: number; endByte: number } }>
  } & Record<string, unknown> }
  const forbiddenNames = ['connect', 'start', 'stop', 'resize', 'attach'] as const
  const forbidden: Array<{ mock: { calls: unknown[][] } }> = forbiddenNames.map(name => vi.spyOn(inner.kernel as Record<string, (...args: unknown[]) => unknown>, name).mockImplementation(() => { throw new Error(`Forbidden Runtime control: ${name}`) }))
  const writes: string[] = []
  if (captured) {
    await inner.registry.load('local'); inner.connected = true; inner.kernel.isConnected = () => true; inner.kernel.identity = () => ({ daemonInstanceId: 'controlled-input-adapter-no-daemon' })
    let cursor = 0
    const run = (): CtxmuxAdapterRun => ({ runId: stored[0]!.run.runId, lifecycleOperationId: null, program: 'claude', args: [], workspacePath: directory, pid: 123, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: cursor })
    inner.kernel.status = async () => run()
    inner.kernel.input = async (_runId, operation) => { expect(operation.expectedByte).toBe(cursor); const startByte = cursor; cursor += Buffer.byteLength(operation.data); writes.push(operation.data); return { run: run(), appliedByteRange: { startByte, endByte: cursor } } }
  } else {
    forbidden.push(vi.spyOn(inner.kernel, 'status').mockImplementation(async () => { throw new Error('No Runtime status required for history') }))
    forbidden.push(vi.spyOn(inner.kernel, 'input').mockImplementation(async () => { throw new Error('No Runtime input required for history') }))
  }
  const sessions: SessionSnapshot[] = stored.map(session => ({ id: session.agentSessionId, kind: 'agent', providerId: 'claude', executorId: 'claude', hostId: 'local', workspacePath: directory,
    label: session.agentSessionId === A ? 'Primary input Context' : 'Same worker name', createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, processState: 'running', latestOutputBytes: 0,
    status: { state: 'running', source: 'run-process', observedAt: 1 }, capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: session.agentSessionId, run: session.run } }))
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }], executors: { claude: { label: 'Claude', providerId: 'claude', command: 'claude', args: [], env: {}, injectAgentMuxGuide: true } },
    workspaces: [{ id: 'native-project', hostId: 'local', name: 'Native inputs', path: directory, kind: 'folder' }], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: directory })
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  const reads: Array<{ id: string; cursor: string | undefined; page: AgentSessionHistoryPage }> = []
  const history = vi.spyOn(api.sessions, 'historyPage').mockImplementation(async (control, options) => { const page = await client.sessionHistoryPage(control.agentSessionId, options); reads.push({ id: control.agentSessionId, cursor: options?.cursor, page }); return page })
  useAppStore.setState({ config, sessions, timelines: {}, tabs: {}, layouts: {}, recoveryCandidates: [], agentNames: {}, workspaceFileRevisions: {}, mainSurface: 'agents', activeWorkspaceId: 'native-project', error: null,
    agentFocus: { execution: { sessionId: A, history: [] }, pmo: { sessionId: null } } })
  client.onEvent(event => { if (event.type === 'agent-timeline') useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event }) })
  const element = document.createElement('div'); document.body.append(element); nodes.push(element)
  const root = createRoot(element); roots.push(root)
  const render = () => act(async () => root.render(createElement(GlobalFocusSurface)))
  const click = async (selector: string) => { const target = element.querySelector<HTMLButtonElement>(selector) ?? floating().querySelector<HTMLButtonElement>(selector); expect(target, selector).not.toBeNull(); await act(async () => target!.click()) }
  const wait = async (check: () => void) => act(async () => { await vi.waitFor(check, { timeout: 3000, interval: 10 }) })
  const readInputs = async () => { await click('[aria-label="View input records"]'); await wait(() => expect(floating().querySelector('[aria-label="Available input records"]')).not.toBeNull()) }
  const verifyNoRuntime = () => expect(forbidden.map(spy => spy.mock.calls.length)).toEqual(forbidden.map(() => 0))
  return { directory, store, client, sessions, stored, root, element, history, reads, writes, render, click, wait, readInputs, writeRecords, verifyNoRuntime }
}

async function changeDate(h: Awaited<ReturnType<typeof fixture>>, timestamp: number) {
  await act(async () => { const input = h.element.querySelector<HTMLInputElement>('[aria-label="Focus history date and time"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, localDateTime(timestamp)); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })) })
}

it('built-in Provider → public Core → Store → mounted Focus keeps exact native and captured IDs, repeated bodies and unknown authors', async () => {
  const h = await fixture([record('one', 'Same body'), record('two', 'Same body')], true)
  await h.client.submitAgentPrompt({ ...agentPromptCondition(h.client.agentSession(A)), agentSessionId: A, prompt: 'Same body', operationId: 'focus-native-captured', authorAgentSessionId: B, allowUncertainTurn: true })
  expect(h.writes).toEqual(['Same body\r'])
  expect(useAppStore.getState().timelines[A]!.items.map(item => item.id)).toEqual(['prompt:focus-native-captured'])
  await h.render(); await h.wait(() => expect(h.element.querySelectorAll('.recent-focus__message')).toHaveLength(3))
  const markers = [...h.element.querySelectorAll<HTMLButtonElement>('.recent-focus__message')]
  expect(markers.map(item => [item.dataset.messageId, item.dataset.messageAuthor, item.closest<HTMLElement>('[data-focus-timeline-id]')!.dataset.focusTimelineId])).toEqual([
    [nativeId('one'), 'unknown', A], [nativeId('two'), 'unknown', A], ['captured:prompt:focus-native-captured', 'agent', A]
  ])
  expect(h.reads.map(read => read.id)).toEqual([A]); h.verifyNoRuntime()
  const before = useAppStore.getState().agentFocus
  await h.click(`[data-message-id="${nativeId('one')}"]`)
  expect(floating().querySelector('[role="dialog"]')!.textContent).toContain('Sender not recorded')
  expect(floating().querySelector('[role="dialog"]')!.textContent).not.toContain('Human')
  expect(useAppStore.getState().agentFocus).toBe(before)
})

it('unknown-time native inputs stay accessible in Focus and ordered parts use the real shared message component', async () => {
  const h = await fixture([record('timed', 'Timed input'), record('untimed', [{ type: 'text', text: 'Before resource' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } }, { type: 'text', text: 'After resource' }], null)])
  await h.render(); await h.wait(() => expect(h.history).toHaveBeenCalledOnce())
  await h.wait(() => expect(h.element.querySelectorAll('.recent-focus__message')).toHaveLength(1))
  expect([...h.element.querySelectorAll<HTMLElement>('.recent-focus__message')].map(item => item.dataset.messageId)).toEqual([nativeId('timed')])
  const focus = useAppStore.getState().agentFocus
  await h.readInputs(); await h.click(`[data-input-message-id="${nativeId('untimed')}"]`)
  const preview = floating().querySelector<HTMLElement>(`[data-input-preview-id="${nativeId('untimed')}"]`)!
  expect(preview).not.toBeNull(); expect(floating().querySelector('[role="dialog"]')!.textContent).toContain('Record time unknown')
  const parts = [...preview.querySelector('.log-turn__body')!.children]
  expect(parts).toHaveLength(3); expect(parts[0]!.textContent).toBe('Before resource'); expect(parts[2]!.textContent).toBe('After resource')
  expect(parts[1]!.querySelector('code')!.textContent).toBe('data:image/png;base64,aW1hZ2U=')
  expect(parts[1]!.textContent).toContain('Resource reference; preview is not available here.')
  expect(useAppStore.getState().agentFocus).toBe(focus); h.verifyNoRuntime()
})

it('out-of-window, future and missing-time records never get guessed time positions; only the explicit Context is read', async () => {
  const h = await fixture([record('old', 'Old input', NOW - 8 * HOUR), record('future', 'Future input', NOW + HOUR / 2), record('missing', 'Untimed input', null), record('current', 'Current input')])
  await h.render(); await h.wait(() => expect(h.element.querySelectorAll('.recent-focus__message')).toHaveLength(1))
  expect([...h.element.querySelectorAll<HTMLElement>('.recent-focus__message')].map(item => item.dataset.messageId)).toEqual([nativeId('current')])
  expect(h.reads.map(read => read.id)).toEqual([A])
  const focus = useAppStore.getState().agentFocus
  await h.readInputs()
  await act(async () => { const select = floating().querySelector<HTMLSelectElement>('[aria-label="Input records Context"]')!; select.value = B; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await h.wait(() => expect(h.reads.map(read => read.id)).toEqual([A, B]))
  expect(useAppStore.getState().agentFocus).toBe(focus); expect(floating().querySelector(`[data-input-message-id="native:claude:native-${B}:other"]`)).not.toBeNull(); h.verifyNoRuntime()
})

it('an old window beyond the first page uses opaque cursors and three raw pages even when most records are assistant/tool', async () => {
  const h = await fixture(Array.from({ length: 110 }, (_, index) => record(`raw-${index}`, index === 5 ? 'Far old input' : `Answer ${index}`, NOW - (index === 5 ? 24 : 1) * HOUR, index === 5 ? 'user' : 'assistant')))
  await h.render(); await h.wait(() => expect(h.reads).toHaveLength(1))
  await act(async () => { const input = h.element.querySelector<HTMLInputElement>('[aria-label="Focus history date and time"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, localDateTime(NOW - 24 * HOUR)); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })) })
  await h.wait(() => expect(h.reads).toHaveLength(4))
  expect(h.reads.slice(1).map(read => read.page.items.length)).toEqual([30, 30, 30])
  expect(h.reads.slice(2).map(read => read.cursor)).toEqual(h.reads.slice(1, 3).map(read => read.page.nextCursor))
  expect(h.element.querySelector('.recent-focus__message')).toBeNull()
  await h.readInputs(); expect(floating().querySelector('[role="dialog"]')!.textContent).toContain('90 native records retained')
  expect(floating().querySelector('[role="dialog"]')!.textContent).toContain('Coverage incomplete')
  await h.click('.recent-focus__input-actions button')
  await h.wait(() => expect(h.reads).toHaveLength(5))
  expect(h.reads.at(-1)!.cursor).toBe(h.reads[3]!.page.nextCursor)
  expect(h.element.querySelector(`[data-message-id="${nativeId('raw-5')}"]`)).not.toBeNull()
  expect(floating().querySelector('[role="dialog"]')!.textContent).toContain('Beginning of this available snapshot reached')
  expect(floating().querySelector('[role="dialog"]')!.textContent).toContain('90 native records retained'); h.verifyNoRuntime()
})

it('unrelated Session output causes zero new native reads or marker DOM replacement', async () => {
  const h = await fixture([record('one', 'Relevant input')])
  await h.render(); await h.wait(() => expect(h.element.querySelector(`[data-message-id="${nativeId('one')}"]`)).not.toBeNull())
  const marker = h.element.querySelector(`[data-message-id="${nativeId('one')}"]`)
  const projection = vi.spyOn(UserMessages, 'projectSessionUserMessages')
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, [C]: { agentSessionId: C, revision: 1, items: [{ id: 'decoy-output', agentSessionId: C, kind: 'assistant_message', source: 'native-hook', status: 'complete', createdAt: NOW, updatedAt: NOW, title: 'Unrelated output', content: 'Only Context C changed' }] } } })))
  expect(h.reads.map(read => read.id)).toEqual([A]); expect(h.element.querySelector(`[data-message-id="${nativeId('one')}"]`)).toBe(marker)
  expect(projection.mock.calls.filter(([input]) => input.agentSessionId === A)).toEqual([])
  // Positive control: the actually consumed public module must observe related
  // source growth, so spying on an unused re-export cannot silently pass zero.
  await h.writeRecords([record('one', 'Relevant input'), record('related-new', 'New input in Context A')])
  await h.readInputs(); await h.click('.recent-focus__input-actions button:last-child')
  await h.wait(() => expect(h.element.querySelector(`[data-message-id="${nativeId('related-new')}"]`)).not.toBeNull())
  expect(h.reads.map(read => read.id)).toEqual([A, A])
  expect(projection.mock.calls.filter(([input]) => input.agentSessionId === A).length).toBeGreaterThan(0); h.verifyNoRuntime()
})

it('explicit continuation rotates at ninety raw records while retaining the exact pinned body DOM and browser selection', async () => {
  const h = await fixture(Array.from({ length: 160 }, (_, index) => record(`row-${index}`, `Input body ${index}`)))
  await h.render(); await h.wait(() => expect(h.reads).toHaveLength(1))
  await h.readInputs(); await h.click(`[data-input-message-id="${nativeId('row-159')}"]`)
  const body = floating().querySelector<HTMLElement>(`[data-input-preview-id="${nativeId('row-159')}"]`)!
  const text = body.querySelector('.log-turn__body p')!.firstChild!
  const selected = document.createRange(); selected.setStart(text, 0); selected.setEnd(text, 5)
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(selected)
  await h.click('.recent-focus__input-actions button'); await h.wait(() => expect(h.reads).toHaveLength(4))
  expect(floating().querySelector(`[data-input-preview-id="${nativeId('row-159')}"]`)).toBe(body)
  await h.click('.recent-focus__input-actions button'); await h.wait(() => expect(h.reads).toHaveLength(7))
  expect(floating().querySelector(`[data-input-preview-id="${nativeId('row-159')}"]`)).toBe(body)
  expect(document.getSelection()!.toString()).toBe('Input')
  expect([...floating().querySelectorAll<HTMLElement>('[data-input-source="native"][data-input-message-id]')].map(item => item.dataset.inputMessageId)).toHaveLength(90)
  expect(floating().querySelector(`[data-input-message-id="${nativeId('row-159')}"]`)).not.toBeNull()
  expect(floating().querySelector('[role="dialog"]')!.textContent).toContain('Newer records are outside this reading window')
  expect(h.reads.slice(1).map(read => read.page.items.length)).toEqual([30, 30, 30, 30, 30, 10]); h.verifyNoRuntime()
})

it('Focus bounds its own native bodies even when another real shared consumer has accumulated more than ninety inputs', async () => {
  const h = await fixture(Array.from({ length: 130 }, (_, index) => record(`shared-${index}`, `Shared input ${index}`)))
  const control = h.sessions[0]!.control
  expect(control.kind).toBe('agent')
  let shared: ReturnType<typeof useSessionUserMessages> | undefined
  function OtherConsumer() { const value = useSessionUserMessages(control.kind === 'agent' ? control : undefined); useEffect(() => { shared = value }, [value]); return createElement('output', { 'data-other-consumer-count': value.messages.length }) }
  const node = document.createElement('div'); document.body.append(node); nodes.push(node); const root = createRoot(node); roots.push(root)
  await act(async () => root.render(createElement(OtherConsumer))); await h.wait(() => expect(shared?.messages).toHaveLength(30))
  for (const expected of [60, 90, 120, 130]) { await act(async () => { await shared!.loadEarlier() }); await h.wait(() => expect(shared?.messages).toHaveLength(expected)) }
  expect(h.reads).toHaveLength(5)
  await h.render(); await h.readInputs()
  expect(shared!.messages).toHaveLength(130)
  const listed = [...floating().querySelectorAll<HTMLElement>('[data-input-source="native"][data-input-message-id]')].map(item => item.dataset.inputMessageId)
  expect(listed).toEqual(Array.from({ length: 90 }, (_, index) => nativeId(`shared-${index + 40}`)))
  expect(h.reads).toHaveLength(5)
  expect(floating().querySelector('[role="dialog"]')!.textContent).toContain('Earlier coverage is unknown')
  expect(floating().querySelector('[role="dialog"]')!.textContent).not.toContain('Beginning of this available snapshot reached'); h.verifyNoRuntime()
})

it('a real Source replacement keeps the old pinned input and only explicit Refresh reads a new Source', async () => {
  const h = await fixture(Array.from({ length: 110 }, (_, index) => record(`source-${index}`, `Old Source ${index}`)))
  await h.render(); await h.wait(() => expect(h.reads).toHaveLength(1)); await h.readInputs(); await h.click('.recent-focus__input-actions button'); await h.wait(() => expect(h.reads).toHaveLength(4))
  await h.click(`[data-input-message-id="${nativeId('source-109')}"]`)
  const body = floating().querySelector(`[data-input-preview-id="${nativeId('source-109')}"]`)
  const replacement = join(h.directory, 'replacement.jsonl')
  await writeFile(replacement, JSON.stringify({ sessionId: 'native-replacement', ...record('new-source', 'New Source body') }) + '\n')
  const original = (await loadAgentSessions(h.store)).find(session => session.agentSessionId === A)!
  expect(original.nativeHandle?.kind).toBe('provider')
  await h.store.compareAndSwap(original, { ...original, updatedAt: NOW, nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-replacement', transcriptPath: replacement } })
  await h.click('.recent-focus__input-actions button')
  await h.wait(() => expect(h.history).toHaveBeenCalledTimes(5))
  let sourceError: (Error & { code?: string }) | undefined
  await act(async () => { try { await h.history.mock.results[4]!.value } catch (error) { sourceError = error as Error & { code?: string } } })
  expect(sourceError?.code).toBe('AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  await h.wait(() => expect(floating().querySelector('.recent-focus__input-error')!.textContent).toContain('Native history cursor belongs to another source.'))
  expect(floating().querySelector(`[data-input-preview-id="${nativeId('source-109')}"]`)).toBe(body)
  expect(floating().querySelector('[data-input-message-id="native:claude:native-replacement:new-source"]')).toBeNull()
  await h.click('.recent-focus__input-actions button:last-child')
  await h.wait(() => expect(h.history).toHaveBeenCalledTimes(6))
  await h.wait(() => expect(h.reads.at(-1)!.page.source).toEqual({ providerId: 'claude', nativeSessionId: 'native-replacement' }))
  expect(h.reads.at(-1)!.page.items.map(item => [item.id, item.kind])).toEqual([['new-source', 'user-message']])
  await h.wait(() => expect(floating().querySelector('[data-input-message-id="native:claude:native-replacement:new-source"]')).not.toBeNull())
  expect(floating().querySelector(`[data-input-message-id="${nativeId('source-109')}"]`)).toBeNull()
  h.verifyNoRuntime()
})

it('hidden scope stops new old-window pages and discards a physically completed late page without disposing the shared Client', async () => {
  const h = await fixture(Array.from({ length: 110 }, (_, index) => record(`late-${index}`, `Input ${index}`)))
  await h.render(); await h.wait(() => expect(h.reads).toHaveLength(1))
  const read = h.history.getMockImplementation()!
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  h.history.mockImplementationOnce(async (control, options) => { const page = await read(control, options); await gate; return page })
  await changeDate(h, NOW - HOUR)
  await h.wait(() => expect(h.reads).toHaveLength(2))
  await h.click('[aria-label="Collapse focus history"]')
  await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 20)) })
  expect(h.reads).toHaveLength(2)
  expect(h.element.querySelector('.recent-focus__viewport')).toBeNull()
  expect((await h.client.sessionHistoryPage(A)).items).toHaveLength(30)
  await h.click('[aria-label="Show focus history"]')
  await h.wait(() => expect(h.reads).toHaveLength(5))
  expect(h.reads.slice(2).map(read => read.cursor)).toEqual([undefined, h.reads[2]!.page.nextCursor, h.reads[3]!.page.nextCursor]); h.verifyNoRuntime()
})

it('empty native pages and latest loading facts never claim a complete old window or a missing Source', async () => {
  const h = await fixture([])
  await h.render(); await h.wait(() => expect(h.reads).toHaveLength(1)); await h.readInputs()
  expect(h.reads[0]!.page.source).toEqual({ providerId: 'claude', nativeSessionId: `native-${A}` })
  expect(floating().querySelector('[role="dialog"]')!.textContent).toContain('Earlier coverage is unknown')
  expect(floating().querySelector('[role="dialog"]')!.textContent).not.toContain('Beginning of this available snapshot reached')
  await h.click('.recent-focus__input-actions button'); await h.wait(() => expect(h.reads).toHaveLength(2))
  expect(floating().querySelector('[role="dialog"]')!.textContent).toContain('Beginning of this available snapshot reached')
  expect(floating().querySelector('[role="dialog"]')!.textContent).toContain('0 native records retained'); h.verifyNoRuntime()
})

it('known captured Agent inspection stays read-only and navigation resolves the exact sender ID before the same-name decoy', async () => {
  const h = await fixture([record('one', 'Native input')], true)
  await h.client.submitAgentPrompt({ ...agentPromptCondition(h.client.agentSession(A)), agentSessionId: A, prompt: 'Known Agent input', operationId: 'sender-core', authorAgentSessionId: B, allowUncertainTurn: true })
  await h.render(); await h.wait(() => expect(h.element.querySelector('[data-message-id="captured:prompt:sender-core"]')).not.toBeNull())
  await act(async () => useAppStore.getState().focusExecutionSession(B)); await h.wait(() => expect(h.reads.map(read => read.id)).toEqual([A, B]))
  const origin = useAppStore.getState().agentFocus
  const marker = h.element.querySelector<HTMLButtonElement>('[data-message-id="captured:prompt:sender-core"]')!
  await act(async () => marker.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null })))
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(floating().querySelector('[role="tooltip"]')).not.toBeNull()
  })
  const summary = floating().querySelector<HTMLElement>('[role="tooltip"]')!
  expect(summary.dataset.messageAuthor).toBe('agent')
  expect(summary.textContent).toContain('Same worker name')
  expect(summary.textContent).toContain('Known Agent input')
  expect(useAppStore.getState().agentFocus).toBe(origin)
  await act(async () => { marker.focus(); marker.click() })
  const senderDetails = floating().querySelector('.recent-focus__sender-details')
  expect(senderDetails).not.toBeNull()
  expect(senderDetails!.textContent).toContain('Sender Run not recorded')
  expect(senderDetails!.textContent).toContain(B)
  expect(floating().querySelector('[role="dialog"]')!.textContent).not.toContain(`${B}-original-run`)
  const knownBody = floating().querySelector<HTMLElement>('[data-input-preview-id="captured:prompt:sender-core"] .log-turn')
  expect(knownBody).not.toBeNull(); expect(knownBody!.dataset.speakerRole).toBe('agent')
  expect(knownBody!.querySelector('.conversation-avatar--human')).toBeNull()
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(floating().querySelector('[role="dialog"]')).toBeNull(); expect(floating().querySelector('[role="tooltip"]')).toBeNull(); expect(document.activeElement).toBe(marker)
  await act(async () => marker.click())
  await h.click('.recent-focus__sender-link')
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(B)
  expect(useAppStore.getState().agentFocus.execution.sessionId).not.toBe(C)
  expect(floating().querySelector('[role="dialog"]')).toBeNull(); h.verifyNoRuntime()
})

it('same Source repeated records across accepted pages are deduplicated without deduplicating equal bodies', async () => {
  const h = await fixture(Array.from({ length: 100 }, (_, index) => record(`duplicate-${index}`, 'Equal body')))
  await h.render(); await h.wait(() => expect(h.reads).toHaveLength(1))
  const repeated = h.reads[0]!.page.items[0]!
  const read = h.history.getMockImplementation()!
  // Explicit transport repetition of an already accepted public record. The
  // Core normalization forbids duplicate IDs inside a single native page.
  h.history.mockImplementation(async (control, options) => { const page = await read(control, options); return options?.cursor ? { ...page, items: [...page.items, repeated] } : page })
  await h.readInputs(); await h.click('.recent-focus__input-actions button'); await h.wait(() => expect(h.reads).toHaveLength(4))
  const ids = [...floating().querySelectorAll<HTMLElement>('[data-input-source="native"][data-input-message-id]')].map(item => item.dataset.inputMessageId)
  expect(ids).toEqual(Array.from({ length: 90 }, (_, index) => nativeId(`duplicate-${index + 10}`)))
  expect(floating().querySelector('[role="dialog"]')!.textContent).toContain('90 native records retained'); h.verifyNoRuntime()
})

it('document hiding and a late old-Context result never read subsequent pages or contaminate the newly selected Context', async () => {
  const h = await fixture(Array.from({ length: 100 }, (_, index) => record(`hidden-${index}`, `Old Context ${index}`)))
  await h.render(); await h.wait(() => expect(h.reads).toHaveLength(1))
  const read = h.history.getMockImplementation()!
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  h.history.mockImplementationOnce(async (control, options) => { const page = await read(control, options); await gate; return page })
  await changeDate(h, NOW - HOUR); await h.wait(() => expect(h.reads).toHaveLength(2))
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 20)) })
  expect(h.reads).toHaveLength(2); expect(floating().querySelector('[role="dialog"]')).toBeNull()
  expect([...h.element.querySelectorAll<HTMLElement>('.recent-focus__message[data-message-source="native"]')].map(item => item.dataset.messageId)).toEqual([])
  await act(async () => useAppStore.getState().focusExecutionSession(B))
  visibility.mockReturnValue('visible'); await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await h.wait(() => expect(h.reads).toHaveLength(3))
  expect(h.reads.map(read => read.id)).toEqual([A, A, B]); await h.readInputs()
  expect([...floating().querySelectorAll<HTMLElement>('[data-input-message-id]')].map(item => item.dataset.inputMessageId)).toEqual([`native:claude:native-${B}:other`])
  h.verifyNoRuntime()
})

it('record time zero remains real, while a public page from another Context is rejected without inventing Source or coverage', async () => {
  const h = await fixture([record('epoch', 'Epoch input', 0), record('one', 'Current input')])
  await h.render(); await h.wait(() => expect(h.reads).toHaveLength(1))
  await changeDate(h, 0); await h.wait(() => expect(h.reads).toHaveLength(2))
  const marker = h.element.querySelector<HTMLElement>(`[data-message-id="${nativeId('epoch')}"]`)!
  expect(marker).not.toBeNull(); expect(marker.dataset.messageAt).toBe('0'); expect(marker.style.left).toBe('75%')
  const focus = useAppStore.getState().agentFocus
  h.history.mockImplementation(async () => h.client.sessionHistoryPage(B))
  await h.readInputs(); await h.wait(() => expect(floating().querySelector<HTMLButtonElement>('.recent-focus__input-actions button:last-child')!.disabled).toBe(false)); await h.click('.recent-focus__input-actions button:last-child')
  await h.wait(() => expect(h.history).toHaveBeenCalledTimes(3))
  await act(async () => { await h.history.mock.results[2]!.value })
  await h.wait(() => { const notice = floating().querySelector('.recent-focus__input-error'); expect(notice).not.toBeNull(); expect(notice!.textContent).toContain('Input records belong to another Context.') })
  expect(h.element.querySelector(`[data-message-id="${nativeId('epoch')}"]`)).toBe(marker)
  expect(floating().querySelector(`[data-input-message-id="native:claude:native-${B}:other"]`)).toBeNull()
  expect(useAppStore.getState().agentFocus).toBe(focus); h.verifyNoRuntime()
})
