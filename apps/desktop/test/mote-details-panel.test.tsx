// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { customMoteId, customTab, defaultAgent, defaultTab, quietMoteId, quietTab, ordinaryTopicId, ordinaryTab, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName, scratchTopicIdentityPath } from '../src/shared/scratch-topics'
import { requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { WorkspaceFilesTool } from '../src/renderer/src/components/SurfaceToolDock'
import { useMoteWorkfaceScope } from '../src/renderer/src/lib/mote-workface'
import { useMoteMaterialsActions } from '../src/renderer/src/lib/mote-materials-actions'
import { topicSpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
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
function originalModal() { return document.querySelector<HTMLElement>('.space-icon-picker[role="dialog"], .mote-rename[role="dialog"]') }

describe('Mote object content in the original secondary tools frame', () => {
  it('keeps the ordinary Topic icon menu and its original no-callback return target', async () => {
    await app.mount()
    await act(async () => useAppStore.getState().openScratchTopic(ordinaryTopicId, SCRATCH_WORKSPACE_ID, { tabId: ordinaryTab.id })); await settleMoteApp()
    const key = topicSpaceIconTarget(scratchWorkspace, moteTopics.find(topic => topic.id === ordinaryTopicId)!).key
    const row = [...app.container.querySelectorAll<HTMLElement>('[data-space-icon-target]')].find(node => node.dataset.spaceIconTarget === key)!
    expect(row).not.toBeNull(); row.focus()
    await act(async () => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }))); await settleMoteApp()
    const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === 'Change icon…')!
    expect(action).not.toBeNull(); await moteClick(action)
    const dialog = originalModal()!, icons = useAppStore.getState().spaceObjectIcons
    expect(dialog).not.toBeNull(); expect(dialog.querySelector('.space-icon-picker__title')?.textContent).toBe('Change icon')
    expect(dialog.querySelector('[aria-label="Mote avatar style"]')).toBeNull()
    await moteClick([...dialog.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === 'Cancel')!)
    expect(originalModal()).toBeNull(); expect(document.activeElement).toBe(row)
    expect(useAppStore.getState().spaceObjectIcons).toBe(icons); expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('uses the original avatar and name modal targets and returns cancellation to the exact invoker', async () => {
    await app.mount()
    const original = useAppStore.getState(), workbench = app.container.querySelector('.workspace-workbench')
    expect([...details().querySelectorAll('[role="tab"]')].map(node => node.textContent)).toEqual(['Profile', 'Ideas'])
    expect([...details().querySelectorAll('button')].filter(node => ['Avatar', 'Rename', 'Read self setting', 'Explore notes'].includes(node.textContent?.trim() ?? ''))).toHaveLength(0)
    for (const label of ['Change Mote avatar', 'Rename Mote']) {
      const invoker = details().querySelector<HTMLButtonElement>('[aria-label="' + label + '"]')!
      expect(invoker).not.toBeNull(); invoker.focus(); await moteClick(invoker)
      const dialog = originalModal()!
      expect(dialog).not.toBeNull(); expect(dialog.textContent).toContain('Mote')
      if (label === 'Rename Mote') expect(dialog.querySelector<HTMLInputElement>('input')?.value).toBe('Mote')
      else expect(dialog.querySelector('[aria-label="Mote avatar style"]')).not.toBeNull()
      await moteClick([...dialog.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === 'Cancel')!)
      expect(originalModal()).toBeNull(); expect(document.activeElement).toBe(invoker)
      expect(app.container.querySelector('.workspace-workbench')).toBe(workbench)
      expect(useAppStore.getState().tabs).toBe(original.tabs); expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts)
      expect(useAppStore.getState().spaceObjectIcons).toBe(original.spaceObjectIcons)
    }
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('lets later original input focus win during each installed modal asynchronous close', async () => {
    await app.mount()
    const input = app.container.querySelector<HTMLElement>('[aria-label="Message Agent"]')!
    expect(input).not.toBeNull()
    for (const label of ['Change Mote avatar', 'Rename Mote']) {
      await moteClick(details().querySelector<HTMLButtonElement>('[aria-label="' + label + '"]')!)
      const dialog = originalModal()!, cancel = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === 'Cancel')!
      act(() => cancel.click())
      expect(originalModal()).toBeNull()
      input.focus(); expect(document.activeElement).toBe(input)
      await settleMoteApp(); expect(document.activeElement).toBe(input)
    }
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('keeps an opened rename draft bound to its captured original directory after same-id Host rebind', async () => {
    const rename = vi.spyOn(useAppStore.getState(), 'renameScratchTopic')
    await app.mount(); await moteClick(details().querySelector<HTMLButtonElement>('[aria-label="Rename Mote"]')!)
    const dialog = originalModal()!, input = dialog.querySelector<HTMLInputElement>('input')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Original unsaved name'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    const state = useAppStore.getState(), original = state.config!.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)!
    const { scratchTopicsScope } = await import('../src/renderer/src/lib/scratch-topic-snapshots')
    await act(async () => useAppStore.setState({ config: { ...state.config!, workspaces: state.config!.workspaces.map(item => item.id === original.id ? { ...item, hostId: 'new-host', path: original.path + '-new' } : item) }, scratchTopicSnapshots: {
      ...state.scratchTopicSnapshots, [original.id]: { ...state.scratchTopicSnapshots[original.id]!, scope: scratchTopicsScope({ ...original, hostId: 'new-host', path: original.path + '-new' }) }
    } })); await settleMoteApp()
    expect(originalModal()).toBe(dialog); expect(input.value).toBe('Original unsaved name')
    await moteClick([...dialog.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === 'Save name')!)
    expect(rename).not.toHaveBeenCalled(); expect(dialog.textContent).toContain('original Mote directory is still restoring')
    expect(input.value).toBe('Original unsaved name'); expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('keeps an opened avatar choice on its captured original resource and respects an explicitly unavailable return target after Host rebind', async () => {
    const originalTarget = topicSpaceIconTarget(scratchWorkspace, moteTopics.find(topic => topic.id === PMO_TEAMS_TOPIC_ID)!)
    // A connected original-resource entry is a competing fallback candidate, not a replacement Dialog owner.
    await app.mount(createElement('button', { 'data-space-icon-target': originalTarget.key, 'data-original-return-candidate': true }, 'Original resource entry'))
    const competing = app.container.querySelector<HTMLButtonElement>('[data-original-return-candidate]')!
    const save = vi.spyOn(useAppStore.getState(), 'setSpaceObjectIcon')
    await moteClick(details().querySelector<HTMLButtonElement>('[aria-label="Change Mote avatar"]')!)
    const dialog = originalModal()!
    await moteClick(dialog.querySelector<HTMLButtonElement>('[data-avatar-source="alternative"]')!)
    await moteClick(dialog.querySelector<HTMLButtonElement>('[data-space-icon-choice="rocket"]')!)
    const state = useAppStore.getState(), original = state.config!.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)!
    const { scratchTopicsScope } = await import('../src/renderer/src/lib/scratch-topic-snapshots')
    await act(async () => useAppStore.setState({ config: { ...state.config!, workspaces: state.config!.workspaces.map(item => item.id === original.id ? { ...item, hostId: 'new-host', path: original.path + '-new' } : item) }, scratchTopicSnapshots: {
      ...state.scratchTopicSnapshots, [original.id]: { ...state.scratchTopicSnapshots[original.id]!, scope: scratchTopicsScope({ ...original, hostId: 'new-host', path: original.path + '-new' }) }
    } })); await settleMoteApp()
    expect(originalModal()).toBe(dialog)
    expect(dialog.querySelector('[data-space-icon-choice="rocket"]')?.getAttribute('aria-pressed')).toBe('true')
    const currentTarget = topicSpaceIconTarget(useAppStore.getState().config!.workspaces.find(item => item.id === original.id)!, moteTopics.find(topic => topic.id === PMO_TEAMS_TOPIC_ID)!)
    expect(currentTarget.key).not.toBe(originalTarget.key)
    await moteClick(dialog.querySelector<HTMLButtonElement>('[aria-label="Save avatar"]')!)
    expect(save).toHaveBeenCalledExactlyOnceWith(originalTarget.key, 'rocket')
    expect(useAppStore.getState().spaceObjectIcons[currentTarget.key]).toBeUndefined()
    // The real writer may retain the choice while restoration is unconfirmed; either close path uses the installed FocusScope.
    if (originalModal()) await moteClick([...dialog.querySelectorAll<HTMLButtonElement>('button')].find(node => ['Cancel', 'Close'].includes(node.textContent?.trim() ?? ''))!)
    await settleMoteApp(); expect(originalModal()).toBeNull(); expect(document.activeElement).not.toBe(competing)
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('uses finite authoritative times for three stable recent titles and opens the identical Ideas path without reading Profile note bodies', async () => {
    const names = [['a-old.md', 10], ['z-new.md', 50], ['b-equal.md', 20], ['c-equal.md', 20], ['zero.md', 0], ['unknown.md', undefined], ['invalid.md', NaN]] as const
    vi.mocked(api.files.readDirectory).mockResolvedValue(names.map(([name, mtimeMs]) => ({ ...entry(rootPath + '/' + name), ...(mtimeMs === undefined ? {} : { mtimeMs }) })))
    const read = vi.spyOn(api.files, 'read').mockImplementation(async (_workspace, path) => ({ status: 'read', document: { path, content: 'Exact note ' + path, revision: 'original-note' } }))
    await app.mount()
    const original = useAppStore.getState(), workbench = app.container.querySelector('.workspace-workbench')
    const recent = [...details().querySelectorAll<HTMLButtonElement>('.mote-details__recent .mote-details__note')]
    expect(recent.map(node => node.textContent)).toEqual(['z-new', 'b-equal', 'c-equal']); expect(read).not.toHaveBeenCalled()
    const unknownTime = details().querySelector<HTMLElement>('.mote-details__recent [role="status"]')
    expect(unknownTime).not.toBeNull(); expect(unknownTime!.textContent).toContain('not confirmed')
    await moteClick(recent[1]!)
    expect(details().querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Ideas')
    expect(read).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, rootPath + '/b-equal.md')
    expect(details().querySelector('.mote-details__note[aria-pressed="true"]')?.textContent).toContain('b-equal')
    expect(details().querySelectorAll('.mote-details__note')).toHaveLength(names.length)
    expect(details().querySelector('.mote-details__preview')?.textContent).toContain('Exact note ' + rootPath + '/b-equal.md')
    expect(app.container.querySelector('.workspace-workbench')).toBe(workbench); expect(useAppStore.getState().tabs).toBe(original.tabs)
    expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts); expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('keeps epoch-zero recent facts and all unknown-time notes accessible through the original Ideas group', async () => {
    vi.mocked(api.files.readDirectory).mockResolvedValue([{ ...entry(rootPath + '/zero.md'), mtimeMs: 0 }, entry(rootPath + '/unknown.md'), { ...entry(rootPath + '/invalid.md'), mtimeMs: Infinity }])
    await app.mount()
    expect([...details().querySelectorAll('.mote-details__recent .mote-details__note')].map(node => node.textContent)).toEqual(['zero'])
    await section('Ideas'); expect(details().querySelectorAll('.mote-details__note')).toHaveLength(3)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('starts each explicitly selected object section at its beginning and keeps the original workbench', async () => {
    await app.mount()
    const originalWorkbench = app.container.querySelector('.workspace-workbench')
    expect(originalWorkbench).not.toBeNull()
    const original = useAppStore.getState()
    const profile = details().querySelector<HTMLElement>('[role="tabpanel"]')!
    profile.scrollTop = 120
    await section('Ideas')
    expect(details().querySelector<HTMLElement>('[role="tabpanel"]')!.scrollTop).toBe(0)
    details().querySelector<HTMLElement>('[role="tabpanel"]')!.scrollTop = 120
    await section('Profile')
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
    await app.mount()
    await moteClick(details().querySelector<HTMLButtonElement>('[aria-label="Edit self setting"]')!)
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
  it('hands the Float to the identical original Space secondary panel above another project', async () => {
    useAppStore.setState({ activeWorkspaceId: 'project', mainSurface: 'board' })
    const focus = vi.spyOn(useAppStore.getState(), 'executeControl')
    await app.mount(); await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id })); await settleMoteApp()
    expect(app.panel().querySelector('[data-mote-details], .workspace-tool-explorer, [aria-label="Mote files"]')).toBeNull()
    await moteClick(app.panel().querySelector<HTMLButtonElement>('[aria-label="Open in Space"]')!)
    await act(async () => { await focus.mock.results[0]!.value }); await settleMoteApp()
    expect(details().dataset.moteDetails).toBe(PMO_TEAMS_TOPIC_ID)
    expect(app.container.querySelector('.surface-tool-dock .workspace-tool-explorer .file-explorer')).not.toBeNull()
    expect(app.container.querySelector('.mote-materials')).toBeNull()
    expect(details().textContent).toContain('Identity')
    expect(useAppStore.getState().activeWorkspaceId).toBe(SCRATCH_WORKSPACE_ID)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('opens an empty Mote self-setting in its original Space active Group without creating an Agent', async () => {
    const original = useAppStore.getState()
    const { [quietTab.id]: removed, ...tabs } = original.tabs
    useAppStore.setState({ tabs, activeWorkspaceId: 'project', mainSurface: 'board', layouts: { ...original.layouts,
      [SCRATCH_WORKSPACE_ID]: { ...original.layouts[SCRATCH_WORKSPACE_ID]!, groups: original.layouts[SCRATCH_WORKSPACE_ID]!.groups.map(group => ({ ...group, tabOrder: group.tabOrder.filter(id => id !== quietTab.id) })) } } })
    const read = vi.spyOn(api.files, 'read').mockImplementation(async (_workspace, path) => ({ status: 'read', document: { path, content: '# Quiet original persona', revision: 'empty-persona' } }))
    const focus = vi.spyOn(useAppStore.getState(), 'executeControl')
    await app.mount(); await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: quietMoteId, targetTabId: null })); await settleMoteApp()
    expect(app.panel().querySelector('[aria-label="File opening location"], [data-mote-details]')).toBeNull()
    await moteClick(app.panel().querySelector<HTMLButtonElement>('[aria-label="Open in Space"]')!)
    await act(async () => { await focus.mock.results[0]!.value }); await settleMoteApp()
    const before = useAppStore.getState()
    expect(before.workbenchSpaceSelection).toMatchObject({ topicId: quietMoteId, tabId: null, regionId: null })
    expect(read).not.toHaveBeenCalled()
    await moteClick(details().querySelector<HTMLButtonElement>('[aria-label="Edit self setting"]')!)
    expect(read).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName(quietMoteId) + '/SOUL.md')
    const reference = useAppStore.getState().workbenchSpaceSelection!
    expect(reference.workspaceId).toBe(SCRATCH_WORKSPACE_ID); expect(reference.groupId).toBe('mote-group')
    expect(useAppStore.getState().tabs[reference.tabId!]?.topicId).toBe(quietMoteId)
    expect(useAppStore.getState().tabs[reference.tabId!]?.regions[reference.regionId!]?.kind).toBe('file')
    // This is also the first File surface in the isolated one-case withdrawal
    // run; await the real lazy FileSurfaceView commit rather than a warm timer.
    await vi.waitFor(async () => { await settleMoteApp(); expect(app.container.querySelector('[data-original-editor]')).not.toBeNull() }, { timeout: 3000, interval: 20 })
    expect(useAppStore.getState().activeWorkspaceId).toBe(SCRATCH_WORKSPACE_ID); expect(useAppStore.getState().mainSurface).toBe('workbench')
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

  it('routes the original public Space Files directory terminal callback to its explicit display Group when the resource layout is absent', async () => {
    const original = useAppStore.getState(), root = scratchTopicDirectoryName(quietMoteId)
    const { [quietTab.id]: removed, ...tabs } = original.tabs
    const { [SCRATCH_WORKSPACE_ID]: resourceLayout, ...layouts } = original.layouts
    const launchTerminal = vi.fn<ReturnType<typeof useAppStore.getState>['launchTerminal']>(async () => {})
    useAppStore.setState({ tabs, layouts, activeWorkspaceId: 'project', mainSurface: 'board', launchTerminal })
    vi.mocked(api.files.readDirectory).mockResolvedValue([{ ...entry(root + '/ideas'), isDirectory: true }])
    const topic = moteTopics.find(topic => topic.id === quietMoteId)!, spaceId = directoryIdentity(scratchWorkspace.hostId, scratchTopicIdentityPath(scratchWorkspace, topic))
    await act(async () => { await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'empty-space-files-counter', operation: 'focus',
      target: { kind: 'space', spaceId, zoneId: homeZoneId(spaceId), displayWorkspaceId: 'project', groupId: 'project-group' }, inputPolicy: 'preserve' }) })
    // This is the original public tool and actual materials callback. Its resource
    // remains Scratch; the explicit selected display Pane belongs to Project.
    // No floating Files surface or substitute File/launcher owner is mounted.
    function OriginalSpaceFiles() {
      const scope = useMoteWorkfaceScope(SCRATCH_WORKSPACE_ID, quietMoteId)
      const materials = useMoteMaterialsActions(scope, { destination: { displayWorkspaceId: 'project', groupId: 'project-group' } })
      return createElement('aside', { 'data-original-space-files-counter': true }, createElement(WorkspaceFilesTool, {
        workspace: scratchWorkspace, isScratch: true, visible: true, topicId: quietMoteId, onOpenTerminal: materials.terminal }))
    }
    await app.mount(createElement(OriginalSpaceFiles))
    expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]).toBeUndefined()
    const folder = app.container.querySelector<HTMLElement>('[data-original-space-files-counter] [data-tree-path="' + root + '/ideas"]')!
    expect(folder).not.toBeNull()
    await act(async () => folder.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }))); await settleMoteApp()
    const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Terminal'))!
    const sessionsBeforeAction = useAppStore.getState().sessions
    expect(action).not.toBeNull(); await moteClick(action)
    expect(launchTerminal).toHaveBeenCalledTimes(1)
    expect(launchTerminal.mock.calls[0]?.[0]).toBe('project-group')
    expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]).toBeUndefined()
    expect(useAppStore.getState().layouts.project!.groups.find(group => group.id === 'project-group')?.tabOrder).toContain(launchTerminal.mock.calls[0]?.[1]?.tabId)
    expect(useAppStore.getState().sessions).toBe(sessionsBeforeAction)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })

})
