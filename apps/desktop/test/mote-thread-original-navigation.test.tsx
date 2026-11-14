// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { customAgent, customTab, defaultAgent, defaultTab, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import type { MoteDialoguePage } from '@agentmux/core/mote-dialogue'

let app: MoteAppFixture
const main = { hostId: 'local', sessionId: defaultAgent.id, displayWorkspaceId: scratchWorkspace.id,
  groupId: 'mote-group', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
const source: Extract<MoteDialoguePage['links'][number], { kind: 'work' }> = {
  kind: 'work', identity: { hostId: 'local', moteId: moteTopics[0]!.id }, sequence: 1, eventId: 'original-work', operationId: 'link-original', associatedAt: 1,
  mainRoleRevision: 'original-main', main: { hostId: 'local', agentSessionId: defaultAgent.id },
  origin: { hostId: 'local', messageId: 'original-source', threadId: 'original-wire-thread', senderSessionId: defaultAgent.id,
    recipientSessionId: customAgent.id, createdAt: 1 }
}
const button = (root: ParentNode, name: string) => [...root.querySelectorAll<HTMLButtonElement>('button')]
  .find(node => node.textContent?.trim() === name || node.getAttribute('aria-label') === name)!
const workPanel = () => app.panel().querySelector<HTMLElement>('.mote-threads-panel:not([hidden])')!

beforeEach(() => {
  app = createMoteApp()
  const topics = moteTopics.map((topic, index) => index ? topic : { ...topic, quickMode: {
    status: 'saved' as const, version: 'original-doc', defaults: { conversation: main }
  } })
  useAppStore.setState({ scratchTopicSnapshots: { [scratchWorkspace.id]: {
    scope: scratchTopicsScope(scratchWorkspace), topics, revision: 0, error: null, reading: false
  } } })
  vi.mocked(api.scratch.listTopics).mockResolvedValue(topics)
  vi.mocked(api.scratch.readTopic).mockImplementation(async (_workspace, id) => topics.find(topic => topic.id === id) ?? null)
  vi.spyOn(api.moteDialogue, 'read').mockImplementation(async ({ target }) => ({ main: { target,
    identity: source.identity, status: 'ready', resource: null, documentRevision: 'original-doc', roleRevision: 'original-main', current: main, issue: null },
    links: [source], incarnation: 'original-links', throughSequence: 1, next: null,
    coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null }))
  vi.spyOn(api.motePreferences, 'read').mockResolvedValue({ status: 'unconfirmed', issue: 'Read-only settings fixture', source: null,
    choices: { executors: [], conversations: [], destinations: [] }, defaults: {}, maintenance: { status: 'unconfirmed', schedule: null, issue: null } } as never)
  vi.spyOn(api.moteDialogue, 'inspectRecovery').mockResolvedValue({ operation: null })
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
  vi.spyOn(api.sessions, 'dispatch').mockResolvedValue({ hostId: 'local', source: { envelope: { ...source.origin, body: 'Keep the original scoped result' } },
    dispatch: { sourceMessageId: source.origin.messageId, threadId: source.origin.threadId, ownerAgentSessionId: defaultAgent.id,
      workerAgentSessionId: customAgent.id, openedAt: 1, originAwaits: false, events: [] }, replies: [], identityDiagnostics: [] } as never)
})
afterEach(async () => { await app.dispose() })

async function openOriginalWork() {
  await app.mount()
  await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: moteTopics[0]!.id }))
  await settleMoteApp()
  await moteClick(button(app.panel(), '工作'))
  await vi.waitFor(() => expect(workPanel()?.querySelector('.mote-work-event__summary')).not.toBeNull())
  await moteClick(workPanel().querySelector<HTMLButtonElement>('.mote-work-event__summary')!)
  await vi.waitFor(() => expect(button(workPanel(), '继续原工作')).toBeDefined())
}

it('the actual Club workface opens an original worker occurrence after that Thread belongs to another Club', async () => {
  const identities = () => useAppStore.getState().sessions.map(session => ({ id: session.id, control: session.control, workspacePath: session.workspacePath }))
  const sessions = identities(), drafts = useAppStore.getState().agentComposerDrafts
  await openOriginalWork()
  await moteClick(button(workPanel(), '继续原工作'))
  const state = useAppStore.getState()
  expect(state.workbenchSpaceSelection).toMatchObject({ workspaceId: scratchWorkspace.id, groupId: 'mote-group',
    tabId: customTab.id, regionId: customTab.layout.activeRegionId })
  expect(state.mainSurface).toBe('agents')
  expect(readPmoTeamsTopicFloatingState().open).toBe(false)
  await vi.waitFor(() => expect(app.container.querySelector('.global-focus-surface:not([hidden]) [data-activity-session="' + customAgent.id + '"]')).not.toBeNull())
  expect(identities()).toEqual(sessions); expect(state.agentComposerDrafts).toEqual(drafts)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('an equal worker SID on a foreign Host does not become an original work occurrence', async () => {
  useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === customAgent.id && session.kind === 'agent'
    ? { ...session, control: { ...session.control, hostId: 'foreign-host' } } : session) }))
  const before = useAppStore.getState().workbenchSpaceSelection
  await openOriginalWork()
  await moteClick(button(workPanel(), '继续原工作'))
  expect(readPmoTeamsTopicFloatingState().open).toBe(true)
  expect(workPanel().textContent).toContain('原执行成员的位置暂未确认')
  expect(useAppStore.getState().workbenchSpaceSelection).toEqual(before)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})
