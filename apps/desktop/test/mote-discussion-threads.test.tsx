// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { createMoteApp, moteClick, motePointer, moteType, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultAgent, defaultTab, neighborAgent, neighborTab, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { moteEntryDraftKey } from '../src/renderer/src/lib/mote-entry-hold'
import { scratchTopicLogicalPath } from '@agentmux/host/mote-model'
import { promptCarrierWaiting } from './helpers/prompt-carrier-receipt'
import { connectWorkbenchCloseApiOwner } from './helpers/workbench-close-api-owner'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { MoteDialoguePage } from '@agentmux/core/mote-dialogue'
const main = { hostId: 'local', sessionId: defaultAgent.id, displayWorkspaceId: scratchWorkspace.id, groupId: 'mote-group', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
const actualSend = useAppStore.getState().send
let currentMain = main
let app: MoteAppFixture, reading: MockInstance<typeof api.moteDialogue.read>, failRead = false, typedUnconfirmed = false
let links: MoteDialoguePage['links'] = [], next: MoteDialoguePage['next'] = null
let sourceUnconfirmed = false
const page = (target: any): MoteDialoguePage => ({ main: { target, identity: { hostId: 'local', moteId: moteTopics[0]!.id }, status: 'ready', resource: null, documentRevision: 'original-doc', roleRevision: 'role-' + currentMain.sessionId, current: currentMain, issue: null }, links: [...links].sort((a,b) => b.sequence-a.sequence), incarnation: 'original-links', throughSequence: Math.max(0, ...links.map(link => link.sequence)), next, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null })
const button = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label)!
const visibleBody = () => app.panel().querySelector<HTMLElement>('[data-mote-workface] .mote-workface__original:not([hidden])')
const mainComposer = () => app.panel().querySelector<HTMLElement>('.mote-composer-surface')!
const mainEditor = () => mainComposer().querySelector<HTMLElement>('[aria-label="Message Agent"]')!
const mainDraftKey = moteEntryDraftKey({ workspace: scratchWorkspace, topic: moteTopics[0]!,
 rootPath: scratchTopicLogicalPath(scratchWorkspace, moteTopics[0]!)! })
let formerDrafts: ReturnType<typeof useLauncherState.getState>['drafts']
beforeEach(() => {
 failRead = false; typedUnconfirmed = false; currentMain = main; links = []; next = null; sourceUnconfirmed = false; app = createMoteApp()
 formerDrafts = useLauncherState.getState().drafts
 useLauncherState.setState({ drafts: {} })
 const topics = moteTopics.map((topic, i) => i ? topic : { ...topic, quickMode: { status: 'saved' as const, version: 'original-doc', defaults: { conversation: main } } })
 useAppStore.setState({ scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), topics, revision: 0, error: null, reading: false } } })
 vi.mocked(api.scratch.listTopics).mockResolvedValue(topics); vi.mocked(api.scratch.readTopic).mockImplementation(async (_w, id) => topics.find(topic => topic.id === id) ?? null)
 reading = vi.spyOn(api.moteDialogue, 'read').mockImplementation(async (input: any) => { if (failRead) throw Error('原角色读取暂不可用'); const value = page(input.target); if(input.eventId) { value.links = value.links.filter(link => link.kind === 'work' && link.eventId === input.eventId); value.next = null } if(sourceUnconfirmed) return { ...value, links: [], next: null, sourceStatus: 'unconfirmed', sourceIssue: '原关联来源尚未确认' }; return typedUnconfirmed ? { ...value, main: { ...value.main, status: 'unconfirmed', current: null, roleRevision: null, issue: '原文件读取暂不可用' } } : value })
 vi.spyOn(api.motePreferences, 'read').mockImplementation(async (input: any) => ({ target: input.target, status: 'unconfirmed', issue: 'Settings fixture is read-only', source: null, choices: { executors: [], conversations: [], destinations: [] }, defaults: {}, maintenance: { status: 'unconfirmed', schedule: null, issue: null } } as any))
 vi.spyOn(api.moteDialogue, 'inspectRecovery').mockResolvedValue({ operation: null } as any)
 vi.spyOn(api.moteDialogue, 'ensureRecovery').mockRejectedValue(Error('Controlled recovery boundary'))
 vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
})
afterEach(async () => {
 try { await app.dispose() }
 finally { useLauncherState.setState({ drafts: formerDrafts }) }
})
async function open() { await app.mount(); await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: moteTopics[0]!.id })); await settleMoteApp(); await vi.waitFor(() => expect(visibleBody()?.querySelector('[data-activity-session="' + defaultAgent.id + '"]')).not.toBeNull()) }
async function openMemberWorkspace() {
 await moteClick(button(app.panel(), '成员'))
 const row = app.panel().querySelector<HTMLElement>('[data-mote-member="' + neighborAgent.id + '"]')!
 expect(row).not.toBeNull()
 await moteClick(row.closest<HTMLButtonElement>('button')!)
 const pane = app.panel().querySelector('.mote-cooperation--threads .mote-conversation-browser__pane:not([hidden])')!
 await moteClick(button(pane, '在工作区打开'))
}
const originalWork = (eventId: string, sequence: number, hostId = 'local'): Extract<MoteDialoguePage['links'][number], { kind: 'work' }> => ({
 kind: 'work', identity: { hostId: 'local', moteId: moteTopics[0]!.id }, eventId, sequence, operationId: 'link-' + sequence, associatedAt: sequence,
 mainRoleRevision: 'previous-main-role', main: { hostId, agentSessionId: 'previous-main' },
 origin: { hostId, messageId: 'dispatch-' + sequence, threadId: 'thread-' + sequence, senderSessionId: 'previous-main', recipientSessionId: neighborAgent.id, createdAt: sequence }
})
it.each([false, true])('keeps the original Mote discussion while closing the exact Browser split (early native close: %s)', async earlyClose => {
 if (earlyClose) {
  currentMain = { ...main, displayWorkspaceId: 'project', groupId: 'project-group' }
  const topics = moteTopics.map((topic, i) => i ? topic : { ...topic, quickMode: { status: 'saved' as const, version: 'original-doc', defaults: { conversation: currentMain } } })
  useAppStore.setState(state => ({ layouts: { ...state.layouts, project: createWorkspaceLayout('project-group', [main.tabId]) },
   scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), topics, revision: 0, error: null, reading: false } } }))
  vi.mocked(api.scratch.listTopics).mockResolvedValue(topics)
  vi.mocked(api.scratch.readTopic).mockImplementation(async (_workspace, id) => topics.find(topic => topic.id === id) ?? null)
 }
 const original = currentMain
 await open()
 expect(readPmoTeamsTopicFloatingState()?.reference).toMatchObject({ displayWorkspaceId: original.displayWorkspaceId, groupId: original.groupId })
 const owner = await connectWorkbenchCloseApiOwner()
 try {
  const body = visibleBody()!, panel = app.panel()
  const editor = mainEditor()
  await moteType(editor, '分栏关闭后保留这段草稿')
  const selectionBefore = useAppStore.getState().workbenchSpaceSelection
  const finishBrowserClose = api.browser.close.bind(api.browser)
  const close = vi.spyOn(api.browser, 'close')
  const stop = vi.spyOn(api.sessions, 'stop')
  const create = api.browser.create.bind(api.browser)
  vi.spyOn(api.browser, 'create').mockImplementationOnce(async (...args) => ({ ...await create(...args), agent: null }))
  await act(async () => useAppStore.getState().openHttpLink({ workspaceId: original.displayWorkspaceId, tabGroupId: original.groupId,
   tabId: main.tabId, regionId: main.regionId, sessionId: defaultAgent.id }, 'https://example.invalid/original', 'right', { surface: 'mote' }))
  const tab = useAppStore.getState().tabs[main.tabId]!
  const browser = Object.values(tab.regions).find(region => region.kind === 'browser')!
  const split = body.querySelector<HTMLElement>(`[data-workbench-region-id="${browser.regionId}"]`)!
  const closeSplit = button(split, 'Close split')
  expect(closeSplit).toBeDefined()
  await motePointer(split, 'down')
  await vi.waitFor(() => expect(readPmoTeamsTopicFloatingState()?.reference?.regionId).toBe(browser.regionId))
  expect(visibleBody()).toBe(body)
  const ref = readPmoTeamsTopicFloatingState()?.reference
  expect(ref).toEqual({ displayWorkspaceId: original.displayWorkspaceId, groupId: original.groupId, tabId: original.tabId, regionId: browser.regionId })
  const request = vi.mocked(api.workbenchClose.call)
  close.mockRejectedValueOnce(new Error('Controlled Browser close failure'))
  await moteClick(closeSplit)
  await act(() => owner.settle())
  expect(request).toHaveBeenCalledWith('space.close.prepare', expect.objectContaining({ target: { kind: 'region', ...ref } }))
  expect(useAppStore.getState().tabs[main.tabId]?.regions[browser.regionId]).toBe(browser)
  expect(readPmoTeamsTopicFloatingState()?.reference).toEqual(ref)
  expect(visibleBody()).toBe(body)
  let earlySelection: ReturnType<typeof readPmoTeamsTopicFloatingState>
  if (earlyClose) close.mockImplementationOnce(async id => {
   await finishBrowserClose(id)
   useAppStore.getState().applyBrowserEvent({ type: 'closed', id })
   earlySelection = readPmoTeamsTopicFloatingState()
  })
  await moteClick(closeSplit)
  await act(() => owner.settle())
  expect(close.mock.calls).toEqual([[browser.browserId], [browser.browserId]])
  await expect(close.mock.results[1]!.value).resolves.toBeUndefined()
  if (earlyClose) expect(earlySelection!).toMatchObject({ open: true, reference: { ...ref, regionId: main.regionId } })
  expect(Object.keys(useAppStore.getState().tabs[main.tabId]!.regions)).toEqual([main.regionId])
  expect(readPmoTeamsTopicFloatingState()).toMatchObject({ open: true, reference: { ...ref, regionId: main.regionId } })
  expect(app.panel()).toBe(panel)
  expect(visibleBody()).toBe(body)
  expect(mainEditor()).toBe(editor)
  expect(editor.textContent).toContain('分栏关闭后保留这段草稿')
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(selectionBefore)
  expect(useAppStore.getState().sessions.find(session => session.id === defaultAgent.id)?.control.run).toEqual(defaultAgent.control.run)
  expect(stop).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled()
 } finally { await owner.dispose() }
})
it('top navigation counts original deduplicated metadata and partial coverage without reading private bodies', async () => {
 links = [originalWork('one', 1), originalWork('one', 2), originalWork('two', 3)]; next = { identity: { hostId: 'local', moteId: moteTopics[0]!.id }, incarnation: 'original-links', selection: '[null,null,null]', throughSequence: 3, beforeSequence: 1 }
 const chat = vi.spyOn(api.moteChat, 'call').mockImplementation(async (method: string) => {
  if (method === 'space.mote.chat.inspect') return { configuration: null } as any
  if (method === 'space.mote.chat.history') return { generations: ['one', 'one', 'two'].map(generationId => ({ generationId, actor: { userId: 'person' }, application: { domain: 'original-platform' }, lastActivityAt: 1, createdAt: 1, executionHostId: 'local', agentSessionId: 'private-' + generationId, phase: 'ready' })), next: 'older' } as any
  throw Error('No people or private bodies in metadata observation')
 })
 vi.spyOn(api.connections, 'hostingTarget').mockResolvedValue({ hostId: 'local', runtimeId: 'original-runtime' })
 await open()
 const nav = app.panel().querySelector('[role="tablist"][aria-label="Mote 内容"]')!
 await vi.waitFor(() => expect(button(nav, '私聊').textContent).toBe('私聊2+'))
 expect(button(nav, '工作').textContent).toBe('工作2+')
 expect(button(nav, '成员').textContent).toBe('成员1')
 const metadataReads = chat.mock.calls.filter(([method]) => method === 'space.mote.chat.history').length
 expect(metadataReads).toBeGreaterThan(0); expect(metadataReads).toBeLessThanOrEqual(2)
 expect(chat.mock.calls.find(([method]) => method === 'space.mote.chat.history')![1]).toMatchObject({ limit: 3 })
 expect(button(nav, '工作').getAttribute('aria-description')).toContain('至少 2')
 const original = visibleBody()
 await moteClick(button(nav, '工作')); expect(app.panel().querySelector('.mote-threads__views')).toBeNull()
 await moteClick(button(nav, '成员')); expect(button(nav, '成员').getAttribute('aria-selected')).toBe('true')
 await moteClick(button(nav, '主对话')); expect(visibleBody()).toBe(original)
 expect(chat.mock.calls.filter(([method]) => method === 'space.mote.chat.history')).toHaveLength(metadataReads)
 expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
})
it('unconfirmed work metadata never becomes a confirmed zero and a failed refresh keeps its last count', async () => {
 sourceUnconfirmed = true; await open()
 const nav = app.panel().querySelector('[role="tablist"][aria-label="Mote 内容"]')!
 await vi.waitFor(() => expect(button(nav, '工作').getAttribute('aria-description')).toContain('来源暂不可用'))
 expect(button(nav, '工作').textContent).toBe('工作·')
 sourceUnconfirmed = false; links = [originalWork('one', 1)]
 await moteClick(button(nav, '主对话')); await vi.waitFor(() => expect(button(nav, '工作').textContent).toBe('工作1'))
 sourceUnconfirmed = true
 await moteClick(button(nav, '主对话')); await vi.waitFor(() => expect(button(nav, '工作').getAttribute('aria-description')).toContain('来源暂不可用'))
 expect(button(nav, '工作').textContent).toBe('工作1')
})
it('quick jump follows exact active actors and original events, never other Hosts or all historical tasks', async () => {
 links = [originalWork('old-main-work', 1), originalWork('another-associated-work', 2), originalWork('wrong-host-work', 3, 'other-host')]
 await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === neighborAgent.id && session.kind === 'agent' ? { ...session, pendingInteraction: undefined, status: { state: 'working', source: 'native-hook', observedAt: Date.now() } } : session) })))
 const dispatch = vi.spyOn(api.sessions, 'dispatch').mockImplementation(async (target, messageId) => ({ hostId: target.hostId,
  source: { envelope: { body: 'Original associated work', messageId } }, dispatch: { events: [] }, replies: [], identityDiagnostics: [] } as any))
 await open(); const body = visibleBody()
 await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === neighborAgent.id && session.kind === 'agent' ? { ...session, pendingInteraction: undefined, status: { state: 'working', source: 'native-hook', observedAt: Date.now() } } : session) })))
 await vi.waitFor(() => expect(button(app.panel(), '工作中的成员')).toBeDefined())
 const jump = button(app.panel(), '工作中的成员')
 expect(jump.textContent).toContain('1')
 await moteClick(jump)
 const popover = document.querySelector('.mote-active-work__popover')!
 expect(popover.querySelectorAll('[data-mote-work-jump]')).toHaveLength(2)
 expect(popover.querySelector('[data-mote-work-jump="wrong-host-work"]')).toBeNull()
 await moteClick(popover.querySelector<HTMLElement>('[data-mote-work-jump="old-main-work"]')!)
 await vi.waitFor(() => expect(app.panel().querySelector('[data-mote-work-thread="old-main-work"]')).not.toBeNull())
 expect(reading.mock.calls.some(([input]) => input.kind === 'work' && input.eventId === 'old-main-work')).toBe(true)
 await moteClick(button(app.panel(), '主对话')); expect(visibleBody()).toBe(body)
 for (const state of ['waiting', 'done'] as const) {
  await act(async () => useAppStore.setState(current => ({ sessions: current.sessions.map(session => session.id === neighborAgent.id && session.kind === 'agent' ? { ...session, status: { state, source: 'native-hook', observedAt: Date.now() } } : session) })))
  await vi.waitFor(() => expect(button(app.panel(), '工作中的成员')).toBeUndefined())
 }
 await act(async () => useAppStore.setState(current => ({ sessions: current.sessions.map(session => session.id === neighborAgent.id && session.kind === 'agent' ? { ...session, status: { state: 'working', source: 'native-hook', observedAt: 1 } } : session) })))
 expect(button(app.panel(), '工作中的成员')).toBeUndefined()
 expect(dispatch.mock.calls.every(([target]) => target.hostId === 'local' || target.hostId === 'other-host')).toBe(true)
 expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})
it('real compact entry opens exact Main, Threads selects a worker and Discussion returns with original DOM and drafts', async () => {
 await open(); const original = useAppStore.getState(), mainBody = visibleBody()!.querySelector('[data-activity-session="' + defaultAgent.id + '"]')!
 expect(visibleBody()!.querySelector('[data-activity-session="' + defaultAgent.id + '"]')).not.toBeNull()
 expect(visibleBody()!.querySelector('.pane-tabbar')?.hasAttribute('hidden')).toBe(true)
 expect(button(app.panel(), '原工作面')).toBeUndefined()
 await moteClick(button(app.panel(), '工作'))
 expect(app.panel().querySelector('.mote-threads-panel:not([hidden])')).not.toBeNull(); expect(visibleBody()).toBeNull()
 expect(mainBody.isConnected).toBe(true)
 await openMemberWorkspace()
 expect(app.panel().querySelector('[data-mote-workface]')?.getAttribute('data-mote-section')).toBe('threads')
 expect(visibleBody()).not.toBeNull()
 expect(visibleBody()!.querySelector('[data-activity-session="' + neighborAgent.id + '"]')).not.toBeNull()
 await moteClick(button(app.panel(), '切换对话'))
 await moteClick(button(document.querySelector('.mote-cooperation__popover')!, '原工作区'))
 expect(app.panel().querySelector('[data-mote-workface-presentation="workface"]')).not.toBeNull()
 expect(visibleBody()!.querySelector('.pane-tabbar')?.hasAttribute('hidden')).toBe(false)
 await moteClick(button(app.panel(), '返回主对话'))
 await vi.waitFor(() => expect(visibleBody()!.querySelector('[data-activity-session="' + defaultAgent.id + '"]')).not.toBeNull())
 expect(visibleBody()!.querySelector('[data-activity-session="' + defaultAgent.id + '"]')).toBe(mainBody)
 expect(useAppStore.getState().agentComposerDrafts).toEqual(original.agentComposerDrafts)
 expect(useAppStore.getState().tabs).toBe(original.tabs); expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})
it('unknown role refresh retains the exact readable Main and Composer DOM', async () => {
 await open(); const body = visibleBody(), composer = mainEditor()
 expect(composer).not.toBeNull()
 failRead = true
 await moteClick(button(app.panel(), '工作')); await moteClick(button(app.panel(), '返回主对话'))
 await vi.waitFor(() => expect(reading.mock.calls.length).toBeGreaterThan(1))
 expect(visibleBody()).toBe(body); expect(mainEditor()).toBe(composer)
 expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
})

it('explicit worker input remains generic after that worker becomes Main in the real App', async () => {
 useAppStore.setState({ send: actualSend })
 vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
 vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(null)
 const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (control, _body, id) => promptCarrierWaiting(control.agentSessionId, control.run.runId, id))
 await open(); await moteClick(button(app.panel(), '工作'))
 await openMemberWorkspace()
 currentMain = { ...main, sessionId: neighborAgent.id, tabId: neighborTab.id, regionId: neighborTab.layout.activeRegionId }
 await act(async () => useAppStore.setState(state => ({ scratchTopicSnapshots: Object.fromEntries(Object.entries(state.scratchTopicSnapshots).map(([id, value]) => [id, { ...value,
   topics: value.topics === null ? null : value.topics.map(topic => topic.id === moteTopics[0]!.id ? { ...topic, quickMode: { status: 'saved', version: 'role-B', defaults: { conversation: currentMain } } } : topic) }])) })))
 await vi.waitFor(() => expect(reading.mock.calls.length).toBeGreaterThan(1))
 const surface = visibleBody()!.querySelector('[data-activity-session="' + neighborAgent.id + '"]')!.closest('.agent-surface')!
 await moteType(surface.querySelector<HTMLElement>('[aria-label="Message Agent"]')!, '继续原成员工作')
 await moteClick(button(surface, 'Send'))
 await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
 expect(submit.mock.calls[0]![0].agentSessionId).toBe(neighborAgent.id)
 expect(submit.mock.calls[0]![4]?.moteMain).toBeUndefined()
})

it('explicitly reopening the same Mote returns from a worker to Main through one new entry', async () => {
 await open(); await moteClick(button(app.panel(), '工作'))
 await openMemberWorkspace()
 await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: moteTopics[0]!.id }))
 await settleMoteApp()
 expect(app.panel().querySelector('[data-mote-workface]')?.getAttribute('data-mote-section')).toBe('discussion')
 expect(visibleBody()!.querySelector('[data-activity-session="' + defaultAgent.id + '"]')).not.toBeNull()
 expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})
it('known Main B cannot silently downgrade a newly authored logical Main input to old A', async () => {
 useAppStore.setState({ send: actualSend })
 vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
 vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(null)
 const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (control, _body, id) => promptCarrierWaiting(control.agentSessionId, control.run.runId, id))
 await open()
 await moteType(mainEditor(), '原主对话的新问题，保留原稿')
 currentMain = { ...main, sessionId: neighborAgent.id, tabId: neighborTab.id, regionId: neighborTab.layout.activeRegionId }
 await act(async () => useAppStore.setState(state => ({ scratchTopicSnapshots: Object.fromEntries(Object.entries(state.scratchTopicSnapshots).map(([id, value]) => [id, { ...value,
  topics: value.topics === null ? null : value.topics.map(topic => topic.id === moteTopics[0]!.id ? { ...topic, quickMode: { status: 'saved', version: 'confirmed-role-B', defaults: { conversation: currentMain } } } : topic) }])) })))
 await vi.waitFor(async () => expect((await reading.mock.results.at(-1)!.value).main.current).toEqual(currentMain))
 await moteClick(button(mainComposer(), 'Send'))
 expect(submit).not.toHaveBeenCalled()
 expect(useLauncherState.getState().drafts[mainDraftKey]?.prompt).toContain('原主对话的新问题，保留原稿')
 expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
 expect(document.body.textContent).toContain('主 Agent 已更换')
 expect(app.stop).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled()
})
it('a missing Session observation does not bring back the IDE tabbar or remove original work', async () => {
 await open(); const before = useAppStore.getState(), body = visibleBody()
 await act(async () => useAppStore.setState({ sessions: before.sessions.filter(session => session.id !== defaultAgent.id) }))
 expect(visibleBody()).toBe(body)
 expect(visibleBody()!.querySelector('.pane-tabbar')?.hasAttribute('hidden')).toBe(true)
 expect(useAppStore.getState().tabs).toBe(before.tabs)
 expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
 expect(app.stop).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled()
})
it('typed unconfirmed Main source never silently sends a new logical Main input as generic A', async () => {
 useAppStore.setState({ send: actualSend })
 const submit = vi.spyOn(api.sessions, 'submitPrompt')
 await open()
 const body = visibleBody(), editor = mainEditor()
 await moteType(editor, '主角色暂未确认时保留原稿')
 typedUnconfirmed = true
 await moteClick(button(app.panel(), '工作')); await moteClick(button(app.panel(), '返回主对话'))
 await vi.waitFor(() => expect(app.panel().textContent).toContain('原文件读取暂不可用'))
 expect(visibleBody()).toBe(body)
 await moteClick(button(mainComposer(), 'Send'))
 expect(submit).not.toHaveBeenCalled()
 expect(useLauncherState.getState().drafts[mainDraftKey]?.prompt).toContain('主角色暂未确认时保留原稿')
 expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
 expect(app.panel().textContent).toContain('原文件读取暂不可用')
 expect(mainEditor()).toBe(editor)
 expect(editor.getAttribute('contenteditable')).toBe('true')
 expect(app.stop).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled()
})
it('explicit Discussion restores Main input intent when the already selected member becomes Main', async () => {
 useAppStore.setState({ send: actualSend })
 vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
 vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(null)
 const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (control, _body, id) => promptCarrierWaiting(control.agentSessionId, control.run.runId, id))
 await open(); await moteClick(button(app.panel(), '工作'))
 await openMemberWorkspace()
 currentMain = { ...main, sessionId: neighborAgent.id, tabId: neighborTab.id, regionId: neighborTab.layout.activeRegionId }
 await act(async () => useAppStore.setState(state => ({ scratchTopicSnapshots: Object.fromEntries(Object.entries(state.scratchTopicSnapshots).map(([id, value]) => [id, { ...value,
  topics: value.topics === null ? null : value.topics.map(topic => topic.id === moteTopics[0]!.id ? { ...topic, quickMode: { status: 'saved', version: 'main-was-member', defaults: { conversation: currentMain } } } : topic) }])) })))
 await settleMoteApp()
 await moteClick(button(app.panel(), '返回主对话')); await settleMoteApp()
 await vi.waitFor(() => expect(readPmoTeamsTopicFloatingState()).toMatchObject({ conversationIntent: 'main', reference: { tabId: neighborTab.id } }))
 expect(visibleBody()?.querySelector('[data-activity-session="' + neighborAgent.id + '"]')).not.toBeNull()
 await moteType(mainEditor(), '明确回到现在的主对话')
 await moteClick(button(mainComposer(), 'Send'))
 await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
 expect(submit.mock.calls[0]![0].agentSessionId).toBe(neighborAgent.id)
 expect(submit.mock.calls[0]![4]?.moteMain).toEqual({ target: expect.any(Object), expectedRoleRevision: 'role-' + neighborAgent.id })
})

it('a new Main startup card must not describe the retained old conversation', async () => {
  useAppStore.setState(state => ({ sessions: state.sessions.map(value => value.id === neighborAgent.id && value.kind === 'agent' ? { ...value,
    terminalFrontend: { run: neighborAgent.control.run, frontendId: 'new-main-attached', state: 'attached', backendState: 'running', source: 'managed-process', observedAt: 1000,
      initialization: { lifecycleOperationId: 'new-main-setup', phase: 'unknown', native: { state: 'unknown' } } } } : value) }))
  await open()
  expect(visibleBody()?.querySelector('[data-activity-session="' + defaultAgent.id + '"]')).not.toBeNull()
  currentMain = { ...main, sessionId: neighborAgent.id, tabId: neighborTab.id, regionId: neighborTab.layout.activeRegionId }
  await act(async () => useAppStore.setState(state => ({ scratchTopicSnapshots: Object.fromEntries(Object.entries(state.scratchTopicSnapshots).map(([id, value]) => [id, { ...value,
    topics: value.topics === null ? null : value.topics.map(topic => topic.id === moteTopics[0]!.id ? { ...topic, quickMode: { status: 'saved', version: 'confirmed-role-B', defaults: { conversation: currentMain } } } : topic) }])) })))
  await vi.waitFor(() => expect(document.body.textContent).toContain('主 Agent 已更换'))
  await settleMoteApp()
  expect(readPmoTeamsTopicFloatingState().reference?.tabId).toBe(defaultTab.id)
  expect(visibleBody()?.querySelector('[data-activity-session="' + defaultAgent.id + '"]')).not.toBeNull()
  expect(visibleBody()?.querySelector('[data-activity-session="' + defaultAgent.id + '"]')?.closest('.agent-surface')?.getAttribute('aria-hidden')).not.toBe('true')
  const readingRoot = visibleBody()!.closest<HTMLElement>('[data-mote-workface]')!
  expect([...readingRoot.children].find(node => node.getAttribute('aria-label') === 'Mote startup')?.getAttribute('data-startup-session'),
    'The retained old reading cannot borrow another Main startup state').not.toBe(neighborAgent.id)
})
