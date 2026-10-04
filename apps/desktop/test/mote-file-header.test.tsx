import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { scratchWorkspace, moteTopics, customMoteId, ordinaryTopicId, defaultAgent } from './fixtures/mote-workface'
import { WorkspaceFilesTool } from '../src/renderer/src/components/WorkspaceFilesTool'
import { TopicKnowledgeCapture } from '../src/renderer/src/components/TopicKnowledgeEditor'
import { DesktopClientUiProvider } from '../src/renderer/src/components/DesktopClientUiProvider'
import { WindowOverlayHost } from '../src/renderer/src/components/WindowOverlayHost'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
let app: MoteAppFixture, root: ReturnType<typeof createClientUiRoot>, container: HTMLDivElement
beforeEach(() => {
  app = createMoteApp(); container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
  useAppStore.setState({ explorerCollapsed: { [scratchWorkspace.id]: false } })
  vi.spyOn(api.files, 'readDirectory').mockImplementation(async (_id, directory) => [{ path: directory + '/SOUL.md', name: 'SOUL.md', isDirectory: false, isSymlink: false, ignored: false }])
  vi.spyOn(api.files, 'observe').mockResolvedValue(); vi.spyOn(api.files, 'unobserve').mockResolvedValue()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); await app.dispose() })
async function render(topicId = PMO_TEAMS_TOPIC_ID) {
  await act(async () => root.render(createElement(DesktopClientUiProvider, null,
    createElement(WindowOverlayHost), createElement(WorkspaceFilesTool, { workspace: scratchWorkspace, isScratch: true, visible: true, topicId }))))
  await settleMoteApp()
}
it('uses the exact original Mote file root without scope or knowledge controls and preserves manual input', async () => {
  const before = useAppStore.getState(); await render()
  const header = container.querySelector('.workspace-tool-context--explorer')!
  expect(header.textContent).toContain('Mote'); expect(header.textContent).not.toContain('Show all files')
  expect(header.querySelector('[aria-label="Collect sources in a knowledge topic"]')).toBeNull()
  expect(header.querySelector('.workspace-files-scope')).toBeNull()
  expect(api.files.readDirectory).toHaveBeenCalledWith(scratchWorkspace.id, scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID))
  expect(vi.mocked(api.files.readDirectory).mock.calls.every(call => call[1] !== '')).toBe(true)
  await moteClick(header.querySelector('[aria-label="Hide file tree"]')!)
  expect(header.querySelector('[aria-label="Show file tree"]')).not.toBeNull()
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent'); expect(app.stop).not.toHaveBeenCalled()
})
it('keeps the last confirmed Mote root during a directory observation error', async () => {
  await render(customMoteId)
  await act(async () => useAppStore.setState(state => ({ scratchTopicSnapshots: { ...state.scratchTopicSnapshots, [scratchWorkspace.id]: {
    ...state.scratchTopicSnapshots[scratchWorkspace.id]!, topics: moteTopics.map(topic => topic.id === customMoteId ? { ...topic, soul: undefined, readError: 'Metadata upgrade unconfirmed' } : topic)
  } } })))
  await settleMoteApp()
  expect(container.querySelector('.workspace-tool-context--explorer')!.textContent).toContain('Analyst')
  expect(container.querySelector('[aria-label="Collect sources in a knowledge topic"]')).toBeNull()
  expect(vi.mocked(api.files.readDirectory).mock.calls.every(call => call[1] !== '')).toBe(true)
})
it('does not load shared Scratch when the selected object root has never been confirmed', async () => {
  app.listTopics.mockResolvedValue([])
  await act(async () => useAppStore.setState({ scratchTopicSnapshots: {}, spaceZoneBindings: {} }))
  await render(customMoteId)
  expect(container.textContent).toContain("file root is not confirmed")
  expect(container.querySelector('[aria-label="Collect sources in a knowledge topic"]')).toBeNull()
  expect(api.files.readDirectory).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  app.listTopics.mockResolvedValue(moteTopics)
  await moteClick(container.querySelector('[aria-label="Retry directory discovery"]')!)
  expect(api.files.readDirectory).toHaveBeenCalledWith(scratchWorkspace.id, scratchTopicDirectoryName(customMoteId))
  expect(container.querySelector('[aria-label="Collect sources in a knowledge topic"]')).toBeNull()
  expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
})
it('retains ordinary collection with a clear source and destination journey', async () => {
  await render(ordinaryTopicId)
  expect(container.querySelector('[aria-label="Collect sources in a knowledge topic"]')).not.toBeNull()
  const call = vi.spyOn(api.topics, 'call').mockResolvedValue({ topics: [], unavailable: [] } as never)
  await act(async () => root.render(createElement(DesktopClientUiProvider, null, createElement(WindowOverlayHost),
    createElement(TopicKnowledgeCapture, { target: { title: 'design.md', sources: [{ kind: 'file', hostId: 'local', workspaceId: 'project', path: 'design.md', revision: 'sha256:' + 'a'.repeat(64) }] as never }, onClose: vi.fn() }))))
  await settleMoteApp()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Collect sources')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('references to design.md')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Destination topic')
  expect(call).toHaveBeenCalledWith('topic.ls', {}); expect(call).toHaveBeenCalledTimes(1)
})
it('does not borrow the shared root from an ordinary descriptor with an invalid directory', async () => {
  const topics = moteTopics.map(topic => topic.id === ordinaryTopicId ? { ...topic, directoryPath: _hygiene_fixturePath("wrong-root/unrelated-object") } : topic)
  app.listTopics.mockResolvedValue(topics)
  await act(async () => useAppStore.setState(state => ({ scratchTopicSnapshots: { [scratchWorkspace.id]: { ...state.scratchTopicSnapshots[scratchWorkspace.id]!, topics } } })))
  await render(ordinaryTopicId)
  expect(container.textContent).toContain('file root is not confirmed')
  expect(api.files.readDirectory).not.toHaveBeenCalled()
  expect(container.querySelector('[aria-label="Collect sources in a knowledge topic"]')).toBeNull()
  expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
})
