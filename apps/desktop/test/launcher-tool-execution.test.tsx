// @vitest-environment happy-dom
import { act, type ContextType } from 'react'
import { expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-warm-run /> }))
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { useAppStore, warmTerminalKey } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { hydratePersistedTab, reducePersistedTab } from '../src/renderer/src/lib/workbench-persistence'
import { createWorkspaceLayout } from '@agentmux/layout'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
const dom = composerDOM()
const remote = { id: 'B', kind: 'ssh' as const, label: 'Agent server', hostname: 'fixture.invalid' }
const remoteProject = { id: 'agent-project', hostId: 'B', name: 'Agent home', path: '/agent-home', kind: 'folder' as const }
const target = { tabId: 'launch', regionId: 'input' }
async function mount(reverse = false, settings: ContextType<typeof SettingsNavigation> = null) {
  const project = reverse ? remoteProject : composerConfig.workspaces[0]!
  const warm = { ...composerSession('warm-original'), kind: 'terminal' as const, providerId: null,
    hostId: project.hostId, workspacePath: project.path, control: { kind: 'terminal' as const, hostId: project.hostId, runId: 'warm-run', run: { runId: 'warm-run' } } }
  const base = createWorkbenchTab('launch', { regionId: 'input', kind: 'launcher', workspaceId: project.id })
  const tab = addWorkbenchRegion(base, 'input', 'right', { regionId: 'sibling', kind: 'launcher', workspaceId: project.id })!
  tab.layout = { ...tab.layout, activeRegionId: 'input' }
  vi.spyOn(api.executors, 'discover').mockImplementation(async hostId => ({ routeHostId: hostId, runtimeId: 'runtime-' + hostId, executors: [{ executorId: 'codex', label: 'Core Agent ' + hostId,
    providerId: 'codex', command: '/core-codex', source: 'registered', configRevision: 'revision-' + hostId, availability: 'available' }] }))
  await act(async () => {
    useLauncherState.setState({ sections: {}, drafts: {}, executors: {} })
    useAppStore.setState({ config: { ...composerConfig, hosts: [...composerConfig.hosts, remote], workspaces: [...composerConfig.workspaces, remoteProject] },
      activeWorkspaceId: project.id, tabs: { launch: tab }, layouts: { [project.id]: createWorkspaceLayout('group', [tab.id]) },
      hostExecutorInventories: {}, executorDetections: {}, hostChecks: {},
      agentComposerDrafts: { input: 'Keep complete request', sibling: 'Neighbor draft' }, launcherNameDrafts: { input: { agentName: 'Original name', tabName: 'Original tab' } },
      launcherOptionDrafts: { input: { codex: { model: 'original-model' } } }, recoveryCandidates: [],
      warmTerminals: { [warmTerminalKey(project.hostId, project.path)]: [{ key: warmTerminalKey(project.hostId, project.path), ownerLauncherId: 'region:input', session: warm, ready: Promise.resolve(warm) }] },
      prewarmTerminal: vi.fn() })
  })
  await dom.render(<SettingsNavigation.Provider value={settings}><NewTabSurface tabGroupId="group" tabId="launch" regionId="input" /></SettingsNavigation.Provider>)
  return { project, warm, before: useAppStore.getState() }
}
async function mode(label: string) {
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('.launcher-execution__mode')].find(item => item.textContent?.includes(label))
  expect(button).toBeDefined()
  await act(async () => button!.click())
}
async function applySplit(workspaceId: string) {
  expect(dom.container.querySelector('.launcher-execution__modes')?.closest('[role="dialog"], [hidden], [inert]')).toBeNull()
  await dom.click('.launcher-execution__custom')
  await dom.click('.launcher-execution__endpoints > button:nth-child(2)')
  const hostId = useAppStore.getState().config!.workspaces.find(item => item.id === workspaceId)!.hostId
  const before = useAppStore.getState().tabs.launch!.regions.input
  await act(async () => { const select = document.querySelector<HTMLSelectElement>('[aria-label="Machine for new session"]')!; select.value = hostId; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(useAppStore.getState().tabs.launch!.regions.input).toBe(before)
  await act(async () => document.querySelector<HTMLButtonElement>(`[data-workspace-id="${workspaceId}"]`)!.click())
  expect(useAppStore.getState().tabs.launch!.regions.input).toBe(before)
  await dom.click('.launcher-execution__setup .primary-button')
}
async function splitAt(workspaceId: string) { await expect(applySplit(workspaceId)).resolves.toBeUndefined() }
it.each([false, true])('real Launcher sends exact B Core revision and A tool resource in direction reverse=%s, retaining A draft/files/warm shell', async reverse => {
  const f = await mount(reverse), agentWorkspace = reverse ? composerConfig.workspaces[0]! : remoteProject
  const stops = vi.spyOn(api.sessions, 'stop')
  await splitAt(agentWorkspace.id)
  const state = useAppStore.getState(), surface = state.tabs.launch!.regions.input
  expect(surface).toMatchObject({ workspaceId: f.project.id, agentWorkspaceId: agentWorkspace.id, agentExecutor: { hostId: agentWorkspace.hostId, executorId: 'codex', executorRevision: 'revision-' + agentWorkspace.hostId } })
  expect(state.agentComposerDrafts).toEqual(f.before.agentComposerDrafts)
  expect(state.launcherNameDrafts).toEqual(f.before.launcherNameDrafts)
  expect(state.launcherOptionDrafts).toEqual(f.before.launcherOptionDrafts)
  expect(state.tabs.launch!.regions.sibling).toBe(f.before.tabs.launch!.regions.sibling)
  expect(state.layouts).toBe(f.before.layouts)
  expect(state.warmTerminals).toBe(f.before.warmTerminals)
  expect(dom.container.querySelector('[data-warm-run]')).not.toBeNull()
  expect(dom.container.querySelector('[aria-pressed="true"][data-executor-id="codex"]')?.textContent).toContain('Core Agent ' + agentWorkspace.hostId)
  expect(dom.container.querySelector('.launcher-resume-trigger')?.textContent).toContain('Resume original')
  expect(hydratePersistedTab(reducePersistedTab(state.tabs.launch!)).regions.input).toEqual(surface)
  const launch = vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(new Error('Original launch outcome unconfirmed'))
  await dom.click('.launcher-launch-button')
  expect(launch).toHaveBeenCalledWith(expect.objectContaining({ hostId: agentWorkspace.hostId, workspacePath: agentWorkspace.path, executionWorkspaceId: agentWorkspace.id,
    toolWorkspace: { id: f.project.id, hostId: f.project.hostId, path: f.project.path }, executorRevision: 'revision-' + agentWorkspace.hostId, prompt: 'Keep complete request', launchOptions: { model: 'original-model' } }), undefined)
  const pendingSurface = useAppStore.getState().tabs.launch!.regions.input
  expect(pendingSurface).toMatchObject({ kind: 'agent', phase: 'launching', workspaceId: agentWorkspace.id, sessionId: launch.mock.calls[0]![0].agentSessionId })
  expect(useAppStore.getState().pendingAgentLaunches[launch.mock.calls[0]![0].agentSessionId!]?.request).toMatchObject({ toolWorkspace: { id: f.project.id, hostId: f.project.hostId, path: f.project.path }, executionWorkspaceId: agentWorkspace.id })
  expect(useAppStore.getState().agentComposerDrafts.input).toBe('Keep complete request')
  expect(stops).not.toHaveBeenCalled()
})
it('keeps actual remote file references and ordinary Terminal launch on A after choosing local Agent B', async () => {
  const f = await mount(true); await splitAt('workspace')
  const list = vi.spyOn(api.files, 'readDirectory').mockResolvedValue([{ name: 'original.md', path: 'original.md', isDirectory: false, isSymlink: false }])
  const localFiles = vi.spyOn(api.ui, 'chooseFiles')
  await dom.click('[aria-label="Reference files for the Agent"]')
  expect(list).toHaveBeenCalledWith(remoteProject.id, ''); expect(localFiles).not.toHaveBeenCalled()
  await act(async () => document.querySelector<HTMLButtonElement>('[data-reference-path="original.md"]')!.click())
  expect(useAppStore.getState().agentComposerDrafts.input).toContain('[original.md](agentmux-file:%40original.md)')
  const launch = vi.spyOn(api.sessions, 'launchTerminal')
  await act(async () => useAppStore.getState().launchTerminal('group', target))
  expect(launch).toHaveBeenCalledWith(expect.objectContaining({ hostId: f.project.hostId, workspacePath: f.project.path }))
})
it('never aliases a retained Core choice to App templates or a new Host revision; returning to ordinary mode preserves the project', async () => {
  await mount(); await splitAt('workspace')
  await act(async () => useAppStore.setState(state => { const inventory = state.hostExecutorInventories.local!; return { hostExecutorInventories: { ...state.hostExecutorInventories,
    local: { ...inventory, result: { ...inventory.result!, executors: inventory.result!.executors.map(item => ({ ...item, configRevision: 'changed-revision' })) } } } } }))
  expect(dom.container.querySelector('[aria-pressed="true"][data-executor-id="codex"]')).toBeNull()
  expect(dom.container.querySelector<HTMLButtonElement>('.launcher-launch-button')!.disabled).toBe(true)
  expect(dom.container.querySelector('[aria-label="Agent prompt"]')?.getAttribute('contenteditable')).toBe('true')
  await dom.click('[data-executor-id="codex"]')
  expect(useAppStore.getState().tabs.launch!.regions.input).toMatchObject({ agentExecutor: { executorRevision: 'changed-revision' } })
  await mode('Local development')
  expect(useAppStore.getState().tabs.launch!.regions.input).toMatchObject({ workspaceId: 'workspace' })
  expect(useAppStore.getState().tabs.launch!.regions.input).not.toHaveProperty('agentWorkspaceId')
})
it('retains exact selection after discovery failure and obeys the original closing View boundary', async () => {
  await mount(); await splitAt(remoteProject.id)
  const before = useAppStore.getState()
  vi.mocked(api.executors.discover).mockRejectedValue(new Error('Observation unavailable'))
  await act(async () => useAppStore.getState().detectExecutors(remote.id, { source: 'host' }))
  expect(dom.container.querySelector<HTMLButtonElement>('.launcher-launch-button')!.disabled).toBe(false)
  expect(dom.container.querySelector('[aria-pressed="true"][data-executor-id="codex"]')).not.toBeNull()
  useAppStore.setState({ closingWorkbenchViews: { launch: { workspaceId: 'workspace', tabGroupId: 'group', tabId: 'launch', closesView: true, surfaces: [], resources: [], reservedSessionIds: [] } } })
  expect(() => useAppStore.getState().setLauncherAgentExecutor(target, 'codex')).toThrow('View is closing')
  expect(useAppStore.getState().tabs.launch).toBe(before.tabs.launch)
})
it('restores the exact dual selection only on an authoritative not-applied reply', async () => {
  await mount(); await splitAt(remoteProject.id)
  const surface = useAppStore.getState().tabs.launch!.regions.input
  vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(Object.assign(new Error('Owner rejected this operation before apply'), { controlFailure: { disposition: 'not_applied' } }))
  await dom.click('.launcher-launch-button')
  expect(useAppStore.getState().tabs.launch!.regions.input).toEqual(surface)
  expect(useAppStore.getState().agentComposerDrafts.input).toBe('Keep complete request')
})

it('opens the exact Remote execution guide from the project Launcher without preparing or launching work', async () => {
  const open = vi.fn()
  const settings = { open, openToolkit: vi.fn(), openHost: vi.fn(), openChannel: vi.fn(), channelEntries: [],
    channelPresentation: vi.fn(), openMoteLark: vi.fn(), chooseAgent: vi.fn() }
  await mount(false, settings)
  const before = useAppStore.getState()
  const launch = vi.spyOn(api.sessions, 'launchAgent'), resume = vi.spyOn(api.sessions, 'resume'), stop = vi.spyOn(api.sessions, 'stop')
  const prepare = vi.spyOn(useAppStore.getState(), 'setLauncherAgentWorkspace')
  const help = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.textContent?.trim() === 'How it works')
  expect(help).toHaveLength(1)
  expect(help[0]!.closest('[role="dialog"], [hidden], [inert]')).toBeNull()
  await act(async () => help[0]!.click())
  expect(open).toHaveBeenCalledExactlyOnceWith('remote-execution', undefined, 'guide')
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(prepare).not.toHaveBeenCalled()
  expect(launch).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
})
it('explains unsupported Mote dual execution while retaining normal launch, all inputs and original selection', async () => {
  await mount(); await splitAt(remoteProject.id)
  const { SCRATCH_WORKSPACE_ID } = await import('../src/shared/scratch-topics')
  const scratch = { ...composerConfig.workspaces[0]!, id: SCRATCH_WORKSPACE_ID, name: 'No Project' }
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [...state.config!.workspaces, scratch] } })))
  await act(async () => useAppStore.getState().setLauncherExecutionWorkspace(target, scratch.id))
  expect(dom.container.textContent).toContain('Separate execution needs two registered projects')
  expect(dom.container.querySelector<HTMLButtonElement>('.launcher-launch-button')!.disabled).toBe(true)
  expect(useAppStore.getState().tabs.launch!.regions.input).toMatchObject({ workspaceId: scratch.id, agentWorkspaceId: remoteProject.id })
  const launch = vi.spyOn(api.sessions, 'launchAgent')
  await act(async () => { await expect(useAppStore.getState().launchAgent('codex', 'Keep complete request', 'group', target)).rejects.toThrow('two registered project') })
  expect(launch).not.toHaveBeenCalled()
  await act(async () => useAppStore.getState().setLauncherAgentWorkspace(target, null))
  expect(dom.container.querySelector<HTMLButtonElement>('.launcher-launch-button')!.disabled).toBe(false)
  expect(useAppStore.getState().agentComposerDrafts.input).toBe('Keep complete request')
})


it('exposes three intentions immediately; cancel and Host browsing keep the complete original tuple and drafts', async () => {
  const f = await mount()
  const launch = vi.spyOn(api.sessions, 'launchAgent'), stop = vi.spyOn(api.sessions, 'stop')
  expect(dom.container.querySelectorAll('.launcher-execution__mode')).toHaveLength(3)
  await mode('Remote Agent')
  expect(dom.container.querySelector('.launcher-execution__setup')?.textContent).toContain('Choose the remote Agent environment')
  expect(dom.container.querySelectorAll('[aria-label="Machine for new session"] option')).toHaveLength(1)
  expect(dom.container.querySelector<HTMLSelectElement>('[aria-label="Machine for new session"]')!.value).toBe('B')
  expect(useAppStore.getState().tabs).toBe(f.before.tabs)
  await dom.click('[aria-label="Cancel execution setup"]')
  expect(useAppStore.getState().tabs).toBe(f.before.tabs)
  expect(useAppStore.getState().agentComposerDrafts).toBe(f.before.agentComposerDrafts)
  expect(useAppStore.getState().launcherNameDrafts).toBe(f.before.launcherNameDrafts)
  expect(useAppStore.getState().launcherOptionDrafts).toBe(f.before.launcherOptionDrafts)
  expect(document.activeElement?.textContent).toContain('Remote Agent')
  expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
})
it('one Remote Agent target choice commits the original local project and remote runtime without launching', async () => {
  const f = await mount(), launch = vi.spyOn(api.sessions, 'launchAgent')
  await mode('Remote Agent')
  await dom.click('[data-workspace-id="agent-project"]')
  expect(useAppStore.getState().tabs.launch!.regions.input).toMatchObject({ workspaceId: 'workspace', agentWorkspaceId: remoteProject.id })
  expect(dom.container.querySelector('.launcher-execution__setup')).toBeNull()
  expect(useAppStore.getState().agentComposerDrafts).toBe(f.before.agentComposerDrafts)
  expect(launch).not.toHaveBeenCalled()
  await mode('Local development')
  expect(useAppStore.getState().tabs.launch!.regions.input).not.toHaveProperty('agentWorkspaceId')
  expect(useAppStore.getState().tabs.launch!.regions.input.workspaceId).toBe('workspace')
})
it('Remote development enters the selected project’s workface and keeps relative file drafts in the original project', async () => {
  const f = await mount(), launch = vi.spyOn(api.sessions, 'launchAgent')
  await act(async () => useAppStore.getState().setAgentComposerDraft('input', '[local.md](agentmux-file:%40local.md)'))
  const source = useAppStore.getState()
  await mode('Remote development')
  expect(useAppStore.getState().activeWorkspaceId).toBe('workspace')
  await dom.click('[data-workspace-id="agent-project"]')
  const state = useAppStore.getState(), newTab = Object.values(state.tabs).find(tab => tab.id !== 'launch')!
  expect(state.activeWorkspaceId).toBe(remoteProject.id)
  expect(state.tabs.launch).toBe(source.tabs.launch)
  expect(state.agentComposerDrafts.input).toBe('[local.md](agentmux-file:%40local.md)')
  expect(newTab.workspaceId).toBe(remoteProject.id)
  expect(newTab.regions[newTab.layout.activeRegionId]).toMatchObject({ kind: 'launcher', workspaceId: remoteProject.id })
  expect(newTab.regions[newTab.layout.activeRegionId]).not.toHaveProperty('agentWorkspaceId')
  expect(state.agentComposerDrafts[newTab.layout.activeRegionId] ?? '').toBe('')
  expect(state.launcherNameDrafts.input).toBe(f.before.launcherNameDrafts.input)
  expect(state.launcherOptionDrafts.input).toBe(f.before.launcherOptionDrafts.input)
  expect(launch).not.toHaveBeenCalled()
})
it('Custom staging leaves both addresses unchanged until one complete arrangement is applied', async () => {
  const f = await mount(true)
  await dom.click('.launcher-execution__custom')
  await dom.click('.launcher-execution__endpoints > button:nth-child(2)')
  await dom.click('[data-workspace-id="workspace"]')
  expect(useAppStore.getState().tabs).toBe(f.before.tabs)
  await dom.click('.launcher-execution__setup .primary-button')
  expect(useAppStore.getState().tabs.launch!.regions.input).toMatchObject({ workspaceId: remoteProject.id, agentWorkspaceId: 'workspace' })
})


it('Custom endpoints distinguish identical project names and paths by their exact local and SSH environments', async () => {
  await mount()
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!,
    hosts: state.config!.hosts.map(host => host.id === 'B' ? { ...host, label: 'Studio', hostname: 'worker.example.invalid', user: 'developer', port: 2222 } : { ...host, label: 'Studio' }),
    workspaces: state.config!.workspaces.map(workspace => ({ ...workspace, name: 'Same project', path: '/same/project' })) } })))
  await applySplit(remoteProject.id)
  await dom.click('.launcher-execution__custom')
  const endpoints = [...dom.container.querySelectorAll('.launcher-execution__endpoints > button')]
  expect(endpoints).toHaveLength(2)
  expect(endpoints[0]!.textContent).toContain('This machine')
  expect(endpoints[0]!.textContent).toContain('/same/project')
  expect(endpoints[1]!.textContent).toContain('developer@worker.example.invalid:2222')
  expect(endpoints[1]!.textContent).toContain('/same/project')
  expect(endpoints[0]!.textContent).not.toBe(endpoints[1]!.textContent)
})

it('keeps execution setup open for IME-owned Escape and restores its mode focus only on an ordinary Escape', async () => {
  await mount()
  await mode('Remote Agent')
  const input = dom.container.querySelector<HTMLInputElement>('.launcher-execution__setup input')!
  expect(input).not.toBeNull()
  await act(async () => { input.focus(); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', isComposing: true, bubbles: true })) })
  expect(dom.container.querySelector('.launcher-execution__setup')).not.toBeNull()
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })))
  expect(dom.container.querySelector('.launcher-execution__setup')).toBeNull()
  expect(document.activeElement?.textContent).toContain('Remote Agent')
})

it('keeps a failed first Host inventory unknown and retries the same runtime without borrowing App configurations', async () => {
  await mount()
  const before = useAppStore.getState()
  vi.mocked(api.executors.discover).mockRejectedValue(new Error('Original Host observation unavailable'))
  await mode('Remote Agent')
  await dom.click('.launcher-execution__setup [data-workspace-id="agent-project"]')
  await act(async () => { await useAppStore.getState().detectExecutors(remote.id, { source: 'host' }) })
  expect(useAppStore.getState().hostExecutorInventories[remote.id]?.state).toBe('error')
  expect(dom.container.textContent?.match(/Agent configurations are unconfirmed/gu)).toHaveLength(1)
  expect(dom.container.textContent).not.toMatch(/No Agent (?:Executor )?is configured/u)
  expect(dom.container.querySelector('[data-executor-id]')).toBeNull()
  expect(dom.container.querySelector<HTMLButtonElement>('.launcher-launch-button')!.disabled).toBe(true)
  expect(dom.container.querySelector('[aria-label="Agent prompt"]')?.getAttribute('contenteditable')).toBe('true')
  await dom.click('[aria-label="Collapse Agents"]')
  expect(dom.container.textContent?.match(/Agent configurations are unconfirmed/gu)).toHaveLength(1)
  vi.mocked(api.executors.discover).mockResolvedValue({ routeHostId: remote.id, runtimeId: 'runtime-' + remote.id,
    executors: [{ executorId: 'codex', label: 'Recovered original Host', providerId: 'codex', command: '/core-codex',
      source: 'registered', configRevision: 'recovered-revision', availability: 'available' }] })
  const retry = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.textContent === 'Check again')
  expect(retry).toHaveLength(1)
  await act(async () => retry[0]!.click())
  expect(api.executors.discover).toHaveBeenLastCalledWith(remote.id)
  await dom.click('[aria-label="Expand Agents"]')
  expect(dom.container.textContent).not.toContain('Agent configurations are unconfirmed')
  expect(dom.container.querySelector('[data-executor-id="codex"]')?.textContent).toContain('Recovered original Host')
  expect(useAppStore.getState().agentComposerDrafts).toEqual(before.agentComposerDrafts)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
})

it('shows an unread Host inventory as unconfirmed until an authoritative empty result arrives', async () => {
  await mount()
  let complete!: (value: Awaited<ReturnType<typeof api.executors.discover>>) => void
  vi.mocked(api.executors.discover).mockImplementation(() => new Promise(resolve => { complete = resolve }))
  await mode('Remote Agent')
  await dom.click('.launcher-execution__setup [data-workspace-id="agent-project"]')
  expect(dom.container.textContent).toContain('Agent configurations are unconfirmed')
  expect(dom.container.textContent).not.toMatch(/No Agent (?:Executor )?is configured/u)
  await act(async () => complete({ routeHostId: remote.id, runtimeId: 'runtime-' + remote.id, executors: [] }))
  expect(dom.container.textContent).not.toContain('Agent configurations are unconfirmed')
  expect(dom.container.textContent?.match(/No Agent is configured/gu)).toHaveLength(1)
  expect(dom.container.textContent).not.toContain('No Agent Executor is configured')
})

it.each([false, true])('configures an authoritatively empty ordinary SSH runtime at its own Host, specialized=%s', async specialized => {
  const openHost = vi.fn(), openHostExecutors = vi.fn(), open = vi.fn()
  const settings = { open, openHost, ...(specialized ? { openHostExecutors } : {}), openToolkit: vi.fn(), openChannel: vi.fn(), channelEntries: [],
    channelPresentation: vi.fn(), openMoteLark: vi.fn(), chooseAgent: vi.fn() }
  await mount(true, settings)
  vi.mocked(api.executors.discover).mockResolvedValue({ routeHostId: remote.id, runtimeId: 'runtime-' + remote.id, executors: [] })
  await act(async () => { await useAppStore.getState().detectExecutors(remote.id) })
  expect(dom.container.textContent).not.toContain('Agent configurations are unconfirmed')
  expect(dom.container.textContent?.match(/No Agent is configured/gu)).toHaveLength(1)
  expect(dom.container.textContent).not.toContain('No Agent Executor is configured')
  const configure = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Configure an Agent')!
  await act(async () => configure.click())
  expect(specialized ? openHostExecutors : openHost).toHaveBeenCalledExactlyOnceWith(remote.id)
  expect(open).not.toHaveBeenCalled()
})
