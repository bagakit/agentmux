// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { workspaceProjectId } from '../src/renderer/src/lib/workspace-projects'
import { allStyles } from './helpers/styles'
const initial = useAppStore.getState()
let root: Root | undefined
const container = document.createElement('div')
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; container.remove(); vi.restoreAllMocks(); useAppStore.setState(initial, true) })
it('makes nonempty Topic and Folder rows recognizable without changing their navigation owners', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const topics = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', kind: 'folder' as const, path: '/topics' }
  const folder = { id: 'source-folder', name: 'Source folder', hostId: 'local', kind: 'folder' as const, path: '/source' }
  useAppStore.setState({ config: { ...initial.config!, version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {}, workspaces: [topics, folder] }, sessions: [], layouts: {}, tabs: {}, activeWorkspaceId: folder.id, workspaceFileRevisions: {} })
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(['one','two'].map((id) => ({ id: `view:${id}`, directoryPath: `topic--view--${id}`, topicPath: `topic--view--${id}/topic.md`, title: `Topic ${id}`, summary: 'Shared knowledge', collaborators: [] })))
  const openTopic = vi.fn(async () => {}), selectWorkspace = vi.fn(async () => {})
  useAppStore.setState({ openScratchTopic: openTopic, selectWorkspace })
  document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(createElement(WorkspaceSidebar)))
  const topicRows = [...container.querySelectorAll<HTMLButtonElement>('.space-topic-row')]
  expect(topicRows.map((row) => row.querySelector('.project-rail-row__identity')?.textContent)).toEqual(['Topic one','Topic two'])
  const folders = container.querySelector('nav[aria-label="Folders"]')
  expect(folders).not.toBeNull()
  expect(folders?.querySelector('.space-folders-row')?.textContent).toBe('Folders1')
  expect(container.querySelector('button[aria-label="Topics overview"]')?.textContent).toContain('Topics')
  const styleSource = allStyles()
  const commonRowRule = styleSource.match(/\.project-rail-row \{([^}]+)\}/)
  expect(commonRowRule).not.toBeNull()
  expect(commonRowRule![1]).toContain('display: flex')
  expect(styleSource).not.toMatch(/\.space-topic-row\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) auto/)
  expect(topicRows[0]?.style.getPropertyValue('--rail-depth')).toBe('1')
  expect(topicRows.map((row) => row.querySelector('[data-monogram]')?.textContent)).toEqual(['T', 'T'])
  expect(topicRows[0]?.querySelector('.lucide-notebook-text')).toBeNull()
  expect(topicRows[0]?.closest('nav')?.getAttribute('aria-label')).toBe('Topics')
  const folderRow = folders!.querySelector<HTMLButtonElement>('button.project-rail-row[data-workspace-id]')
  expect(folderRow?.textContent).toContain('Source folder')
  expect(folderRow?.querySelector('.project-rail-row__icon')?.getAttribute('title')).toBe('Project folder')
  expect(folderRow?.querySelector('[data-monogram]')?.textContent).toBe('S')
  expect(folderRow?.closest('.project-rail-row-shell')?.getAttribute('style')).toContain('--rail-depth: 1')
  expect(folderRow?.querySelector('.lucide-notebook-text')).toBeNull()
  await act(async () => topicRows[0]!.click())
  expect(openTopic).toHaveBeenCalledWith('view:one', SCRATCH_WORKSPACE_ID)
  await act(async () => folderRow!.click())
  expect(selectWorkspace).toHaveBeenCalledWith(folder.id)
  expect(useAppStore.getState().sessions).toEqual([])
})

it('keeps category members and real descendants indented and groups only each Folder’s own pins', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const scratch = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', kind: 'folder' as const, path: '/topics' }
  const workspaces = [
    { id: 'alpha', name: 'Alpha', path: '/work/alpha', branch: 'main' },
    { id: 'core', name: 'Core', path: '/work/alpha/packages/core', branch: 'trunk' },
    { id: 'beta', name: 'Beta', path: '/work/beta' },
    { id: 'notes', name: 'Notes', path: '/notes' }
  ].map((workspace) => ({ ...workspace, hostId: 'local', kind: 'folder' as const }))
  const alpha = workspaceProjectId(workspaces[0]!), core = workspaceProjectId(workspaces[1]!)
  const pins = { [alpha]: ['main', 'review'], [core]: ['trunk'] }
  useAppStore.setState({ config: { ...initial.config!, version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }],
    executors: {}, workspaces: [scratch, ...workspaces] }, sessions: [], layouts: {}, tabs: {}, activeWorkspaceId: 'notes',
    collapsedProjectGroups: {}, pinnedItems: pins, workspaceFileRevisions: {} })
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([{ id: 'view:roadmap', title: 'Roadmap', summary: '', collaborators: [],
    directoryPath: 'topic--view--roadmap', topicPath: 'topic--view--roadmap/topic.md' }])
  document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(createElement(WorkspaceSidebar)))
  const row = (id: string) => container.querySelector<HTMLButtonElement>(`[data-workspace-id="${id}"]`)!
  const depth = (id: string) => row(id).closest<HTMLElement>('.project-rail-row-shell')!.style.getPropertyValue('--rail-depth')
  expect([depth('notes'), depth('alpha'), depth('core'), depth('beta')]).toEqual(['1', '2', '3', '2'])
  expect([...container.querySelectorAll<HTMLElement>('.space-mote-row, .space-topic-row')]
    .map((node) => node.style.getPropertyValue('--rail-depth'))).toEqual(['1', '1'])
  expect(container.querySelector('.space-folders-heading .lucide-folders')).not.toBeNull()
  expect(container.querySelector('.project-rail-group__header .lucide-layers')).not.toBeNull()
  const blocks = [...container.querySelectorAll<HTMLElement>('[data-space-folder]')]
  expect(blocks.map((block) => block.dataset.spaceFolder).sort()).toEqual(workspaces.map(workspaceProjectId).sort())
  const ownedPins = (block: HTMLElement) => [...block.querySelectorAll<HTMLElement>('[data-space-pin-owner]')]
    .map((pin) => [pin.dataset.spacePinOwner, pin.querySelector('strong')?.textContent])
  const alphaBlock = row('alpha').closest<HTMLElement>('[data-space-folder]')!
  const coreBlock = row('core').closest<HTMLElement>('[data-space-folder]')!
  expect(ownedPins(alphaBlock)).toEqual([[alpha, 'main'], [alpha, 'review']])
  expect(ownedPins(coreBlock)).toEqual([[core, 'trunk']])
  expect(alphaBlock.classList.contains('project-rail-folder-block--pinned')).toBe(true)
  expect(coreBlock.classList.contains('project-rail-folder-block--pinned')).toBe(true)
  expect(alphaBlock.contains(row('core'))).toBe(false)
  expect(alphaBlock.contains(row('beta'))).toBe(false)
  expect(row('notes').closest('[data-space-folder]')?.classList.contains('project-rail-folder-block--pinned')).toBe(false)
  const group = container.querySelector<HTMLButtonElement>('.project-rail-group__header')!
  await act(async () => group.click())
  expect([...container.querySelectorAll<HTMLElement>('[data-space-folder]')].map((block) => block.dataset.spaceFolder))
    .toEqual([workspaceProjectId(workspaces[3]!)])
  expect(useAppStore.getState().pinnedItems).toEqual(pins)
})
