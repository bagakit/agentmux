// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-original-warm-terminal /> }))
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, HostConfig, WorkspaceRecord } from '../src/shared/contracts'
import { RemoteExecutionSettingsPane } from '../src/renderer/src/components/settings/RemoteExecutionSettingsPane'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { api } from '../src/renderer/src/lib/api'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { fileNavigationSelection, useAppStore, warmTerminalKey } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
const dom = composerDOM(), close = vi.fn()
const remote: HostConfig = { id: 'agent-mac', kind: 'ssh', label: 'Agent Mac', hostname: 'agent.invalid' }
const other: HostConfig = { ...remote, id: 'other-mac', hostname: 'other.invalid' }
const home: WorkspaceRecord = { id: 'agent-home', hostId: remote.id, name: 'Agent home', path: '/Users/original-agent', kind: 'folder' }
let config: AppConfig
beforeEach(() => {
  close.mockClear(); config = { ...structuredClone(composerConfig), hosts: [...composerConfig.hosts, remote, other] }
  useLauncherState.setState({ sections: {}, drafts: {}, executors: {} })
  useAppStore.setState({ config, activeWorkspaceId: 'workspace', tabs: {}, layouts: { workspace: createWorkspaceLayout('group') }, sessions: [composerSession('healthy')],
    hostExecutorInventories: {}, executorDetections: {}, hostChecks: {}, agentComposerDrafts: { retained: 'Existing original draft' },
    launcherNameDrafts: {}, launcherOptionDrafts: {}, workbenchSpaceSelection: null, prewarmTerminal: vi.fn(), recoveryCandidates: [] })
  vi.spyOn(api.hosts, 'home').mockResolvedValue({ routeHostId: remote.id, homeDirectory: home.path })
  vi.spyOn(api.workspaces, 'add').mockResolvedValue(home)
  vi.spyOn(api.executors, 'discover').mockImplementation(async hostId => ({ routeHostId: hostId, runtimeId: 'runtime-' + hostId,
    executors: [{ executorId: 'codex', label: 'Original Core Agent', providerId: 'codex', command: '/original/codex', source: 'registered', configRevision: 'revision-' + hostId, availability: 'available' }] }))
})
const mount = () => dom.render(<RemoteExecutionSettingsPane config={config} active onClose={close} onNavigate={() => {}} />)
async function select(label: string, value: string) { await act(async () => { const element = dom.container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; expect(element).not.toBeNull(); element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })) }) }
const prepare = () => dom.click('[data-remote-prepare]')
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }

it('prepares the current local project with only an Agent device, then the original Launcher sends exact Agent cwd and local tools', async () => {
  const launch = vi.spyOn(api.sessions, 'launchAgent').mockReturnValue(new Promise(() => {})), stop = vi.spyOn(api.sessions, 'stop')
  const original = useAppStore.getState(), navigation = fileNavigationSelection(original)
  await mount(); expect(dom.container.querySelector('[aria-label="Project for remote Agent"]')).not.toBeNull()
  expect(dom.container.querySelector('.remote-execution-intro')).toBeNull()
  await select('Agent runs on', remote.id)
  expect(fileNavigationSelection(useAppStore.getState())).toBe(navigation); expect(api.hosts.home).not.toHaveBeenCalled()
  await prepare()
  expect(api.hosts.home).toHaveBeenCalledWith(remote, expect.objectContaining({ signal: expect.any(AbortSignal) }))
  expect(api.workspaces.add).toHaveBeenCalledExactlyOnceWith({ hostId: remote.id, path: home.path })
  const state = useAppStore.getState(), tab = Object.values(state.tabs).find(item => item.regions[item.layout.activeRegionId]?.kind === 'launcher')!
  expect(state.activeWorkspaceId).toBe('workspace'); expect(state.sessions).toBe(original.sessions)
  expect(state.agentComposerDrafts.retained).toBe('Existing original draft')
  expect(tab.regions[tab.layout.activeRegionId]).toMatchObject({ workspaceId: 'workspace', agentWorkspaceId: home.id })
  expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce()
  await act(async () => useAppStore.getState().setAgentComposerDraft(tab.layout.activeRegionId, 'Work on this Mac project'))
  await dom.render(<NewTabSurface tabGroupId="group" tabId={tab.id} regionId={tab.layout.activeRegionId} />)
  await vi.waitFor(() => expect(dom.container.querySelector('[data-executor-id="codex"]')).not.toBeNull())
  await dom.click('[data-executor-id="codex"]')
  await dom.click('.launcher-launch-button')
  expect(launch).toHaveBeenCalledWith(expect.objectContaining({ hostId: remote.id, workspacePath: home.path, executionWorkspaceId: home.id,
    toolWorkspace: { id: 'workspace', hostId: 'local', path: composerConfig.workspaces[0]!.path }, executorRevision: 'revision-' + remote.id,
    prompt: 'Work on this Mac project' }), undefined)
  expect(stop).not.toHaveBeenCalled()
})

it('late preparation cannot overwrite a newer device intent, while an accepted directory registration remains retained', async () => {
  const pending = deferred<WorkspaceRecord>()
  vi.mocked(api.workspaces.add).mockReturnValue(pending.promise)
  const open = vi.spyOn(useAppStore.getState(), 'openLauncher')
  await mount(); await select('Agent runs on', remote.id); await prepare()
  expect(api.workspaces.add).toHaveBeenCalled()
  await select('Agent runs on', other.id)
  await act(async () => pending.resolve(home))
  expect(open).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
  expect(useAppStore.getState().config!.workspaces).toContainEqual(home)
  expect(dom.container.querySelector<HTMLSelectElement>('[aria-label="Agent runs on"]')!.value).toBe(other.id)
  expect(useAppStore.getState().activeWorkspaceId).toBe('workspace')
})

it('late home results cannot reopen a Launcher after another explicit navigation or hide', async () => {
  const pending = deferred<{ routeHostId: string; homeDirectory: string }>()
  vi.mocked(api.hosts.home).mockReturnValue(pending.promise)
  const open = vi.spyOn(useAppStore.getState(), 'openLauncher')
  await mount(); await select('Agent runs on', remote.id); await prepare()
  await act(async () => useAppStore.getState().selectWorkspace('later-project'))
  await act(async () => pending.resolve({ routeHostId: remote.id, homeDirectory: home.path }))
  expect(open).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
  expect(useAppStore.getState().activeWorkspaceId).toBe('later-project')
})

it('preparing an Agent directory preserves name-only Host edits and equivalent Main-owned registration spellings', async () => {
  const pending = deferred<{ routeHostId: string; homeDirectory: string }>()
  vi.mocked(api.hosts.home).mockReturnValue(pending.promise)
  vi.mocked(api.workspaces.add).mockResolvedValue({ ...home, path: home.path + '/' })
  const operation = useAppStore.getState().prepareAgentHostWorkspace(remote.id)
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, hosts: state.config!.hosts.map(host => host.id === remote.id ? { ...host, label: 'Renamed device' } : host) } })))
  await act(async () => pending.resolve({ routeHostId: remote.id, homeDirectory: home.path }))
  expect(await operation).toEqual({ ...home, path: home.path + '/' })
  expect(useAppStore.getState().activeWorkspaceId).toBe('workspace')
})

it('a failed home read keeps the current project and draft and never chooses an arbitrary remote project', async () => {
  vi.mocked(api.hosts.home).mockRejectedValue(Object.assign(new Error('private original diagnostic'), { code: 'REMOTE_CORE_UPGRADE_REQUIRED' }))
  config.workspaces.push({ ...home, id: 'unrelated-project', path: '/another-project' }); useAppStore.setState({ config })
  const open = vi.spyOn(useAppStore.getState(), 'openLauncher')
  await mount(); await select('Agent runs on', remote.id); await prepare()
  expect(open).not.toHaveBeenCalled(); expect(api.workspaces.add).not.toHaveBeenCalled()
  expect(dom.container.textContent).toContain('Update AgentMux Core on this device')
  expect(dom.container.textContent).not.toContain('private original diagnostic')
  expect(useAppStore.getState().agentComposerDrafts.retained).toBe('Existing original draft')
})

it('a route change while registration is pending retains its receipt but refuses to reveal the old target', async () => {
  const pending = deferred<WorkspaceRecord>()
  vi.mocked(api.workspaces.add).mockReturnValue(pending.promise)
  const operation = useAppStore.getState().prepareAgentHostWorkspace(remote.id)
  const result = expect(operation).rejects.toThrow('The Agent device changed')
  await vi.waitFor(() => expect(api.workspaces.add).toHaveBeenCalled())
  useAppStore.setState(state => ({ config: { ...state.config!, hosts: state.config!.hosts.map(host => host.id === remote.id ? { ...remote, hostname: 'changed.invalid' } : host) } }))
  pending.resolve(home)
  await result
  expect(useAppStore.getState().config!.workspaces).toContainEqual(home)
  expect(useAppStore.getState().activeWorkspaceId).toBe('workspace')
})


it.each([false, true])('an unconfirmed device choice cannot launch the old target, and failure restores its accurate label (failure=%s)', async failure => {
  const launch = vi.spyOn(api.sessions, 'launchAgent').mockReturnValue(new Promise(() => {}))
  await mount(); await select('Agent runs on', remote.id); await prepare()
  const tab = Object.values(useAppStore.getState().tabs).find(item => item.regions[item.layout.activeRegionId]?.kind === 'launcher')!
  await act(async () => useAppStore.getState().setAgentComposerDraft(tab.layout.activeRegionId, 'Keep this local project request'))
  await dom.render(<NewTabSurface tabGroupId="group" tabId={tab.id} regionId={tab.layout.activeRegionId} />)
  await vi.waitFor(() => expect(dom.container.querySelector('[data-executor-id="codex"]')).not.toBeNull())
  await dom.click('[data-executor-id="codex"]')
  expect(dom.container.querySelector<HTMLButtonElement>('.launcher-launch-button')!.disabled).toBe(false)
  const pending = deferred<{ routeHostId: string; homeDirectory: string }>(), otherHome = { ...home, id: 'other-home', hostId: other.id, path: '/Users/other-agent' }
  vi.mocked(api.hosts.home).mockReturnValue(pending.promise); vi.mocked(api.workspaces.add).mockResolvedValue(otherHome)
  await select('Agent runs on', other.id)
  expect(dom.container.querySelector<HTMLButtonElement>('.launcher-launch-button')!.disabled).toBe(true)
  await dom.click('.launcher-launch-button')
  await act(async () => { for (const key of ['ctrlKey', 'metaKey']) dom.container.querySelector('[aria-label="Agent prompt"]')!.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',code:'Enter',[key]:true,bubbles:true})) })
  expect(launch).not.toHaveBeenCalled()
  await act(async () => { if (failure) pending.reject(new Error('Original device home read failed')); else pending.resolve({ routeHostId: other.id, homeDirectory: otherHome.path }) })
  expect(dom.container.querySelector<HTMLSelectElement>('[aria-label="Agent runs on"]')!.value).toBe(failure ? remote.id : other.id)
  await vi.waitFor(() => expect(dom.container.querySelector<HTMLButtonElement>('.launcher-launch-button')!.disabled).toBe(false))
  await dom.click('.launcher-launch-button')
  expect(launch).toHaveBeenCalledWith(expect.objectContaining({ hostId: failure ? remote.id : other.id, workspacePath: failure ? home.path : otherHome.path,
    toolWorkspace: { id:'workspace',hostId:'local',path:composerConfig.workspaces[0]!.path },prompt:expect.stringContaining('Keep this local project request') }),undefined)
})
