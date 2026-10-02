import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-warm-run /> }))
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { useAppStore, warmTerminalKey } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { addWorkbenchRegion, createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'

const dom = composerDOM()
const launcherBefore = useLauncherState.getState()
const remote = { id: 'farm', kind: 'ssh' as const, label: 'DAFarm', hostname: 'farm.example' }
const remoteProject = { id: 'flowlens', hostId: remote.id, name: 'FlowLens', path: _hygiene_fixturePath("home/developer/flowlens"), kind: 'folder' as const }
const warm = { ...composerSession('retained-warm'), kind: 'terminal' as const, providerId: null,
  control: { kind: 'terminal' as const, hostId: 'local', runId: 'retained-run', run: { runId: 'retained-run' } } }
beforeEach(async () => { await act(async () => useLauncherState.setState({ sections: {}, drafts: {}, executors: {} })) })
afterEach(async () => { await act(async () => useLauncherState.setState(launcherBefore, true)) })

async function mount(empty = false) {
  const base = createWorkbenchTab('launcher', { regionId: 'input', kind: 'launcher', workspaceId: 'workspace' })
  const tab = addWorkbenchRegion(base, 'input', 'right', { regionId: 'sibling', kind: 'launcher', workspaceId: 'workspace' })!
  tab.layout = { ...tab.layout, activeRegionId: 'input' }
  useAppStore.setState({
    config: { ...composerConfig, hosts: [...composerConfig.hosts, remote, { ...remote, id: 'empty-machine', label: 'Other server' }],
      workspaces: [...composerConfig.workspaces, remoteProject] },
    activeWorkspaceId: 'workspace', tabs: empty ? {} : { launcher: tab },
    // Execution does not require a display layout for the selected remote project.
    layouts: { workspace: createWorkspaceLayout('group', empty ? [] : [tab.id]) },
    recoveryCandidates: [], executorDetections: {}, hostChecks: {},
    agentComposerDrafts: { input: 'Keep the complete\nunsent request', sibling: 'Independent draft' },
    launcherNameDrafts: { input: { agentName: 'Reviewer', tabName: 'Investigation' } },
    launcherOptionDrafts: { input: { codex: { model: 'selected-model' } } },
    warmTerminal: { key: warmTerminalKey('local', _hygiene_fixturePath("repo")), ownerLauncherId: empty ? 'group:group' : 'region:input', session: warm, ready: Promise.resolve(warm) },
    detectExecutors: vi.fn().mockResolvedValue(undefined), prewarmTerminal: vi.fn()
  })
  await dom.render(<NewTabSurface tabGroupId="group" {...(empty ? {} : { tabId: 'launcher', regionId: 'input' })} />)
}
async function browse(hostId = 'farm') {
  await dom.click('[aria-label="Runtime environment"]')
  const select = document.querySelector<HTMLSelectElement>('[aria-label="Machine for new session"]')!
  expect(select).not.toBeNull()
  await act(async () => { select.value = hostId; select.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function selectRemote() {
  await browse()
  const button = document.querySelector<HTMLButtonElement>('[data-workspace-id="flowlens"]')!
  expect(button).not.toBeNull()
  await act(async () => button.click())
}

describe('the real Launcher execution target consumer', () => {
  it('selects the exact remote project while retaining display, sibling, inputs and healthy warm Run', async () => {
    await mount()
    const before = useAppStore.getState()
    const beforeInputs = { prompt: before.agentComposerDrafts, names: before.launcherNameDrafts, options: before.launcherOptionDrafts }
    const stop = vi.spyOn(api.sessions, 'stop')
    const originalWarmCalls = vi.mocked(before.prewarmTerminal).mock.calls.length
    await selectRemote()
    const state = useAppStore.getState()
    expect(dom.container.querySelector('.launcher-environment__host')?.textContent).toContain('DAFarm')
    expect(dom.container.querySelector('.launcher-environment__path')?.textContent).toBe(remoteProject.path)
    expect(state.tabs.launcher?.regions.input).toMatchObject({ kind: 'launcher', workspaceId: remoteProject.id })
    expect(state.tabs.launcher?.workspaceId).toBe('workspace')
    expect(state.tabs.launcher?.regions.sibling).toBe(before.tabs.launcher?.regions.sibling)
    expect(state.layouts).toBe(before.layouts)
    expect(state.activeWorkspaceId).toBe('workspace')
    expect({ prompt: state.agentComposerDrafts, names: state.launcherNameDrafts, options: state.launcherOptionDrafts }).toEqual(beforeInputs)
    expect(state.warmTerminal).toBe(before.warmTerminal)
    expect(stop).not.toHaveBeenCalled()
    expect(vi.mocked(state.prewarmTerminal).mock.calls).toHaveLength(originalWarmCalls)
    expect(vi.mocked(state.detectExecutors)).toHaveBeenLastCalledWith('farm')
    expect(dom.container.querySelector('[data-warm-run]')).toBeNull()
    expect(dom.container.querySelector<HTMLButtonElement>('.launcher-launch-button')?.disabled).toBe(false)
  })

  it('browsing an empty machine does not select a borrowed local directory or stop a Run', async () => {
    await mount()
    const before = useAppStore.getState()
    await browse('empty-machine')
    expect(document.querySelector('.launcher-target__projects')?.textContent).toContain('No project registered')
    expect(document.querySelector('.launcher-target__manage')?.textContent).toContain('Manage projects')
    expect(document.querySelectorAll('.launcher-target__project')).toHaveLength(0)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().warmTerminal).toBe(before.warmTerminal)
  })

  it('materializes the empty Group in its original display and transfers every unsent input before choosing execution', async () => {
    await mount(true)
    await act(async () => {
    useLauncherState.getState().setDraft('group:group', 'prompt', 'Original group request')
    useLauncherState.getState().setAgentName('group:group', 'agentName', 'Kept name')
    useLauncherState.getState().setAgentOption('group:group', 'codex', 'model', 'kept-model')
    useLauncherState.getState().setDraft('group:group', 'note', 'Original note')
    })
    await dom.render(<NewTabSurface tabGroupId="group" />)
    await selectRemote()
    const state = useAppStore.getState()
    const tabs = Object.values(state.tabs)
    expect(tabs).toHaveLength(1)
    const tab = tabs[0]!, id = tab.layout.activeRegionId
    expect(tab.workspaceId).toBe('workspace')
    expect(tab.regions[id]).toMatchObject({ kind: 'launcher', workspaceId: 'flowlens' })
    expect(state.layouts.workspace?.groups[0]?.tabOrder).toEqual([tab.id])
    expect(state.agentComposerDrafts[id]).toBe('Original group request')
    expect(state.launcherNameDrafts[id]?.agentName).toBe('Kept name')
    expect(state.launcherOptionDrafts[id]?.codex).toEqual({ model: 'kept-model' })
    expect(useLauncherState.getState().drafts[`region:${id}`]?.note).toBe('Original note')
  })

  it('the ordinary Terminal creation uses the selected remote Host/cwd and original display with no remote layout', async () => {
    await mount()
    await selectRemote()
    const launch = vi.spyOn(api.sessions, 'launchTerminal')
    const stop = vi.spyOn(api.sessions, 'stop')
    await act(async () => useAppStore.getState().promoteWarmTerminal('group', { tabId: 'launcher', regionId: 'input' }))
    expect(launch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ hostId: 'farm', workspacePath: remoteProject.path }))
    const state = useAppStore.getState()
    expect(state.tabs.launcher?.workspaceId).toBe('workspace')
    expect(state.tabs.launcher?.regions.input).toMatchObject({ kind: 'terminal', workspaceId: 'flowlens' })
    expect(state.sessions.find(session => session.id === (state.tabs.launcher?.regions.input as { sessionId: string }).sessionId)?.control.hostId).toBe('farm')
    expect(state.warmTerminal?.session).toBe(warm)
    expect(stop).not.toHaveBeenCalled()
  })

  it('an Agent creation failure retains the selected target and complete draft for a same-target retry', async () => {
    await mount()
    await selectRemote()
    const launch = vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(new Error('Private unavailable observation'))
    await act(async () => { await expect(useAppStore.getState().launchAgent('codex', 'Keep the complete\nunsent request', 'group',
      { tabId: 'launcher', regionId: 'input' })).rejects.toThrow('Private unavailable observation') })
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'farm', workspacePath: remoteProject.path }))
    const state = useAppStore.getState()
    expect(state.tabs.launcher?.regions.input).toMatchObject({ kind: 'launcher', workspaceId: 'flowlens' })
    expect(state.tabs.launcher?.workspaceId).toBe('workspace')
    expect(state.agentComposerDrafts.input).toBe('Keep the complete\nunsent request')
    expect(state.launcherNameDrafts.input).toEqual({ agentName: 'Reviewer', tabName: 'Investigation' })
    expect(state.launcherOptionDrafts.input?.codex).toEqual({ model: 'selected-model' })
  })

  it('a remote Note writes and reads the selected resource while preserving the original display', async () => {
    await mount()
    await selectRemote()
    const write = vi.spyOn(api.files, 'write')
    const read = vi.spyOn(api.files, 'read')
    const open = vi.spyOn(useAppStore.getState(), 'openFile')
    await act(async () => { await expect(useAppStore.getState().createNote('group', { tabId: 'launcher', regionId: 'input' }, 'Remote note')).resolves.toMatchObject({ status: 'written' }) })
    expect(write).toHaveBeenCalledExactlyOnceWith('flowlens', expect.objectContaining({ expectedRevision: null, content: expect.stringContaining('Remote note') }))
    const receipt = useLauncherState.getState().drafts['region:input']?.noteCreation
    expect(receipt?.target).toMatchObject({ workspaceId: 'flowlens', hostId: 'farm', workspacePath: remoteProject.path,
      directoryPath: remoteProject.path, displayWorkspaceId: 'workspace', groupId: 'group' })
    expect(receipt?.status).toBe('written')
    expect(read).toHaveBeenCalledWith('flowlens', receipt?.path)
    expect(useAppStore.getState().documents[documentKey('flowlens', receipt!.path)]?.content).toContain('Remote note')
    expect(open).toHaveBeenCalledWith(receipt?.path, 'group', undefined, 'flowlens', undefined,
      expect.objectContaining({ displayWorkspaceId: 'workspace', resource: { hostId: 'farm', path: remoteProject.path } }))
  })

  it('rejects changing a started Region without changing its original healthy Session', async () => {
    await mount()
    const session = composerSession('original-agent')
    await act(async () => useAppStore.setState({ sessions: [session], tabs: { launcher: createWorkbenchTab('launcher', {
      regionId: 'input', kind: 'agent', phase: 'attached', sessionId: session.id, workspaceId: 'workspace' }) } }))
    const before = useAppStore.getState()
    expect(() => before.setLauncherExecutionWorkspace({ tabId: 'launcher', regionId: 'input' }, 'flowlens')).toThrow('Only an unstarted Launcher')
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
  })

  it('creates in a third physical display without rewriting the Tab resource or either layout', async () => {
    await mount()
    await selectRemote()
    const original = useAppStore.getState()
    await act(async () => useAppStore.setState({ layouts: {
      workspace: createWorkspaceLayout('source-group'),
      third: createWorkspaceLayout('group', ['launcher'])
    } }))
    const layouts = useAppStore.getState().layouts
    await act(async () => useAppStore.getState().launchTerminal('group', { tabId: 'launcher', regionId: 'input' }))
    const state = useAppStore.getState()
    expect(state.tabs.launcher?.workspaceId).toBe('workspace')
    expect(state.tabs.launcher?.regions.input).toMatchObject({ kind: 'terminal', workspaceId: 'flowlens' })
    expect(state.tabs.launcher?.regions.sibling).toBe(original.tabs.launcher?.regions.sibling)
    expect(state.layouts.third).toBe(layouts.third)
    expect(state.layouts.workspace).toBe(layouts.workspace)
  })

  it('can choose a valid local project when the original selected remote registration has disappeared', async () => {
    await mount()
    await selectRemote()
    await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, workspaces: composerConfig.workspaces } })))
    await browse('local')
    await act(async () => document.querySelector<HTMLButtonElement>('[data-workspace-id="workspace"]')!.click())
    expect(useAppStore.getState().tabs.launcher?.regions.input).toMatchObject({ kind: 'launcher', workspaceId: 'workspace' })
    expect(dom.container.querySelector('.launcher-environment__host')?.textContent).toContain('This Mac')
    expect(useAppStore.getState().agentComposerDrafts.input).toBe('Keep the complete\nunsent request')
  })

  it('the empty Group keeps a manually chosen non-default Executor after target selection and pending failure remount', async () => {
    await mount(true)
    await act(async () => {
      useAppStore.setState(state => ({ config: { ...state.config!, executors: { ...state.config!.executors,
        review: { ...state.config!.executors.codex!, providerId: 'claude', label: 'Review' } } } }))
      useLauncherState.getState().setDraft('group:group', 'prompt', 'Original custom request')
      useLauncherState.getState().setAgentName('group:group', 'agentName', 'Original name')
      useLauncherState.getState().setAgentOption('group:group', 'claude', 'model', 'original-model')
    })
    await dom.click('[data-executor-id="review"]')
    await selectRemote()
    const tab = Object.values(useAppStore.getState().tabs)[0]!, regionId = tab.layout.activeRegionId
    await dom.render(<NewTabSurface tabGroupId="group" tabId={tab.id} regionId={regionId} />)
    expect(dom.container.querySelector('[data-executor-id="review"]')?.getAttribute('aria-pressed')).toBe('true')
    let fail!: (error: Error) => void
    const launched = vi.spyOn(api.sessions, 'launchAgent').mockImplementation(() => new Promise((_resolve, reject) => { fail = reject }))
    await dom.click('.launcher-launch-button')
    expect(launched).toHaveBeenCalledWith(expect.objectContaining({ executorId: 'review', hostId: 'farm',
      prompt: 'Original custom request', launchOptions: { model: 'original-model' } }))
    await dom.render(<div data-pending-launch />)
    await act(async () => fail(new Error('Task-owned pending failure')))
    await dom.render(<NewTabSurface tabGroupId="group" tabId={tab.id} regionId={regionId} />)
    expect(dom.container.querySelector('[data-executor-id="review"]')?.getAttribute('aria-pressed')).toBe('true')
    const state = useAppStore.getState()
    expect(state.tabs[tab.id]?.regions[regionId]).toMatchObject({ kind: 'launcher', workspaceId: 'flowlens', executorId: 'review' })
    expect(state.agentComposerDrafts[regionId]).toBe('Original custom request')
    expect(state.launcherNameDrafts[regionId]?.agentName).toBe('Original name')
    expect(state.launcherOptionDrafts[regionId]?.claude).toEqual({ model: 'original-model' })
  })

  it('references files through the selected remote file owner instead of the local system picker', async () => {
    await mount()
    await selectRemote()
    const localPicker = vi.spyOn(api.ui, 'chooseFiles')
    const list = vi.spyOn(api.files, 'readDirectory').mockResolvedValue([{ name: 'remote.md', path: 'remote.md', isDirectory: false, isSymlink: false }])
    await dom.click('[aria-label="Reference files for the Agent"]')
    expect(list).toHaveBeenCalledWith('flowlens', '')
    expect(localPicker).not.toHaveBeenCalled()
    await act(async () => document.querySelector<HTMLButtonElement>('[data-reference-path="remote.md"]')!.click())
    expect(useAppStore.getState().agentComposerDrafts.input).toContain('@remote.md')
    expect(useAppStore.getState().agentComposerDrafts.input).toContain('Keep the complete\nunsent request')
  })

  it('a cold Terminal failure remounts the same manually chosen Agent and its complete inputs', async () => {
    await mount()
    await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, executors: {
      ...state.config!.executors, review: { ...state.config!.executors.codex!, providerId: 'claude', label: 'Review' }
    } } })))
    await dom.click('[data-executor-id="review"]')
    await selectRemote()
    let fail!: (error: Error) => void
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockImplementation(() => new Promise((_resolve, reject) => { fail = reject }))
    await dom.click('[data-agentmux-action="claim-reusable-terminal"]')
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'farm', workspacePath: remoteProject.path }))
    await dom.render(<div data-pending-terminal />)
    await act(async () => fail(new Error('Task-owned Terminal creation failure')))
    await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="input" />)
    const state = useAppStore.getState()
    expect(state.tabs.launcher?.regions.input).toMatchObject({ kind: 'launcher', workspaceId: 'flowlens', executorId: 'review' })
    expect(dom.container.querySelector('[data-executor-id="review"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(state.agentComposerDrafts.input).toBe('Keep the complete\nunsent request')
    expect(state.launcherNameDrafts.input).toEqual({ agentName: 'Reviewer', tabName: 'Investigation' })
    expect(state.launcherOptionDrafts.input?.codex).toEqual({ model: 'selected-model' })
  })

  it.each(['open.terminal', 'open.browser'] as const)('public Control %s uses the exact selected Launcher resource', async operation => {
    await mount()
    await selectRemote()
    const before = useAppStore.getState()
    const terminal = vi.spyOn(api.sessions, 'launchTerminal').mockResolvedValue({ ...warm, id: 'control-remote',
      hostId: 'farm', workspacePath: remoteProject.path,
      control: { kind: 'terminal', hostId: 'farm', runId: 'control-run', run: { runId: 'control-run' } } })
    const browser = vi.spyOn(api.browser, 'create')
    const request = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: `task-${operation}`, operation,
      destination: { kind: 'launcher' as const, regionId: 'input' }, ...(operation === 'open.browser' ? { url: 'https://example.com' } : {}) }
    let opened!: Awaited<ReturnType<typeof before.executeControl>>
    await act(async () => { opened = await useAppStore.getState().executeControl(request as Parameters<typeof before.executeControl>[0]) })
    if (operation === 'open.terminal') expect(terminal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ hostId: 'farm', workspacePath: remoteProject.path }))
    else expect(browser).toHaveBeenCalledWith(expect.any(String), 'https://example.com', 'flowlens')
    expect(opened).toMatchObject({ operation, region: { workspaceId: 'flowlens', regionId: 'input' } })
    const state = useAppStore.getState()
    expect(state.tabs.launcher?.workspaceId).toBe('workspace')
    expect(state.tabs.launcher?.regions.input).toMatchObject({ workspaceId: 'flowlens' })
    expect(state.tabs.launcher?.regions.sibling).toBe(before.tabs.launcher?.regions.sibling)
    expect(state.layouts).toEqual(before.layouts)
    expect(state.activeWorkspaceId).toBe(before.activeWorkspaceId)
  })

  it('keeps the draft and reports an untransferred image without inserting a Mac cache path into the remote request', async () => {
    await mount()
    await selectRemote()
    const save = vi.spyOn(api.ui, 'savePastedImage')
    const editor = dom.container.querySelector<HTMLElement>('[contenteditable="true"]')!
    expect(editor).not.toBeNull()
    const event = new Event('paste', { bubbles: true, cancelable: true })
    const file = new window.File(['image bytes'], 'clipboard.png', { type: 'image/png' })
    Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], getData: () => '' } })
    await act(async () => editor.dispatchEvent(event))
    expect(save).not.toHaveBeenCalled()
    expect(dom.container.querySelector('.composer-feedback')?.textContent).toContain('has not been sent to the selected machine')
    expect(useAppStore.getState().agentComposerDrafts.input).toBe('Keep the complete\nunsent request')
    expect(dom.container.querySelector<HTMLButtonElement>('.launcher-launch-button')?.disabled).toBe(false)
  })
})
