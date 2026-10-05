// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { SurfaceToolDock } from '../src/renderer/src/components/SurfaceToolDock'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { originalTopicAddress } from '../src/shared/space-addresses'
import { scratchTopicLogicalPath } from '../src/shared/scratch-topics'
import { composerDOM } from './helpers/composer-dom-fixture'
import { installFileTreeGeometry } from './helpers/file-tree-geometry'
import { qualityTopics, seedTopicNavigation, topicCategory, topicWorkspace } from './fixtures/topics-navigation-quality'

const dom = composerDOM()
beforeEach(() => {
  installFileTreeGeometry()
  seedTopicNavigation()
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(qualityTopics)
  vi.spyOn(api.spaceObjects, 'appearance').mockResolvedValue({ local: true, icon: null })
  vi.spyOn(api.files, 'readDirectory').mockImplementation(async (_workspace, path) => [
    { name: 'research.md', path: path ? path + '/research.md' : 'research.md', isDirectory: false, isSymlink: false }
  ])
})
const mounted = () => dom.render(<SurfaceToolDock workspace={topicWorkspace} />)
async function settle() { await act(async () => { await new Promise(done => setTimeout(done, 10)) }) }
function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = dom.container.querySelector<T>(selector)
  expect(found, selector).not.toBeNull()
  return found!
}
async function click(selector: string) { await act(async () => element(selector).click()); await settle() }
async function reveal(index: number) {
  const target = element<HTMLButtonElement>(`[aria-label="Actions for ${qualityTopics[index]!.title}"]`)
  await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })))
  await settle()
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === 'Reveal in Files')
  expect(item, 'Original Topic object menu exposes Reveal in Files').toBeDefined()
  await act(async () => item!.click()); await settle()
}
it('keeps the directory first and its original node across persisted Files preferences and Knowledge switches', async () => {
  await mounted(); await settle()
  const directory = element('.topic-navigation-panel')
  const files = element('.workspace-topic-files')
  expect(directory.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  expect(element('.workspace-topic-index-header').textContent).toContain(topicCategory.title)
  expect(element('.workspace-tool-context__toggle').textContent).toBe('Files')
  expect(dom.container.querySelector('.file-explorer')).toBeNull()
  expect(element('[aria-label="Show file tree"]').getAttribute('aria-expanded')).toBe('false')
  await click('[aria-label="Show Knowledge"]')
  const search = element<HTMLInputElement>('.topic-knowledge-search input')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'original query')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('[aria-label="Show file tree"]')
  expect(useAppStore.getState().explorerCollapsed[topicWorkspace.id]).toBe(false)
  expect(element('.topic-navigation-panel')).toBe(directory)
  expect(element<HTMLInputElement>('.topic-knowledge-search input').value).toBe('original query')
  expect(element('.file-explorer').dataset.fileRoot).toBe(scratchTopicLogicalPath(topicWorkspace, qualityTopics[0]!))
  await click('[aria-label="Hide file tree"]')
  expect(element('.topic-navigation-panel')).toBe(directory)
  expect(useAppStore.getState().explorerCollapsed[topicWorkspace.id]).toBe(true)
  expect(dom.container.querySelector('[data-panel-resize-handle-id]')).toBeNull()
  await act(async () => useAppStore.getState().setExplorerCollapsed(topicWorkspace.id, false))
  expect(element('[aria-label="Hide file tree"]').getAttribute('aria-expanded')).toBe('true')
  expect(element<HTMLInputElement>('.topic-knowledge-search input').value).toBe('original query')
})
it('reveals a different original Topic directory without navigating or replacing the current workface', async () => {
  await mounted(); await settle()
  const before = useAppStore.getState()
  await reveal(1)
  const root = scratchTopicLogicalPath(topicWorkspace, qualityTopics[1]!)!
  expect(useAppStore.getState().explorerCollapsed[topicWorkspace.id]).toBe(false)
  expect(element('.file-explorer').dataset.fileRoot).toBe(root)
  expect(element('.workspace-topic-files .workspace-tool-context').textContent).toContain(qualityTopics[1]!.title)
  expect(api.files.readDirectory).toHaveBeenCalledWith(topicWorkspace.id, root)
  const after = useAppStore.getState()
  for (const key of ['tabs', 'layouts', 'sessions', 'workbenchSpaceSelection', 'agentComposerDrafts', 'agentFocus'] as const) expect(after[key]).toBe(before[key])
  await act(async () => useAppStore.setState({ workbenchSpaceSelection: { ...before.workbenchSpaceSelection!,
    topicId: qualityTopics[1]!.id, zoneId: originalTopicAddress(topicWorkspace, qualityTopics[1]!, {})!.zoneId } }))
  await reveal(0)
  expect(element('.file-explorer').dataset.fileRoot).toBe(scratchTopicLogicalPath(topicWorkspace, qualityTopics[0]!))
  await act(async () => useAppStore.setState({ workbenchSpaceSelection: { ...before.workbenchSpaceSelection!,
    topicId: qualityTopics[2]!.id, zoneId: originalTopicAddress(topicWorkspace, qualityTopics[2]!, {})!.zoneId } }))
  await settle()
  expect(element('.file-explorer').dataset.fileRoot).toBe(scratchTopicLogicalPath(topicWorkspace, qualityTopics[2]!))
  await act(async () => useAppStore.setState({ workbenchSpaceSelection: { ...before.workbenchSpaceSelection!,
    topicId: qualityTopics[1]!.id, zoneId: originalTopicAddress(topicWorkspace, qualityTopics[1]!, {})!.zoneId } }))
  await settle()
  expect(element('.file-explorer').dataset.fileRoot).toBe(scratchTopicLogicalPath(topicWorkspace, qualityTopics[1]!))
  await act(async () => useAppStore.setState({ workbenchSpaceSelection: { ...before.workbenchSpaceSelection!, topicId: null, zoneId: null } }))
  await reveal(0)
  expect(element('.file-explorer').dataset.fileRoot).toBe(scratchTopicLogicalPath(topicWorkspace, qualityTopics[0]!))
  await act(async () => useAppStore.setState({ workbenchSpaceSelection: { ...before.workbenchSpaceSelection!,
    spaceId: 'another-original-category', topicId: null, zoneId: null } }))
  expect(element('.file-explorer').dataset.fileRoot).toBe('')
})
it('honors an explicit expanded preference on first mount and retains original selection in empty or unconfirmed metadata', async () => {
  seedTopicNavigation({ collapsed: false })
  const original = useAppStore.getState().workbenchSpaceSelection
  await mounted(); await settle()
  expect(element('[aria-label="Hide file tree"]').getAttribute('aria-expanded')).toBe('true')
  await act(async () => useAppStore.setState({ topicCategories: [{ ...topicCategory, title: 'Very long research category with its full source title retained' }] }))
  expect(element('.workspace-topic-index-header').textContent).toContain('Very long research category')
  await act(async () => useAppStore.setState({ topicCategories: [{ ...topicCategory, readError: 'Source temporarily unavailable' }] }))
  expect(dom.container.textContent).toContain('Source temporarily unavailable')
  expect(dom.container.querySelectorAll('.workspace-topic-entry')).toHaveLength(qualityTopics.length)
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(original)
})
it('never reads a revealed directory under a different workspace during the first navigation render', async () => {
  await mounted(); await settle()
  await reveal(1)
  const previous = useAppStore.getState()
  const other = { ...topicWorkspace, id: 'original-project', name: 'Original project', path: topicWorkspace.path + '/project' }
  vi.mocked(api.files.readDirectory).mockClear()
  await act(async () => {
    useAppStore.setState({ config: { ...previous.config!, workspaces: [...previous.config!.workspaces, other] },
      workbenchSpaceSelection: { ...previous.workbenchSpaceSelection!, workspaceId: other.id },
      explorerCollapsed: { ...previous.explorerCollapsed, [other.id]: false } })
    await dom.render(<SurfaceToolDock workspace={other} />)
  })
  await settle()
  expect(api.files.readDirectory).not.toHaveBeenCalledWith(other.id, scratchTopicLogicalPath(topicWorkspace, qualityTopics[1]!))
  expect(element('.file-explorer').dataset.fileRoot).toBe(scratchTopicLogicalPath(topicWorkspace, qualityTopics[0]!))
})
it('refreshes an unavailable category through its original public reader without replacing the workface', async () => {
  await mounted(); await settle()
  await act(async () => useAppStore.setState({ topicCategories: [{ ...topicCategory, readError: 'Source temporarily unavailable' }] }))
  const original = useAppStore.getState()
  const read = vi.spyOn(api.topics, 'call').mockRejectedValueOnce(new Error('Original Host could not be reached'))
    .mockResolvedValueOnce({ categories: [topicCategory], unavailable: [] })
  await click('[aria-label="Refresh category description"]')
  expect(element('.workspace-topic-category-status').textContent).toContain('Original Host could not be reached')
  expect(useAppStore.getState().topicCategories).toBe(original.topicCategories)
  expect(dom.container.querySelectorAll('.workspace-topic-entry')).toHaveLength(qualityTopics.length)
  await click('[aria-label="Refresh category description"]')
  expect(read).toHaveBeenNthCalledWith(2, 'topic.category.ls', {})
  expect(dom.container.querySelector('.workspace-topic-category-status')).toBeNull()
  for (const key of ['tabs', 'layouts', 'sessions', 'spaceZoneBindings', 'workbenchSpaceSelection', 'agentComposerDrafts', 'agentFocus'] as const) expect(useAppStore.getState()[key]).toBe(original[key])
  await act(async () => useAppStore.setState({ topicCategories: [{ ...topicCategory, readError: 'Source unavailable again' }] }))
  let finish!: (value: { categories: typeof topicCategory[]; unavailable: [] }) => void
  read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }) as ReturnType<typeof api.topics.call>)
  await click('[aria-label="Refresh category description"]')
  const newer = { ...topicCategory, title: 'Newer confirmed category name', revision: 'newer-original-revision' }
  await act(async () => useAppStore.setState({ topicCategories: [newer] }))
  await act(async () => finish({ categories: [topicCategory], unavailable: [] }))
  expect(useAppStore.getState().topicCategories[0]).toBe(newer)
})
