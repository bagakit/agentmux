// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { TopicFilesTool } from '../src/renderer/src/components/TopicFilesTool'
import * as floating from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { installFileTreeGeometry } from './helpers/file-tree-geometry'
import { qualityTopics, seedTopicNavigation, topicWorkspace } from './fixtures/topics-navigation-quality'
import { originalTopicAddress } from '../src/shared/space-addresses'
import { mkdir, rename, rm } from 'node:fs/promises'

const dom = composerDOM()
beforeEach(() => {
  installFileTreeGeometry()
  seedTopicNavigation()
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(qualityTopics)
  vi.spyOn(api.spaceObjects, 'appearance').mockResolvedValue({ local: true, icon: null })
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
  vi.spyOn(api.topics, 'call').mockImplementation(async (method, params) => {
    if (method === 'topic.inspect') {
      const topic = qualityTopics.find(topic => 'topicId' in params && topic.id === params.topicId)!
      return { topic: { topicId: topic.id, hostId: topicWorkspace.hostId, zoneId: originalTopicAddress(topicWorkspace, topic, {})!.zoneId,
        directoryPath: topic.physicalDirectoryPath!, title: topic.title, summary: topic.summary, categorySpaceIds: [], chatIds: [], spatialRevision: 0, contentKind: 'topic' }, unavailable: [] } as never
    }
    if (method === 'topic.knowledge.ls') return { entries: [], documents: [], unavailable: [] } as never
    throw new Error(`Unexpected Topic operation: ${method}`)
  })
})
const directory = (visible = true) => <TopicFilesTool workspace={topicWorkspace} isScratch visible={visible} actions={null} />
const chosen = (name: string) => dom.container.querySelector(`[aria-label="Show ${name}"]`)?.getAttribute('aria-selected')
const input = () => dom.container.querySelector<HTMLInputElement>('.topic-knowledge-search input')!
async function text(node: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('the real file-tool consumer seeds only new panels and preserves the current view, query, selection and workface', async () => {
  const before = useAppStore.getState()
  await dom.render(directory())
  const original = dom.container.querySelector('.topic-navigation-panel')!
  expect(chosen('Topics')).toBe('true')
  expect(dom.container.querySelector('.topic-knowledge-panel')).toBeNull()
  expect(api.topics.call).not.toHaveBeenCalled()
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, topicDirectoryInitialView: 'knowledge' } })))
  expect(dom.container.querySelector('.topic-navigation-panel')).toBe(original)
  expect(chosen('Topics')).toBe('true')
  expect(dom.container.querySelector('.topic-knowledge-panel')).toBeNull()
  await dom.render(null)
  await dom.render(directory())
  expect(chosen('Knowledge')).toBe('true')
  expect(input()).not.toBeNull()
  expect(api.topics.call).toHaveBeenCalledWith('topic.inspect', { topicId: qualityTopics[0]!.id })
  expect(api.topics.call).toHaveBeenCalledWith('topic.knowledge.ls', { topicId: qualityTopics[0]!.id, limit: 100 })
  const search = input(), panel = dom.container.querySelector<HTMLElement>('.topic-knowledge-panel')!
  await text(search, 'Original query')
  panel.scrollTop = 73
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, topicDirectoryInitialView: 'topics' } })))
  expect(chosen('Knowledge')).toBe('true')
  expect(input()).toBe(search)
  expect(search.value).toBe('Original query')
  expect(panel.scrollTop).toBe(73)
  await dom.click('[aria-label="Show Topics"]')
  const calls = vi.mocked(api.topics.call).mock.calls.length
  await dom.render(directory(false))
  expect(vi.mocked(api.topics.call).mock.calls).toHaveLength(calls)
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})

it('Settings saves through the original durable ConfigOwner with the absent default and retains a failed later draft', async () => {
  const f = await configOwnerFixture({ workspaces: [topicWorkspace] })
  f.owner.subscribe(saved => useAppStore.setState({ config: saved }))
  useAppStore.setState({ config: f.owner.current, loading: false })
  const save = vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => f.owner.edit(expected!, next))
  await dom.render(<SettingsPanel initialSection="topic" onClose={() => {}} />)
  const pane = dom.container.querySelector('[data-settings-pane="topic"]')!
  expect(pane.querySelector('header small')?.textContent).toBe('Saved: Topics')
  await dom.click('input[value="knowledge"]')
  expect(pane.querySelector('header small')?.textContent).toBe('Saved: Topics')
  expect(save).not.toHaveBeenCalled()
  await act(async () => { await f.owner.update(config => ({ ...config, copyPathsAsAbsolute: true })) })
  await dom.click('[data-settings-pane="topic"] [data-settings-save-bar] button')
  await act(async () => { await save.mock.results[0]!.value })
  expect(save).toHaveBeenCalledOnce()
  expect(save.mock.calls[0]![1]?.topicDirectoryInitialView).toBe('topics')
  expect((await f.disk()).topicDirectoryInitialView).toBe('knowledge')
  expect(f.owner.current.copyPathsAsAbsolute).toBe(true)
  expect(pane.querySelector('header small')?.textContent).toBe('Saved: Knowledge')
  await dom.click('input[value="topics"]')
  const backup = f.store.filePath + '.original'
  await rename(f.store.filePath, backup)
  await mkdir(f.store.filePath)
  try {
    await dom.click('[data-settings-pane="topic"] [data-settings-save-bar] button')
    await act(async () => { await save.mock.results[1]!.value.catch(() => {}) })
    expect(pane.querySelector('[data-settings-save-bar] [role="alert"]')).not.toBeNull()
    expect(pane.querySelector<HTMLInputElement>('input[value="topics"]')!.checked).toBe(true)
    expect(pane.querySelector('header small')?.textContent).toBe('Saved: Knowledge')
    expect(f.owner.current.topicDirectoryInitialView).toBe('knowledge')
    expect(save.mock.calls[1]![1]?.topicDirectoryInitialView).toBe('knowledge')
  } finally {
    await rm(f.store.filePath, { recursive: true })
    await rename(backup, f.store.filePath)
  }
})

it('Promotion discovers the original Club only on explicit entry and never writes a global policy or promotes a Topic', async () => {
  const close = vi.fn(), open = vi.spyOn(floating, 'requestPmoTeamsTopicFloatingOpen').mockImplementation(() => {})
  const save = vi.spyOn(api.config, 'save')
  await dom.render(<SettingsPanel initialSection="mote-promotion" onClose={close} />)
  const pane = dom.container.querySelector('[data-settings-pane="mote-promotion"]')!
  expect(pane.textContent).toContain('Profile')
  expect(pane.textContent).toContain('Quick mode')
  expect(pane.querySelector('input,select,[data-settings-save-bar]')).toBeNull()
  expect(open).not.toHaveBeenCalled()
  expect(api.topics.call).not.toHaveBeenCalled()
  await dom.click('[data-open-mote-club]')
  expect(open).toHaveBeenCalledExactlyOnceWith()
  expect(close).toHaveBeenCalledOnce()
  expect(save).not.toHaveBeenCalled()
  expect(api.topics.call).not.toHaveBeenCalled()
})
