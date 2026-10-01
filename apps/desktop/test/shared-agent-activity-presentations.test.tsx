// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { act, createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { createWorkspaceLayout, type WorkspaceLayout } from '@agentmux/layout'
import type { AgentSessionHistoryObservation } from '@agentmux/core'
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
const paint = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }))
// Only isolate xterm/PTY paint. App, placement, Region, Session, messages and Composer are actual.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => {
  useEffect(() => { paint.mounts++; return () => { paint.unmounts++ } }, [])
  return createElement('div', { 'data-terminal-paint-probe': '' }, 'Original retained Agent output')
} }))
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { installNativePopover } from './fixtures/mote-workface'

const bodyText = 'Actual retained Activity body in both places'
async function mountScene() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.localStorage.clear()
  const initial = useAppStore.getState(), restorePopover = installNativePopover()
  const config = await api.config.get(), snapshot = await api.sessions.snapshot()
  const known = snapshot.sessions.find(session => session.id === 'session-codex')!
  expect(known.kind).toBe('agent')
  if (known.kind !== 'agent') throw new Error('Expected actual Agent fixture')
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: '/fixture/topics', name: 'Topics', kind: 'folder' as const }
  const topicId = 'launcher:activity-original', directoryPath = workspace.path + '/' + scratchTopicDirectoryName(topicId)
  const topic = { id: topicId, title: 'Original Agent', summary: '', directoryPath, topicPath: directoryPath + '/topic.md', collaborators: [],
    soul: { path: directoryPath + '/SOUL.md', content: '# Identity', version: 'actual-store-fixture' } }
  const session = { ...known, workspacePath: directoryPath }
  const tab = { ...createWorkbenchTab('activity-original-tab', { kind: 'agent', phase: 'attached', regionId: 'activity-original-region', workspaceId: workspace.id, sessionId: session.id }), topicId }
  const scratch = [vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic]), vi.spyOn(api.scratch, 'readTopic').mockResolvedValue(topic), vi.spyOn(api.scratch, 'ensureMote').mockResolvedValue(topic)]
  const controls = [vi.spyOn(api.sessions, 'launchAgent'), vi.spyOn(api.sessions, 'stop'), vi.spyOn(api.sessions, 'resume'), vi.spyOn(api.sessions, 'write')]
  const source = { providerId: session.providerId, nativeSessionId: 'activity-native-fixture' }
  let nativeText = 'Native input visible in both places'
  let appendedText: string | undefined
  let changed: ((observation: AgentSessionHistoryObservation) => void) | undefined
  let activeObservers = 0
  const reads = vi.spyOn(api.sessions, 'historyPage').mockImplementation(async () => ({ agentSessionId: session.id, source,
    items: [{ id: 'native-input', kind: 'user-message', startedAt: 1, contentParts: [{ kind: 'text', text: nativeText }] },
      ...(appendedText ? [{ id: 'native-append', kind: 'user-message' as const, startedAt: 3, contentParts: [{ kind: 'text' as const, text: appendedText }] }] : [])], nextCursor: null }))
  const observation = vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async (_control, onChange) => {
    changed = onChange; activeObservers++
    let disposed = false
    return { source, dispose: () => { if (!disposed) { disposed = true; activeObservers-- } } }
  })
  window.localStorage.setItem('agentmux.leader-topic-floating.v1', JSON.stringify({ open: false, targetTopicId: topicId, targetTabId: tab.id, railMode: 'avatars' }))
  const captured = { id: 'activity-body-message', agentSessionId: session.id, kind: 'assistant_message' as const, status: 'complete' as const,
    source: 'native-hook' as const, createdAt: 2, updatedAt: 2, title: 'Response', content: bodyText }
  useAppStore.setState({ ...initial, loading: false, initialize: async () => () => {}, config: { ...config, workspaces: [workspace] }, sessions: [session],
    activeWorkspaceId: workspace.id, mainSurface: 'workbench', tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('activity-original-group', [tab.id]) }, toolsOpen: false, projectRailOpen: false,
    scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), revision: 0, topics: [topic], error: null, reading: false } },
    viewModes: { [session.id]: 'activity' }, timelines: { [session.id]: { agentSessionId: session.id, items: [captured, { ...captured, id: 'activity-tool', kind: 'tool_call', title: 'Read sample', content: '', toolName: 'Read', toolInput: '{"file_path":"sample.txt"}', toolOutput: 'Independent reading detail' }], revision: 1 } }, agentComposerDrafts: { [session.id]: 'Retained unsent draft' },
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } }, true)
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(createElement(App)))
  await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain(nativeText) })
  const primary = container.querySelector<HTMLElement>('.agent-surface:not([data-session-presentation])')!
  const primaryMessage = [...primary.querySelectorAll<HTMLElement>('.log-turn__body')].find(element => element.textContent === bodyText)!
  expect(primaryMessage).toBeDefined()
  const draft = primary.querySelector<HTMLElement>('.ProseMirror')!
  expect(draft.textContent).toBe('Retained unsent draft')
  const trigger = document.querySelector<HTMLButtonElement>('[data-pmo-teams-topic-launcher] button')!
  expect(trigger).not.toBeNull()
  const before = useAppStore.getState()
  const visibleSlots = () => {
    const floating = document.getElementById('pmo-teams-topic-floating-panel')!
    const slots = [...container.querySelectorAll<HTMLElement>(`[data-workbench-tab-id="${tab.id}"]`)].filter(element => element.classList.contains('workbench-tab-slot'))
    const space = slots.filter(element => !floating.contains(element)), mote = slots.filter(element => floating.contains(element))
    expect(space).toHaveLength(1); expect(mote).toHaveLength(1)
    return { space: space[0]!, mote: mote[0]!, floating }
  }
  const openMote = async () => {
    await act(async () => trigger.click())
    await vi.waitFor(async () => { await act(async () => {}); const { space, mote, floating } = visibleSlots()
      expect(floating.matches(':popover-open')).toBe(true)
      expect([space.querySelectorAll('.agent-surface').length, mote.querySelectorAll('.agent-surface').length]).toEqual([1, 1])
      expect(mote.textContent).toContain(bodyText)
    })
    return visibleSlots()
  }
  return { container, root, session, tab, workspace, captured, primary, primaryMessage, draft, before, controls, reads, observation, openMote, visibleSlots, trigger,
    activeObservers: () => activeObservers,
    invalidate: (text: string) => { nativeText = text; expect(changed).toBeDefined(); changed!({ agentSessionId: session.id, kind: 'invalidated', source }) },
    append: (text: string) => { appendedText = text; expect(changed).toBeDefined(); changed!({ agentSessionId: session.id, kind: 'invalidated', source }) },
    close: async () => { await act(async () => root.unmount()); container.remove(); restorePopover(); useAppStore.setState(initial, true)
      for (const spy of [...scratch, ...controls, reads, observation]) spy.mockRestore(); vi.useRealTimers(); vi.unstubAllGlobals() }
  }
}

it('actual App shows two nonempty Activity bodies and keeps primary reading, original draft and entity identities', async () => {
  const scene = await mountScene()
  try {
    const reading = scene.primaryMessage.querySelector('p')!.firstChild!
    expect(reading.nodeType).toBe(Node.TEXT_NODE)
    const range = document.createRange(); range.setStart(reading, 2); range.setEnd(reading, 8)
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
    const { space, mote } = await scene.openMote()
    expect(space.querySelector('.agent-surface')).toBe(scene.primary)
    expect([...space.querySelectorAll('.log-turn__body')].find(element => element.textContent === bodyText)).toBe(scene.primaryMessage)
    expect(space.querySelector('.ProseMirror')).toBe(scene.draft)
    expect([range.startContainer, range.startOffset, range.endContainer, range.endOffset]).toEqual([reading, 2, reading, 8])
    expect(document.getSelection()!.toString()).toBe('tual r')
    for (const slot of [space, mote]) { expect(slot.textContent).toContain(bodyText); expect(slot.textContent).toContain('Native input visible in both places') }
    const aDisclosure = space.querySelector<HTMLButtonElement>('button[data-observation-step-id="activity-tool"]')!, bDisclosure = mote.querySelector<HTMLButtonElement>('button[data-observation-step-id="activity-tool"]')!
    expect(aDisclosure).not.toBeNull();expect(bDisclosure).not.toBeNull();expect(aDisclosure).not.toBe(bDisclosure)
    await act(async () => bDisclosure.click())
    expect(bDisclosure.getAttribute('aria-expanded')).toBe('true');expect(aDisclosure.getAttribute('aria-expanded')).toBe('false')
    const aFeed=space.querySelector<HTMLElement>('.activity-feed')!, bFeed=mote.querySelector<HTMLElement>('.activity-feed')!
    expect(aFeed).not.toBe(bFeed); bFeed.scrollTop=31;expect(aFeed.scrollTop).toBe(0);expect(bFeed.scrollTop).toBe(31)
    const current = useAppStore.getState()
    expect(current.tabs).toBe(scene.before.tabs); expect(current.layouts).toBe(scene.before.layouts)
    expect(current.sessions[0]!.control).toBe(scene.session.control)
    expect(current.agentComposerDrafts[scene.session.id]).toBe('Retained unsent draft')
    expect(scene.controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0])
    expect(paint.mounts).toBe(0)
    expect(scene.reads).toHaveBeenCalledTimes(1); expect(scene.activeObservers()).toBe(1)
    if (process.env.INTAKE_OBSERVATION) writeFileSync(process.env.INTAKE_OBSERVATION, JSON.stringify({
      twoBodies: [space, mote].map(slot => ({ host: slot.id, body: slot.querySelector('.agent-surface')?.textContent, count: slot.querySelectorAll('.agent-surface').length })),
      primaryDOMAndReadingKept: true, draftKept: true, entityMutations: 0, nativeReads: scene.reads.mock.calls.length,
      conditions: { actualAppStoreWorkbenchSessionComposer: true, publicNativeDTOFixture: true, physicalPTYNativeWriter: false }
    }, null, 2))
  } finally { await scene.close() }
})

it('one holder reads for a visible secondary, freezes hidden primary, and stops observing when all stages hide', async () => {
  const scene = await mountScene()
  try {
    const { space, mote } = await scene.openMote()
    const primaryNative = [...scene.primary.querySelectorAll<HTMLElement>('.log-turn__body')].find(element => element.textContent === 'Native input visible in both places')!
    expect(primaryNative).toBeDefined()
    const reading = primaryNative.querySelector('p')!.firstChild!, range = document.createRange()
    range.setStart(reading, 1); range.setEnd(reading, 6); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
    await act(async () => useAppStore.setState({ mainSurface: 'board' }))
    expect(space.closest('.workspace-workbench-slot')?.getAttribute('aria-hidden')).toBe('true')
    expect(mote.closest('[data-pmo-teams-topic-floating]')?.matches(':popover-open')).toBe(true)
    const initialReads = scene.reads.mock.calls.length
    vi.useFakeTimers()
    await act(async () => { scene.invalidate('Fresh native input while Space is covered'); await vi.advanceTimersByTimeAsync(50) })
    expect(scene.reads.mock.calls.length).toBe(initialReads + 1)
    expect(mote.textContent).toContain('Fresh native input while Space is covered')
    expect(space.textContent).not.toContain('Fresh native input while Space is covered')
    expect([...space.querySelectorAll('.log-turn__body')].find(element => element.textContent === 'Native input visible in both places')).toBe(primaryNative)
    expect([range.startContainer, range.startOffset, range.endContainer, range.endOffset]).toEqual([reading, 1, reading, 6])
    const readsBeforeUnrelated = scene.reads.mock.calls.length
    await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, unrelated: { agentSessionId: 'unrelated', revision: 1, items: [] } } })))
    await act(async () => vi.advanceTimersByTimeAsync(100))
    expect(scene.reads.mock.calls.length).toBe(readsBeforeUnrelated)
    await act(async () => scene.trigger.click())
    expect(scene.activeObservers()).toBe(0)
    await act(async () => { scene.invalidate('Ignored hidden invalidation'); await vi.advanceTimersByTimeAsync(100) })
    expect(scene.reads.mock.calls.length).toBe(readsBeforeUnrelated)
    expect(scene.controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0])
    vi.useRealTimers()
    await act(async () => useAppStore.setState({ mainSurface: 'workbench' }))
    expect(space.querySelector('.agent-surface')).toBe(scene.primary)
    expect(space.querySelector('.ProseMirror')).toBe(scene.draft)
    expect(useAppStore.getState().agentComposerDrafts[scene.session.id]).toBe('Retained unsent draft')
  } finally { await scene.close() }
})

it('a manual secondary Composer action reaches the original queue once; mounting and closing a binding never close the entity', async () => {
  const scene = await mountScene()
  const queue = vi.fn(useAppStore.getState().enqueueAgentSteer), originalQueue = useAppStore.getState().enqueueAgentSteer
  await act(async () => useAppStore.setState({ enqueueAgentSteer: queue }))
  try {
    const { mote } = await scene.openMote()
    expect(queue).not.toHaveBeenCalled()
    const composer = mote.querySelector<HTMLElement>('.ProseMirror')!
    expect(composer.textContent).toBe('Retained unsent draft')
    await act(async () => composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(queue).toHaveBeenCalledTimes(1)
    expect(queue.mock.calls[0]![0]).toBe(scene.session.id)
    expect(queue.mock.calls[0]![1]).toBe('Retained unsent draft')
    expect(queue.mock.calls[0]![4]).toBe('manual')
    await act(async () => scene.trigger.click())
    expect(useAppStore.getState().tabs[scene.tab.id]).toBe(scene.tab)
    expect(scene.controls.slice(0, 3).map(spy => spy.mock.calls.length)).toEqual([0, 0, 0])
  } finally { await act(async () => useAppStore.setState({ enqueueAgentSteer: originalQueue })); await scene.close() }
})

it('foreign and nonfirst Group presentations select their own exact occurrence through the original Region frame', async () => {
  const scene = await mountScene()
  const originalFocus = useAppStore.getState().focusRegion, focus = vi.fn(originalFocus)
  try {
    const current = useAppStore.getState(), first = current.layouts[scene.workspace.id]!
    const double: WorkspaceLayout = { ...first, root: { type: 'split', direction: 'horizontal', ratio: .5, first: first.root, second: { type: 'leaf', groupId: 'second-group' } },
      groups: [...first.groups, { ...first.groups[0]!, id: 'second-group' }] }
    const foreign = { id: 'foreign-display', hostId: 'local', path: '/fixture/foreign', name: 'Foreign display', kind: 'folder' as const }
    await act(async () => useAppStore.setState({ config: { ...current.config!, workspaces: [...current.config!.workspaces, foreign] },
      layouts: { ...current.layouts, [scene.workspace.id]: double, [foreign.id]: createWorkspaceLayout('foreign-group', [scene.tab.id]) },
      focusRegion: focus }))
    await act(async () => useAppStore.setState({ activeWorkspaceId: foreign.id }))
    const slot = () => document.getElementById('workbench-tab-slot:["foreign-display","foreign-group","activity-original-tab"]')!
    await vi.waitFor(async () => { await act(async () => {}); expect(slot()?.textContent).toContain(bodyText) })
    const frame = slot().querySelector<HTMLElement>('[data-workbench-region-id="activity-original-region"]')!
    expect(frame).not.toBeNull()
    expect(frame.querySelectorAll('.log-turn__body').length).toBeGreaterThan(0)
    focus.mockClear()
    await act(async () => frame.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    expect(focus.mock.calls).toEqual([[foreign.id, scene.tab.id, 'activity-original-region', 'pointer', 'foreign-group']])
    expect(useAppStore.getState().activeWorkspaceId).toBe(foreign.id)
    expect(useAppStore.getState().layouts[foreign.id]!.activeGroupId).toBe('foreign-group')
    const contexts: EventTarget[] = []
    const onContext = (event: Event) => { if (event.target) contexts.push(event.target) }
    document.addEventListener('contextmenu', onContext)
    try {
      await act(async () => frame.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })))
      expect(contexts).toEqual([frame])
      await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelectorAll('.region-context-menu')).toHaveLength(1) })
      const menu = document.querySelector<HTMLElement>('.region-context-menu')!
      expect(menu.textContent).toContain('Copy Session Address')
      await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    } finally { document.removeEventListener('contextmenu', onContext) }
    await act(async () => useAppStore.setState({ activeWorkspaceId: scene.workspace.id }))
    const second = document.getElementById('workbench-tab-slot:["__scratch__","second-group","activity-original-tab"]')!
    await vi.waitFor(async () => { await act(async () => {}); expect(second?.textContent).toContain(bodyText) })
    focus.mockClear()
    await act(async () => second.querySelector<HTMLElement>('[data-workbench-region-id="activity-original-region"]')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    expect(focus.mock.calls).toEqual([[scene.workspace.id, scene.tab.id, 'activity-original-region', 'pointer', 'second-group']])
    expect(scene.controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0])
  } finally { await act(async () => useAppStore.setState({ focusRegion: originalFocus })); await scene.close() }
})

it('the existing live Terminal stays in the selected Mote with one original paint owner', async () => {
  const scene = await mountScene()
  try {
    const { mote } = await scene.openMote()
    await act(async () => useAppStore.setState({ viewModes: { [scene.session.id]: 'terminal' } }))
    expect(document.querySelectorAll('[data-terminal-paint-probe]')).toHaveLength(1)
    expect(mote.querySelectorAll('[data-terminal-paint-probe]')).toHaveLength(1)
    expect(mote.querySelector('.agent-surface:not([data-session-presentation])')).toBe(scene.primary)
    expect(mote.querySelector('.ProseMirror')).toBe(scene.draft)
    await act(async () => useAppStore.setState({ viewModes: { [scene.session.id]: 'activity' } }))
    const { space } = scene.visibleSlots()
    expect(space.querySelector('.agent-surface')).toBe(scene.primary)
    expect([...space.querySelectorAll('.log-turn__body')].find(element => element.textContent === bodyText)).toBe(scene.primaryMessage)
    expect(space.querySelector('.ProseMirror')).toBe(scene.draft)
    const reading = scene.primaryMessage.querySelector('p')!.firstChild!, range = document.createRange()
    range.setStart(reading, 2); range.setEnd(reading, 8); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
    await act(async () => useAppStore.setState({ viewModes: { [scene.session.id]: 'terminal' } }))
    const terminal = mote.querySelector('[data-terminal-paint-probe]')!
    expect(terminal).not.toBeNull()
    expect(mote.querySelector('.agent-surface:not([data-session-presentation])')).toBe(scene.primary)
    await act(async () => scene.trigger.click())
    expect(space.querySelector('[data-terminal-paint-probe]')).toBe(terminal)
    expect(document.querySelectorAll('[data-terminal-paint-probe]')).toHaveLength(1)
    await act(async () => useAppStore.setState({ viewModes: { [scene.session.id]: 'activity' } }))
    expect(space.querySelector('.agent-surface')).toBe(scene.primary)
    expect(space.querySelector('.ProseMirror')).toBe(scene.draft)
    expect([range.startContainer, range.startOffset, range.endContainer, range.endOffset]).toEqual([reading, 2, reading, 8])
    expect(scene.controls.slice(0, 3).map(spy => spy.mock.calls.length)).toEqual([0, 0, 0])
  } finally { await scene.close() }
})


it('an open secondary Mailbox pauses with its ineligible Activity while a legitimate visible consumer keeps the shared source alive', async () => {
  const scene = await mountScene()
  try {
    const { mote } = await scene.openMote()
    const stage = mote.querySelector<HTMLElement>('[data-session-presentation]')!
    expect(stage).not.toBeNull()
    const body = [...stage.querySelectorAll<HTMLElement>('.log-turn__body')].find(element => element.textContent === bodyText)!
    expect(body).toBeDefined()
    const reading = body.querySelector('p')!.firstChild!, range = document.createRange()
    range.setStart(reading, 2); range.setEnd(reading, 8)
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
    const disclosure = stage.querySelector<HTMLButtonElement>('button[data-observation-step-id="activity-tool"]')!
    expect(disclosure).not.toBeNull()
    await act(async () => disclosure.click())
    const feed = stage.querySelector<HTMLElement>('.activity-feed')!, draft = stage.querySelector<HTMLElement>('.ProseMirror')!
    feed.scrollTop = 31
    const mailbox = stage.querySelector<HTMLElement>('.composer-mailbox')!, trigger = stage.querySelector<HTMLButtonElement>('.composer__mailbox')!
    expect(mailbox).not.toBeNull(); expect(trigger).not.toBeNull()
    // Actual Mailbox pointer entry and native-toggle boundary; no Hook is mocked.
    await act(async () => trigger.dispatchEvent(new PointerEvent('pointerover', { pointerType: 'mouse', buttons: 0, bubbles: true })))
    await vi.waitFor(async () => { await act(async () => {}); expect(mailbox.dataset.state).toBe('open') })
    await act(async () => mailbox.querySelector<HTMLButtonElement>('[role="tab"][id$="-outbox-tab"]')!.click())
    await vi.waitFor(async () => { await act(async () => {}); expect(mailbox.textContent).toContain('Native input visible in both places') })
    const record = mailbox.querySelector<HTMLButtonElement>('button[data-record-key]')!
    expect(record).not.toBeNull()
    await act(async () => record.click())
    const mailboxText = mailbox.querySelector<HTMLElement>('.composer-mailbox__full-text')!
    expect(mailboxText.textContent).toBe('Native input visible in both places')
    const mailboxReading = mailboxText.firstChild!, mailboxRange = document.createRange()
    mailboxRange.setStart(mailboxReading, 1); mailboxRange.setEnd(mailboxReading, 6)
    const mailboxScroll = mailbox.querySelector<HTMLElement>('.composer-mailbox__content')!
    mailboxScroll.scrollTop = 19
    const paused = { ...scene.session, processState: 'exited' as const }
    await act(async () => useAppStore.setState({ sessions: [paused] }))
    expect(stage.querySelector<HTMLElement>('.agent-input-stack')!.hidden).toBe(true)
    expect(stage.querySelector<HTMLElement>('.agent-terminal-stage')!.hidden).toBe(true)
    expect(mailbox.dataset.state).toBe('open')
    // Activity demand is now false; the hidden B Mailbox must not keep a watch alive.
    expect(scene.activeObservers()).toBe(0)
    const readsPaused = scene.reads.mock.calls.length
    vi.useFakeTimers()
    await act(async () => { scene.append('Hidden append'); await vi.advanceTimersByTimeAsync(100) })
    expect(scene.reads.mock.calls.length).toBe(readsPaused)
    expect(mailbox.querySelector('.composer-mailbox__full-text')).toBe(mailboxText)
    expect(mailboxText.firstChild).toBe(mailboxReading)
    expect([mailboxRange.startContainer, mailboxRange.startOffset, mailboxRange.endContainer, mailboxRange.endOffset]).toEqual([mailboxReading, 1, mailboxReading, 6])
    // The original primary Mailbox is still a legitimate visible read surface.
    const primaryMailbox = scene.primary.querySelector<HTMLElement>('.composer-mailbox')!, primaryTrigger = scene.primary.querySelector<HTMLButtonElement>('.composer__mailbox')!
    await act(async () => primaryTrigger.dispatchEvent(new PointerEvent('pointerover', { pointerType: 'mouse', buttons: 0, bubbles: true })))
    await act(async () => primaryMailbox.querySelector<HTMLButtonElement>('[role="tab"][id$="-outbox-tab"]')!.click())
    await act(async () => vi.advanceTimersByTimeAsync(100))
    expect(scene.activeObservers()).toBe(1)
    expect(primaryMailbox.textContent).toContain('Hidden append')
    const readsVisible = scene.reads.mock.calls.length
    await act(async () => { scene.append('Visible primary append'); await vi.advanceTimersByTimeAsync(100) })
    expect(scene.reads.mock.calls.length).toBe(readsVisible + 1)
    expect(primaryMailbox.textContent).toContain('Visible primary append')
    expect(mailbox.textContent).not.toContain('Visible primary append')
    expect(mailbox.querySelector('.composer-mailbox__full-text')).toBe(mailboxText)
    await act(async () => useAppStore.setState({ sessions: [scene.session] }))
    expect(stage.querySelector<HTMLElement>('.agent-input-stack')!.hidden).toBe(false)
    expect(stage.querySelector('.ProseMirror')).toBe(draft)
    expect([...stage.querySelectorAll('.log-turn__body')].find(element => element.textContent === bodyText)).toBe(body)
    expect(body.querySelector('p')!.firstChild).toBe(reading)
    expect([range.startContainer, range.startOffset, range.endContainer, range.endOffset]).toEqual([reading, 2, reading, 8])
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(stage.querySelector('.activity-feed')).toBe(feed); expect(feed.scrollTop).toBe(31)
    expect(mailbox.querySelector('.composer-mailbox__full-text')).toBe(mailboxText)
    expect(mailboxText.firstChild).toBe(mailboxReading); expect(mailboxScroll.scrollTop).toBe(19)
    expect(draft.textContent).toBe('Retained unsent draft')
    expect(scene.controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0])
    if (process.env.INTAKE_MAILBOX_OBSERVATION) writeFileSync(process.env.INTAKE_MAILBOX_OBSERVATION, JSON.stringify({
      secondaryOpenBeforeHidden: true, hiddenActivityAndComposer: true, hiddenOwnObserver: 0,
      legitimatePrimaryObserver: scene.activeObservers(), nativeReads: scene.reads.mock.calls.length,
      pausedMailboxOriginalBody: mailbox.querySelector('.composer-mailbox__full-text') === mailboxText,
      activityBodyRangeDisclosureScrollDraftPreserved: true, entityLifecycleCalls: scene.controls.map(spy => spy.mock.calls.length),
      boundary: 'Actual App/Store/Session/Composer/Mailbox/Hook. Native DTO and HTMLElement popover boundary; no Native Writer or physical Run.'
    }, null, 2))
  } finally { await scene.close() }
})
