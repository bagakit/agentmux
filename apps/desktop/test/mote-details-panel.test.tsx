// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { customMoteId, customTab, defaultAgent, defaultTab, quietMoteId, quietTab, ordinaryTopicId, ordinaryTab } from './fixtures/mote-workface'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { requestPmoTeamsTopicFloatingOpen, readPmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: () => createElement('div', { 'data-original-editor': true }) }))
let app: MoteAppFixture
const rootPath = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID), notePath = rootPath + '/try-a-new-angle.md'
const entry = (path: string) => ({ path, name: path.split('/').at(-1)!, isDirectory: false, isSymlink: false, ignored: false })
beforeEach(() => {
  app = createMoteApp()
  useAppStore.setState({ toolsOpen: true, explorerCollapsed: { [SCRATCH_WORKSPACE_ID]: false } })
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([entry(notePath)])
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
})
afterEach(async () => { await app.dispose() })
function details() { const result = app.container.querySelector<HTMLElement>('.surface-tool-dock [data-mote-details]'); expect(result).not.toBeNull(); return result! }
async function section(name: string, panel = details()) { await moteClick([...panel.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent === name)!) }

describe('Mote object content in the original secondary tools frame', () => {
  it('starts each explicitly selected object section at its beginning and keeps the original workbench', async () => {
    await app.mount()
    const originalWorkbench = app.container.querySelector('.workspace-workbench')
    expect(originalWorkbench).not.toBeNull()
    const original = useAppStore.getState()
    const profile = details().querySelector<HTMLElement>('[role="tabpanel"]')!
    profile.scrollTop = 120
    await section('Persona')
    const persona = details().querySelector<HTMLElement>('[role="tabpanel"]')!
    expect(persona.scrollTop).toBe(0)
    persona.scrollTop = 120
    await section('Ideas')
    expect(details().querySelector<HTMLElement>('[role="tabpanel"]')!.scrollTop).toBe(0)
    expect(app.container.querySelector('.workspace-workbench')).toBe(originalWorkbench)
    expect(useAppStore.getState().tabs).toBe(original.tabs)
    expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('shows the original name, avatar and SOUL while keeping ordinary Topic functionality', async () => {
    await app.mount()
    expect(details().dataset.moteDetails).toBe(PMO_TEAMS_TOPIC_ID)
    expect(details().querySelector('.mote-details__identity strong')?.textContent).toBe('Mote')
    expect(details().querySelector('[aria-label="Change Mote avatar"] img')).not.toBeNull()
    expect(details().querySelector('.mote-details__status')?.textContent).toContain('running')
    expect(details().querySelector('.workspace-topics-panel')).toBeNull()
    await section('Persona')
    expect(details().textContent).toContain('Identity')
    const before = useAppStore.getState()
    await act(async () => useAppStore.getState().openScratchTopic(ordinaryTopicId, SCRATCH_WORKSPACE_ID, { tabId: ordinaryTab.id }))
    await settleMoteApp()
    expect(app.container.querySelector('.surface-tool-dock [data-mote-details]')).toBeNull()
    expect(app.container.querySelector('.surface-tool-dock .workspace-topics-panel')).not.toBeNull()
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('opens the original self-setting file in the real File owner without restarting the running Agent', async () => {
    const read = vi.spyOn(api.files, 'read').mockImplementation(async (_workspace, path) => ({ status: 'read', document: { path, content: '# Original self setting', revision: 'original-source' } }))
    await app.mount(); await section('Persona')
    await moteClick([...details().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Edit')!)
    expect(read).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, rootPath + '/SOUL.md')
    expect(useAppStore.getState().documents[documentKey(SCRATCH_WORKSPACE_ID, rootPath + '/SOUL.md')]?.content).toBe('# Original self setting')
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('reads an original idea with its filename, then creates a note through the shared FileExplorer owner', async () => {
    const read = vi.spyOn(api.files, 'read').mockImplementation(async (_workspace, path) => ({ status: 'read', document: { path, content: '# An original thought\nCompare both approaches before deciding.', revision: 'original-note' } }))
    const create = vi.spyOn(api.files, 'create').mockResolvedValue(undefined)
    await app.mount(); await section('Ideas')
    const note = details().querySelector<HTMLButtonElement>('.mote-details__note')!
    expect(note.textContent).toContain('try-a-new-angle')
    await moteClick(note)
    expect(read).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, notePath)
    expect(details().textContent).toContain('Compare both approaches')
    expect(details().textContent).toContain('try-a-new-angle.md')
    await moteClick([...details().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('New note'))!)
    const input = app.container.querySelector<HTMLInputElement>('.surface-tool-dock input[placeholder="file name"]')!
    expect(input).not.toBeNull()
    await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; setter.call(input, 'my-idea.md'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))); await settleMoteApp()
    expect(create).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, { path: rootPath + '/my-idea.md', kind: 'file' })
    expect(useAppStore.getState().documents[documentKey(SCRATCH_WORKSPACE_ID, rootPath + '/my-idea.md')]).toBeDefined()
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('rejects a late idea read after switching to another Mote, and makes failed reads retryable', async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
    const read = vi.spyOn(api.files, 'read').mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockRejectedValue(new Error('Original note unavailable'))
    await app.mount(); await section('Ideas'); await moteClick(details().querySelector<HTMLButtonElement>('.mote-details__note')!)
    await act(async () => useAppStore.getState().openScratchTopic(customMoteId, SCRATCH_WORKSPACE_ID, { tabId: customTab.id })); await settleMoteApp()
    expect(details().dataset.moteDetails).toBe(customMoteId)
    await act(async () => finish({ status: 'read', document: { path: notePath, content: 'OLD MOTE SECRET', revision: 'late' } })); await settleMoteApp()
    expect(details().textContent).not.toContain('OLD MOTE SECRET')
    await act(async () => useAppStore.getState().openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { tabId: defaultTab.id })); await settleMoteApp()
    await section('Ideas'); await moteClick(details().querySelector<HTMLButtonElement>('.mote-details__note')!)
    expect(details().textContent).toContain('Original note unavailable')
    expect([...details().querySelectorAll('button')].some(button => button.textContent === 'Retry')).toBe(true)
    expect(read).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  })
  it('loads the identical secondary panel in Float above another project', async () => {
    useAppStore.setState({ activeWorkspaceId: 'project', mainSurface: 'board' })
    await app.mount(); await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id })); await settleMoteApp()
    await moteClick(app.panel().querySelector<HTMLButtonElement>('[aria-label="Mote files"]')!)
    const floatDetails = app.panel().querySelector<HTMLElement>('[data-mote-details]')!
    expect(floatDetails.dataset.moteDetails).toBe(PMO_TEAMS_TOPIC_ID)
    expect(app.panel().querySelector('.workspace-tool-explorer .file-explorer')).not.toBeNull()
    expect(app.panel().querySelector('.mote-materials')).toBeNull()
    await section('Persona', floatDetails)
    expect(floatDetails.textContent).toContain('Identity')
    expect(useAppStore.getState().activeWorkspaceId).toBe('project')
  })
  it('opens an empty Mote self-setting through an explicit original Group without creating an Agent', async () => {
    const original = useAppStore.getState()
    const { [quietTab.id]: removed, ...tabs } = original.tabs
    useAppStore.setState({ tabs, activeWorkspaceId: 'project', mainSurface: 'board', layouts: { ...original.layouts,
      [SCRATCH_WORKSPACE_ID]: { ...original.layouts[SCRATCH_WORKSPACE_ID]!, groups: original.layouts[SCRATCH_WORKSPACE_ID]!.groups.map(group => ({ ...group, tabOrder: group.tabOrder.filter(id => id !== quietTab.id) })) } } })
    const read = vi.spyOn(api.files, 'read').mockImplementation(async (_workspace, path) => ({ status: 'read', document: { path, content: '# Quiet original persona', revision: 'empty-persona' } }))
    await app.mount(); await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: quietMoteId, targetTabId: null })); await settleMoteApp()
    const before = useAppStore.getState()
    await moteClick([...app.panel().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Edit persona')!)
    const destination = app.panel().querySelector<HTMLSelectElement>('[aria-label="File opening location"]')!
    expect(destination).not.toBeNull(); expect(destination.value).toBe('')
    expect(read).not.toHaveBeenCalled(); expect(app.panel().textContent).toContain('Choose where to open')
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(destination, JSON.stringify(['project','project-group'])); destination.dispatchEvent(new Event('change', { bubbles: true })) }); await settleMoteApp()
    await moteClick([...app.panel().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Edit persona')!)
    expect(read).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName(quietMoteId) + '/SOUL.md')
    const reference = readPmoTeamsTopicFloatingState()?.reference
    expect(reference?.displayWorkspaceId).toBe('project'); expect(reference?.groupId).toBe('project-group')
    expect(useAppStore.getState().tabs[reference!.tabId]?.topicId).toBe(quietMoteId)
    expect(useAppStore.getState().tabs[reference!.tabId]?.regions[reference!.regionId]?.kind).toBe('file')
    expect(app.panel().querySelector('[data-original-editor]')).not.toBeNull()
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    expect(useAppStore.getState().activeWorkspaceId).toBe('project'); expect(useAppStore.getState().mainSurface).toBe('board')
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('drops a note preview from the old Host when the same logical Mote is rebound', async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
    vi.spyOn(api.files, 'read').mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await app.mount(); await section('Ideas'); await moteClick(details().querySelector<HTMLButtonElement>('.mote-details__note')!)
    const state = useAppStore.getState(), workspace = state.config!.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)!
    const { scratchTopicsScope } = await import('../src/renderer/src/lib/scratch-topic-snapshots')
    await act(async () => useAppStore.setState({ config: { ...state.config!, workspaces: state.config!.workspaces.map(item => item.id === workspace.id ? { ...item, hostId: 'new-host' } : item) }, scratchTopicSnapshots: {
      ...state.scratchTopicSnapshots, [workspace.id]: { ...state.scratchTopicSnapshots[workspace.id]!, scope: scratchTopicsScope({ ...workspace, hostId: 'new-host' }) }
    } })); await settleMoteApp()
    await act(async () => finish({ status: 'read', document: { path: notePath, content: 'OLD HOST SECRET', revision: 'late' } })); await settleMoteApp()
    expect(details().textContent).not.toContain('OLD HOST SECRET')
    expect(details().querySelector('.mote-details__preview')).toBeNull()
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  })

  it('routes a directory terminal action to its explicit display Group when the resource layout is absent', async () => {
    const original = useAppStore.getState(), root = scratchTopicDirectoryName(quietMoteId)
    const { [quietTab.id]: removed, ...tabs } = original.tabs
    const { [SCRATCH_WORKSPACE_ID]: resourceLayout, ...layouts } = original.layouts
    const launchTerminal = vi.fn(async () => {})
    useAppStore.setState({ tabs, layouts, activeWorkspaceId: 'project', mainSurface: 'board', launchTerminal })
    vi.mocked(api.files.readDirectory).mockResolvedValue([{ ...entry(root + '/ideas'), isDirectory: true }])
    await app.mount(); await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: quietMoteId, targetTabId: null })); await settleMoteApp()
    await moteClick(app.panel().querySelector<HTMLButtonElement>('[aria-label="Mote files"]')!)
    const destination = app.panel().querySelector<HTMLSelectElement>('[aria-label="File opening location"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(destination, JSON.stringify(['project','project-group'])); destination.dispatchEvent(new Event('change', { bubbles: true })) }); await settleMoteApp()
    const folder = app.panel().querySelector<HTMLElement>('[data-tree-path="' + root + '/ideas"]')!
    expect(folder).not.toBeNull()
    await act(async () => folder.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }))); await settleMoteApp()
    const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Terminal'))!
    const sessionsBeforeAction = useAppStore.getState().sessions
    expect(action).not.toBeNull(); await moteClick(action)
    expect(launchTerminal).toHaveBeenCalledTimes(1)
    expect(launchTerminal.mock.calls[0]?.[0]).toBe('project-group')
    expect(readPmoTeamsTopicFloatingState()?.reference?.displayWorkspaceId).toBe('project')
    expect(useAppStore.getState().sessions).toBe(sessionsBeforeAction)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })

})
