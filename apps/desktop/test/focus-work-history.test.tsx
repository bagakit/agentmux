import { fixtureData as _hygiene_fixtureData, fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect, useMemo } from 'react'
import relativeFixture_acceptedPublicInputs from './fixtures/focus-work-history-public-inputs.json'
const acceptedPublicInputs = _hygiene_fixtureData(relativeFixture_acceptedPublicInputs)
import { expect, it, vi } from 'vitest'
import * as WorkHistory from '@agentmux/core/timeline'
import { loadAgentSessions, type AgentTimelineItem } from '@agentmux/core'
import { fixture, NOW, HOUR, BODY } from './fixtures/focus-history-public'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
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


it('retained work budget must preserve eight known current Working bands', async () => {
  const h = await fixture([], 9, { native: false, retire: false })
  const stored = await loadAgentSessions(h.store)
  const current = stored.slice(0, 8)
  const enteredAt = NOW - HOUR / 4
  const typedById: Record<string, AgentTimelineItem> = {}
  for (const value of current) {
    const item = { ...observed(`current-work-${value.agentSessionId}`, enteredAt, 'working', undefined, value.run.runId), agentSessionId: value.agentSessionId }
    typedById[value.agentSessionId] = item
    await h.store.applyTimelineMutation({ type: 'append', agentSessionId: value.agentSessionId, item })
  }
  const snapshots = current.map(value => ({
    id: value.agentSessionId, kind: 'agent', providerId: value.providerId, executorId: value.executorId,
    hostId: value.hostId, workspacePath: value.workspacePath, label: `Current ${value.agentSessionId}`, createdAt: 1, updatedAt: NOW,
    processState: 'running', latestOutputBytes: 0, status: { state: 'working', source: 'acp', observedAt: NOW },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
    semanticStatus: { state: 'working', source: 'acp', observedAt: NOW, stateEnteredAt: enteredAt },
    control: { kind: 'agent', hostId: value.hostId, agentSessionId: value.agentSessionId, run: value.run }
  } as SessionSnapshot))
  const timelines: Record<string, Awaited<ReturnType<typeof api.sessions.timeline>>> = {}
  for (const value of current) timelines[value.agentSessionId] = await api.sessions.timeline({ hostId: value.hostId, agentSessionId: value.agentSessionId })
  useAppStore.setState(state => ({ sessions: snapshots, timelines, config: { ...state.config!, workspaces: [
    { id: 'observed-alpha', name: 'Observed Alpha', hostId: current[0]!.hostId, path: current[0]!.workspacePath, kind: 'folder' }
  ] } }))
  const selector = createFocusProjectionSelector()
  function Surface() {
    const contexts = useAppStore(state => selector({ sessions: state.sessions, timelines: state.timelines, agentNames: state.agentNames, config: state.config, scratchTopicSnapshots: state.scratchTopicSnapshots }).contexts)
    const config = useAppStore(state => state.config)
    const lanes = useMemo(() => deriveFocusProjectLanes(contexts, config), [contexts, config])
    return createElement(RecentFocusTimeline, { contexts, lanes, entries: [], currentSessionId: null, onSelect: h.onSelect })
  }
  const ids = new Set(current.map(value => value.agentSessionId))
  const bands = () => [...h.element.querySelectorAll<HTMLButtonElement>('.recent-focus__working')].filter(node => ids.has(node.closest<HTMLElement>('[data-focus-timeline-id]')!.dataset.focusTimelineId!))
  const live = () => [...h.element.querySelectorAll<HTMLButtonElement>('.recent-focus__live')].filter(node => ids.has(node.closest<HTMLElement>('[data-focus-timeline-id]')!.dataset.focusTimelineId!))
  const capture = () => ({
    counts: h.counts(), workRecordCount: Number(h.element.querySelector<HTMLElement>('.recent-focus')!.dataset.workRecordCount),
    trimmed: h.element.querySelector<HTMLElement>('.recent-focus')!.dataset.readingTrimmed ?? null,
    currentBands: bands().map(node => ({ id: node.closest<HTMLElement>('[data-focus-timeline-id]')!.dataset.focusTimelineId, runId: node.dataset.runId, enteredAt: node.dataset.workingEnteredAt, through: node.dataset.workingThrough, end: node.dataset.workEnd })),
    live: live().map(node => ({ id: node.closest<HTMLElement>('[data-focus-timeline-id]')!.dataset.focusTimelineId, runId: node.dataset.runId, title: node.title })),
    contexts: selector({ sessions: useAppStore.getState().sessions, timelines: useAppStore.getState().timelines, agentNames: useAppStore.getState().agentNames, config: useAppStore.getState().config, scratchTopicSnapshots: useAppStore.getState().scratchTopicSnapshots }).contexts.map(context => ({ id: context.id, state: context.state, processState: context.processState, workingEnteredAt: context.workingEnteredAt, runId: context.runId })),
    canonicalWork: current.map(value => ({ id: value.agentSessionId, records: useAppStore.getState().timelines[value.agentSessionId]!.items.filter(item => item.activityState) }))
  })
  await act(async () => h.root.render(createElement(Surface)))
  await h.wait(() => { expect(bands()).toHaveLength(8); expect(live()).toHaveLength(8); expect(capture().workRecordCount).toBe(8) })
  expect(capture().contexts.filter(context => context.state === 'working')).toHaveLength(8)
  const before = capture()

  const extra = stored[8]!
  let previous: string | undefined
  for (let index = 0; index < 200; index++) {
    const id = `extra-${index}`
    const item = { ...observed(id, NOW - 2 * HOUR + index * 1000, index % 2 ? 'done' : 'working', previous, extra.run.runId), agentSessionId: extra.agentSessionId }
    await h.store.applyTimelineMutation({ type: 'append', agentSessionId: extra.agentSessionId, item })
    previous = id
  }
  await h.selectSource(extra.agentSessionId)
  await h.wait(() => { expect(capture().workRecordCount).toBe(200); expect(capture().trimmed).toBe('true') })
  const after = capture()
  const kernel = (h.client as unknown as { kernel: Record<string, (...args: unknown[]) => unknown> }).kernel
  const controls = Object.fromEntries(['start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => [name, vi.mocked(kernel[name]!).mock.calls.length]))
  const result = { before, after, controls, connectCalls: vi.mocked(h.client.connect).mock.calls.length, selectCalls: h.onSelect.mock.calls.length,
    readCalls: { catalogue: h.calls.catalogue.mock.calls, page: h.calls.page.mock.calls, timeline: h.calls.timeline.mock.calls },
    input: { knownCurrentAgents: 8, trustedSource: 'acp', semanticObservedAt: NOW, stateEnteredAt: enteredAt, extraTypedObservations: 200, actualFileStore: true, actualPublicIpcAndCoreReader: true } }
  expect(after.counts[0]).toBe(before.counts[0])
  expect(after.counts[1]).toBe(before.counts[1]! + 1)
  expect(after.counts[2]).toBe(before.counts[2]! + 1)
  expect(after.live).toHaveLength(8)
  expect(after.contexts.filter(context => context.state === 'working')).toHaveLength(8)
  expect(useAppStore.getState().sessions).toEqual(snapshots)
  for (const value of current) expect(useAppStore.getState().timelines[value.agentSessionId]!.items.filter(item => item.activityState)).toEqual([typedById[value.agentSessionId]])
  expect(Object.values(controls)).toEqual([0, 0, 0, 0, 0, 0])
  expect(result.connectCalls).toBe(0); expect(result.selectCalls).toBe(0)
  expect(after.currentBands).toHaveLength(8)
})

it('current work extension preserves exact Run freshness and missing-start boundaries', async () => {
  const h = await mounted()
  // This tail is actually persisted/read through the original FileStore bridge.
  const enteredAt = NOW - HOUR / 3
  const tail = observed('current-contract-tail', enteredAt, 'working', 'done-two')
  await h.store.applyTimelineMutation({ type: 'append', agentSessionId: SID, item: tail })
  const fresh = { ...h.snapshot, updatedAt: NOW,
    status: { state: 'working', source: 'acp', observedAt: NOW },
    semanticStatus: { state: 'working', source: 'acp', observedAt: NOW, stateEnteredAt: enteredAt }
  } as SessionSnapshot
  const setSnapshot = async (value: SessionSnapshot) => act(async () => useAppStore.setState({ sessions: [value] }))
  await setSnapshot(fresh)
  await h.refresh()
  const point = () => h.bands().find(node => node.dataset.workingEnteredAt === String(enteredAt))!
  const historical = () => h.bands().filter(node => node.dataset.workingEnteredAt !== String(enteredAt))
  const recorded = () => ({
    end: point()?.dataset.workEnd, width: point()?.style.width,
    through: Number(point()?.dataset.workingThrough), run: point()?.dataset.runId,
    live: h.element.querySelectorAll('.recent-focus__live').length,
    canonicalItems: useAppStore.getState().timelines[SID]!.items.filter(item => item.activityState).map(item => item.id),
    reads: h.counts(), originalClosedBands: historical().map(node => ({ start: node.dataset.workingEnteredAt, through: node.dataset.workingThrough, end: node.dataset.workEnd }))
  })
  await h.wait(() => { expect(point()).not.toBeUndefined(); expect(point().dataset.workEnd).toBe('current'); expect(Number(point().dataset.workingThrough)).toBe(NOW); expect(h.element.querySelectorAll('.recent-focus__working')).toHaveLength(3) })
  const baseline = recorded(), reads = h.counts()
  expect(baseline.live).toBe(1)
  expect(baseline.originalClosedBands.map(item => item.end)).toEqual(['state-change', 'state-change'])
  const phases: Array<{ condition: string; observation: ReturnType<typeof recorded> }> = []
  const expectUnknownPoint = async (condition: string) => {
    await h.wait(() => {
      expect(point()).not.toBeUndefined()
      expect(point().dataset.workEnd).toBe('unknown')
      expect(point().style.width).toBe('0%')
      expect(h.element.querySelectorAll('.recent-focus__working:not([data-work-end])')).toHaveLength(0)
      expect(Number(point().dataset.workingThrough)).toBe(enteredAt)
      expect(h.element.querySelectorAll('.recent-focus__live')).toHaveLength(1)
    })
    expect(recorded().originalClosedBands).toEqual(baseline.originalClosedBands)
    expect(recorded().canonicalItems).toEqual(baseline.canonicalItems)
    expect(h.counts()).toEqual(reads)
    phases.push({ condition, observation: recorded() })
  }
  const expectRestored = async () => {
    await setSnapshot(fresh)
    await h.wait(() => { expect(point().dataset.workEnd).toBe('current'); expect(Number(point().dataset.workingThrough)).toBe(NOW); expect(h.element.querySelectorAll('.recent-focus__working')).toHaveLength(3) })
    expect(h.counts()).toEqual(reads)
  }

  // Same Session, different exact current Run: old typed tail stays a point.
  await setSnapshot({ ...fresh, control: { ...fresh.control, run: { runId: 'different-current-run' } } } as SessionSnapshot)
  await expectUnknownPoint('current Run differs from typed tail')
  await expectRestored()

  // State entered 20 min ago; last trusted observation 16 min ago: both times
  // remain chronological, and the public 15-min freshness owner decides stale.
  await setSnapshot({ ...fresh,
    status: { state: 'working', source: 'acp', observedAt: NOW - 16 * 60_000 },
    semanticStatus: { state: 'working', source: 'acp', observedAt: NOW - 16 * 60_000, stateEnteredAt: enteredAt }
  } as SessionSnapshot)
  await expectUnknownPoint('current working observation is stale')
  await expectRestored()

  // Current semantic Working is fresh, but its begin is unrecorded. Do not
  // borrow the known historical tail's begin as current semantic authority.
  await setSnapshot({ ...fresh, semanticStatus: { state: 'working', source: 'acp', observedAt: NOW } } as SessionSnapshot)
  await expectUnknownPoint('current working start is unknown')
  await expectRestored()
  const kernel = (h.client as unknown as { kernel: Record<string, (...args: unknown[]) => unknown> }).kernel
  const controls = Object.fromEntries(['start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => [name, vi.mocked(kernel[name]!).mock.calls.length]))
  const receipt = { executedOriginalMountedFixture: true, baseline, phases, restored: recorded(), controls,
    connectCalls: vi.mocked(h.client.connect).mock.calls.length, selectCalls: h.onSelect.mock.calls.length,
    boundary: 'One fixture, three negative current DTO changes, same literal stored tail and two closed rounds. No new read, Run control, history cache or Core algorithm. Does not qualify Native/PTY or replace original 200-record/Range adjacency.' }
  expect(Object.values(controls)).toEqual([0, 0, 0, 0, 0, 0]); expect(receipt.connectCalls).toBe(0); expect(receipt.selectCalls).toBe(0)
})

it('actual native file growth reaches shared Hook incomplete window and visible Timeline coverage without losing reading', async () => {
  const h = await mounted(rounds(), true)
  const snapshot = h.snapshot
  const control = (() => {
    const value = snapshot.control
    if (value.kind !== 'agent') throw new Error('Actual fixture Agent control required')
    return value
  })()
  const events: import('@agentmux/core').AgentSessionHistoryObservation[] = []
  const realObserve = h.client.observeSessionHistory.bind(h.client)
  const observe = vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async (reference, listener, options) => {
    expect(reference).toEqual(snapshot.control)
    return realObserve(reference.agentSessionId, event => { events.push(event); listener(event) }, options)
  })
  let reading: ReturnType<typeof useSessionUserMessages> | undefined
  function ReadingFacts() {
    const value = useSessionUserMessages(control, { enabled: true })
    useLayoutEffect(() => { reading = value }, [value])
    return null
  }
  const selector = createFocusProjectionSelector()
  function Surface() {
    const contexts = useAppStore(state => selector({ sessions: state.sessions, timelines: state.timelines, agentNames: state.agentNames, config: state.config, scratchTopicSnapshots: state.scratchTopicSnapshots }).contexts)
    const config = useAppStore(state => state.config)
    const lanes = useMemo(() => deriveFocusProjectLanes(contexts, config), [contexts, config])
    return createElement('section', null, createElement(ReadingFacts), createElement(RecentFocusTimeline, { contexts, lanes, entries: [], currentSessionId: SID, onSelect: h.onSelect }))
  }
  await act(async () => h.root.render(createElement(Surface)))
  await h.wait(() => {
    expect(reading?.error).toBeNull()
    expect(reading?.observationError).toBeNull()
    expect(reading?.nativeHistoryPage?.items.map(item => item.id)).toEqual(['native-kept'])
    expect(reading?.windowIncomplete).toBe(false)
    expect(observe).toHaveBeenCalledTimes(1)
  })
  const original = reading!.nativeHistoryPage!.items[0]!
  await h.selectSource()
  await h.wait(() => expect(h.inputs().some(node => node.textContent?.includes('Native same Context original'))).toBe(true))
  await act(async () => h.inputs().find(node => node.textContent?.includes('Native same Context original'))!.click())
  const body = document.querySelector('.recent-focus__message-body')!
  expect(body.textContent).toContain('Native same Context original')
  const text = document.createTreeWalker(body, NodeFilter.SHOW_TEXT).nextNode()!
  const range = document.createRange(); range.selectNodeContents(text)
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  const selected = selection.toString(); expect(selected.length).toBeGreaterThan(0)
  const before = h.counts()
  // 91 new user records place the prior boundary beyond the public Hook's
  // existing three pages of 30. Genuine FS observation drives revalidation.
  const rows = Array.from({ length: 91 }, (_, index) => ({ sessionId: `native-${SID}`, uuid: `incomplete-burst-${index}`, type: 'user',
    message: { role: 'user', content: `Actual native appended input ${index}` }, timestamp: new Date(NOW - HOUR / 4 + index).toISOString() }))
  await appendFile(join(h.directory, `${SID}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  await act(async () => vi.waitFor(() => {
    expect(events.some(event => event.kind === 'invalidated')).toBe(true)
    expect(reading?.windowIncomplete).toBe(true)
    expect(reading?.loading).toBe(false)
  }, { timeout: 3000, interval: 10 }))
  expect(reading?.windowFrozen).toBe(false)
  expect(reading?.error).toBeNull(); expect(reading?.observationError).toBeNull()
  expect(reading!.nativeHistoryPage!.items.find(item => item.id === original.id)).toBe(original)
  expect(reading!.nativeHistoryPage!.items.some(item => item.id === 'incomplete-burst-90')).toBe(true)
  expect(h.element.querySelector<HTMLElement>('.recent-focus')!.dataset.readingTrimmed).not.toBe('true')
  const coverage = h.element.querySelector<HTMLButtonElement>('[aria-label="Timeline meaning and coverage"]')!
  expect(coverage.textContent).toContain('Partial history')
  expect(coverage.title).toContain('outside this bounded window')
  const statuses = [...document.querySelectorAll('.recent-focus__input-reader [role="status"]')].map(node => node.textContent).join(' ')
  expect(statuses).toContain('Some latest input records are outside this bounded window')
  expect(document.querySelector('.recent-focus__message-body')).toBe(body)
  expect(selection.rangeCount).toBe(1); expect(selection.toString()).toBe(selected)
  expect(h.element.querySelectorAll('[data-message-id="native:claude:native-archived-0:native-kept"]')).toHaveLength(1)
  expect(h.element.querySelectorAll('.recent-focus__live')).toHaveLength(1)
  expect(observe).toHaveBeenCalledTimes(1)
  expect(h.counts()[0]).toBe(before[0]); expect(h.counts()[2]).toBe(before[2])
  expect(h.counts()[1]! - before[1]!).toBe(3)
  const kernel = (h.client as unknown as { kernel: Record<string, (...args: unknown[]) => unknown> }).kernel
  for (const name of ['start', 'input', 'resize', 'stop', 'attach', 'status']) expect(vi.mocked(kernel[name]!).mock.calls).toEqual([])
  expect(h.client.connect).not.toHaveBeenCalled(); expect(h.onSelect).not.toHaveBeenCalled()
})
