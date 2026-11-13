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
import { chooseField } from './helpers/selection-field'
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
  vi.spyOn(api.hosts, 'home').mockImplementation(async host => ({ routeHostId: host.id, homeDirectory: useAppStore.getState().config!.workspaces.find(item => item.hostId === host.id)!.path }))
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
const runsOn = () => dom.container.querySelector<HTMLButtonElement>('.launcher-agent-device [aria-label="Runs on"]')!
async function mode(label: string) { await chooseField(runsOn(), label === 'Local development' ? 'local' : remote.id) }
/** Settings prepares the arrangements the start page no longer edits; the Launcher consumes the same two fields. */
async function arrange(resourceWorkspaceId: string, agentWorkspaceId: string | null) {
  await act(async () => { useAppStore.getState().selectLauncherExecution({ ...target, displayWorkspaceId: resourceWorkspaceId, groupId: 'group' },
    { resourceWorkspaceId, agentWorkspaceId }, { navigateProject: false, reveal: false }) })
}
async function splitAt(workspaceId: string) {
  const project = useAppStore.getState().tabs.launch!.regions.input
  const resourceWorkspaceId = project.kind === 'launcher' ? project.workspaceId! : 'workspace'
  const hostId = useAppStore.getState().config!.workspaces.find(item => item.id === workspaceId)!.hostId
  if (resourceWorkspaceId === 'workspace' && hostId !== 'local') await mode('Remote Agent')
  else await arrange(resourceWorkspaceId, workspaceId)
  await vi.waitFor(() => expect(dom.container.querySelector('[data-executor-id="codex"]')).not.toBeNull())
  if (!dom.container.querySelector('[aria-pressed="true"][data-executor-id="codex"]')) await dom.click('[data-executor-id="codex"]')
}
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
  // A same-device binding is a Settings arrangement: the start page reads it and returns to the project device.
  await act(async () => [...dom.container.querySelectorAll<HTMLButtonElement>('.launcher-agent-device__action')].find(button => button.textContent === 'Use project device')!.click())
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

it('a Settings-prepared arrangement reads on the start page and returns to the project device without preparing work', async () => {
  const open = vi.fn()
  const settings = { open, openToolkit: vi.fn(), openHost: vi.fn(), openChannel: vi.fn(), channelEntries: [],
    channelPresentation: vi.fn(), openMoteLark: vi.fn(), chooseAgent: vi.fn() }
  await mount(false, settings)
  await arrange('workspace', 'workspace')
  const launch = vi.spyOn(api.sessions, 'launchAgent'), resume = vi.spyOn(api.sessions, 'resume'), stop = vi.spyOn(api.sessions, 'stop')
  const read = dom.container.querySelector('.launcher-agent-device[data-arrangement="settings"]')!
  expect(read).not.toBeNull()
  expect(read.textContent).toContain(composerConfig.workspaces[0]!.path)
  expect(dom.container.querySelector('[aria-label="Runs on"]')).toBeNull()
  const before = useAppStore.getState()
  await act(async () => [...read.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Remote Agents')!.click())
  expect(open).toHaveBeenCalledExactlyOnceWith('remote-execution')
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  await act(async () => [...read.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Use project device')!.click())
  expect(useAppStore.getState().tabs.launch!.regions.input).not.toHaveProperty('agentWorkspaceId')
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
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


it('exposes the Agent device directly without project-mode cards or early Agent creation', async () => {
  const f = await mount(), launch = vi.spyOn(api.sessions, 'launchAgent')
  expect(dom.container.querySelector('.launcher-execution__modes')).toBeNull()
  expect(runsOn().dataset.value).toBe('local')
  await mode('Remote Agent')
  expect(useAppStore.getState().tabs.launch!.regions.input).toMatchObject({ workspaceId: 'workspace', agentWorkspaceId: remoteProject.id })
  expect(useAppStore.getState().agentComposerDrafts).toBe(f.before.agentComposerDrafts)
  expect(launch).not.toHaveBeenCalled()
})
it('an explicit device choice uses its home and returning to this device follows the original project', async () => {
  await mount(); await mode('Remote Agent')
  expect(api.hosts.home).toHaveBeenCalledWith(remote, expect.objectContaining({ signal: expect.any(AbortSignal) }))
  await mode('Local development')
  expect(useAppStore.getState().tabs.launch!.regions.input).not.toHaveProperty('agentWorkspaceId')
  expect(useAppStore.getState().tabs.launch!.regions.input.workspaceId).toBe('workspace')
})
it('the start page has no project or machine selector and its device label reads the exact Space project', async () => {
  const f = await mount()
  expect(dom.container.querySelector('.launcher-environment button, .launcher-environment select')).toBeNull()
  expect(dom.container.querySelector('.launcher-execution-advanced, [aria-label="Files and tools"], [aria-label="Agent startup directory"]')).toBeNull()
  const label = dom.container.querySelector<HTMLElement>('.launcher-environment__device')!
  expect(label.dataset.hostId).toBe('local'); expect(label.getAttribute('aria-label')).toBe('Device: ' + composerConfig.hosts[0]!.label)
  await act(async () => label.focus())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(f.project.path)
  expect(document.querySelector('[role="tooltip"]')?.textContent).not.toContain('opens this device')
})
it('Runs on is absent for a remote project and for a single configured device', async () => {
  await mount(true)
  expect(dom.container.querySelector('.launcher-environment__device')?.getAttribute('aria-label')).toBe('Device: Agent server')
  expect(runsOn()).toBeNull()
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, hosts: state.config!.hosts.filter(host => host.id === 'local'),
    workspaces: state.config!.workspaces.filter(workspace => workspace.hostId === 'local') }, activeWorkspaceId: 'workspace',
    tabs: { launch: { ...state.tabs.launch!, workspaceId: 'workspace', regions: { ...state.tabs.launch!.regions, input: { ...state.tabs.launch!.regions.input, workspaceId: 'workspace' } } } } })))
  expect(runsOn()).toBeNull()
})
it('Runs on distinguishes identical device names by their exact IDs', async () => {
  await mount()
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, hosts: state.config!.hosts.map(host => ({ ...host, label: 'Studio' })) } })))
  await act(async () => { runsOn().focus(); runsOn().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  const labels = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].map(item => item.textContent)
  expect(labels.some(text => text?.includes('Studio · local'))).toBe(true)
  expect(labels.some(text => text?.includes('Studio · B'))).toBe(true)
})
it('a failed device preparation stays next to Runs on with Retry and keeps the original target and draft', async () => {
  const f = await mount()
  vi.mocked(api.hosts.home).mockRejectedValueOnce(new Error('home unavailable'))
  await mode('Remote Agent')
  const status = dom.container.querySelector<HTMLElement>('.launcher-agent-device__status[data-state="failed"]')!
  expect(status.textContent).toContain('could not be read')
  expect(useAppStore.getState().tabs.launch!.regions.input).not.toHaveProperty('agentWorkspaceId')
  expect(useAppStore.getState().agentComposerDrafts).toBe(f.before.agentComposerDrafts)
  await act(async () => status.querySelector<HTMLButtonElement>('button')!.click())
  await vi.waitFor(() => expect(useAppStore.getState().tabs.launch!.regions.input).toMatchObject({ agentWorkspaceId: remoteProject.id }))
})
it('unrelated navigation does not cancel an in-flight device preparation', async () => {
  await mount()
  let resolve!: (value: { routeHostId: string; homeDirectory: string }) => void
  vi.mocked(api.hosts.home).mockReturnValueOnce(new Promise(done => { resolve = done }))
  await mode('Remote Agent')
  expect(dom.container.querySelector('.launcher-agent-device__status')?.textContent).toBe('Preparing…')
  await act(async () => useAppStore.setState({ focusView: 'agents' }))
  await act(async () => resolve({ routeHostId: remote.id, homeDirectory: remoteProject.path }))
  await vi.waitFor(() => expect(useAppStore.getState().tabs.launch!.regions.input).toMatchObject({ agentWorkspaceId: remoteProject.id }))
})

it('keeps a failed first Host inventory unknown and retries the same runtime without borrowing App configurations', async () => {
  await mount()
  const before = useAppStore.getState()
  vi.mocked(api.executors.discover).mockRejectedValue(new Error('Original Host observation unavailable'))
  await mode('Remote Agent')
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

it('shows reference labels in the collapsed request summary without changing the durable prompt or submission', async () => {
  await mount()
  const raw = 'Review [local.md](agentmux-file:%40local.md) and [Build skill](agentmux-skill:%2Fskills%2Fbuild%20workflow.md)\nKeep the next line intact.'
  await act(async () => useAppStore.getState().setAgentComposerDraft('input', raw))
  const before = useAppStore.getState()
  await dom.click('[aria-label="Collapse Agents"]')
  const summary = dom.container.querySelector<HTMLElement>('.launcher-agent-entry small')!
  expect(summary.textContent).toBe('Review local.md and Build skill')
  expect(summary.title).toBe('Review local.md and Build skill\nKeep the next line intact.')
  expect(summary.textContent).not.toMatch(/agentmux-|%40|%2F/u)
  expect(useAppStore.getState().agentComposerDrafts.input).toBe(raw)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  await dom.click('[aria-label="Expand Agents"]')
  expect(useAppStore.getState().agentComposerDrafts.input).toBe(raw)
  const launch = vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(Object.assign(new Error('Not applied'), { controlFailure: { disposition: 'not_applied' } }))
  await dom.click('.launcher-launch-button')
  expect(launch).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Review @local.md and /skills/build workflow.md\nKeep the next line intact.' }), undefined)
  expect(useAppStore.getState().agentComposerDrafts.input).toBe(raw)
})
