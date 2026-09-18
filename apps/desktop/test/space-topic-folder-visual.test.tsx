// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
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
  expect(topicRows.map((row) => row.textContent)).toEqual(['Topic one','Topic two'])
  const folders = container.querySelector('nav[aria-label="Folders"]')
  expect(folders).not.toBeNull()
  expect(folders?.querySelector('.sidebar__section-heading')?.textContent).toBe('Folders')
  expect(container.querySelector('button[aria-label="Topics overview"]')?.textContent).toContain('Topics')
  const styleSource = readFileSync(resolve(process.cwd(), 'apps/desktop/src/renderer/src/styles/chrome.css'), 'utf8')
  const commonRowRule = styleSource.match(/\.project-rail-row \{([^}]+)\}/)
  expect(commonRowRule).not.toBeNull()
  expect(commonRowRule![1]).toContain('grid-template-columns: auto minmax(0, 1fr) auto')
  expect(styleSource).not.toMatch(/\.space-topic-row\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) auto/)
  expect(topicRows[0]?.style.getPropertyValue('--rail-depth')).toBe('1')
  expect(topicRows[0]?.querySelector('.project-rail-row__icon .lucide-notebook-text')).not.toBeNull()
  const folderRow = folders!.querySelector<HTMLButtonElement>('button.project-rail-row')
  expect(folderRow?.textContent).toContain('Source folder')
  expect(folderRow?.querySelector('.project-rail-row__icon')?.getAttribute('title')).toBe('Project folder')
  expect(folderRow?.querySelector('[data-monogram]')?.textContent).toBe('S')
  expect(folderRow?.querySelector('.lucide-notebook-text')).toBeNull()
  await act(async () => topicRows[0]!.click())
  expect(openTopic).toHaveBeenCalledWith('view:one', SCRATCH_WORKSPACE_ID)
  await act(async () => folderRow!.click())
  expect(selectWorkspace).toHaveBeenCalledWith(folder.id)
  expect(useAppStore.getState().sessions).toEqual([])
})
