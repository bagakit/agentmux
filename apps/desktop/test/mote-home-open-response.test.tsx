// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ScratchTopicSnapshot } from '../src/shared/contracts'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { customMoteId, defaultAgent, moteTopics, neighborAgent, neighborTab, quietMoteId } from './fixtures/mote-workface'

let app: MoteAppFixture
const topic = (id = PMO_TEAMS_TOPIC_ID) => moteTopics.find(item => item.id === id)!
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const home = () => app.container.querySelector('[data-surface-tool-dock][data-content-expanded="true"]')
const row = (id = PMO_TEAMS_TOPIC_ID) => {
  const found = app.container.querySelector<HTMLButtonElement>('[data-space-nav="topic:' + id + '"]')
  expect(found).not.toBeNull(); return found!
}
const discussion = () => {
  const found = app.container.querySelector<HTMLButtonElement>('[aria-label="Mote pages"] [data-surface-mode="discussion"]')
  expect(found).not.toBeNull(); return found!
}
beforeEach(() => {
  app = createMoteApp()
  useAppStore.setState({ projectRailOpen: true, activeWorkspaceId: 'project', workbenchSpaceSelection: null,
    mainSurface: 'workbench', toolsOpen: false })
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
  vi.spyOn(api.files, 'readPublic').mockResolvedValue({ resource: null, result: { status: 'unknown', code: 'CONTROLLED_READ', message: 'Controlled file observation unavailable.' } })
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.continuousProgress, 'goals').mockResolvedValue([])
  vi.spyOn(api.schedule, 'list').mockResolvedValue({ schedules: [], executionScope: 'connected-host' })
  vi.spyOn(api.schedule, 'onChanged').mockImplementation(() => () => {})
})
afterEach(async () => { await app.dispose() })

it('opens a known Mote home through the real App while its metadata read is unresolved', async () => {
  const read = deferred<ScratchTopicSnapshot | null>()
  vi.mocked(api.scratch.readTopic).mockReturnValue(read.promise)
  await app.mount()
  const before = useAppStore.getState()
  await moteClick(row())
  expect(home()).not.toBeNull()
  expect(home()!.querySelector('[data-mote-details="' + PMO_TEAMS_TOPIC_ID + '"]')).not.toBeNull()
  expect(api.scratch.readTopic).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID)
  expect(app.ensureMote).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  await act(async () => read.resolve({ ...topic(), quickMode: { status: 'saved', version: 'new-original-preference',
    defaults: { conversation: { hostId: neighborAgent.hostId, sessionId: neighborAgent.id,
      displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-group', tabId: neighborTab.id, regionId: 'neighbor-region' } } } })); await settleMoteApp()
  expect(home()).not.toBeNull()
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('keeps the revealed original home and reports a failed metadata refresh without repairing files', async () => {
  const read = deferred<ScratchTopicSnapshot | null>()
  vi.mocked(api.scratch.readTopic).mockReturnValue(read.promise)
  await app.mount(); await moteClick(row())
  const original = home(), selection = useAppStore.getState().workbenchSpaceSelection
  expect(original).not.toBeNull()
  await act(async () => read.reject(new Error('Original Mote read unavailable.'))); await settleMoteApp()
  expect(home()).toBe(original)
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(selection)
  expect(useAppStore.getState().reportError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Original Mote read unavailable.' }), expect.objectContaining({ kind: 'indeterminate' }))
  expect(app.ensureMote).not.toHaveBeenCalled()
})

it('does not let a late metadata receipt reopen the home after Discussion and later input', async () => {
  const read = deferred<ScratchTopicSnapshot | null>()
  vi.mocked(api.scratch.readTopic).mockReturnValue(read.promise)
  await app.mount(); await moteClick(row()); await moteClick(discussion())
  expect(home()).toBeNull()
  await act(async () => {
    useAppStore.getState().setAgentComposerDraft(defaultAgent.id, 'Keep the later original discussion draft.')
    document.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const selection = useAppStore.getState().workbenchSpaceSelection
  await act(async () => read.resolve({ ...topic(), quickMode: { status: 'saved', version: 'new-original-preference',
    defaults: { conversation: { hostId: neighborAgent.hostId, sessionId: neighborAgent.id,
      displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-group', tabId: neighborTab.id, regionId: 'neighbor-region' } } } })); await settleMoteApp()
  expect(home()).toBeNull()
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(selection)
  expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Keep the later original discussion draft.')
})

it('keeps a later Mote selection when the first home metadata arrives', async () => {
  const read = deferred<ScratchTopicSnapshot | null>()
  vi.mocked(api.scratch.readTopic).mockImplementation(async (_workspace, id) => id === PMO_TEAMS_TOPIC_ID ? read.promise : topic(id))
  await app.mount(); await moteClick(row()); await moteClick(row(customMoteId))
  const selection = useAppStore.getState().workbenchSpaceSelection
  expect(selection?.topicId).toBe(customMoteId)
  await act(async () => read.resolve(topic())); await settleMoteApp()
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(selection)
  expect(home()?.querySelector('[data-mote-details="' + customMoteId + '"]')).not.toBeNull()
  expect(app.ensureMote).not.toHaveBeenCalled()
})

it('reveals an original empty Mote before reading without creating a Tab', async () => {
  useAppStore.setState(state => ({ tabs: Object.fromEntries(Object.entries(state.tabs).filter(([, tab]) => tab.topicId !== quietMoteId)) }))
  const read = deferred<ScratchTopicSnapshot | null>()
  vi.mocked(api.scratch.readTopic).mockReturnValue(read.promise)
  await app.mount()
  const tabs = useAppStore.getState().tabs
  await moteClick(row(quietMoteId))
  expect(home()).not.toBeNull()
  expect(useAppStore.getState().workbenchSpaceSelection?.topicId).toBe(quietMoteId)
  expect(useAppStore.getState().tabs).toBe(tabs)
  await act(async () => read.resolve(topic(quietMoteId))); await settleMoteApp()
  expect(useAppStore.getState().tabs).toBe(tabs)
})

it('waits for an unknown Topic identity and never reports a background read as a reveal', async () => {
  useAppStore.setState({ scratchTopicSnapshots: {} })
  const read = deferred<ScratchTopicSnapshot | null>(), onRevealed = vi.fn()
  vi.mocked(api.scratch.readTopic).mockReturnValue(read.promise)
  const pending = useAppStore.getState().openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { onRevealed })
  expect(onRevealed).not.toHaveBeenCalled()
  read.resolve(topic()); await pending
  expect(onRevealed).toHaveBeenCalledOnce()
  onRevealed.mockClear()
  await useAppStore.getState().openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { reveal: false, onRevealed })
  expect(onRevealed).not.toHaveBeenCalled()
  expect(app.ensureMote).not.toHaveBeenCalled()
})
