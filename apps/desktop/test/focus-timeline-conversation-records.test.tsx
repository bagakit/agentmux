import { fixtureIso as _hygiene_fixtureIso } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { appendFile, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { projectConversationRecords } from '@agentmux/client-ui/conversation-records'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { localDateTime } from '../src/renderer/src/lib/focus-time-window'
// The actual Global/Store/Timeline/shared Hook and public Core/FileStore/Claude
// reader are mounted. Only the unrelated PTY observation leaf is isolated.
vi.mock('../src/renderer/src/components/SessionObservationRegions', () => ({ SessionObservationRegions: () => <output data-private-terminal-leaf /> }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'

const ID = 'private-agent', NOW = Date.parse(_hygiene_fixtureIso(24148800000, "second")), HOUR = 3_600_000, DRAFT = 'Original unsubmitted draft'
const initial = useAppStore.getState()
let fixture: Awaited<ReturnType<typeof nativeHistoryFixture>>, host: HTMLDivElement, root: Root
const extraFixtures: Awaited<ReturnType<typeof nativeHistoryFixture>>[] = []
let pages: AgentSessionHistoryPage[], reads: MockInstance<typeof api.sessions.historyPage>, controls: { mock: { calls: unknown[][] } }[]
function native(id: string, role: 'user' | 'assistant', text: unknown, at: number | null = NOW - HOUR / 2) {
  return { sessionId: 'native-main', uuid: id, type: role, message: { role, content: text }, ...(at === null ? {} : { timestamp: new Date(at).toISOString() }) }
}
const original = [native('u', 'user', 'Repeated original speech'), native('a', 'assistant', [{ type: 'thinking', thinking: 'Original recorded reasoning' }, { type: 'text', text: 'Repeated original speech' }]), native('thinking', 'assistant', [{ type: 'thinking', thinking: 'Reasoning without plain text' }])]
function captured(id: string, kind: 'user_message' | 'assistant_message', more: Partial<AgentTimelineItem> = {}): AgentTimelineItem {
  return { id, agentSessionId: ID, kind, source: 'native-hook', status: 'complete', createdAt: NOW - HOUR / 2, updatedAt: NOW - HOUR / 2, title: 'Recorded speech', content: 'Repeated original speech', ...more }
}
const overlay = () => { const node = document.getElementById('agentmux-window-overlay-host'); expect(node).not.toBeNull(); return node! }
const markers = () => [...host.querySelectorAll<HTMLButtonElement>('.recent-focus__message')]
const rawIds = () => markers().flatMap(node => JSON.parse(node.dataset.messageRawIds!) as string[])
const recordIds = () => markers().flatMap(node => JSON.parse(node.dataset.messageIds!) as string[])
const recordCount = () => markers().reduce((count, node) => count + Number(node.dataset.recordCount), 0)
async function render(extra?: ReactNode) { await act(async () => root.render(<><GlobalFocusSurface />{extra}</>)) }
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 3000, interval: 10 }) }
async function click(selector: string) { const node = host.querySelector<HTMLElement>(selector) ?? overlay().querySelector<HTMLElement>(selector); expect(node, selector).not.toBeNull(); await act(async () => node!.click()) }
async function plotRecord(id: string) {
  const marker = markers().find(node => (JSON.parse(node.dataset.messageRawIds!) as string[]).includes(id)); expect(marker).toBeDefined()
  await act(async () => marker!.click())
  if (Number(marker!.dataset.recordCount) > 1) { const item = overlay().querySelector<HTMLElement>(`[data-record-raw-id="${id}"]`); expect(item).not.toBeNull(); await act(async () => item!.click()) }
}
async function textButton(text: string) { const node = [...overlay().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text); expect(node, text).toBeDefined(); await act(async () => node!.click()) }
async function records() { await click('[aria-label="View conversation records"]'); await wait(() => expect(overlay().querySelector('[aria-label="Available conversation records"]')).not.toBeNull()) }
async function seedCaptured(items: AgentTimelineItem[]) {
  for (const item of items) await fixture.store.applyTimelineMutation({ type: 'append', agentSessionId: ID, item })
  const timeline = await fixture.client.sessionTimeline(ID)
  await act(async () => useAppStore.setState({ timelines: { [ID]: timeline } }))
}
function healthy() { expect(useAppStore.getState().agentComposerDrafts[ID]).toBe(DRAFT); expect(useAppStore.getState().sessions[0]!.control).toEqual({ kind: 'agent', hostId: 'local', agentSessionId: ID, run: { runId: 'unchanged-private-run' } }) }
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); localStorage.clear()
  fixture = await nativeHistoryFixture('claude', jsonl(original))
  pages = []
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }], executors: { claude: { label: 'Claude', providerId: 'claude', command: 'claude', args: [], env: {}, injectAgentMuxGuide: true } }, workspaces: [{ id: 'project', name: 'Private project', hostId: 'local', path: fixture.root, kind: 'folder' }], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const session: SessionSnapshot = { id: ID, kind: 'agent', providerId: 'claude', executorId: 'claude', hostId: 'local', workspacePath: fixture.root, label: 'Original Agent', createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, promptSubmissionPredecessor: null, processState: 'running', latestOutputBytes: 0, status: { state: 'running', source: 'run-process', observedAt: NOW }, capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' }, control: { kind: 'agent', hostId: 'local', agentSessionId: ID, run: fixture.session.run } }
  useAppStore.setState({ config, sessions: [session], timelines: {}, agentNames: {}, tabs: {}, layouts: {}, recoveryCandidates: [], workspaceFileRevisions: {}, scratchTopicSnapshots: {}, spaceObjectIcons: {}, activeWorkspaceId: 'project', mainSurface: 'agents', agentComposerDrafts: { [ID]: DRAFT }, agentFocus: { execution: { sessionId: ID, history: [] }, pmo: { sessionId: null } }, error: null })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: fixture.root })
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  reads = vi.spyOn(api.sessions, 'historyPage').mockImplementation(async (control, options) => { expect(control.hostId).toBe('local'); expect(control.agentSessionId).toBe(ID); const page = await fixture.client.sessionHistoryPage(control.agentSessionId, options); pages.push(page); return page })
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation((control, listener, options) => fixture.client.observeSessionHistory(control.agentSessionId, listener, options))
  vi.spyOn(api.sessions, 'timeline').mockImplementation(control => fixture.client.sessionTimeline(control.agentSessionId))
  controls = ['submitPrompt', 'write', 'resume', 'recover', 'stop'].map(name => vi.spyOn(api.sessions, name as 'stop'))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  expect(fixture.controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]); expect(controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0])
  await fixture.close(); for (const extra of extraFixtures.splice(0)) { expect(extra.controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]); await extra.close() } useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); document.getElementById('agentmux-window-overlay-host')?.remove()
})

it('the actual current Global page and shared ConversationView both retain user and assistant speech with original parts while keeping reasoning activity distinct', async () => {
  await render(); await wait(() => expect(pages.length).toBeGreaterThan(0))
  expect(pages[0]!.items.map(item => [item.id, item.kind])).toEqual([['u', 'user-message'], ['a', 'assistant-message'], ['thinking', 'activity']])
  expect(rawIds()).toEqual(['u', 'a'])
  const visualInput = process.env.AGENTMUX_FOCUS_CONVERSATION_VISUAL_INPUT
  if (visualInput) {
    if (!isAbsolute(visualInput)) throw new Error('AGENTMUX_FOCUS_CONVERSATION_VISUAL_INPUT must be an absolute path')
    await writeFile(visualInput, JSON.stringify({ now: NOW, config: useAppStore.getState().config, sessions: useAppStore.getState().sessions, agentFocus: useAppStore.getState().agentFocus, agentComposerDrafts: useAppStore.getState().agentComposerDrafts, nativePage: pages[0], timeline: await fixture.client.sessionTimeline(ID), boundary: 'Actual public Core/FileStore/Claude page from the first owning mounted case. Equal recorded timestamps remain equal; typed transport is not a Native Writer or Runtime claim.' }, null, 2) + '\n')
  }
  await render(<div data-shared-conversation><ConversationView page={pages[0]!} sessionId={ID} /></div>)
  expect([...host.querySelectorAll('[data-shared-conversation] [data-native-record-id]')].map(node => node.getAttribute('data-native-record-id'))).toEqual(['u', 'a', 'thinking'])
  expect(host.querySelector('[data-native-record-id="thinking"]')!.textContent).toContain('Reasoning')
  // Typed public-page contract: a non-text reply remains a reply; Claude's
  // activity record above is not relabelled to manufacture that fact.
  const nonText = { ...pages[0]!.items[1]!, id: 'non-text-reply', contentParts: [{ kind: 'reasoning' as const, text: 'Typed non-text reply' }], startedAt: Number.MAX_VALUE }
  const described = projectConversationRecords({ agentSessionId: ID, executionHostId: 'local', historyPage: { ...pages[0]!, items: [nonText] } })[0]!
  expect(described.kind).toBe('assistant-message'); expect(described.input).toBeUndefined(); expect(described.contentParts).toBe(nonText.contentParts); expect(described.original.item).toBe(nonText); expect(described.recordedAt).toBeUndefined()
  await render(<div data-shared-conversation><ConversationView page={{ ...pages[0]!, items: [nonText] }} sessionId={ID} /></div>)
  expect(host.querySelector('[data-native-record-id="non-text-reply"]')!.textContent).toContain('Reasoning')
  expect(markers()).toHaveLength(1); expect(markers()[0]!.dataset.recordCount).toBe('2'); expect(markers()[0]!.getAttribute('aria-label')).toContain('1 inputs and 1 replies')
  await act(async () => markers()[0]!.click())
  expect([...overlay().querySelectorAll<HTMLElement>('[data-conversation-record-id]')].map(node => [node.dataset.recordRawId, node.dataset.recordKind])).toEqual([['u', 'user-message'], ['a', 'assistant-message']])
  expect(overlay().textContent).not.toContain('Refresh source')
  await plotRecord('a')
  expect(overlay().querySelector('.recent-focus__message-body')!.textContent).toContain('Reasoning')
  healthy()
})

it('historical native and FileStore captured user/reply facts keep equal bodies and cross-source raw IDs separate', async () => {
  await seedCaptured([captured('u', 'user_message', { authorHuman: true }), captured('a', 'assistant_message')])
  await render(); await wait(() => expect(recordCount()).toBe(4))
  expect(new Set(recordIds()).size).toBe(4)
  await records(); await textButton('Read earlier records')
  await wait(() => expect(overlay().querySelectorAll('[data-conversation-record-id]')).toHaveLength(4))
  const list = [...overlay().querySelectorAll<HTMLElement>('[data-conversation-record-id]')]
  expect(list.filter(node => node.dataset.recordKind === 'assistant-message')).toHaveLength(2)
  expect(list.filter(node => node.dataset.recordSource === 'captured')).toHaveLength(2)
  expect(reads.mock.calls.length).toBeLessThanOrEqual(2); healthy()
})

it('unknown, human and Agent-authored inputs remain distinct from the recipient reply and exact native source identity', async () => {
  await seedCaptured([captured('human', 'user_message', { authorHuman: true }), captured('agent-input', 'user_message', { authorAgentSessionId: 'other-agent' }), captured('unknown', 'user_message')])
  await render(); await wait(() => expect(recordCount()).toBe(5))
  await records()
  const item = (id: string) => overlay().querySelector<HTMLElement>(`[data-conversation-record-id][data-record-raw-id="${id}"]`)!
  expect(item('u').dataset.messageAuthor).toBe('unknown'); expect(item('human').dataset.messageAuthor).toBe('human')
  expect(item('agent-input').getAttribute('aria-label')!).toContain('other-agent'); expect(item('a').getAttribute('aria-label')!).toContain(ID); expect(item('unknown').getAttribute('aria-label')!).toContain('not recorded')
  const ids = recordIds(); expect(ids.every(id => id.includes('local') && id.includes(ID))).toBe(true)
  await plotRecord('a'); expect(overlay().querySelector('[data-input-source] .log-turn')).toBeNull()
  expect(overlay().querySelector('.recent-focus__message-body')!.textContent).toContain('Repeated original speech')
  await records(); await textButton('Read earlier records')
  await wait(() => expect(overlay().querySelector('[data-record-raw-id="u"][data-record-source="native"]')).not.toBeNull())
  const pinned = overlay().querySelector<HTMLElement>('[data-record-raw-id="u"][data-record-source="native"]')!; await act(async () => pinned.click())
  const pinnedBody = overlay().querySelector('.recent-focus__message-body')
  // Two private public Core/FileStore services model exact Desktop Host routing;
  // there is no SSH connection, Runtime operation or fabricated user DTO.
  const other = await nativeHistoryFixture('claude', jsonl(Array.from({ length: 90 }, (_, index) => native(index === 89 ? 'u' : 'remote-' + index, 'user', 'Other Host input ' + index))))
  extraFixtures.push(other)
  for (const item of useAppStore.getState().timelines[ID]!.items) await other.store.applyTimelineMutation({ type: 'append', agentSessionId: ID, item })
  reads.mockImplementation(async (control, options) => { expect(control.hostId).toBe('other'); const page = await other.client.sessionHistoryPage(control.agentSessionId, options); pages.push(page); return page })
  vi.spyOn(api.sessions, 'timeline').mockImplementation(control => other.client.sessionTimeline(control.agentSessionId))
  const state = useAppStore.getState(), session = state.sessions[0]!
  if (session.kind !== 'agent') throw new Error('Fixture requires the original Agent')
  await act(async () => useAppStore.setState({
    config: { ...state.config!, hosts: [...state.config!.hosts, { id: 'other', kind: 'ssh', label: 'Private logical Host', hostname: 'unused.invalid' }], workspaces: state.config!.workspaces.map(workspace => ({ ...workspace, hostId: 'other' })) },
    sessions: [{ ...session, hostId: 'other', control: { ...session.control, hostId: 'other' } }]
  }))
  await wait(() => expect(overlay().querySelectorAll('[data-conversation-record-id][data-record-source="native"]')).toHaveLength(89))
  expect(overlay().querySelector('[data-record-raw-id="u"][data-record-source="native"]')).toBeNull()
  expect(overlay().querySelector('.recent-focus__message-body')).toBe(pinnedBody)
  expect([...overlay().querySelectorAll<HTMLElement>('[data-conversation-record-id]')].map(node => JSON.parse(node.dataset.conversationRecordId!)[0])).toEqual(Array.from({ length: 92 }, () => 'other'))
  expect(new Set(recordIds().map(id => JSON.parse(id)).filter(identity => identity.at(-1) === 'human').map(identity => identity[0]))).toEqual(new Set(['local', 'other']))
  const returnButton = [...overlay().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Return to Context')!; expect(returnButton.disabled).toBe(true)
  expect(useAppStore.getState().agentComposerDrafts[ID]).toBe(DRAFT)

})

it('zero and missing time remain original facts; only real in-range speech receives a position', async () => {
  await writeFile(fixture.path, jsonl([native('zero', 'assistant', 'Epoch record', 0), native('untimed', 'assistant', 'Untimed reply', null), native('old', 'assistant', 'Older reply', NOW - 8 * HOUR), native('future', 'assistant', 'Future reply', NOW + HOUR), native('now', 'user', 'In-range input')]))
  await render(); await wait(() => expect(rawIds()).toEqual(['now']))
  await records(); expect(overlay().textContent).toContain('Time unknown')
  const untimed = overlay().querySelector<HTMLElement>('[data-conversation-record-id][data-record-raw-id="untimed"]')!; expect(untimed).not.toBeNull(); await act(async () => untimed.click())
  expect(overlay().querySelector('.recent-focus__message-body')!.textContent).toContain('Untimed reply')
  const input = host.querySelector<HTMLInputElement>('[aria-label="Focus history date and time"]')!; expect(input).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, localDateTime(HOUR)); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(rawIds()).toEqual(['zero']); expect(markers()[0]!.dataset.messageAt).toBe('0'); healthy()
})

it('same-source pending refresh and hidden late completion preserve the pinned reply DOM, Range and original draft without reading another source', async () => {
  await render(); await wait(() => expect(rawIds()).toEqual(['u', 'a']))
  await records()
  const selected = overlay().querySelector<HTMLElement>('[data-conversation-record-id][data-record-raw-id="a"]')!; expect(selected).not.toBeNull(); await act(async () => selected.click())
  const body = overlay().querySelector<HTMLElement>('.recent-focus__message-body')!, text = body.querySelector('p')!.firstChild!; const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 8); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  await appendFile(fixture.path, jsonl([native('b', 'assistant', 'Appended reply')]))
  await wait(() => expect([...overlay().querySelectorAll<HTMLElement>('[data-conversation-record-id]')].map(node => node.dataset.recordRawId)).toEqual(['u', 'a', 'b']))
  expect(overlay().querySelector('.recent-focus__message-body')).toBe(body); expect(selection.toString()).toBe('Repeated')
  const oldReads = reads.mock.calls.length
  await act(async () => useAppStore.setState({ timelines: { unrelated: { agentSessionId: 'unrelated', revision: 1, items: [captured('unrelated', 'assistant_message', { agentSessionId: 'unrelated' })] } } }))
  expect(reads.mock.calls).toHaveLength(oldReads); expect(overlay().querySelector('.recent-focus__message-body')).toBe(body); expect(selection.toString()).toBe('Repeated')
  let release!: (page: AgentSessionHistoryPage) => void
  reads.mockImplementationOnce(() => new Promise<AgentSessionHistoryPage>(resolve => { release = resolve }))
  await textButton('Refresh source'); await wait(() => expect(release).toBeDefined())
  await act(async () => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')) })
  const count = reads.mock.calls.length; await act(async () => release(pages[0]!)); expect(reads.mock.calls).toHaveLength(count)
  expect(overlay().querySelector('.recent-focus__message-body')).toBe(body); expect(selection.toString()).toBe('Repeated'); healthy()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); selection.removeAllRanges()
})

it('raw capacity and service failures preserve observed replies and healthy control, with no extra unrelated IO', async () => {
  await writeFile(fixture.path, jsonl(Array.from({ length: 120 }, (_, index) => native('row-' + index, index % 2 ? 'assistant' : 'user', 'Bounded speech ' + index))))
  await render(); await wait(() => expect(markers().length).toBeGreaterThan(0)); expect(markers().length).toBeLessThanOrEqual(90)
  for (let batch = 0; batch < 4; batch++) {
    await appendFile(fixture.path, jsonl(Array.from({ length: 20 }, (_, index) => native(`append-${batch}-${index}`, index % 2 ? 'assistant' : 'user', 'Appended original speech'))))
    await wait(() => expect(rawIds()).toContain(`append-${batch}-19`))
  }
  expect(recordCount()).toBe(90)
  await records(); expect(overlay().textContent).toContain('Some latest conversation records are outside this bounded window'); const list = overlay().querySelectorAll('[data-conversation-record-id]'); expect(list.length).toBeGreaterThan(0); expect(list.length).toBeLessThanOrEqual(90)
  const before = reads.mock.calls.length
  reads.mockRejectedValueOnce(new Error('Observed history service unavailable'))
  await textButton('Refresh source'); await wait(() => expect(overlay().textContent).toContain('Observed history service unavailable'))
  expect(overlay().querySelectorAll('[data-conversation-record-id]')).toHaveLength(list.length); expect(useAppStore.getState().sessions[0]!.processState).toBe('running')
  await act(async () => useAppStore.setState({ agentNames: { unrelated: 'Changed unrelated name' } })); expect(reads.mock.calls).toHaveLength(before + 1); healthy()
})
