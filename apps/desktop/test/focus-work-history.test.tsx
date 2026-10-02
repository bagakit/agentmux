import { fixtureData as _hygiene_fixtureData, fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement, useMemo } from 'react'
import relativeFixture_acceptedPublicInputs from './fixtures/focus-work-history-public-inputs.json'
const acceptedPublicInputs = _hygiene_fixtureData(relativeFixture_acceptedPublicInputs)
import { expect, it, vi } from 'vitest'
import * as WorkHistory from '@agentmux/core/timeline'
import { loadAgentSessions, type AgentTimelineItem } from '@agentmux/core'
import { fixture, NOW, HOUR, BODY } from './fixtures/focus-history-public'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { deriveFocusProjectLanes } from '../src/renderer/src/lib/focus-project-lanes'
import { removeSessionProjection } from '../src/renderer/src/lib/session-state'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import type { SessionSnapshot } from '../src/shared/contracts'

// These are controlled typed observations persisted/read by the actual public
// FileStore/Client bridge. They qualify the UI consumer; T001 independently owns
// accepted native/ACP producer proof, and must pass before final T002 release.
const SID = 'archived-0', RUN = 'not-controlled-archived-0'
function observed(id: string, at: number, state: 'working' | 'done', previous?: string, runId = RUN): AgentTimelineItem {
  return { id, agentSessionId: SID, kind: 'lifecycle', status: 'complete', source: 'acp', title: 'Controlled typed observation', createdAt: at, updatedAt: at,
    activityState: { run: { runId }, state, stateEnteredAt: at, ...(previous ? { previousObservationId: previous } : {}) } }
}
function rounds() {
  return [observed('work-one', NOW - 2 * HOUR, 'working'), observed('done-one', NOW - 1.5 * HOUR, 'done', 'work-one'),
    observed('work-two', NOW - HOUR, 'working', 'done-one'), observed('done-two', NOW - 0.5 * HOUR, 'done', 'work-two')]
}
async function mounted(items = rounds(), native = false) {
  const h = await fixture(native ? [{ id: 'native-kept', body: 'Native same Context original', at: NOW - HOUR }] : [], 1, { native, retire: false })
  for (const item of items) await h.store.applyTimelineMutation({ type: 'append', agentSessionId: SID, item })
  const raw = await api.sessions.timeline(h.reference)
  expect(raw.items.filter(item => item.activityState)).toEqual(items)
  const stored = (await loadAgentSessions(h.store))[0]!
  const snapshot = { id: stored.agentSessionId, kind: 'agent', providerId: stored.providerId, executorId: stored.executorId,
    hostId: stored.hostId, workspacePath: stored.workspacePath, label: 'Original work history', createdAt: 1, updatedAt: NOW,
    processState: 'running', latestOutputBytes: 0, status: { state: 'done', source: 'acp', observedAt: NOW - HOUR / 2 },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
    semanticStatus: { state: 'done', source: 'acp', observedAt: NOW - HOUR / 2, stateEnteredAt: NOW - HOUR / 2 },
    control: { kind: 'agent', hostId: stored.hostId, agentSessionId: SID, run: stored.run } } as SessionSnapshot
  useAppStore.setState(state => ({ sessions: [snapshot], config: { ...state.config!, workspaces: [
    { id: 'observed-alpha', name: 'Observed Alpha', hostId: 'private-host', path: stored.workspacePath, kind: 'folder' },
    { id: 'observed-beta', name: 'Observed Beta', hostId: 'private-host', path: _hygiene_fixturePath("different-observed-project"), kind: 'folder' }
  ] }, timelines: { ...state.timelines, [SID]: raw }, agentComposerDrafts: { ...state.agentComposerDrafts, [SID]: 'Original unsent request' } }))
  const selector = createFocusProjectionSelector()
  function Surface() {
    const contexts = useAppStore(state => selector({ sessions: state.sessions, timelines: state.timelines, agentNames: state.agentNames, config: state.config, scratchTopicSnapshots: state.scratchTopicSnapshots }).contexts)
    const config = useAppStore(state => state.config), lanes = useMemo(() => deriveFocusProjectLanes(contexts, config), [contexts, config])
    return createElement(RecentFocusTimeline, { contexts, lanes, entries: [], currentSessionId: null, onSelect: h.onSelect })
  }
  await act(async () => h.root.render(createElement(Surface)))
  await h.wait(() => expect(h.element.querySelectorAll('[data-work-end]')).toHaveLength(2))
  const bands = () => [...h.element.querySelectorAll<HTMLButtonElement>('[data-work-end]')]
  const close = () => act(async () => useAppStore.setState(state => removeSessionProjection(state, SID)))
  const refresh = async () => {
    const value = await api.sessions.timeline(h.reference)
    await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, [SID]: value } })))
  }
  return { ...h, bands, close, refresh, raw, snapshot }
}

it('renders two independent public typed rounds even when the current semantic state is done', async () => {
  const h = await mounted()
  expect(h.bands().map(node => [node.dataset.runId, Number(node.dataset.workingEnteredAt), Number(node.dataset.workingThrough), node.dataset.workEnd])).toEqual([
    [RUN, NOW - 2 * HOUR, NOW - 1.5 * HOUR, 'state-change'], [RUN, NOW - HOUR, NOW - HOUR / 2, 'state-change']])
  expect(h.onSelect).not.toHaveBeenCalled()
  expect(h.element.querySelectorAll('.recent-focus__live')).toHaveLength(1)
})

it('the real removeSessionProjection retains already seen state-only history without opening Input records or controlling a Run', async () => {
  const h = await mounted(), before = h.bands().map(node => node.dataset.workingEnteredAt)
  expect(h.element.querySelector('[aria-label="Input records Context"]')).toBeNull()
  await h.close()
  await h.wait(() => expect(h.bands()).toHaveLength(2))
  expect(useAppStore.getState().timelines[SID]).toBeUndefined()
  expect(h.bands().map(node => node.dataset.workingEnteredAt)).toEqual(before)
  expect(h.element.querySelectorAll('.recent-focus__live')).toHaveLength(0)
  expect(h.element.querySelector('[data-history-only="true"]')).not.toBeNull()
  expect(useAppStore.getState().agentComposerDrafts[SID]).toBe('Original unsent request')
  await act(async () => h.bands()[0]!.click())
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain(RUN); expect(dialog.textContent).toContain(SID)
  expect(dialog.textContent).toContain('does not restore')
  expect(h.onSelect).not.toHaveBeenCalled(); h.noRuntime()
})

it('work-only admission cannot overwrite the same Context captured input markers or pinned BODY/Range', async () => {
  const h = await mounted()
  await h.selectSource()
  await h.wait(() => expect(h.inputs().some(node => node.textContent?.includes(BODY))).toBe(true))
  await act(async () => h.inputs().find(node => node.textContent?.includes(BODY))!.click())
  await h.wait(() => expect(document.querySelector('.recent-focus__message-body')).not.toBeNull())
  const body = document.querySelector('.recent-focus__message-body')!, text = [...body.childNodes].find(node => node.nodeType === Node.TEXT_NODE) ?? body.firstChild!
  const range = document.createRange(); range.selectNodeContents(text); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  const selected = selection.toString(), before = body
  const next = observed('work-three', NOW - HOUR / 4, 'working', 'done-two')
  await h.store.applyTimelineMutation({ type: 'append', agentSessionId: SID, item: next }); await h.refresh()
  await h.wait(() => expect(h.bands()).toHaveLength(3))
  expect(h.element.querySelectorAll('[data-message-id="captured:captured"]')).toHaveLength(1)
  expect(document.querySelector('.recent-focus__message-body')).toBe(before)
  expect(selection.rangeCount).toBe(1); expect(selection.toString()).toBe(selected)
})

it('unknown ends and cross-Run observations do not synthesize a band to Now', async () => {
  const h = await mounted()
  const item = observed('unclosed-other-run', NOW - HOUR / 4, 'working', 'missing-predecessor', 'another-run')
  await h.store.applyTimelineMutation({ type: 'append', agentSessionId: SID, item }); await h.refresh()
  await h.wait(() => expect(h.bands()).toHaveLength(3))
  const unknown = h.bands().find(node => node.dataset.runId === 'another-run')!
  expect(unknown.dataset.workEnd).toBe('unknown'); expect(unknown.style.width).toBe('0%')
  expect(unknown.title).toContain('End not recorded')
})

it('normalization/tool clones, unrelated Session output and 200 viewport operations do not call the work projector or issue history I/O', async () => {
  const h = await mounted(), projector = vi.spyOn(WorkHistory, 'projectAgentWorkHistory'), reads = h.counts()
  for (let index = 0; index < 20; index++) {
    await h.store.applyTimelineMutation({ type: 'append', agentSessionId: SID, item: { id: `tool-${index}`, agentSessionId: SID, kind: 'tool_call', source: 'acp', status: 'complete', createdAt: NOW, updatedAt: NOW, title: 'Actual tool update' } })
    await h.refresh()
  }
  // Public explicit refreshes above are intentional; reset their I/O baseline.
  const before = h.counts()
  for (let index = 0; index < 200; index++) await act(async () => {
    h.element.querySelector<HTMLButtonElement>(`[aria-label="${index % 2 ? 'Next focus window' : 'Previous focus window'}"]`)!.click()
    useAppStore.setState(state => ({ timelines: { ...state.timelines, unrelated: { agentSessionId: 'unrelated', revision: index, items: [] } } }))
  })
  expect(projector).not.toHaveBeenCalled()
  expect(h.counts()).toEqual(before)
  expect(before[0]).toBe(reads[0])
})

it('actual T001 nativeHTTP/ACP public facts remain visible for a retired state-only source when native input cannot be read', async () => {
  const h = await fixture([], 1, { native: false, retire: false })
  const history = acceptedPublicInputs.history as import('@agentmux/core').AgentTimelineSnapshot
  const descriptor = acceptedPublicInputs.descriptor as import('@agentmux/core').AgentSessionHistoryDescriptor
  expect(acceptedPublicInputs.provenance.runtimeConnected).toBe(false)
  expect(new Set(history.items.filter(item => item.activityState).map(item => item.source))).toEqual(new Set(['native-hook', 'acp', 'run-process']))
  const last = Math.max(...history.items.map(item => item.createdAt))
  vi.spyOn(Date, 'now').mockReturnValue(last + HOUR)
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([descriptor])
  vi.spyOn(api.sessions, 'timeline').mockImplementation(async reference => { expect(reference).toEqual({ hostId: descriptor.hostId, agentSessionId: history.agentSessionId }); return history })
  vi.spyOn(api.sessions, 'historyPage').mockRejectedValue(new Error('Native identity not available; typed history is still readable'))
  await act(async () => h.root.render(createElement(RecentFocusTimeline, { contexts: [], entries: [], currentSessionId: null, onSelect: h.onSelect })))
  await h.selectSource(history.agentSessionId)
  const expected = WorkHistory.projectAgentWorkHistory(history.items).segments
  expect(expected).toHaveLength(5)
  await h.wait(() => expect(h.element.querySelectorAll('[data-work-end]')).toHaveLength(expected.length))
  expect([...h.element.querySelectorAll<HTMLElement>('[data-work-end]')].map(node => [node.dataset.runId, Number(node.dataset.workingEnteredAt), Number(node.dataset.workingThrough), node.dataset.workEnd])).toEqual(expected.map(item => [item.run.runId, item.startAt, item.endAt, item.end]))
  expect(h.element.querySelectorAll('.recent-focus__live')).toHaveLength(0)
  expect(document.body.textContent).toContain('Native identity not available')
  h.noRuntime()
})

it('a closed typed source still exposes captured input and ignores a hidden late refresh without losing its pinned BODY/Range', async () => {
  const h = await mounted(); await h.close(); await h.selectSource()
  await h.wait(() => expect(h.inputs().some(node => node.textContent?.includes(BODY))).toBe(true))
  await act(async () => h.inputs().find(node => node.textContent?.includes(BODY))!.click())
  const body = document.querySelector('.recent-focus__message-body')!
  const text = document.createTreeWalker(body, NodeFilter.SHOW_TEXT).nextNode()!, range = document.createRange()
  range.selectNodeContents(text); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  const selected = selection.toString(); expect(selected.length).toBeGreaterThan(0)
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve }); let read = false
  const latest = { ...h.raw, items: [...h.raw.items, observed('late-third-round', NOW - HOUR / 4, 'working', 'done-two')] }
  await h.wait(() => expect([...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Refresh source')!.disabled).toBe(false))
  h.calls.timeline.mockImplementation(async () => { read = true; await gate; return latest })
  await h.button('Refresh source'); await h.wait(() => expect(read).toBe(true))
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  const counts = h.counts()
  await act(async () => { release(); await gate })
  expect(h.bands()).toHaveLength(2)
  expect(document.querySelector('.recent-focus__message-body')).toBe(body)
  expect(selection.toString()).toBe(selected); expect(selection.rangeCount).toBe(1)
  expect(h.counts()).toEqual(counts); h.noRuntime()
})

it('observed old project and Run identity remain on their original track after the current Session moves and changes Run', async () => {
  const h = await mounted()
  const oldName = h.element.querySelector('.recent-focus__project-summary')!.textContent
  const next = observed('new-run-work', NOW - HOUR / 4, 'working', undefined, 'new-run')
  const snapshot = { ...h.snapshot, workspacePath: _hygiene_fixturePath("different-observed-project"), control: { ...h.snapshot.control, run: { runId: 'new-run' } } } as SessionSnapshot
  await act(async () => useAppStore.setState(state => ({ sessions: [snapshot], timelines: { ...state.timelines, [SID]: { ...h.raw, items: [...h.raw.items, next] } } })))
  await h.wait(() => expect(h.bands()).toHaveLength(3))
  expect(h.bands().filter(node => node.dataset.runId === RUN).map(node => node.dataset.workingThrough)).toEqual([String(NOW - 1.5 * HOUR), String(NOW - HOUR / 2)])
  expect(h.bands().find(node => node.dataset.runId === 'new-run')!.dataset.workEnd).toBe('unknown')
  expect(h.element.querySelector('.recent-focus__project-summary')!.textContent).toBe(oldName)
  const groups = [...h.element.querySelectorAll('.recent-focus__project')]
  expect(groups.filter(group => group.textContent?.includes('Observed Alpha')).flatMap(group => [...group.querySelectorAll<HTMLButtonElement>('[data-work-end]')]).map(node => node.dataset.runId)).toEqual([RUN, RUN])
  expect(groups.filter(group => group.textContent?.includes('Observed Beta')).flatMap(group => [...group.querySelectorAll<HTMLButtonElement>('[data-work-end]')]).map(node => node.dataset.runId)).toEqual(['new-run'])
  await h.close(); expect(h.bands()).toHaveLength(3); h.noRuntime()
})

it('bounds typed observations globally at 200 independently of the same holder captured input and byte budget', async () => {
  const h = await mounted(); await h.close(); await h.selectSource()
  await h.wait(() => expect(h.inputs().some(node => node.textContent?.includes(BODY))).toBe(true))
  const two = { ...h.snapshot, id: 'controlled-second-session', control: { ...h.snapshot.control, agentSessionId: 'controlled-second-session', run: { runId: 'second-run' } } } as SessionSnapshot
  const facts = (sid: string, run: string) => Array.from({ length: 160 }, (_, index) => ({ ...observed(`${sid}-${index}`, NOW - 2 * HOUR + index * 1000, index % 2 ? 'done' : 'working', index ? `${sid}-${index - 1}` : undefined, run), agentSessionId: sid }))
  const first = facts(SID, RUN), second = facts(two.id, 'second-run')
  await act(async () => useAppStore.setState(state => ({ sessions: [h.snapshot, two], timelines: { ...state.timelines,
    [SID]: { ...h.raw, items: [h.raw.items.find(item => item.kind === 'user_message')!, ...first] },
    [two.id]: { agentSessionId: two.id, revision: 1, items: second } } })))
  await h.wait(() => expect(Number(h.element.querySelector<HTMLElement>('.recent-focus')!.dataset.workRecordCount)).toBe(200))
  const section = h.element.querySelector<HTMLElement>('.recent-focus')!
  expect(Number(section.dataset.capturedRecordCount)).toBe(1)
  expect(Number(section.dataset.readBytes)).toBeLessThanOrEqual(12 * 1024 * 1024)
  expect(section.dataset.readingTrimmed).toBe('true')
  expect(h.element.querySelectorAll('[data-message-id="captured:captured"]')).toHaveLength(1)
  expect(h.bands().length).toBeGreaterThan(0)
  // Controlled oversized raw observations qualify the holder's aggregate byte
  // bound, independently of T001's accepted producer/storage limits.
  const content = '观测'.repeat(180_000), large = Array.from({ length: 15 }, (_, index) => ({
    ...observed(`large-${index}`, NOW - HOUR / 4 + index, 'working', undefined, RUN), content
  }))
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, [SID]: { ...h.raw, items: large } } })))
  await h.wait(() => expect(Number(section.dataset.readBytes)).toBeLessThanOrEqual(12 * 1024 * 1024))
  expect(Number(section.dataset.readBytes)).toBeGreaterThan(1024 * 1024)
  expect(Number(section.dataset.workRecordCount)).toBeLessThan(200)
  expect(Number(section.dataset.capturedRecordCount)).toBe(1)
  expect(h.element.querySelectorAll('[data-message-id="captured:captured"]')).toHaveLength(1)
})

it('the actual public native reader and typed history keep both original reader bodies after work-only admission', async () => {
  const h = await mounted(rounds(), true); await h.close(); await h.selectSource()
  await h.wait(() => expect(h.inputs().map(node => node.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Native same Context original'), expect.stringContaining(BODY)])))
  expect(h.inputs().map(node => node.dataset.inputMessageId)).toEqual(expect.arrayContaining(['native:claude:native-archived-0:native-kept', 'captured:captured']))
  await act(async () => h.inputs().find(node => node.textContent?.includes('Native same Context original'))!.click())
  const body = document.querySelector('.recent-focus__message-body')!
  expect(body.textContent).toContain('Native same Context original')
  await h.store.applyTimelineMutation({ type: 'append', agentSessionId: SID, item: observed('read-third', NOW - HOUR / 4, 'working', 'done-two') })
  await h.wait(() => expect([...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Refresh source')!.disabled).toBe(false))
  await h.button('Refresh source'); await h.wait(() => expect(h.bands()).toHaveLength(3))
  expect(h.element.querySelector<HTMLElement>('.recent-focus')!.dataset.readSourceCount).toBe('1')
  expect(document.querySelector('.recent-focus__message-body')).toBe(body)
  expect(h.inputs().map(node => node.dataset.inputMessageId)).toEqual(expect.arrayContaining(['native:claude:native-archived-0:native-kept', 'captured:captured']))
  expect(h.element.querySelectorAll('[data-message-id="native:claude:native-archived-0:native-kept"]')).toHaveLength(1)
  h.noRuntime()
})
