const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, createElement, useMemo } from 'react'
import { afterAll, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, projectAgentWorkHistory, type AgentTimelineItem, type AgentTimelineSnapshot } from '@agentmux/core'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { fixture, NOW, HOUR, BODY } from './fixtures/focus-history-public'
import { localRuntimeConnector } from './helpers/local-runtime-connector'
import { RuntimeController } from '../src/main/runtime-controller'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { deriveFocusProjectLanes } from '../src/renderer/src/lib/focus-project-lanes'
import { useAppStore, recoveryCandidateSession } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { SessionSnapshot } from '../src/shared/contracts'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false) })

const SID = 'archived-0', RUN = `not-controlled-${SID}`
const evidence: Record<string, unknown> = {}
afterAll(async () => {
  const directory = process.env.FOCUS_RESTART_EVIDENCE_DIR
  if (directory) { await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'mounted-observations.json'), JSON.stringify(evidence, null, 2) + '\n') }
})

function observed(id: string, at: number, state: 'working' | 'done', previousObservationId?: string, sid = SID): AgentTimelineItem {
  return { id, agentSessionId: sid, kind: 'lifecycle', source: 'acp', status: 'complete', title: 'Controlled durable observation',
    createdAt: at, updatedAt: at, activityState: { run: { runId: `not-controlled-${sid}` }, state, stateEnteredAt: at,
      ...(previousObservationId ? { previousObservationId } : {}) } }
}

function session(id = SID, hostId = 'private-host', runId = `not-controlled-${id}`): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { id, kind: 'agent', providerId: 'claude', executorId: 'private-claude', hostId,
    workspacePath: _hygiene_fixturePath("isolated-work-history"), label: 'Original retained Agent', createdAt: 1, updatedAt: NOW, agentSessionUpdatedAt: NOW,
    processState: 'running', status: { state: 'done', source: 'acp', observedAt: NOW - HOUR / 2 },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
    latestOutputBytes: 0, control: { kind: 'agent', hostId, agentSessionId: id, run: { runId } } }
}

type Harness = Awaited<ReturnType<typeof fixture>>
async function durable(count = 1, native = false) {
  const h = await fixture(native ? [{ id: 'kept-native', body: 'Original native input', at: NOW - HOUR }] : [], count, { native, retire: false })
  // Project artwork is outside this reading contract. The fixture's Main config deliberately has
  // no workspace catalog; avoid its unrelated unknown-workspace error replacing the read notice.
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  for (let index = 0; index < count; index++) {
    const sid = `archived-${index}`
    for (const item of [observed('original-working', NOW - HOUR, 'working', undefined, sid),
      observed('original-done', NOW - HOUR / 2, 'done', 'original-working', sid)]) {
      await h.store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item })
    }
  }
  const raw = await h.client.sessionTimeline(SID)
  useAppStore.setState(state => ({ sessions: [session()], timelines: {}, agentSteerQueues: {},
    agentComposerDrafts: { [SID]: 'Original unsent draft' }, mainSurface: 'agents',
    config: { ...state.config!, workspaces: [{ id: 'original-project', hostId: 'private-host', name: 'Original project', path: _hygiene_fixturePath("isolated-work-history"), kind: 'folder' }] } }))
  const selector = createFocusProjectionSelector()
  function Surface({ visible = true }: { visible?: boolean }) {
    const contexts = useAppStore(state => selector(state).contexts)
    const config = useAppStore(state => state.config)
    const lanes = useMemo(() => deriveFocusProjectLanes(contexts, config), [contexts, config])
    return createElement(RecentFocusTimeline, { visible, contexts, lanes, entries: [], currentSessionId: null, onSelect: h.onSelect })
  }
  const render = async (visible = true, key?: string) => act(async () => h.root.render(createElement(Surface, { visible, ...(key ? { key } : {}) })))
  const global = async (visible = true) => act(async () => h.root.render(<GlobalFocusSurface visible={visible} workspaceOpen={false} onSelectContext={h.onSelect} />))
  const bands = () => [...h.element.querySelectorAll<HTMLElement>('[data-work-end]')]
  const intervals = () => bands().map(node => [node.dataset.runId, Number(node.dataset.workingEnteredAt), Number(node.dataset.workingThrough), node.dataset.workEnd])
  return { ...h, raw, render, global, bands, intervals }
}

async function freshSnapshot(h: Harness) {
  const store = new AgentMuxFileAgentSessionStore(join(h.directory, 'sessions.json')), client = new AgentMuxClient({ store })
  await (client as unknown as { registry: { load(hostId: string): Promise<unknown> } }).registry.load('private-host')
  // Only Runtime transport has an empty subject projection. Durable storage, public timeline,
  // Main snapshot, original recovery candidate and mounted Focus remain production consumers.
  vi.spyOn(client, 'connect').mockResolvedValue(undefined)
  vi.spyOn(client, 'runtimeProjection').mockResolvedValue({ hostId: 'private-host', subjects: [] })
  vi.spyOn(client, 'runtimeIdentity').mockReturnValue({ ownership: 'verified' } as never)
  Object.assign(client, { runtimeOwnerIdentity: () => ({ runtimeId: 'isolated-transport-owner', availability: 'connected' }) })
  const controller = new RuntimeController(store, localRuntimeConnector)
  controller.commit({ hosts: [{ id: 'private-host', config: { id: 'private-host', kind: 'ssh', hostname: 'unused.invalid', label: 'Private' }, client,
    executionHost: { kind: 'local', dispose: vi.fn() } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const snapshot = await controller.snapshot(useAppStore.getState().config!)
  await client.dispose()
  return snapshot
}

function delayed(h: Harness) {
  let resolve!: (snapshot: AgentTimelineSnapshot) => void
  h.calls.timeline.mockImplementation(() => new Promise<AgentTimelineSnapshot>(done => { resolve = done }))
  return { resolve: (snapshot: AgentTimelineSnapshot) => resolve(snapshot) }
}

it('cold FileStore/Main snapshot restores the original work interval through the visible production Context, without an explicit read', async () => {
  const h = await durable(), snapshot = await freshSnapshot(h)
  expect(snapshot.sessions).toEqual([]); expect(snapshot.timelines).toEqual({})
  const candidate = snapshot.recoveryCandidates.find(item => item.agentSessionId === SID)!
  expect(candidate).toBeDefined()
  const pending = recoveryCandidateSession(candidate, { kind: 'pending', detail: 'Original unavailable Run and durable Session retained.' })
  useAppStore.setState({ sessions: [pending], timelines: snapshot.timelines, recoveryCandidates: snapshot.recoveryCandidates })
  const queue = [{ operationId: 'unsent-original', runId: RUN, text: 'Original queued intent', status: 'queued' as const }]
  const flush = vi.fn().mockResolvedValue(undefined)
  useAppStore.setState({ agentSteerQueues: { [SID]: queue }, flushAgentSteerQueue: flush })
  await h.render()
  await h.wait(() => expect(h.bands()).toHaveLength(1))
  expect(h.intervals()).toEqual([[RUN, NOW - HOUR, NOW - HOUR / 2, 'state-change']])
  expect(h.calls.timeline).toHaveBeenCalledExactlyOnceWith(pending.control)
  expect(useAppStore.getState().agentSteerQueues[SID]).toBe(queue); expect(flush).not.toHaveBeenCalled()
  expect(h.onSelect).not.toHaveBeenCalled(); expect(useAppStore.getState().agentComposerDrafts[SID]).toBe('Original unsent draft')
  evidence.cold = { restoredIntervals: projectAgentWorkHistory(h.raw.items).segments, ids: h.raw.items.map(item => item.id),
    beforeTimelineKeys: Object.keys(snapshot.timelines), recoveryCandidateSID: candidate.agentSessionId, bands: h.intervals(),
    observationBeforeQueue: queue, observationAfterQueue: useAppStore.getState().agentSteerQueues[SID], observationSendCalls: flush.mock.calls.length }
  evidence.visualScene = { now: NOW, timeline: h.raw, session: pending, config: useAppStore.getState().config,
    agentComposerDrafts: useAppStore.getState().agentComposerDrafts, originalIntervals: h.intervals(),
    boundary: 'Actual private FileStore/public Core/Main snapshot input; private Renderer transport replay, not vendor Writer, user App or Runtime restart.' }
})

it('Global actual host visibility reaches the timeline: hidden reads zero, reveal restores once, unrelated output stays zero', async () => {
  const h = await durable()
  await h.global(false)
  const hidden = h.counts(); expect(h.calls.timeline).not.toHaveBeenCalled()
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, unrelated: { agentSessionId: 'unrelated', revision: 1, items: [] } } })))
  expect(h.counts()).toEqual(hidden)
  await h.global(true); await h.wait(() => expect(h.bands()).toHaveLength(1))
  expect(h.calls.timeline).toHaveBeenCalledTimes(1)
  expect(h.calls.timeline.mock.calls[0]?.[0].agentSessionId).toBe(SID)
  evidence.global = { hiddenReads: hidden, afterRevealReads: h.counts(), originalIntervals: h.intervals() }
})

it('an existing canonical empty snapshot is known and does not trigger an automatic second read', async () => {
  const h = await durable()
  useAppStore.setState({ timelines: { [SID]: { agentSessionId: SID, revision: 1, items: [] } } })
  await h.render(); expect(h.calls.timeline).not.toHaveBeenCalled()
})

it('a top-level collapsed timeline postpones the first cold read until explicitly shown', async () => {
  const h = await durable()
  await h.render(false); await h.click('Collapse focus history'); await h.render(true)
  const before = h.counts(); expect(h.calls.timeline).not.toHaveBeenCalled()
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, unrelated: { agentSessionId: 'unrelated', revision: 1, items: [] } } })))
  expect(h.counts()).toEqual(before)
  evidence.collapsed = { beforeReads: before, afterReads: h.counts(), calls: {} }
  await h.click('Show focus history'); await h.wait(() => expect(h.bands()).toHaveLength(1))
  expect(h.calls.timeline).toHaveBeenCalledTimes(1)
})

it('a collapsed project does not read missing facts until that exact project is expanded', async () => {
  const h = await durable()
  useAppStore.setState({ timelines: { [SID]: h.raw } })
  await h.render()
  await h.wait(() => expect(h.bands()).toHaveLength(1))
  await h.click('Collapse project Original project')
  await act(async () => useAppStore.setState({ timelines: {} }))
  expect(h.calls.timeline).not.toHaveBeenCalled()
  await h.click('Expand project Original project'); await h.wait(() => expect(h.calls.timeline).toHaveBeenCalledTimes(1))
  await h.wait(() => expect(h.bands()).toHaveLength(1))
})

it('a hidden document does not request the missing snapshot', async () => {
  const h = await durable()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await h.render(); expect(h.calls.timeline).not.toHaveBeenCalled()
})

it('only the exact current Agent Context is a recovery consumer, without reading unrelated stored Sessions', async () => {
  const h = await durable(2)
  await h.render(); await h.wait(() => expect(h.bands()).toHaveLength(1))
  expect(h.calls.timeline.mock.calls.map(call => call[0].agentSessionId)).toEqual([SID])
})

it.each(['wrong-Host', 'non-Agent'] as const)('a %s Context cannot trigger an automatic history read', async kind => {
  const h = await durable(), original = createFocusProjectionSelector()(useAppStore.getState()).contexts[0]!
  const context = kind === 'wrong-Host' ? { ...original, hostId: 'unconfirmed-context-host' } : { ...original, kind: 'terminal' as const }
  await act(async () => h.root.render(createElement(RecentFocusTimeline, { entries: [], contexts: [context], currentSessionId: null, onSelect: h.onSelect })))
  expect(h.calls.timeline).not.toHaveBeenCalled()
})

it('observation-only resync keeps both delivered and unsent queue entries untouched', async () => {
  const h = await durable()
  const head = { operationId: 'delivered-head', runId: RUN, text: 'Original delivered intent', status: 'queued' as const }, tail = { ...head, operationId: 'tail' }
  await h.store.applyTimelineMutation({ type: 'append', agentSessionId: SID, item: { id: 'prompt:delivered-head', agentSessionId: SID,
    kind: 'user_message', source: 'user', status: 'complete', title: 'Prompt', content: head.text, createdAt: NOW, updatedAt: NOW } })
  const queue = [head, tail], flush = vi.fn().mockResolvedValue(undefined)
  useAppStore.setState({ agentSteerQueues: { [SID]: queue }, flushAgentSteerQueue: flush })
  await useAppStore.getState().resyncTimeline(SID, { observationOnly: true })
  expect(useAppStore.getState().agentSteerQueues[SID]).toBe(queue); expect(flush).not.toHaveBeenCalled()
})

it('same-Host parallel observers share one read, and a concurrent normal gap retains its queue-processing intent', async () => {
  const h = await durable(), pending = delayed(h)
  const head = { operationId: 'head', runId: RUN, text: 'Original delivered input', status: 'queued' as const }, tail = { ...head, operationId: 'tail' }
  const snapshot = { ...h.raw, revision: h.raw.revision + 1, items: [...h.raw.items, { id: 'prompt:head', agentSessionId: SID,
    kind: 'user_message' as const, source: 'user' as const, status: 'complete' as const, title: 'Prompt', content: head.text, createdAt: NOW, updatedAt: NOW }] }
  const flush = vi.fn().mockResolvedValue(undefined)
  useAppStore.setState({ agentSteerQueues: { [SID]: [head, tail] }, flushAgentSteerQueue: flush })
  const observation = useAppStore.getState().resyncTimeline(SID, { observationOnly: true })
  const secondObservation = useAppStore.getState().resyncTimeline(SID, { observationOnly: true })
  expect(h.calls.timeline).toHaveBeenCalledTimes(1)
  const normal = useAppStore.getState().resyncTimeline(SID)
  h.calls.timeline.mockResolvedValue(snapshot); pending.resolve(snapshot)
  await Promise.all([observation, secondObservation, normal])
  expect(h.calls.timeline).toHaveBeenCalledTimes(2)
  expect(useAppStore.getState().agentSteerQueues[SID]).toEqual([tail]); expect(flush).toHaveBeenCalledExactlyOnceWith(SID)
  evidence.concurrentNormalGapIntentPreserved = true
})

it.each(['rejected', 'wrong-SID'] as const)('a %s first observation does not consume an already queued normal gap request', async cause => {
  const h = await durable(2)
  let reject!: (error: Error) => void, resolve!: (snapshot: AgentTimelineSnapshot) => void
  h.calls.timeline.mockImplementationOnce(() => new Promise<AgentTimelineSnapshot>((done, fail) => { resolve = done; reject = fail })).mockResolvedValue(h.raw)
  const observation = useAppStore.getState().resyncTimeline(SID, { observationOnly: true })
  const normal = useAppStore.getState().resyncTimeline(SID)
  if (cause === 'rejected') reject(new Error('Controlled first original read failed'))
  else resolve(await h.client.sessionTimeline('archived-1'))
  await Promise.all([observation, normal])
  expect(h.calls.timeline).toHaveBeenCalledTimes(2)
  expect(useAppStore.getState().timelines[SID]).toEqual(h.raw)
  expect(useAppStore.getState().timelines['archived-1']).toBeUndefined()
})

it('a failed old-Host observation still services the concurrently requested new-Host read', async () => {
  const h = await durable()
  let reject!: (error: Error) => void
  h.calls.timeline.mockImplementationOnce(() => new Promise<AgentTimelineSnapshot>((_done, fail) => { reject = fail })).mockResolvedValue(h.raw)
  const oldRead = useAppStore.getState().resyncTimeline(SID, { observationOnly: true })
  useAppStore.setState({ sessions: [session(SID, 'different-current-host')] })
  const currentRead = useAppStore.getState().resyncTimeline(SID, { observationOnly: true })
  reject(new Error('Controlled old Host read failed'))
  await Promise.all([oldRead, currentRead])
  expect(h.calls.timeline.mock.calls.map(call => call[0].hostId)).toEqual(['private-host', 'different-current-host'])
  expect(useAppStore.getState().timelines[SID]).toEqual(h.raw)
})

it('a response for another existing SID is refused without contaminating either timeline', async () => {
  const h = await durable(2), wrong = await h.client.sessionTimeline('archived-1')
  useAppStore.setState({ sessions: [session(), session('archived-1')] })
  h.calls.timeline.mockResolvedValue(wrong)
  await useAppStore.getState().resyncTimeline(SID, { observationOnly: true })
  expect(useAppStore.getState().timelines).toEqual({})
  expect(useAppStore.getState().errorNoticeContext?.summary).toContain('Work history could not be read')
})

it('an old-Host late response cannot land in the current same-SID Host, and the new Host can subsequently read', async () => {
  const h = await durable(), pending = delayed(h)
  const read = useAppStore.getState().resyncTimeline(SID, { observationOnly: true })
  useAppStore.setState({ sessions: [session(SID, 'different-current-host')] })
  pending.resolve(h.raw); await read
  expect(useAppStore.getState().timelines[SID]).toBeUndefined()
  h.calls.timeline.mockResolvedValue(h.raw)
  await useAppStore.getState().resyncTimeline(SID, { observationOnly: true })
  expect(h.calls.timeline.mock.calls[1]?.[0].hostId).toBe('different-current-host')
  expect(useAppStore.getState().timelines[SID]).toEqual(h.raw)
  evidence.hostAndSessionGuardsPassed = true
})

it('a same-SID same-Host Run change retains the valid original durable interval, without extending it to Now', async () => {
  const h = await durable(), pending = delayed(h)
  const read = useAppStore.getState().resyncTimeline(SID, { observationOnly: true })
  useAppStore.setState({ sessions: [session(SID, 'private-host', 'new-current-run')] })
  pending.resolve(h.raw); await read
  expect(projectAgentWorkHistory(useAppStore.getState().timelines[SID]!.items).segments).toMatchObject([
    { run: { runId: RUN }, startAt: NOW - HOUR, endAt: NOW - HOUR / 2, end: 'state-change' }])
})

it('a late read never recreates a removed SID or regresses newer canonical history', async () => {
  const h = await durable(), pending = delayed(h)
  const read = useAppStore.getState().resyncTimeline(SID, { observationOnly: true })
  useAppStore.setState({ sessions: [] }); pending.resolve(h.raw); await read
  expect(useAppStore.getState().timelines[SID]).toBeUndefined()
  useAppStore.setState({ sessions: [session()] })
  const next = delayed(h), second = useAppStore.getState().resyncTimeline(SID, { observationOnly: true }), newer = { ...h.raw, revision: h.raw.revision + 1 }
  useAppStore.setState({ timelines: { [SID]: newer } }); next.resolve(h.raw); await second
  expect(useAppStore.getState().timelines[SID]).toBe(newer)
})

it('a failed automatic read is reported once, retains the original Session, and does not retry on unrelated updates', async () => {
  const h = await durable()
  h.calls.timeline.mockRejectedValue(new Error('Controlled original timeline read unavailable'))
  await h.render()
  evidence.failedAutomatic = { reads: h.counts(), error: useAppStore.getState().error, notice: useAppStore.getState().errorNoticeContext,
    contexts: createFocusProjectionSelector()(useAppStore.getState()).contexts.map(row => ({ id: row.id, kind: row.kind, hostId: row.hostId })) }
  await h.wait(() => expect(useAppStore.getState().errorNoticeContext?.summary).toContain('Work history could not be read'))
  expect(h.calls.timeline).toHaveBeenCalledTimes(1)
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, unrelated: { agentSessionId: 'unrelated', revision: 1, items: [] } } })))
  expect(h.calls.timeline).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().sessions[0]?.id).toBe(SID)
  expect(useAppStore.getState().agentComposerDrafts[SID]).toBe('Original unsent draft')
  expect(useAppStore.getState().errorNoticeContext?.kind).toBe('indeterminate')
})

it('the original Conversation reader Refresh source action can retry a failed missing canonical timeline', async () => {
  const h = await durable(1, true)
  h.calls.timeline.mockRejectedValue(new Error('Controlled original read temporarily unavailable'))
  await h.render(); await h.wait(() => expect(useAppStore.getState().errorNoticeContext?.summary).toContain('Refresh source'))
  const resync = vi.spyOn(useAppStore.getState(), 'resyncTimeline')
  h.calls.timeline.mockRestore()
  const reads = vi.spyOn(api.sessions, 'timeline')
  await h.click('View conversation records')
  await h.wait(() => expect(document.querySelector('[aria-label="Conversation records Context"] option[value="'+SID+'"]')).not.toBeNull())
  await act(async () => {
    const select = document.querySelector<HTMLSelectElement>('[aria-label="Conversation records Context"]')!
    select.value = SID; select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await h.wait(() => expect([...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Refresh source')?.disabled).toBe(false))
  await h.button('Refresh source'); await h.wait(() => expect(useAppStore.getState().timelines[SID]).toBeDefined())
  expect(resync).toHaveBeenCalledWith(SID, { observationOnly: true })
  expect(reads.mock.calls.some(call => call[0].agentSessionId === SID)).toBe(true)
  expect(useAppStore.getState().agentComposerDrafts[SID]).toBe('Original unsent draft')
  expect(h.onSelect).not.toHaveBeenCalled()
})

it('read-only recovery preserves the pinned original Reader DOM, Range, scroll, draft and a later user focus', async () => {
  const h = await durable(1, true)
  useAppStore.setState({ timelines: { [SID]: h.raw } })
  await h.render(); await h.click('View conversation records')
  await h.wait(() => expect(document.querySelector('[aria-label="Conversation records Context"] option[value="'+SID+'"]')).not.toBeNull())
  await act(async () => {
    const select = document.querySelector<HTMLSelectElement>('[aria-label="Conversation records Context"]')!
    select.value = SID; select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await h.wait(() => expect(h.inputs().some(node => node.textContent?.includes(BODY))).toBe(true))
  await act(async () => h.inputs().find(node => node.textContent?.includes(BODY))!.click())
  await h.wait(() => expect(document.querySelector('.recent-focus__message-body')).not.toBeNull())
  const body = document.querySelector<HTMLElement>('.recent-focus__message-body')!
  const text = document.createTreeWalker(body, NodeFilter.SHOW_TEXT).nextNode()!, range = document.createRange()
  range.selectNodeContents(text)
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  const selected = selection.toString(); expect(selected.length).toBeGreaterThan(0)
  const beforeText = body.textContent!, beforeDraft = useAppStore.getState().agentComposerDrafts[SID]!
  body.scrollTop = 23
  const later = document.createElement('button'); later.textContent = 'Later user control'; h.element.append(later); later.focus()
  const pending = delayed(h), read = useAppStore.getState().resyncTimeline(SID, { observationOnly: true })
  await act(async () => { pending.resolve({ ...h.raw, revision: h.raw.revision + 1 }); await read })
  expect(document.querySelector('.recent-focus__message-body')).toBe(body)
  expect(document.createTreeWalker(body, NodeFilter.SHOW_TEXT).nextNode()).toBe(text)
  expect(selection.getRangeAt(0)).toBe(range); expect(selection.toString()).toBe(selected)
  expect(body.scrollTop).toBe(23); expect(body.textContent).toBe(beforeText)
  expect(useAppStore.getState().agentComposerDrafts[SID]).toBe(beforeDraft); expect(document.activeElement).toBe(later)
  const before = h.counts()
  await act(async () => h.bands()[0]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)) })
  expect(h.counts()).toEqual(before)
  const hoverReads = h.counts()
  await h.render(false)
  const hiddenReads = h.counts()
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, unrelated: { agentSessionId: 'unrelated', revision: 1, items: [] } } })))
  expect(h.counts()).toEqual(hiddenReads)
  expect(document.querySelector('.recent-focus__message-body')).toBe(body); expect(selection.getRangeAt(0)).toBe(range)
  expect(body.scrollTop).toBe(23); expect(document.activeElement).toBe(later)
  evidence.hidden = { beforeReads: hiddenReads, afterReads: h.counts(), calls: {} }
  evidence.reading = { sameNode: true, sameTextNode: true, sameRange: true, beforeScroll: 23, scroll: body.scrollTop,
    beforeText, text: body.textContent, beforeDraft, draft: useAppStore.getState().agentComposerDrafts[SID], laterFocusPreserved: true,
    hover: { beforeReads: before, afterReads: hoverReads, calls: {} } }
})
