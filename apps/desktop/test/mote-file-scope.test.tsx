// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileExplorer } from '../src/renderer/src/components/FileExplorer'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { fileExplorerContains, fileExplorerRelativeRoot } from '../src/renderer/src/lib/file-explorer-scope'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { createMoteApp, moteClick, moteType, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultTab, neighborTab, defaultAgent, customMoteId } from './fixtures/mote-workface'
import { requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { createWorkbenchTab, documentKey, fileTabId } from '../src/renderer/src/lib/workbench-tabs'
import { addTab } from '@agentmux/layout'

// The real File owner/reducers and Explorer dispatch remain in this proof.
// Monaco's native editor transport is outside this delayed navigation case.
vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: () => createElement('div', { 'data-editor-boundary': true }) }))

let app: MoteAppFixture
const home = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID), other = scratchTopicDirectoryName(customMoteId)
function entry(path: string) { return { path, name: path.split('/').at(-1)!, isDirectory: false, isSymlink: false, ignored: false } }
beforeEach(() => { app = createMoteApp() })
afterEach(async () => { await app.dispose() })

describe('original scoped Mote files consumer', () => {
  async function delayedFile(existingWithoutSpace = false) {
    const path = home + '/SOUL.md', id = fileTabId(SCRATCH_WORKSPACE_ID, path)
    vi.spyOn(api.files, 'readDirectory').mockResolvedValue([entry(path)])
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
    vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
    let finish!: (result: { status: 'read'; document: { path: string; content: string; revision: string } }) => void
    const read = vi.spyOn(api.files, 'read').mockImplementation(async () => await new Promise(resolve => { finish = resolve }))
    if (existingWithoutSpace) useAppStore.setState(state => ({
      tabs: { ...state.tabs, [id]: { ...createWorkbenchTab(id, { kind: 'file', workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'region:' + id, path }), topicId: PMO_TEAMS_TOPIC_ID } },
      layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: addTab(state.layouts[SCRATCH_WORKSPACE_ID]!, 'mote-group', id) }
    }))
    useAppStore.setState({ activeWorkspaceId: 'project', mainSurface: 'board' })
    await app.mount()
    await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id }))
    await settleMoteApp()
    await moteClick(app.panel().querySelector<HTMLButtonElement>('.mote-conversations__secondary button')!)
    await moteClick(app.panel().querySelector<HTMLElement>('[data-tree-path="' + path + '"]')!)
    expect(read.mock.calls).toEqual([[SCRATCH_WORKSPACE_ID, path]])
    return { id, path, finish: async () => {
      await act(async () => finish({ status: 'read', document: { path, content: '# Original persona', revision: 'read-original' } }))
      await settleMoteApp()
    } }
  }

  it.each(['same-Mote discussion', 'A→B→A', 'later input', 'later Region'] as const)('keeps %s after a real Explorer file read finishes late', async intent => {
    const file = await delayedFile()
    if (intent === 'same-Mote discussion') await moteClick(app.panel().querySelector<HTMLButtonElement>('[data-workbench-tab-id="' + neighborTab.id + '"]')!)
    if (intent === 'A→B→A') {
      await moteClick(app.panel().querySelector<HTMLButtonElement>('[data-mote-topic-id="' + customMoteId + '"]')!)
      await moteClick(app.panel().querySelector<HTMLButtonElement>('[data-mote-topic-id="' + PMO_TEAMS_TOPIC_ID + '"]')!)
      await moteClick(app.panel().querySelector<HTMLButtonElement>('.mote-conversations__secondary button')!)
    }
    if (intent === 'later input') await moteType(app.panel().querySelector<HTMLElement>('[aria-label="Message Agent"]')!, 'My newer unsent intent')
    if (intent === 'later Region') await act(async () => useAppStore.getState().focusRegion(SCRATCH_WORKSPACE_ID, neighborTab.id, neighborTab.layout.activeRegionId, 'pointer', 'mote-group'))
    const afterIntent = useAppStore.getState(), target = app.panel().dataset.moteTargetTab, active = document.activeElement
    expect(app.panel().querySelector('.mote-materials')).not.toBeNull()
    await file.finish()
    const state = useAppStore.getState()
    expect(state.documents[documentKey(SCRATCH_WORKSPACE_ID, file.path)]?.content).toBe('# Original persona')
    expect(state.tabs[file.id]?.topicId).toBe(PMO_TEAMS_TOPIC_ID)
    expect(app.panel().dataset.moteTargetTab).toBe(target)
    expect(app.panel().querySelector('.mote-materials')).not.toBeNull()
    expect(document.activeElement).toBe(active)
    expect(state.agentFocus).toBe(afterIntent.agentFocus)
    expect(state.activeWorkspaceId).toBe('project'); expect(state.mainSurface).toBe('board')
    expect(state.agentComposerDrafts).toBe(afterIntent.agentComposerDrafts)
    expect(state.sessions).toBe(afterIntent.sessions); expect(state.viewModes).toBe(afterIntent.viewModes)
    expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
    if (intent === 'later input') expect(state.agentComposerDrafts[defaultAgent.id]).toBe('My newer unsent intent')
  })

  it('lets a current original material finish and selects its original File Tab', async () => {
    const file = await delayedFile()
    await file.finish()
    expect(app.panel().dataset.moteTargetTab).toBe(file.id)
    expect(app.panel().querySelector('.mote-materials')).toBeNull()
    expect(useAppStore.getState().tabs[file.id]?.topicId).toBe(PMO_TEAMS_TOPIC_ID)
  })

  it.each([false, true])('preserves original File placement without a Space, late input=%s', async late => {
    const file = await delayedFile(true)
    if (late) await moteType(app.panel().querySelector<HTMLElement>('[aria-label="Message Agent"]')!, 'Keep typing here')
    await file.finish()
    expect(useAppStore.getState().tabs[file.id]?.space).toBeUndefined()
    expect(useAppStore.getState().documents[documentKey(SCRATCH_WORKSPACE_ID, file.path)]?.content).toBe('# Original persona')
    expect(app.panel().dataset.moteTargetTab).toBe(late ? defaultTab.id : file.id)
    expect(app.panel().querySelector('.mote-materials') !== null).toBe(late)
    expect(useAppStore.getState().activeWorkspaceId).toBe('project')
  })
  it('shows the exact original Mote root while Float is over another project, then changes scope only explicitly', async () => {
    const reads = vi.spyOn(api.files, 'readDirectory').mockImplementation(async (_workspace, root) => root ? [entry(root + '/SOUL.md'), entry(other + '/outside.md')] : [entry('global.md')])
    useAppStore.setState({ activeWorkspaceId: 'project', mainSurface: 'board' })
    await app.mount()
    await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id }))
    await settleMoteApp()
    await moteClick(app.panel().querySelector<HTMLButtonElement>('.mote-conversations__secondary button')!)
    expect(reads.mock.calls).toEqual([[SCRATCH_WORKSPACE_ID, home]])
    const explorer = app.panel().querySelector<HTMLElement>('.file-explorer')!
    expect(explorer.dataset.fileWorkspace).toBe(SCRATCH_WORKSPACE_ID)
    expect(explorer.dataset.fileRoot).toBe(home)
    expect([...explorer.querySelectorAll('[data-tree-path]')].map(node => node.getAttribute('data-tree-path'))).toEqual([home + '/SOUL.md'])
    expect(app.panel().querySelector('.workspace-topics-panel')).toBeNull()
    await moteClick(app.panel().querySelector<HTMLButtonElement>('.mote-materials__scope')!)
    expect(app.panel().querySelector<HTMLElement>('.file-explorer')!.dataset.fileRoot).toBe('')
    expect(reads.mock.calls).toEqual([[SCRATCH_WORKSPACE_ID, home], [SCRATCH_WORKSPACE_ID, '']])
    expect(useAppStore.getState().activeWorkspaceId).toBe('project')
  })

  it('does not admit sibling roots or traversal and rejects a late previous root result', async () => {
    expect(fileExplorerRelativeRoot('/topics', '/topics/' + home)).toBe(home)
    expect(fileExplorerRelativeRoot('/topics', '/elsewhere/' + home)).toBeNull()
    expect([other + '/SOUL.md', home + '/../' + other, '/root/file', home + 'more/file'].map(path => fileExplorerContains(home, path))).toEqual([false, false, false, false])
    let finishA!: (entries: ReturnType<typeof entry>[]) => void
    const read = vi.spyOn(api.files, 'readDirectory').mockImplementation(async (workspace) => workspace === SCRATCH_WORKSPACE_ID ? await new Promise(resolve => { finishA = resolve }) : [entry(home + '/own.md')])
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
    await act(async () => root.render(createElement(FileExplorer, { workspaceId: SCRATCH_WORKSPACE_ID, rootPath: home })))
    expect(read.mock.calls).toEqual([[SCRATCH_WORKSPACE_ID, home]])
    await act(async () => root.render(createElement(FileExplorer, { workspaceId: 'project', rootPath: home })))
    await settleMoteApp()
    await act(async () => finishA([entry(home + '/late.md')]))
    expect([...host.querySelectorAll('[data-tree-path]')].map(node => node.getAttribute('data-tree-path'))).toEqual([home + '/own.md'])
    expect(host.querySelector<HTMLElement>('.file-explorer')?.dataset.fileWorkspace).toBe('project')
    expect(host.querySelector<HTMLElement>('.file-explorer')?.dataset.fileRoot).toBe(home)
    await act(async () => root.unmount()); host.remove()
  })

  it('routes generic create, rename and delete to the captured original resource while default callers still use their workspace', async () => {
    const create = vi.spyOn(api.files, 'create').mockResolvedValue(undefined)
    const rename = vi.spyOn(api.files, 'move').mockResolvedValue({ status: 'moved' })
    const remove = vi.spyOn(api.files, 'delete').mockResolvedValue(undefined)
    useAppStore.setState({ activeWorkspaceId: 'project' })
    const state = useAppStore.getState()
    await state.createPath({ path: home + '/new.md', kind: 'file' }, SCRATCH_WORKSPACE_ID)
    await state.renamePath(home + '/new.md', home + '/renamed.md', SCRATCH_WORKSPACE_ID)
    await state.deletePath(home + '/renamed.md', SCRATCH_WORKSPACE_ID)
    await state.createPath({ path: 'normal.md', kind: 'file' })
    expect(create.mock.calls.map(call => [call[0], call[1].path])).toEqual([[SCRATCH_WORKSPACE_ID, home + '/new.md'], ['project', 'normal.md']])
    expect(rename.mock.calls[0]?.[0]).toMatchObject({ source: { workspaceId: SCRATCH_WORKSPACE_ID, path: home + '/new.md' }, destination: { workspaceId: SCRATCH_WORKSPACE_ID, path: home + '/renamed.md' } })
    expect(remove.mock.calls).toEqual([[SCRATCH_WORKSPACE_ID, home + '/renamed.md']])
    expect(useAppStore.getState().activeWorkspaceId).toBe('project')
  })
})
