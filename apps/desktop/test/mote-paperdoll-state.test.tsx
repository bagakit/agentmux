// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTimelineItem, RuntimeEvent, SessionSnapshot } from '../src/shared/contracts'
import { DEFAULT_MOTE_FACE } from '../src/shared/mote-avatars'
import { SpaceObjectIcon } from '../src/renderer/src/components/SpaceObjectIcon'
import { api } from '../src/renderer/src/lib/api'
import { prepareRendererUpdate, useAppStore } from '../src/renderer/src/store'
import { reduceTimelineSnapshot } from '../src/renderer/src/lib/session-state'
import { topicSpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultAgent, defaultTab, executionAgent, moteConfig, moteTopics, quietMoteId, savedMoteKey, scratchWorkspace } from './fixtures/mote-workface'
import { PMO_TEAMS_TOPIC_ID } from '../src/shared/scratch-topics'
const key = topicSpaceIconTarget(scratchWorkspace, moteTopics[0]!).key
let app: MoteAppFixture, dispose: (() => void) | undefined
let intersections: Array<{ node: Element; emit(visible: boolean): void }> = [], mediaListeners: Array<() => void> = [], reduce = false
beforeEach(async () => {
  intersections = []; mediaListeners = []; reduce = false
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(Date, 'now').mockReturnValue(200)
  vi.stubGlobal('IntersectionObserver', class {
    node?: Element
    constructor(private readonly listener: IntersectionObserverCallback) {}
    observe(node: Element) { this.node = node; const emit = (visible: boolean) => this.listener([{ target: node, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as IntersectionObserverEntry], this as unknown as IntersectionObserver); intersections.push({ node, emit }); emit(true) }
    unobserve(node: Element) { intersections = intersections.filter(row => row.node !== node) }
    disconnect() { intersections = intersections.filter(row => row.node !== this.node) }
  })
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ media: query, get matches() { return reduce }, addEventListener(_name: string, callback: () => void) { mediaListeners.push(callback) }, removeEventListener(_name: string, callback: () => void) { mediaListeners = mediaListeners.filter(one => one !== callback) } } as MediaQueryList))
  vi.spyOn(api.config, 'get').mockResolvedValue(moteConfig)
  vi.spyOn(api.providers, 'list').mockResolvedValue([]); vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] }); vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
  dispose = await useAppStore.getState().initialize(); await prepareRendererUpdate(); app = createMoteApp()
  useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === defaultAgent.id ? { ...session, semanticStatus: { state: 'working', source: 'native-hook', observedAt: 100, stateEnteredAt: 100 }, status: { state: 'working', source: 'native-hook', observedAt: 100 } } : session) }))
  await useAppStore.getState().setSpaceObjectIcon(key, DEFAULT_MOTE_FACE)
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id }))
})
afterEach(async () => { await app.dispose(); dispose?.(); dispose = undefined; vi.unstubAllGlobals() })
function face() { const node = app.entry().querySelector<HTMLElement>('[data-mote-expression]'); expect(node).not.toBeNull(); return node! }
async function event(value: RuntimeEvent) { await act(async () => useAppStore.getState().applyEvent(value)); await settleMoteApp() }
function tool(id: string, time = 110, sessionId = defaultAgent.id): AgentTimelineItem {
  return { id, agentSessionId: sessionId, kind: 'tool_call', source: 'native-hook', status: 'streaming', createdAt: time, updatedAt: time, title: 'Use tool', toolName: 'read' }
}
function timeline(mutation: Extract<RuntimeEvent['event'], { type: 'agent-timeline' }>['mutation'], options: { runId?: string; observedAt?: number; source?: 'native-hook' | 'acp' | 'run-process'; host?: string; sessionId?: string; omitRun?: boolean } = {}): RuntimeEvent {
  const sessionId = options.sessionId ?? defaultAgent.id
  return { type: 'core', hostId: options.host ?? 'local', event: { type: 'agent-timeline', agentSessionId: sessionId,
    revision: (useAppStore.getState().timelines[sessionId]?.revision ?? 0) + 1, mutation,
    evidence: { source: options.source ?? 'native-hook', observedAt: options.observedAt ?? 110, ...(options.omitRun ? {} : { run: { runId: options.runId ?? 'original-run-' + sessionId } }) } } }
}
async function start(id = 'tool-now', time = 110) { await event(timeline({ type: 'append', agentSessionId: defaultAgent.id, item: tool(id, time) }, { observedAt: time })) }
it('actual applyEvent admits the exact current tool and completion/failed stop it without changing persistent face, draft or Run', async () => {
  await app.mount(); const before = useAppStore.getState()
  expect(face().dataset.moteExpression).toBe('thinking'); expect(face().dataset.moteMotion).toBe('on')
  await start(); expect(face().dataset.moteExpression).toBe('tool')
  expect(useAppStore.getState().timelines[defaultAgent.id]!.liveTool).toEqual({ itemId: 'tool-now', hostId: 'local', runId: defaultAgent.control.run.runId, epoch: 100, observedAt: 110, startedAt: 110 })
  await event(timeline({ type: 'update', agentSessionId: defaultAgent.id, itemId: 'tool-now', status: 'complete', updatedAt: 120 }, { observedAt: 120 }))
  expect(face().dataset.moteExpression).toBe('thinking'); expect(useAppStore.getState().timelines[defaultAgent.id]!.liveTool).toBeUndefined()
  await start('tool-fails', 130)
  await event(timeline({ type: 'upsert', agentSessionId: defaultAgent.id, item: { ...tool('tool-fails', 130), status: 'failed', updatedAt: 140 } }, { observedAt: 140 }))
  expect(face().dataset.moteExpression).toBe('thinking')
  expect(useAppStore.getState().timelines[defaultAgent.id]!.items.map(item => item.status)).toEqual(['complete', 'failed'])
  expect(useAppStore.getState().spaceObjectIcons[key]).toEqual(DEFAULT_MOTE_FACE)
  expect(useAppStore.getState().agentComposerDrafts).toEqual(before.agentComposerDrafts)
  expect(useAppStore.getState().sessions.map(one => one.control.run)).toEqual(before.sessions.map(one => one.control.run))
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})
it('old Run, old epoch, missing evidence and historical streaming never animate; late old-Run same-item completion cannot stop the current tool', async () => {
  await app.mount()
  const old = tool('historical', 10)
  await act(async () => useAppStore.setState(state => reduceTimelineSnapshot(state, { agentSessionId: defaultAgent.id, revision: 1, items: [old] })))
  expect(face().dataset.moteExpression).toBe('thinking')
  await event(timeline({ type: 'append', agentSessionId: defaultAgent.id, item: tool('old-run') }, { runId: 'retired-run' }))
  await event(timeline({ type: 'append', agentSessionId: defaultAgent.id, item: tool('old-round', 10) }, { observedAt: 150 }))
  await event(timeline({ type: 'append', agentSessionId: defaultAgent.id, item: tool('missing') }, { omitRun: true }))
  await event(timeline({ type: 'append', agentSessionId: defaultAgent.id, item: tool('non-semantic') }, { source: 'run-process' }))
  expect(face().dataset.moteExpression).toBe('thinking')
  await start('reused', 160); const admitted = useAppStore.getState().timelines[defaultAgent.id]!.liveTool
  await event(timeline({ type: 'upsert', agentSessionId: defaultAgent.id, item: { ...tool('reused', 110), status: 'complete', updatedAt: 170 } }, { runId: 'retired-run', observedAt: 170 }))
  expect(face().dataset.moteExpression).toBe('tool'); expect(useAppStore.getState().timelines[defaultAgent.id]!.liveTool).toBe(admitted)
  await event(timeline({ type: 'upsert', agentSessionId: defaultAgent.id, item: { ...tool('reused', 10), status: 'failed', updatedAt: 20 } }, { observedAt: 180 }))
  expect(face().dataset.moteExpression).toBe('tool')
  // A previous invocation in this same semantic epoch still cannot complete the later admitted start.
  await event(timeline({ type: 'upsert', agentSessionId: defaultAgent.id, item: { ...tool('reused', 110), status: 'complete', updatedAt: 190 } }, { observedAt: 190 }))
  expect(face().dataset.moteExpression).toBe('tool')
  const retained = useAppStore.getState().timelines[defaultAgent.id]!
  expect(retained.items.map(item => item.id)).toEqual(['historical', 'old-run', 'old-round', 'missing', 'non-semantic', 'reused'])
  await act(async () => useAppStore.setState(state => reduceTimelineSnapshot(state, { agentSessionId: defaultAgent.id, revision: retained.revision, items: retained.items })))
  expect(face().dataset.moteExpression).toBe('thinking'); expect(useAppStore.getState().timelines[defaultAgent.id]!.liveTool).toBeUndefined()
})
it.each(['done', 'waiting', 'blocked', 'error', 'unknown'] as const)('accepted %s status clears the admitted tool and keeps its exact original status', async state => {
  await app.mount(); await start()
  await event({ type: 'core', hostId: 'local', event: { type: 'agent-status', agentSessionId: defaultAgent.id, state, evidence: { source: 'native-hook', run: defaultAgent.control.run, observedAt: 200 } } })
  expect(face().dataset.moteExpression).toBe(state === 'done' ? 'idle' : state === 'error' ? 'error' : state === 'unknown' ? 'unknown' : 'waiting')
  expect(useAppStore.getState().timelines[defaultAgent.id]!.liveTool).toBeUndefined()
  await event({ type: 'core', hostId: 'local', event: { type: 'agent-status', agentSessionId: defaultAgent.id, state: 'working', evidence: { source: 'native-hook', run: defaultAgent.control.run, observedAt: 210 } } })
  expect(face().dataset.moteExpression).toBe('thinking')
})
it('disconnection stops motion without erasing history or blocking the original input', async () => {
  await app.mount(); await start()
  const input = app.panel().querySelector<HTMLElement>('[contenteditable="true"]')
  await event({ type: 'core', hostId: 'local', event: { type: 'connection-state', state: 'lost', evidence: { source: 'run-process', observedAt: 200 } } })
  expect(face().dataset.moteExpression).toBe('unknown'); expect(face().dataset.moteMotion).toBe('off')
  expect(useAppStore.getState().timelines[defaultAgent.id]!.items.map(item => item.id)).toEqual(['tool-now'])
  expect(useAppStore.getState().timelines[defaultAgent.id]!.liveTool).toBeUndefined()
  expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  expect(input?.isConnected).toBe(true); expect(app.stop).not.toHaveBeenCalled()
})
it('the original agent-session owner clears live provenance on a new working epoch and a new Run; a foreign host cannot replace it', async () => {
  await app.mount(); await start(); const before = useAppStore.getState().timelines[defaultAgent.id]
  await event(timeline({ type: 'upsert', agentSessionId: defaultAgent.id, item: tool('foreign-host', 120) }, { host: 'another-host', observedAt: 120 }))
  expect(useAppStore.getState().timelines[defaultAgent.id]).toBe(before); expect(face().dataset.moteExpression).toBe('tool')
  const transition = (epoch: number, runId = defaultAgent.control.run.runId): RuntimeEvent => ({ type: 'core', hostId: 'local', event: { type: 'agent-session', session: {
    kind: 'agent', agentSessionId: defaultAgent.id, providerId: 'fixture', executorId: 'fixture', hostId: 'local', workspacePath: defaultAgent.workspacePath,
    run: { runId }, retiredRuns: runId === defaultAgent.control.run.runId ? [] : [defaultAgent.control.run], createdAt: 1, updatedAt: epoch,
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: epoch, stateEnteredAt: epoch }
  } } })
  await event(transition(150)); expect(face().dataset.moteExpression).toBe('thinking')
  expect(useAppStore.getState().timelines[defaultAgent.id]!.liveTool).toBeUndefined()
  await start('next-epoch', 160); expect(face().dataset.moteExpression).toBe('tool')
  await event(transition(180, 'new-run')); expect(face().dataset.moteExpression).toBe('thinking')
  expect(useAppStore.getState().timelines[defaultAgent.id]!.liveTool).toBeUndefined()
  expect(useAppStore.getState().timelines[defaultAgent.id]!.items.map(item => item.id)).toEqual(['tool-now', 'next-epoch'])
})
it('a real current completion revision gap removes only unconfirmed live expression; old-Run gap cannot stop the current tool', async () => {
  await app.mount(); await start()
  let repair!: (value: { agentSessionId: string; revision: number; items: AgentTimelineItem[] }) => void
  const before = useAppStore.getState().timelines[defaultAgent.id]!
  const repaired = { agentSessionId: defaultAgent.id, revision: before.revision + 5, items: [{ ...before.items[0]!, status: 'complete' as const, updatedAt: 140 }] }
  vi.spyOn(api.sessions, 'timeline').mockResolvedValue(repaired).mockImplementationOnce(() => new Promise(resolve => { repair = resolve }))
  const completion = { type: 'update' as const, agentSessionId: defaultAgent.id, itemId: 'tool-now', status: 'complete' as const, updatedAt: 130 }
  const gap = timeline(completion, { observedAt: 130, runId: 'retired-run' })
  if (gap.event.type !== 'agent-timeline') throw new Error('Fixture has a nonempty original timeline event')
  gap.event.revision += 4
  await event(gap); expect(face().dataset.moteExpression).toBe('tool')
  expect(useAppStore.getState().timelines[defaultAgent.id]).toBe(before)
  const current = timeline(completion, { observedAt: 140 })
  if (current.event.type !== 'agent-timeline') throw new Error('Fixture has a nonempty original timeline event')
  current.event.revision += 4
  await event(current); expect(face().dataset.moteExpression).toBe('thinking')
  expect(useAppStore.getState().timelines[defaultAgent.id]!.items).toBe(before.items)
  expect(useAppStore.getState().timelines[defaultAgent.id]!.liveTool).toBeUndefined()
  expect(useAppStore.getState().sessions.find(one => one.id === defaultAgent.id)?.status.state).toBe('working')
  expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  expect(app.stop).not.toHaveBeenCalled()
  await act(async () => repair(repaired)); await settleMoteApp()
})
it('a current history revision gap may conceal tool completion; foreign, old-Run and old-epoch gaps retain the exact current tool', async () => {
  await app.mount(); await start()
  let repair!: (value: { agentSessionId: string; revision: number; items: AgentTimelineItem[] }) => void
  const before = useAppStore.getState(), original = before.timelines[defaultAgent.id]!
  const repaired = { agentSessionId: defaultAgent.id, revision: original.revision + 5, items: original.items }
  vi.spyOn(api.sessions, 'timeline').mockResolvedValue(repaired).mockImplementationOnce(() => new Promise(resolve => { repair = resolve }))
  const rows: Array<{ host?: string; runId?: string; observedAt?: number; createdAt?: number }> =
    [{ host: 'foreign-host' }, { runId: 'retired-run' }, { observedAt: 90 }, { createdAt: 90 }]
  expect(rows).toHaveLength(4)
  for (const options of rows) {
    const { createdAt = 130, ...evidence } = options
    const gap = timeline({ type: 'append', agentSessionId: defaultAgent.id, item: { ...tool('observed-history', createdAt), updatedAt: 140, kind: 'assistant_message' } }, { observedAt: 140, ...evidence })
    if (gap.event.type !== 'agent-timeline') throw new Error('Fixture has an original nonempty timeline event')
    gap.event.revision += 4
    await event(gap); expect(face().dataset.moteExpression).toBe('tool')
    expect(useAppStore.getState().timelines[defaultAgent.id]).toBe(original)
  }
  const current = timeline({ type: 'append', agentSessionId: defaultAgent.id, item: { ...tool('current-history', 140), kind: 'assistant_message' } }, { observedAt: 140 })
  if (current.event.type !== 'agent-timeline') throw new Error('Fixture has an original nonempty timeline event')
  current.event.revision += 4
  await event(current); expect(face().dataset.moteExpression).toBe('thinking')
  const after = useAppStore.getState()
  expect(after.timelines[defaultAgent.id]!.items).toBe(original.items)
  expect(after.timelines[defaultAgent.id]!.revision).toBe(original.revision)
  expect(after.timelines[defaultAgent.id]!.liveTool).toBeUndefined()
  expect(after.sessions).toBe(before.sessions)
  expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(after.sessions.find(one => one.id === defaultAgent.id)?.status.state).toBe('working')
  expect(app.stop).not.toHaveBeenCalled()
  await act(async () => repair(repaired)); await settleMoteApp()
  expect(face().dataset.moteExpression).toBe('thinking')
})
it('confirmed launcher sleeps, retained missing Agent/unknown do not; starting and stopped are distinct', async () => {
  await app.mount()
  await moteClick(app.panel().querySelector<HTMLElement>(`[data-mote-topic-id="${quietMoteId}"]`)!)
  expect(face().dataset.moteExpression).toBe('sleep')
  await moteClick(app.panel().querySelector<HTMLElement>(`[data-mote-topic-id="${PMO_TEAMS_TOPIC_ID}"]`)!)
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.filter(one => one.id !== defaultAgent.id) })))
  expect(face().dataset.moteExpression).toBe('unknown')
  for (const [state, expression] of [['starting', 'starting'], ['running', 'unknown'], ['exited', 'stopped']] as const) {
    await act(async () => useAppStore.setState(stateNow => ({ sessions: [...stateNow.sessions.filter(one => one.id !== defaultAgent.id), { ...defaultAgent, status: { state, source: 'run-process', observedAt: 200 } }] })))
    expect(face().dataset.moteExpression).toBe(expression)
  }
})
it('offscreen, hidden, document-hidden and reduced-motion stop real native-animation admission; unrelated events do not render the face', async () => {
  let renders = 0
  const node = (visible: boolean) => <Profiler id="isolated-face" onRender={() => renders++}><SpaceObjectIcon kind="mote" name="Mote" manualIcon={DEFAULT_MOTE_FACE} moteSessionId={defaultAgent.id} moteHostId="local" visible={visible} /></Profiler>
  await app.mount(node(true)); const isolated = () => app.container.querySelector<HTMLElement>('[data-isolate]')
  const faces = [...app.container.querySelectorAll<HTMLElement>('[data-mote-expression="thinking"]')]
  expect(faces.length).toBeGreaterThan(1); const target = faces.at(-1)!; const observer = intersections.find(row => row.node === target)
  expect(observer).toBeDefined(); expect(target.dataset.moteMotion).toBe('on')
  const baseline = renders
  await event(timeline({ type: 'append', agentSessionId: executionAgent.id, item: tool('unrelated-tool', 110, executionAgent.id) }, { sessionId: executionAgent.id }))
  expect(useAppStore.getState().timelines[executionAgent.id]!.items.map(item => item.id)).toEqual(['unrelated-tool'])
  expect(renders).toBe(baseline)
  await event(timeline({ type: 'append', agentSessionId: defaultAgent.id, item: { ...tool('own-history', 110), kind: 'assistant_message', status: 'complete' } }))
  expect(useAppStore.getState().timelines[defaultAgent.id]!.items.map(item => item.id)).toEqual(['own-history'])
  expect(renders).toBe(baseline)
  await act(async () => observer!.emit(false)); expect(target.dataset.moteMotion).toBe('off')
  await act(async () => observer!.emit(true)); expect(target.dataset.moteMotion).toBe('on')
  await act(async () => { reduce = true; mediaListeners.forEach(listener => listener()) }); expect(target.dataset.moteMotion).toBe('off')
  await act(async () => { reduce = false; mediaListeners.forEach(listener => listener()) }); expect(target.dataset.moteMotion).toBe('on')
  const hidden = Object.getOwnPropertyDescriptor(document, 'hidden')
  Object.defineProperty(document, 'hidden', { configurable: true, value: true })
  await act(async () => document.dispatchEvent(new Event('visibilitychange'))); expect(target.dataset.moteMotion).toBe('off')
  if (hidden) Object.defineProperty(document, 'hidden', hidden); else delete (document as unknown as Record<string, unknown>).hidden
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await app.mount(node(false)); const still = [...app.container.querySelectorAll<HTMLElement>('[data-mote-expression="thinking"]')].at(-1)!
  expect(still.dataset.moteMotion).toBe('off'); expect(still.querySelector('.mote-face')).not.toBeNull(); expect(isolated()).toBeNull()
})
it('a static directory face participates in native motion without subscribing to Session facts', async () => {
  await app.mount(); let renders = 0
  await app.mount(<Profiler id="static-face" onRender={() => renders++}><div data-static-face><SpaceObjectIcon kind="mote" name="Directory identity" manualIcon={DEFAULT_MOTE_FACE} /></div></Profiler>)
  const identity = app.container.querySelector('[data-static-face]')!
  expect(identity.querySelector('[data-space-icon-source="face"] .mote-face')).not.toBeNull()
  expect(identity.querySelector<HTMLElement>('[data-mote-expression]')!.dataset.moteExpression).toBe('identity')
  expect(identity.querySelector<HTMLElement>('[data-mote-expression]')!.dataset.moteMotion).toBe('on')
  const baseline = renders
  await event(timeline({ type: 'append', agentSessionId: executionAgent.id, item: tool('unrelated-static', 110, executionAgent.id) }, { sessionId: executionAgent.id }))
  expect(renders).toBe(baseline)
})
it('the profiling observer counts nonempty current Face work and excludes stale bailout duration from a previous commit', () => {
  const html = readFileSync(new NodeURL('../scripts/fixtures/mote-navigation-footer/paperdoll.html', import.meta.url), 'utf8')
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  expect(scripts).toHaveLength(1)
  const window: { moteFaceCosts?: { currentCommit: { start: number; end: number }; renders: Record<string, number>; seen: Record<string, number> }; __REACT_DEVTOOLS_GLOBAL_HOOK__?: { onCommitFiberRoot(id: number, root: unknown): void } } = {}
  runInNewContext(scripts[0]![1]!, { window })
  const costs = window.moteFaceCosts!, hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__!
  const fiber = { type: function SessionMotion() {}, memoizedProps: { moteSessionId: 'default-agent' }, flags: 1, actualStartTime: 15, actualDuration: 2, child: null, sibling: null }
  costs.currentCommit = { start: 10, end: 20 }; hook.onCommitFiberRoot(1, { current: fiber })
  expect(costs.renders).toEqual({ 'default-agent': 1 }); expect(costs.seen).toEqual({ 'default-agent': 1 })
  // The previous actual duration remains positive, precisely the realistic false count this observer must reject.
  costs.currentCommit = { start: 30, end: 40 }; hook.onCommitFiberRoot(1, { current: fiber })
  expect(costs.renders).toEqual({ 'default-agent': 1 }); expect(costs.seen).toEqual({ 'default-agent': 2 })
  fiber.actualStartTime = 35; hook.onCommitFiberRoot(1, { current: fiber })
  expect(costs.renders).toEqual({ 'default-agent': 2 })
  fiber.actualStartTime = 50; hook.onCommitFiberRoot(1, { current: fiber })
  expect(costs.renders).toEqual({ 'default-agent': 2 })
  fiber.actualStartTime = 36; fiber.actualDuration = 0; hook.onCommitFiberRoot(1, { current: fiber })
  expect(costs.renders).toEqual({ 'default-agent': 3 })
  fiber.flags = 0; hook.onCommitFiberRoot(1, { current: fiber })
  expect(costs.renders).toEqual({ 'default-agent': 3 })
})
