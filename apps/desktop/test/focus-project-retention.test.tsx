import { fixtureIso as _hygiene_fixtureIso, fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import type { SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts'
import type { AgentFocusHistoryEntry, AgentFocusHistoryIdentity } from '../src/renderer/src/lib/agent-focus'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createFocusTimeFormatters } from '../src/renderer/src/lib/focus-timeline-ruler'
import { createClientUiRoot } from './helpers/client-ui-render'
import { chooseFocusFilter, focusFilterOptions } from './fixtures/focus-filter-menu'

// Only PTY painting is isolated. Global, original Timeline/reader, Store,
// Project/Disconnected components, SessionPane and shared Markdown remain real.
vi.mock('../src/renderer/src/components/TerminalView', () => ({
  TerminalView: ({ sessionId }: { sessionId: string }) => createElement('output', { 'data-private-pty-paint': sessionId })
}))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'

const initial = useAppStore.getState()
const NOW = Date.parse(_hygiene_fixtureIso(24148800000, "second")), DAY = 86_400_000
let root: Root | undefined, container: HTMLDivElement | undefined
let base: Extract<SessionSnapshot, { kind: 'agent' }>

function agent(id: string, workspacePath: string, hostId = 'local', offline = false): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { ...base, id, hostId, workspacePath, label: id, processState: offline ? 'interrupted' : 'running', latestOutputBytes: 0,
    status: { state: offline ? 'disconnected' : 'running', source: 'run-process', observedAt: NOW },
    control: { ...base.control, hostId, agentSessionId: id, run: { runId: `${id}-original-run` } } }
}
function workspace(id: string, name: string, path: string, hostId = 'local'): WorkspaceRecord {
  return { id, name, path, hostId, kind: 'folder' }
}
function history(sessionId: string, projectId: string, name: string, at: number, extra: Partial<AgentFocusHistoryIdentity> = {}): AgentFocusHistoryEntry {
  return { sessionId, focusedAt: at, identity: { name: `Observed ${sessionId}`, kind: 'agent', providerId: 'generic', hostId: 'local',
    workspacePath: (_hygiene_fixturePath("observed/") + (projectId) + ""), project: { id: projectId, name }, ...extra } }
}
function nativePage(id: string): AgentSessionHistoryPage {
  return { agentSessionId: id, source: { providerId: 'generic', nativeSessionId: `retention-native-${id}` },
    items: id === 'live' ? [{ id: 'record-live', kind: 'user-message', startedAt: NOW - 1000,
      contentParts: [{ kind: 'text', text: 'Keep this original native message selected.' }] }] : [], nextCursor: null }
}
const key = (hostId: string, projectId: string) => JSON.stringify([hostId, projectId])
function boardLanes(): HTMLElement[] {
  return [...container!.querySelectorAll<HTMLElement>('.focus-project-board__live .focus-project-lanes__row')]
}
function retainedRows(): HTMLButtonElement[] {
  return [...container!.querySelectorAll<HTMLButtonElement>('[data-retained-project]')]
}
function retainedRow(hostId: string, projectId: string): HTMLButtonElement {
  const node = retainedRows().find(row => row.dataset.retainedProject === key(hostId, projectId))
  expect(node).toBeDefined(); return node!
}
function button(label: string): HTMLButtonElement {
  const node = [...container!.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label)
  expect(node, label).toBeDefined(); return node!
}
function directory(): HTMLElement {
  const node = container!.querySelector<HTMLElement>('.focus-disconnected-projects')
  expect(node).not.toBeNull(); return node!
}
function directoryIds(): string[] {
  return [...directory().querySelectorAll<HTMLElement>('.focus-context')].map(node => node.dataset.sessionId!)
}
async function click(node: HTMLElement): Promise<void> { expect(node).toBeDefined(); await act(async () => node.click()) }
async function mount(sessions: SessionSnapshot[], workspaces: WorkspaceRecord[], entries: AgentFocusHistoryEntry[], selectedId: string | null = null): Promise<void> {
  useAppStore.setState(state => ({ config: { ...state.config!, workspaces }, sessions, agentFocus: {
    execution: { sessionId: selectedId, history: entries }, pmo: { sessionId: null }
  } }))
  await act(async () => root!.render(<GlobalFocusSurface />))
  await act(async () => new Promise<void>(resolve => setTimeout(resolve, 30)))
  expect(container!.querySelector('.recent-focus')).not.toBeNull()
}
async function reveal(lane: HTMLElement): Promise<HTMLButtonElement> {
  const trigger = lane.querySelector<HTMLButtonElement>('.focus-disconnected-entry')
  expect(trigger).not.toBeNull()
  await act(async () => { trigger!.focus(); trigger!.click() })
  expect(directory().dataset.expanded).toBe('true'); return trigger!
}
async function search(value: string): Promise<void> {
  const input = container!.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!
  expect(input).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
function readCounts(): number[] {
  return [api.sessions.historyPage, api.sessions.observeHistory, api.sessions.historySources, api.sessions.timeline,
    api.workspaces.listBranches, api.workspaces.appearance, api.scratch.listTopics, api.ui.readPastedImage, api.files.read].map(fn => vi.mocked(fn).mock.calls.length)
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  const config = await api.config.get(), snapshot = await api.sessions.snapshot()
  const found = snapshot.sessions.find((session): session is typeof base => session.kind === 'agent')
  expect(found).toBeDefined(); if (!found) throw new Error('A nonempty canonical Agent fixture is required'); base = found
  useAppStore.setState({ ...initial, loading: false, config: { ...config, hosts: [
    { id: 'local', kind: 'local', label: 'Local proof' }, { id: 'other', kind: 'ssh', hostname: 'example.invalid', label: 'Other proof' }
  ], workspaces: [] }, sessions: [], tabs: {}, layouts: {}, timelines: {}, providerCatalog: [], recoveryCandidates: [],
    scratchTopicSnapshots: {}, spaceObjectIcons: {}, workspaceFileRevisions: {}, demands: {}, agentNames: {},
    mainSurface: 'agents', error: null, activeWorkspaceId: null,
    focusTimelineRuler: { ...initial.focusTimelineRuler, timeZone: 'UTC' },
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
    agentComposerDrafts: { live: 'Original unsent draft' }
  }, true)
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => nativePage(control.agentSessionId))
  vi.spyOn(api.sessions, 'timeline').mockImplementation(async control => ({ agentSessionId: control.agentSessionId, revision: 0, items: [] }))
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async (control) => ({
    agentSessionId: control.agentSessionId, source: nativePage(control.agentSessionId).source, dispose: vi.fn()
  }))
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: _hygiene_fixturePath("current") })
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  vi.spyOn(api.ui, 'readPastedImage').mockResolvedValue(null); vi.spyOn(api.files, 'read')
  for (const method of ['launchAgent', 'resume', 'recover', 'stop', 'write', 'paste'] as const) vi.spyOn(api.sessions, method)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  await act(async () => new Promise<void>(resolve => setTimeout(resolve, 0)))
  root = undefined; container?.remove(); container = undefined
  document.getElementById('agentmux-window-overlay-host')?.remove(); window.getSelection()?.removeAllRanges()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('keeps online, offline and retained project entry points, and returns from the exact offline lane without replacing the board', async () => {
  const sessions = [agent('live', _hygiene_fixturePath("current")), agent('off-one', _hygiene_fixturePath("offline"), 'local', true), agent('off-two', _hygiene_fixturePath("offline"), 'local', true)]
  const entries = [history('archived', 'past', 'Past project', NOW - 3 * DAY, { branch: 'old-branch', topicId: 'old-topic' }), history('off-one', 'offline', 'Offline project', NOW - DAY)]
  await mount(sessions, [workspace('current', 'Current project', _hygiene_fixturePath("current")), workspace('offline', 'Offline project', _hygiene_fixturePath("offline"))], entries)
  expect(boardLanes().map(row => row.dataset.projectKey).sort()).toEqual([key('local', 'current'), key('local', 'offline')].sort())
  expect(directory().dataset.expanded).toBe('false')
  expect(container!.querySelector('.focus-project-board__live [data-session-id="off-one"]')).toBeNull()
  expect(retainedRows().map(row => row.dataset.retainedProject)).toEqual([key('local', 'past')])
  const toggle = button('Retained projects'); expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(toggle.querySelector('.focus-retained-projects__count')?.textContent).toBe('1')
  await click(toggle); expect(retainedRow('local', 'past').getAttribute('aria-label')).toBe('View Past project focus history')
  expect(retainedRow('local', 'past').title).toContain('old-branch'); expect(retainedRow('local', 'past').title).toContain('old-topic')
  const original = container!.querySelector('.focus-project-board__live [data-session-id="live"]')!
  expect(original).not.toBeNull()
  const offline = boardLanes().find(row => row.dataset.projectId === 'offline')!
  expect(offline.querySelector('.focus-disconnected-entry')?.textContent).toContain('2')
  const focus = useAppStore.getState().agentFocus, drafts = useAppStore.getState().agentComposerDrafts
  const trigger = await reveal(offline)
  expect(directoryIds()).toEqual(['off-one', 'off-two'])
  expect(document.activeElement?.getAttribute('data-session-id')).toBe('off-one')
  expect(retainedRow('local', 'past').isConnected).toBe(true)
  await click(button('Return to board'))
  expect(directory().dataset.expanded).toBe('false'); expect(document.activeElement).toBe(trigger)
  expect(container!.querySelector('.focus-project-board__live [data-session-id="live"]')).toBe(original)
  expect(boardLanes()).toHaveLength(2); expect(useAppStore.getState().sessions).toBe(sessions)
  expect(useAppStore.getState().agentFocus).toBe(focus); expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
})

it('does not auto-open an all-offline board and explicitly locates the chosen project before returning to its original title', async () => {
  const sessions = [agent('off-alpha', _hygiene_fixturePath("alpha"), 'local', true), agent('off-beta', _hygiene_fixturePath("beta"), 'local', true)]
  await mount(sessions, [workspace('alpha', 'Alpha project', _hygiene_fixturePath("alpha")), workspace('beta', 'Beta project', _hygiene_fixturePath("beta"))], [])
  expect(directory().dataset.expanded).toBe('false'); expect(boardLanes()).toHaveLength(2)
  expect(container!.querySelector<HTMLElement>('.focus-project-board__live')!.hidden).toBe(false)
  expect(directory().querySelector('.focus-context')).toBeNull()
  expect(directory().querySelector('.focus-disconnected-projects__count')?.textContent).toBe('2 projects · 2 contexts')
  const beta = boardLanes().find(row => row.dataset.projectId === 'beta')!, trigger = await reveal(beta)
  expect(directoryIds().sort()).toEqual(['off-alpha', 'off-beta'])
  expect(document.activeElement?.getAttribute('data-session-id')).toBe('off-beta')
  const target = [...directory().querySelectorAll<HTMLElement>('[data-lane-id]')].find(node => node.dataset.laneId === beta.dataset.laneId)!
  expect(target).toBeDefined(); expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts).toContain(target)
  await click(button('Return to board'))
  expect(document.activeElement).toBe(trigger); expect(boardLanes().map(row => row.dataset.projectId)).toEqual(['alpha', 'beta'])
  expect(useAppStore.getState().sessions).toBe(sessions); expect(useAppStore.getState().agentFocus.execution.sessionId).toBeNull()
  expect(api.sessions.launchAgent).not.toHaveBeenCalled(); expect(api.sessions.resume).not.toHaveBeenCalled(); expect(api.sessions.stop).not.toHaveBeenCalled()
})

it('retains only recorded Agent Host/Project facts without inventing current cards, and marks zero or invalid-date visits as unknown', async () => {
  const entries: AgentFocusHistoryEntry[] = [
    history('known-old', 'known', 'Known past project', NOW - 5 * DAY),
    history('zero-time', 'zero', 'Zero-time project', 0),
    history('invalid-date', 'invalid', 'Invalid-date project', 8_640_000_000_000_001),
    history('terminal', 'terminal-project', 'Terminal project', NOW - DAY, { kind: 'terminal', providerId: null }),
    history('missing-host', 'hostless', 'Unconfirmed host project', NOW - DAY, { hostId: '' }),
    { sessionId: 'legacy', focusedAt: NOW - 1000 },
    { sessionId: 'without-project', focusedAt: NOW - 2000, identity: { name: 'Project not recorded', kind: 'agent', providerId: 'generic', hostId: 'local', workspacePath: _hygiene_fixturePath("same/current/path") } }
  ]
  await mount([], [], entries)
  expect(container!.querySelector('.global-agents-empty')).toBeNull(); expect(boardLanes()).toHaveLength(0)
  expect(container!.querySelectorAll('.focus-context')).toHaveLength(0)
  expect(retainedRows().map(row => row.dataset.retainedProject).sort()).toEqual(['known', 'zero', 'invalid'].map(id => key('local', id)).sort())
  expect(button('Retained projects').querySelector('.focus-retained-projects__count')?.textContent).toBe('3')
  await click(button('Retained projects'))
  for (const id of ['zero', 'invalid']) {
    const row = retainedRow('local', id)
    expect(row.disabled).toBe(true); expect(row.textContent).toContain('Time unknown')
    expect(row.querySelector('time')).toBeNull(); expect(row.title).toContain('Focus time not recorded'); expect(row.textContent).not.toContain('1970')
  }
  expect(retainedRow('local', 'known').disabled).toBe(false)
  expect(retainedRow('local', 'known').querySelector('time')?.dateTime).toBe(new Date(NOW - 5 * DAY).toISOString())
  const reads = readCounts()
  await click(retainedRow('local', 'zero')); await click(retainedRow('local', 'invalid'))
  expect(button('Return to current focus window').getAttribute('aria-pressed')).toBe('true')
  await click(retainedRow('local', 'known'))
  expect(container!.querySelector<HTMLInputElement>('[aria-label="Focus history date and time"]')!.value).toBe(createFocusTimeFormatters('UTC').dateInput(NOW - 5 * DAY))
  expect(readCounts()).toEqual(reads); expect(useAppStore.getState().agentFocus.execution.history).toBe(entries)
  expect(useAppStore.getState().sessions).toHaveLength(0); expect(useAppStore.getState().agentFocus.execution.sessionId).toBeNull()
  expect(api.sessions.recover).not.toHaveBeenCalled(); expect(api.sessions.launchAgent).not.toHaveBeenCalled()
})

it('isolates project filtering and offline ownership across Hosts with identical project IDs and paths', async () => {
  const sessions = [agent('local-off', _hygiene_fixturePath("same/repo"), 'local', true), agent('other-off', _hygiene_fixturePath("same/repo"), 'other', true)]
  const entries = [history('past-local', 'same-past-id', 'Same past', NOW - 3 * DAY), history('past-other', 'same-past-id', 'Same past', NOW - 4 * DAY, { hostId: 'other' })]
  await mount(sessions, [workspace('same-id', 'Same project', _hygiene_fixturePath("same/repo")), workspace('same-id', 'Same project', _hygiene_fixturePath("same/repo"), 'other')], entries)
  expect(boardLanes()).toHaveLength(2); expect(new Set(boardLanes().map(row => row.dataset.laneId)).size).toBe(2)
  expect(boardLanes().map(row => row.dataset.projectKey).sort()).toEqual([key('local', 'same-id'), key('other', 'same-id')].sort())
  expect(directory().querySelector('.focus-disconnected-projects__count')?.textContent).toBe('2 projects · 2 contexts')
  const options = await focusFilterOptions(container!, 'project')
  expect(options.filter(option => option.value === key('local', 'same-id'))).toHaveLength(1)
  expect(options.find(option => option.value === key('local', 'same-id'))?.text).toContain('Local proof')
  expect(options.find(option => option.value === key('other', 'same-id'))?.text).toContain('Other proof')
  await reveal(boardLanes().find(row => row.dataset.projectKey === key('other', 'same-id'))!)
  expect(document.activeElement?.getAttribute('data-session-id')).toBe('other-off')
  await chooseFocusFilter(container!, 'project', key('local', 'same-id')); expect(directoryIds()).toEqual(['local-off'])
  await chooseFocusFilter(container!, 'project', key('other', 'same-id')); expect(directoryIds()).toEqual(['other-off'])
  await click(button('Retained projects'))
  await chooseFocusFilter(container!, 'project', key('local', 'same-past-id'))
  expect(directoryIds()).toHaveLength(0); expect(retainedRows().map(row => row.dataset.retainedProject)).toEqual([key('local', 'same-past-id')])
  expect(button('Retained projects').querySelector('.focus-retained-projects__count')?.textContent).toBe('1 of 2')
  expect(useAppStore.getState().sessions).toBe(sessions); expect(useAppStore.getState().agentFocus.execution.history).toBe(entries)
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBeNull()
})

it('deduplicates historical projects before filtering and keeps hidden or unrelated-byte updates free of new hierarchy and input reads', async () => {
  const sessions = [agent('live', _hygiene_fixturePath("current"))]
  const entries = [history('a-new', 'archive-a', 'Archive A', NOW - 3 * DAY), history('a-old', 'archive-a', 'Old label A', NOW - 4 * DAY),
    history('b', 'archive-b', 'Archive B', NOW - 3 * DAY), history('current-before', 'current', 'Current previous name', NOW - 3 * DAY)]
  await mount(sessions, [workspace('current', 'Current project', _hygiene_fixturePath("current"))], entries)
  expect(retainedRows()).toHaveLength(2); expect(retainedRow('local', 'archive-a').textContent).toContain('Archive A')
  expect(retainedRow('local', 'archive-a').querySelector('time')?.dateTime).toBe(new Date(NOW - 3 * DAY).toISOString())
  const toggle = button('Retained projects'), originalRows = retainedRows(), originalCurrent = container!.querySelector('.focus-context[data-session-id="live"]')!
  expect(originalCurrent).not.toBeNull()
  await click(toggle); const reads = readCounts()
  const appearanceCalls = vi.mocked(api.workspaces.appearance).mock.calls.map(call => [...call])
  await click(toggle); await click(toggle)
  for (let index = 0; index < 20; index++) await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => ({
    ...session, latestOutputBytes: session.latestOutputBytes + 1, status: { ...session.status, observedAt: session.status.observedAt + 1 }
  })) })))
  expect(retainedRows()).toEqual(originalRows); expect(container!.querySelector('.focus-context[data-session-id="live"]')).toBe(originalCurrent)
  expect(readCounts()).toEqual(reads)
  await search('Archive'); expect(boardLanes()).toHaveLength(0); expect(retainedRows()).toHaveLength(2)
  expect(retainedRows().some(row => row.dataset.retainedProject === key('local', 'current'))).toBe(false)
  await chooseFocusFilter(container!, 'state', 'working'); expect(retainedRows()).toHaveLength(0)
  expect(button('Retained projects').querySelector('.focus-retained-projects__count')?.textContent).toBe('0 of 2')
  await chooseFocusFilter(container!, 'state', 'all'); await chooseFocusFilter(container!, 'project', key('local', 'archive-b'))
  expect(retainedRows().map(row => row.dataset.retainedProject)).toEqual([key('local', 'archive-b')])
  await chooseFocusFilter(container!, 'project', 'all'); await search('')
  // Restoring the filtered current card adds a related ProjectIcon consumer.
  // It may read only that exact workspace; all other eight ports stay flat.
  expect(vi.mocked(api.workspaces.appearance).mock.calls).toEqual([...appearanceCalls, ['current']])
  expect(readCounts().filter((_, index) => index !== 5)).toEqual(reads.filter((_, index) => index !== 5))
  const restoredReads = readCounts()
  await act(async () => useAppStore.setState({ sessions: [] }))
  expect(retainedRows()).toHaveLength(3); expect(retainedRow('local', 'current').textContent).toContain('Current previous name')
  expect(useAppStore.getState().agentFocus.execution.history).toBe(entries)
  expect(readCounts()).toEqual(restoredReads)
})

it('moves the original Timeline viewport from Now through a real retained-date caller without rereading or replacing the pinned native body and Range', async () => {
  const live = agent('live', _hygiene_fixturePath("current")), entries = [history('past', 'past-project', 'Past project', NOW - 4 * DAY)]
  await mount([live], [workspace('current', 'Current project', _hygiene_fixturePath("current"))], entries, live.id)
  const messageId = 'native:generic:retention-native-live:record-live'
  let marker: HTMLButtonElement | null = null
  await act(async () => vi.waitFor(() => { marker = container!.querySelector<HTMLButtonElement>(`[data-input-message-id="${messageId}"]`); expect(marker).not.toBeNull() }))
  expect(button('Return to current focus window').getAttribute('aria-pressed')).toBe('true')
  await click(button('Retained projects'))
  const date = retainedRow('local', 'past-project'); expect(date.disabled).toBe(false)
  await act(async () => { marker!.focus(); marker!.click() })
  let preview: HTMLElement | null = null
  await act(async () => vi.waitFor(() => { preview = document.querySelector<HTMLElement>('.recent-focus__message-preview[data-interactive="true"]'); expect(preview?.style.visibility).toBe('visible') }))
  const body = preview!.querySelector<HTMLElement>('[data-input-preview-id]')!
  expect(body).not.toBeNull(); expect(body.dataset.inputPreviewId).toBe(messageId); expect(body.dataset.inputSource).toBe('native')
  expect(body.textContent).toContain('Keep this original native message selected.')
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
  let text: Node | null
  do { text = walker.nextNode() } while (text && !text.textContent?.includes('Keep this original native message'))
  expect(text).not.toBeNull()
  const range = document.createRange(); range.setStart(text!, 0); range.setEnd(text!, 4)
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); expect(selection.toString()).toBe('Keep')
  const before = useAppStore.getState(), counts = readCounts()
  expect(counts[0]).toBeGreaterThan(0); expect(counts[1]).toBeGreaterThan(0); expect(counts[2]).toBeGreaterThan(0)
  const sourceCalls = vi.mocked(api.sessions.historyPage).mock.calls.map(call => [call[0].hostId, call[0].agentSessionId, call[1]])
  await act(async () => { date.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true })); date.click() })
  await act(async () => new Promise<void>(resolve => setTimeout(resolve, 60)))
  expect(container!.querySelector<HTMLInputElement>('[aria-label="Focus history date and time"]')!.value).toBe(createFocusTimeFormatters('UTC').dateInput(NOW - 4 * DAY))
  expect(button('Return to current focus window').getAttribute('aria-pressed')).toBe('false')
  expect(document.querySelector('.recent-focus__message-preview[data-interactive="true"]')).toBe(preview)
  expect(preview!.querySelector('[data-input-preview-id]')).toBe(body); expect(body.dataset.inputPreviewId).toBe(messageId)
  expect(selection.rangeCount).toBe(1); expect(selection.getRangeAt(0)).toBe(range)
  expect(selection.getRangeAt(0).startContainer).toBe(text); expect(selection.toString()).toBe('Keep')
  expect(readCounts()).toEqual(counts)
  expect(vi.mocked(api.sessions.historyPage).mock.calls.map(call => [call[0].hostId, call[0].agentSessionId, call[1]])).toEqual(sourceCalls)
  expect(useAppStore.getState().agentFocus).toBe(before.agentFocus); expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().sessions[0]!.control).toBe(live.control); expect(live.processState).toBe('running')
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(api.sessions.stop).not.toHaveBeenCalled(); expect(api.sessions.recover).not.toHaveBeenCalled()
})
