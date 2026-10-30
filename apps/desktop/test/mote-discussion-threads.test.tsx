// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMoteApp, moteClick, moteType, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultAgent, defaultTab, neighborAgent, neighborTab, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { promptCarrierWaiting } from './helpers/prompt-carrier-receipt'
import type { MoteDialoguePage } from '@agentmux/core/mote-dialogue'
const main = { hostId: 'local', sessionId: defaultAgent.id, displayWorkspaceId: scratchWorkspace.id, groupId: 'mote-group', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
const actualSend = useAppStore.getState().send
let currentMain = main
let app: MoteAppFixture, reading: ReturnType<typeof vi.spyOn>, failRead = false, typedUnconfirmed = false
const page = (target: any): MoteDialoguePage => ({ main: { target, identity: { hostId: 'local', moteId: moteTopics[0]!.id }, status: 'ready', resource: null, documentRevision: 'original-doc', roleRevision: 'role-' + currentMain.sessionId, current: currentMain, issue: null }, links: [], incarnation: 'original-links', throughSequence: 0, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null })
const button = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label)!
const visibleBody = () => app.panel().querySelector<HTMLElement>('[data-mote-workface] .mote-workface__original:not([hidden])')
beforeEach(() => {
 failRead = false; typedUnconfirmed = false; currentMain = main; app = createMoteApp()
 const topics = moteTopics.map((topic, i) => i ? topic : { ...topic, quickMode: { status: 'saved' as const, version: 'original-doc', defaults: { conversation: main } } })
 useAppStore.setState({ scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), topics, revision: 0, error: null, reading: false } } })
 vi.mocked(api.scratch.listTopics).mockResolvedValue(topics); vi.mocked(api.scratch.readTopic).mockImplementation(async (_w, id) => topics.find(topic => topic.id === id) ?? null)
 reading = vi.spyOn(api.moteDialogue, 'read').mockImplementation(async (input: any) => { if (failRead) throw Error('原角色读取暂不可用'); const value = page(input.target); return typedUnconfirmed ? { ...value, main: { ...value.main, status: 'unconfirmed', current: null, roleRevision: null, issue: '原文件读取暂不可用' } } : value })
 vi.spyOn(api.motePreferences, 'read').mockImplementation(async (input: any) => ({ target: input.target, status: 'unconfirmed', issue: 'Settings fixture is read-only', source: null, choices: { executors: [], conversations: [], destinations: [] }, defaults: {}, maintenance: { status: 'unconfirmed', schedule: null, issue: null } } as any))
 vi.spyOn(api.moteDialogue, 'inspectRecovery').mockResolvedValue({ operation: null } as any)
 vi.spyOn(api.moteDialogue, 'ensureRecovery').mockRejectedValue(Error('Controlled recovery boundary'))
 vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
})
afterEach(async () => { await app.dispose() })
async function open() { await app.mount(); await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: moteTopics[0]!.id })); await settleMoteApp(); await vi.waitFor(() => expect(visibleBody()).not.toBeNull()) }
it('real compact entry opens exact Main, Threads selects a worker and Discussion returns with original DOM and drafts', async () => {
 await open(); const original = useAppStore.getState(), mainBody = app.panel().querySelector('[data-activity-session="' + defaultAgent.id + '"]')
 expect(visibleBody()!.querySelector('[data-activity-session="' + defaultAgent.id + '"]')).not.toBeNull()
 expect(visibleBody()!.querySelector('.pane-tabbar')?.hasAttribute('hidden')).toBe(true)
 expect(button(app.panel(), '原工作面')).toBeUndefined()
 await moteClick(button(app.panel(), 'Threads'))
 expect(app.panel().querySelector('.mote-threads-panel:not([hidden])')).not.toBeNull(); expect(visibleBody()).toBeNull()
 const worker = app.panel().querySelector<HTMLElement>('[data-mote-member="' + neighborAgent.id + '"]')!
 expect(worker).not.toBeNull(); await moteClick(worker.querySelector('button')!)
 expect(app.panel().querySelector('[data-mote-workface]')?.getAttribute('data-mote-section')).toBe('threads')
 expect(visibleBody()).not.toBeNull()
 expect(visibleBody()!.querySelector('[data-activity-session="' + neighborAgent.id + '"]')).not.toBeNull()
 await moteClick(button(app.panel(), '在工作区打开 ↗'))
 expect(app.panel().querySelector('[data-mote-workface-presentation="workface"]')).not.toBeNull()
 expect(visibleBody()!.querySelector('.pane-tabbar')?.hasAttribute('hidden')).toBe(false)
 await moteClick(button(app.panel(), 'Discussion'))
 await vi.waitFor(() => expect(visibleBody()!.querySelector('[data-activity-session="' + defaultAgent.id + '"]')).not.toBeNull())
 expect(app.panel().querySelector('[data-activity-session="' + defaultAgent.id + '"]')).toBe(mainBody)
 expect(useAppStore.getState().agentComposerDrafts).toEqual(original.agentComposerDrafts)
 expect(useAppStore.getState().tabs).toBe(original.tabs); expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})
it('unknown role refresh retains the exact readable Main and Composer DOM', async () => {
 await open(); const body = visibleBody(), composer = body!.querySelector('[aria-label="Message Agent"]')
 failRead = true
 await moteClick(button(app.panel(), 'Threads')); await moteClick(button(app.panel(), 'Discussion'))
 await vi.waitFor(() => expect(reading.mock.calls.length).toBeGreaterThan(1))
 expect(visibleBody()).toBe(body); expect(visibleBody()!.querySelector('[aria-label="Message Agent"]')).toBe(composer)
 expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
})

it('explicit worker input remains generic after that worker becomes Main in the real App', async () => {
 useAppStore.setState({ send: actualSend })
 vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
 vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(null)
 const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (control, _body, id) => promptCarrierWaiting(control.agentSessionId, control.run.runId, id))
 await open(); await moteClick(button(app.panel(), 'Threads'))
 await moteClick(app.panel().querySelector<HTMLElement>('[data-mote-member="' + neighborAgent.id + '"] button')!)
 currentMain = { ...main, sessionId: neighborAgent.id, tabId: neighborTab.id, regionId: neighborTab.layout.activeRegionId }
 await act(async () => useAppStore.setState(state => ({ scratchTopicSnapshots: Object.fromEntries(Object.entries(state.scratchTopicSnapshots).map(([id, value]) => [id, { ...value,
   topics: value.topics?.map(topic => topic.id === moteTopics[0]!.id ? { ...topic, quickMode: { status: 'saved', version: 'role-B', defaults: { conversation: currentMain } } } : topic) }])) })))
 await vi.waitFor(() => expect(reading.mock.calls.length).toBeGreaterThan(1))
 const surface = visibleBody()!.querySelector('[data-activity-session="' + neighborAgent.id + '"]')!.closest('.agent-surface')!
 await moteType(surface.querySelector<HTMLElement>('[aria-label="Message Agent"]')!, '继续原成员工作')
 await moteClick(button(surface, 'Send'))
 await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
 expect(submit.mock.calls[0]![0].agentSessionId).toBe(neighborAgent.id)
 expect(submit.mock.calls[0]![4]?.moteMain).toBeUndefined()
})

it('explicitly reopening the same Mote returns from a worker to Main through one new entry', async () => {
 await open(); await moteClick(button(app.panel(), 'Threads'))
 await moteClick(app.panel().querySelector<HTMLElement>('[data-mote-member="' + neighborAgent.id + '"] button')!)
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
 const surface = visibleBody()!.querySelector('[data-activity-session="' + defaultAgent.id + '"]')!.closest('.agent-surface')!
 const editor = surface.querySelector<HTMLElement>('[aria-label="Message Agent"]')!
 await moteType(editor, '原主对话的新问题，保留原稿')
 currentMain = { ...main, sessionId: neighborAgent.id, tabId: neighborTab.id, regionId: neighborTab.layout.activeRegionId }
 await act(async () => useAppStore.setState(state => ({ scratchTopicSnapshots: Object.fromEntries(Object.entries(state.scratchTopicSnapshots).map(([id, value]) => [id, { ...value,
  topics: value.topics?.map(topic => topic.id === moteTopics[0]!.id ? { ...topic, quickMode: { status: 'saved', version: 'confirmed-role-B', defaults: { conversation: currentMain } } } : topic) }])) })))
 await vi.waitFor(() => expect(app.panel().textContent).toContain('主 Agent 已更换'))
 await moteClick(button(surface, 'Send'))
 expect(submit).not.toHaveBeenCalled()
 expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toContain('原主对话的新问题，保留原稿')
 expect(app.panel().textContent).toContain('原输入尚未发送')
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
 const body = visibleBody(), editor = body!.querySelector<HTMLElement>('[aria-label="Message Agent"]')!
 await moteType(editor, '主角色暂未确认时保留原稿')
 typedUnconfirmed = true
 await moteClick(button(app.panel(), 'Threads')); await moteClick(button(app.panel(), 'Discussion'))
 await vi.waitFor(() => expect(app.panel().textContent).toContain('原文件读取暂不可用'))
 expect(visibleBody()).toBe(body)
 await moteClick(button(body!, 'Send'))
 expect(submit).not.toHaveBeenCalled()
 expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toContain('主角色暂未确认时保留原稿')
 expect(app.panel().textContent).toContain('主对话的原角色来源暂未确认')
 expect(editor.getAttribute('contenteditable')).toBe('true')
 expect(app.stop).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled()
})
it('explicit Discussion restores Main input intent when the already selected member becomes Main', async () => {
 useAppStore.setState({ send: actualSend })
 vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
 vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(null)
 const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (control, _body, id) => promptCarrierWaiting(control.agentSessionId, control.run.runId, id))
 await open(); await moteClick(button(app.panel(), 'Threads'))
 await moteClick(app.panel().querySelector<HTMLElement>('[data-mote-member="' + neighborAgent.id + '"] button')!)
 currentMain = { ...main, sessionId: neighborAgent.id, tabId: neighborTab.id, regionId: neighborTab.layout.activeRegionId }
 await act(async () => useAppStore.setState(state => ({ scratchTopicSnapshots: Object.fromEntries(Object.entries(state.scratchTopicSnapshots).map(([id, value]) => [id, { ...value,
  topics: value.topics?.map(topic => topic.id === moteTopics[0]!.id ? { ...topic, quickMode: { status: 'saved', version: 'main-was-member', defaults: { conversation: currentMain } } } : topic) }])) })))
 await settleMoteApp()
 await moteClick(button(app.panel(), 'Discussion')); await settleMoteApp()
 await vi.waitFor(() => expect(readPmoTeamsTopicFloatingState()).toMatchObject({ conversationIntent: 'main', reference: { tabId: neighborTab.id } }))
 const surface = visibleBody()!.querySelector('[data-activity-session="' + neighborAgent.id + '"]')!.closest('.agent-surface')!
 await moteType(surface.querySelector<HTMLElement>('[aria-label="Message Agent"]')!, '明确回到现在的主对话')
 await moteClick(button(surface, 'Send'))
 await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
 expect(submit.mock.calls[0]![0].agentSessionId).toBe(neighborAgent.id)
 expect(submit.mock.calls[0]![4]?.moteMain).toEqual({ target: expect.any(Object), expectedRoleRevision: 'role-' + neighborAgent.id })
})
