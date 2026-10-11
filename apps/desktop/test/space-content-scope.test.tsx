// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../src/shared/contracts'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { SurfaceToolDock } from '../src/renderer/src/components/SurfaceToolDock'
import { api } from '../src/renderer/src/lib/api'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installFileTreeGeometry } from './helpers/file-tree-geometry'

const dom = composerDOM()
const folder: WorkspaceRecord = { id: 'display-folder', name: 'Mote', kind: 'folder', hostId: 'local', path: fixturePath('display-project') }
const resource: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, name: 'Shared storage', kind: 'folder', hostId: 'remote', path: fixturePath('remote/content-store') }
const moteId = 'launcher:scope-partner'
const topicId = 'launcher:scope-topic'
const rootPath = scratchTopicDirectoryName(moteId)
const physicalPath = fixturePath('remote/objects/research-partner')
const mote: ScratchTopicSnapshot = { id: moteId, title: 'Research partner', directoryPath: rootPath,
  physicalDirectoryPath: physicalPath, confirmedDirectoryPaths: [physicalPath], topicPath: `${physicalPath}/topic.md`, summary: '', collaborators: [],
  soul: { path: `${physicalPath}/SOUL.md`, content: '# Original identity', version: 'original' } }
const topic: ScratchTopicSnapshot = { id: topicId, title: 'Mote', directoryPath: scratchTopicDirectoryName(topicId),
  topicPath: `${resource.path}/${scratchTopicDirectoryName(topicId)}/topic.md`, summary: '', collaborators: [] }
const moteSpace = directoryIdentity(resource.hostId, `${resource.path}/${rootPath}`)
const moteZone = homeZoneId(moteSpace)
const topicSpace = directoryIdentity(resource.hostId, `${resource.path}/${topic.directoryPath}`)
const topicZone = homeZoneId(topicSpace)
const categorySpace = directoryIdentity(resource.hostId, fixturePath('remote/categories/knowledge'))
const folderSpace = directoryIdentity(folder.hostId, folder.path)
const tab = { ...createWorkbenchTab('mote-workface', { kind: 'launcher', workspaceId: resource.id, regionId: 'original-region' }),
  topicId: moteId, space: { spaceId: moteSpace, zoneId: moteZone } }

beforeEach(() => {
  installFileTreeGeometry()
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([mote, topic])
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'readDirectory').mockImplementation(async (_workspaceId, path) => [
    { name: 'note.md', path: `${path}/note.md`, isDirectory: false, isSymlink: false }
  ])
  vi.spyOn(api.files, 'read').mockImplementation(async (_workspaceId, path) => ({ status: 'read', document: { path, content: '# Retained material', revision: 'original' } }))
  useAppStore.setState({ config: { ...composerConfig, workspaces: [folder, resource], hosts: [...composerConfig.hosts,
    { id: 'remote', kind: 'ssh', label: 'Research Host', hostname: 'scope-fixture' }] },
    tabs: { [tab.id]: tab }, sessions: [composerSession()], layouts: { [resource.id]: createWorkspaceLayout('resource-group', [tab.id]),
      [folder.id]: createWorkspaceLayout('display-group') }, activeWorkspaceId: resource.id, mainSurface: 'workbench',
    workspaceTool: 'files-branches', workspaceGitView: 'changes', toolsOpen: true, workbenchSpaceSelection: selection(resource),
    spaceZoneBindings: { [moteZone]: { spaceId: moteSpace, workspaceId: resource.id, directoryPath: physicalPath,
      topicId: moteId, contentKind: 'mote', relations: { [folderSpace]: true } },
    [topicZone]: { spaceId: topicSpace, workspaceId: resource.id, topicId, contentKind: 'topic', relations: { [categorySpace]: true } } },
    topicCategories: [{ categoryId: '10000000-0000-4000-8000-000000000003', spaceId: categorySpace,
      hostId: resource.hostId, directoryPath: fixturePath('remote/categories/knowledge'), title: 'Mote', revision: 'original' }],
    scratchTopicSnapshots: { [resource.id]: { scope: scratchTopicsScope(resource), revision: 0, reading: false, error: null, topics: [mote, topic] } },
    workspaceFileRevisions: {}, explorerCollapsed: { [resource.id]: false, [folder.id]: false }, fileExplorerStates: {},
    documents: {}, dirtyDocuments: {}, documentIssues: {}, documentGenerations: {}, documentObservationGenerations: {},
    editorRegionModes: {}, closingWorkbenchViews: {}, spatialRequests: {}, projectGroups: [], localHome: '',
    regionCaretFocus: null, retainedSpatialFocus: null, workbenchNavigationInputPolicy: 'preserve' })
})

function selection(display: WorkspaceRecord) {
  return { spaceId: moteSpace, zoneId: moteZone, topicId: moteId, workspaceId: display.id,
    groupId: display.id === resource.id ? 'resource-group' : 'second', tabId: tab.id, regionId: 'original-region' }
}
function visible<ElementType extends HTMLElement = HTMLElement>(selector: string): ElementType[] {
  return [...dom.container.querySelectorAll<ElementType>(selector)].filter(element => !element.closest('[hidden]'))
}
async function render(workspace = resource) { await dom.render(<SurfaceToolDock workspace={workspace} />) }
function foreignDisplay() {
  const first = createWorkspaceLayout('first', [tab.id]), second = createWorkspaceLayout('second', [tab.id])
  useAppStore.setState(state => ({ activeWorkspaceId: folder.id, workbenchSpaceSelection: selection(folder),
    layouts: { ...state.layouts, [folder.id]: { root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: first.root, second: second.root },
      groups: [...first.groups, ...second.groups], activeGroupId: 'second' } } }))
}

describe('original content scopes on the actual Space Dock', () => {
  it('labels the confirmed Mote rather than shared Topics and keeps its original Profile, Ideas and physical Host', async () => {
    const before = useAppStore.getState()
    await render()
    expect(visible('[data-space-tool]')[0]?.getAttribute('aria-label')).toBe('Files + Mote')
    expect(visible('[data-space-tool]').map(button => button.getAttribute('data-space-tool'))).toEqual(['files-branches', 'agents'])
    expect(visible('[aria-label="Mote details"] button').map(button => button.textContent)).toEqual(['Profile', 'Ideas'])
    expect(visible('.workspace-tool-context--explorer strong')[0]?.textContent).toBe(mote.title)
    expect(visible<HTMLElement>('.workspace-tool-context--explorer > span')[0]?.title).toBe(physicalPath)
    expect(visible('.workspace-tool-context--explorer em')[0]?.textContent).toContain(resource.hostId)
    expect(visible('.workspace-zones-panel')).toHaveLength(0)
    expect(visible('[aria-label="Topic directory view"]')).toHaveLength(0)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
  })

  it('reads the Mote resource rather than a foreign display Workspace through the actual Dock Files assembly', async () => {
    foreignDisplay()
    const before = useAppStore.getState()
    await render(folder)
    expect(api.files.readDirectory).toHaveBeenCalledWith(resource.id, rootPath)
    expect(vi.mocked(api.files.readDirectory).mock.calls.every(([workspaceId]) => workspaceId === resource.id)).toBe(true)
    expect(visible<HTMLElement>('.workspace-tool-context--explorer > span')[0]?.title).toBe(physicalPath)
    expect(visible('.workspace-tool-context--explorer em')[0]?.textContent).toContain(resource.hostId)
    expect(visible('[data-space-tool]')[0]?.getAttribute('aria-label')).toBe('Files + Mote')
    expect(useAppStore.getState().activeWorkspaceId).toBe(folder.id)
    expect(visible('[data-space-tool]').map(button => button.getAttribute('data-space-tool'))).toEqual(['files-branches', 'agents'])
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    expect(useAppStore.getState().spaceZoneBindings).toBe(before.spaceZoneBindings)
  })

  it('opens an original Mote file in its exact second display occurrence without borrowing the first Group', async () => {
    foreignDisplay()
    const before = useAppStore.getState(), open = vi.spyOn(before, 'openFile')
    const launch = vi.spyOn(api.sessions, 'launchAgent')
    await render(folder)
    await dom.click(`[data-tree-path="${rootPath}/note.md"] .tree-row__icon`)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open.mock.calls[0]!.slice(0, 5)).toEqual([`${rootPath}/note.md`, 'second', undefined, resource.id, true])
    expect(open.mock.calls[0]![5]).toMatchObject({ displayWorkspaceId: folder.id, focus: false,
      resource: { hostId: resource.hostId, path: resource.path } })
    expect(useAppStore.getState().documents[documentKey(resource.id, `${rootPath}/note.md`)]?.content).toBe('# Retained material')
    expect(useAppStore.getState().layouts[folder.id]!.groups[0]).toStrictEqual(before.layouts[folder.id]!.groups[0])
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ workspaceId: folder.id, groupId: 'second', topicId: moteId })
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(launch).not.toHaveBeenCalled()
  })

  it('keeps a stored Folder Git preference without exposing that tool in the currently selected foreign Mote scope', async () => {
    foreignDisplay()
    useAppStore.setState({ workspaceTool: 'git' })
    const before = useAppStore.getState()
    await render(folder)
    expect(visible('[data-space-tool]').map(button => button.getAttribute('aria-label'))).toEqual(['Files + Mote', 'Agents'])
    expect(visible('[data-git-workspace]')).toHaveLength(0)
    expect(visible('[data-mote-details]')).toHaveLength(1)
    expect(useAppStore.getState().workspaceTool).toBe('git')
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
  })

  it('retains the Mote tree and content through metadata uncertainty and retries only the original directory owner', async () => {
    await render()
    const tree = visible('.file-explorer')[0], before = useAppStore.getState()
    await act(async () => useAppStore.setState(state => ({ scratchTopicSnapshots: { ...state.scratchTopicSnapshots,
      [resource.id]: { ...state.scratchTopicSnapshots[resource.id]!, topics: [{ ...mote, readError: 'Original metadata temporarily unavailable. '.repeat(30) }, topic] } } })))
    expect(visible('[data-space-tool]')[0]?.getAttribute('aria-label')).toBe('Files + Mote')
    expect(visible('.file-explorer')[0]).toBe(tree)
    expect(visible('[data-mote-details]')).toHaveLength(1)
    expect(visible('[aria-label="Mote directory observation"]')[0]?.textContent).toContain('Original metadata temporarily unavailable')
    const issue = visible('[aria-label="Mote directory observation"]')[0]!
    expect(issue.style.overflowY).toBe('auto')
    expect(issue.parentElement?.classList.contains('workspace-tool-slot')).toBe(true)
    expect(visible('[data-mote-details]')[0]?.parentElement?.classList.contains('workspace-tool-slot')).toBe(true)
    expect(visible<HTMLElement>('.workspace-tool-context--explorer > span')[0]?.title).toBe(physicalPath)
    await dom.click('[aria-label="Retry Mote directory discovery"]')
    expect(api.scratch.listTopics).toHaveBeenCalledExactlyOnceWith(resource.id)
    expect(visible('[aria-label="Mote directory observation"]')).toHaveLength(0)
    expect(visible('.file-explorer')[0]).toBe(tree)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
  })

  it('keeps ordinary same-named Folder content and its Git entry without treating a display name as Mote identity', async () => {
    useAppStore.setState({ activeWorkspaceId: folder.id, workbenchSpaceSelection: null })
    await render(folder)
    expect(visible('[data-space-tool]').map(button => button.getAttribute('aria-label'))).toEqual(['Files + Zones', 'Agents', 'Git'])
    expect(visible('.workspace-zones-panel')).toHaveLength(1)
    expect(visible('[data-mote-details]')).toHaveLength(0)
    expect(api.scratch.listTopics).not.toHaveBeenCalled()
  })

  it('keeps a same-named ordinary Topic in its Category on the original Topics and Knowledge tools', async () => {
    useAppStore.setState({ workbenchSpaceSelection: { spaceId: categorySpace, zoneId: topicZone, topicId,
      workspaceId: resource.id, groupId: null, tabId: null, regionId: null } })
    await render()
    expect(visible('[data-space-tool]')[0]?.getAttribute('aria-label')).toBe('Files + Topics')
    expect(visible('[aria-label="Topic directory view"] button').map(button => button.textContent)).toEqual(['Topics', 'Knowledge'])
    expect(visible('[data-mote-details]')).toHaveLength(0)
    expect(api.files.readDirectory).toHaveBeenCalledWith(resource.id, topic.directoryPath)
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ spaceId: categorySpace, zoneId: topicZone, topicId })
  })

  it('preserves multiple bindings, workface and drafts across tools without Session-output-driven directory reads', async () => {
    foreignDisplay()
    await render(folder)
    const before = useAppStore.getState(), reads = vi.mocked(api.files.readDirectory).mock.calls.length
    for (let revision = 1; revision <= 12; revision++) {
      await act(async () => useAppStore.setState({ sessions: Array.from({ length: revision }, (_, index) => ({
        ...composerSession(`unrelated-${index}`), latestOutputBytes: revision * 1024, updatedAt: revision })) }))
    }
    expect(api.files.readDirectory).toHaveBeenCalledTimes(reads)
    expect(api.scratch.listTopics).not.toHaveBeenCalled()
    await dom.click('[data-space-tool="agents"]')
    await dom.click('[data-space-tool="files-branches"]')
    expect(visible('[data-space-tool]')[0]?.getAttribute('aria-label')).toBe('Files + Mote')
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().spaceZoneBindings).toBe(before.spaceZoneBindings)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
  })
})
