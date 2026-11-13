// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMoteApp, moteClick, moteType, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultAgent, defaultTab, customAgent, customTab, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { requestPmoTeamsTopicFloatingOpen, requestAgentConversationFloatingOpen, requestPmoTeamsTopicFloatingClose } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { promptCarrierWaiting } from './helpers/prompt-carrier-receipt'
import { originalTopicAddress } from '../src/shared/space-addresses'

const actualSend = useAppStore.getState().send
const main = { hostId: 'local', sessionId: defaultAgent.id, displayWorkspaceId: scratchWorkspace.id, groupId: 'mote-group', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
const other = { ...main, sessionId: customAgent.id, tabId: customTab.id, regionId: customTab.layout.activeRegionId }
const targets = moteTopics.map(topic => ({ ...originalTopicAddress(scratchWorkspace, topic, {})!, expectedResource: { hostId: scratchWorkspace.hostId, workspaceId: scratchWorkspace.id, workspacePath: scratchWorkspace.path } }))
let app: MoteAppFixture
let submit: ReturnType<typeof vi.spyOn>
const button = (root: ParentNode, name: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === name || node.getAttribute('aria-label') === name)!
const surface = () => app.panel().querySelector('[data-activity-session="' + defaultAgent.id + '"]')!.closest('.agent-surface')!
beforeEach(() => {
 app = createMoteApp()
 const topics = moteTopics.map((topic, i) => ({ ...topic, quickMode: { status: 'saved' as const, version: 'source-' + topic.id, defaults: { conversation: i ? other : main } } }))
 useAppStore.setState({ send: actualSend, scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), topics, revision: 0, error: null, reading: false } } })
 vi.mocked(api.scratch.listTopics).mockResolvedValue(topics)
 vi.mocked(api.scratch.readTopic).mockImplementation(async (_w, id) => topics.find(topic => topic.id === id) ?? null)
 vi.spyOn(api.moteDialogue, 'read').mockImplementation(async (input: any) => {
  const index = targets.findIndex(target => JSON.stringify(target) === JSON.stringify(input.target))
  expect(index).toBeGreaterThanOrEqual(0)
  const current = index === 0 ? main : other
  return { main: { target: input.target, identity: { hostId: 'local', moteId: moteTopics[index]!.id }, status: 'ready', resource: null, documentRevision: 'doc', roleRevision: 'role-' + current.sessionId, current, issue: null }, links: [], incarnation: 'links', throughSequence: 0, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null } as any
 })
 vi.spyOn(api.motePreferences, 'read').mockResolvedValue({ status: 'unconfirmed', issue: null, source: null, choices: { executors: [], conversations: [], destinations: [] }, defaults: {} } as any)
 vi.spyOn(api.moteDialogue, 'inspectRecovery').mockResolvedValue({ operation: null } as any)
 vi.spyOn(api.moteDialogue, 'ensureRecovery').mockRejectedValue(Error('Controlled recovery boundary'))
 vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
 vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
 vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(null)
 submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (control, _body, id) => promptCarrierWaiting(control.agentSessionId, control.run.runId, id))
})
afterEach(async () => { await act(async () => requestPmoTeamsTopicFloatingClose({ restoreFocus: false })); await app.dispose() })
async function sendMain(text: string) {
 await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: moteTopics[0]!.id }))
 await settleMoteApp()
 await vi.waitFor(() => expect(surface()).not.toBeNull())
 expect(surface().closest('[hidden], [inert], [aria-hidden="true"]')).toBeNull()
 await moteType(surface().querySelector<HTMLElement>('[aria-label="Message Agent"]')!, text)
 await moteClick(button(surface(), 'Send'))
 await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
 expect(submit.mock.calls[0]![0].agentSessionId).toBe(defaultAgent.id)
 expect(submit.mock.calls[0]![4]?.moteMain).toEqual({ target: targets[0], expectedRoleRevision: 'role-' + defaultAgent.id })
}
it('Main opens and sends from Focus while its original workspace is in the background', async () => {
 useAppStore.setState({ activeWorkspaceId: 'project', mainSurface: 'agents' })
 await app.mount()
 await sendMain('从 Focus 继续原主对话')
 expect(useAppStore.getState().activeWorkspaceId).toBe('project')
 expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})
it('another Mote in the background cannot supply the visible Main role or callbacks', async () => {
 useAppStore.getState().activateTab(scratchWorkspace.id, 'mote-group', customTab.id)
 await app.mount()
 await sendMain('给当前浮窗的主对话')
 expect(useAppStore.getState().tabs[customTab.id]).toBeDefined()
})
it('a background member intent cannot downgrade the floating Main to generic input', async () => {
 useAppStore.getState().activateTab(scratchWorkspace.id, 'mote-group', customTab.id)
 await app.mount()
 await act(async () => useAppStore.setState({ moteDiscussionEntry: { workspaceId: scratchWorkspace.id, topicId: moteTopics[1]!.id, token: 'explicit-background-member', memberReference: other } }))
 await settleMoteApp()
 expect(app.container.querySelector('[data-workspace-id="' + scratchWorkspace.id + '"] [data-mote-workface]')?.getAttribute('data-mote-section')).toBe('threads')
 await sendMain('浮窗 Main 保持逻辑主输入')
})
it('a retained Composer rollover action reaches its displayed shell and preserves the original Query', async () => {
 useAppStore.setState({ activeWorkspaceId: 'project', mainSurface: 'agents' })
 await app.mount()
 await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: moteTopics[0]!.id }))
 await settleMoteApp()
 const target = targets[0]!
 const entry = { operationId: 'original_rollover_query', text: '保留原问题并接到当前浮窗的新对话', createdAt: 1,
  mainRollover: { target, expectedRoleRevision: 'role-' + defaultAgent.id, reference: main, policyRevision: 'original-policy', policy: { kind: 'idle', idleMs: 60000 },
   activity: { inputKey: { kind: 'prompt', agentSessionId: defaultAgent.id, expectedRun: defaultAgent.control.kind === 'agent' ? defaultAgent.control.run : { runId: '' }, submissionId: 'previous_input' }, run: defaultAgent.control.kind === 'agent' ? defaultAgent.control.run : { runId: '' }, sourceId: 'native', sequence: 1, idleSince: 1 },
   evaluatedAt: 60001, queryOperationId: 'original_rollover_query', creationOperationId: 'original_rollover_creation' } }
 await act(async () => useAppStore.setState({ agentSteerQueues: { [defaultAgent.id]: [entry as any] } }))
 await vi.waitFor(() => expect(app.panel().textContent).toContain('正在按此 Mote 的空闲策略承接原输入'))
 expect(app.panel().textContent).toContain(entry.text)
 expect(useAppStore.getState().agentSteerQueues[defaultAgent.id]?.[0]?.operationId).toBe(entry.operationId)
 expect(submit).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})
it('an explicitly opened Agent remains a direct member regardless of background Main', async () => {
 await app.mount()
 await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: moteTopics[0]!.id }))
 await settleMoteApp()
 const original = surface().querySelector<HTMLElement>('[aria-label="Message Agent"]')!
 await moteType(original, '从主对话保留的未发草稿')
 await act(async () => requestAgentConversationFloatingOpen(defaultAgent.id, 'local'))
 await settleMoteApp()
 expect(surface().querySelector('[aria-label="Message Agent"]')).toBe(original)
 expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('从主对话保留的未发草稿')
 await moteType(surface().querySelector<HTMLElement>('[aria-label="Message Agent"]')!, '明确给这位 Agent')
 await moteClick(button(surface(), 'Send'))
 await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
 expect(submit.mock.calls[0]![4]?.moteMain).toBeUndefined()
 const waiting = useAppStore.getState().agentSteerQueues[defaultAgent.id]![0]!
 await moteType(original, '回到主对话也保留原稿')
 await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: moteTopics[0]!.id }))
 await settleMoteApp()
 expect(surface().querySelector('[aria-label="Message Agent"]')).toBe(original)
 expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('回到主对话也保留原稿')
 await moteClick(button(surface(), 'Send'))
 const queued = useAppStore.getState().agentSteerQueues[defaultAgent.id]!
 expect(queued.find(entry => entry.text === '回到主对话也保留原稿')?.moteMain).toEqual({ target: targets[0], expectedRoleRevision: 'role-' + defaultAgent.id })
 expect(queued.find(entry => entry.operationId === waiting.operationId)?.moteMain).toBeUndefined()
 await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2))
 expect(submit.mock.calls[1]![4]?.moteMain).toEqual({ target: targets[0], expectedRoleRevision: 'role-' + defaultAgent.id })
 expect(submit.mock.calls[1]![2]).not.toBe(submit.mock.calls[0]![2])
})
