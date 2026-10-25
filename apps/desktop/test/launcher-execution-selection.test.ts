// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { useAppStore, type LauncherExecutionSelection } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { api } from '../src/renderer/src/lib/api'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import type { WorkspaceRecord } from '../src/shared/contracts'
import { workspaceZoneId } from '../src/shared/space-addresses'
import { workspaceProjectId } from '../src/renderer/src/lib/workspace-projects'

const originalState = useAppStore.getState(), originalLauncherState = useLauncherState.getState()
const remote: WorkspaceRecord = { id: 'remote-project', hostId: 'remote', name: 'Project', path: '/work/project', kind: 'folder' }
const runtime: WorkspaceRecord = { id: 'remote-runtime', hostId: 'remote', name: 'Agent environment', path: '/work/agent', kind: 'folder' }
const otherRuntime: WorkspaceRecord = { ...runtime, id: 'other-runtime', hostId: 'other' }
const localRuntime: WorkspaceRecord = { ...runtime, id: 'local-runtime', hostId: 'local' }
const source = { displayWorkspaceId: 'workspace', groupId: 'source-group', tabId: 'source', regionId: 'input' }
const split: LauncherExecutionSelection = { resourceWorkspaceId: 'workspace', agentWorkspaceId: runtime.id }

beforeEach(() => {
  const launcher = addWorkbenchRegion(createWorkbenchTab('source', { kind: 'launcher', regionId: 'input', workspaceId: 'workspace', executorId: 'review' }),
    'input', 'right', { kind: 'file', regionId: 'sibling', workspaceId: 'workspace', path: 'README.md' })
  useAppStore.setState({ ...originalState,
    config: { ...composerConfig, hosts: [...composerConfig.hosts,
      { id: 'remote', kind: 'ssh', label: 'Remote', hostname: 'remote.example' },
      { id: 'other', kind: 'ssh', label: 'Other', hostname: 'other.example' }],
      workspaces: [...composerConfig.workspaces, remote, runtime, otherRuntime, localRuntime] },
    tabs: { source: launcher }, layouts: { workspace: createWorkspaceLayout(source.groupId, ['source']) },
    activeWorkspaceId: 'workspace', sessions: [composerSession('healthy-original')],
    agentComposerDrafts: { input: '@src/original.ts Original request' },
    launcherNameDrafts: { input: { agentName: 'Original Agent', tabName: 'Original work' } },
    launcherOptionDrafts: { input: { codex: { model: 'original-model' } } } }, true)
  useLauncherState.setState({ ...originalLauncherState, drafts: {
    'region:input': { browser: 'https://source.example', note: 'Original source note',
      noteCreation: { intentId: 'original-unknown-write', createdAt: 1, noteId: 'original-note', blockIds: [], draft: 'Original source note',
        target: { workspaceId: 'workspace', hostId: 'local', workspacePath: composerConfig.workspaces[0]!.path,
          directoryPath: composerConfig.workspaces[0]!.path, relativeDirectory: '', zoneId: null, sourceSpaceId: null,
          displayWorkspaceId: 'workspace', groupId: source.groupId }, path: 'notes/original.md', status: 'unknown', revealed: false } }
  } }, true)
})
afterEach(() => { vi.restoreAllMocks(); useAppStore.setState(originalState, true); useLauncherState.setState(originalLauncherState, true) })

describe('atomic Launcher execution selection in the real Store', () => {
  it('changes only the same-project Region and keeps all original input owners and healthy Sessions', () => {
    const before = useAppStore.getState(), utility = useLauncherState.getState().drafts
    const launch = vi.spyOn(api.sessions, 'launchAgent'), stop = vi.spyOn(api.sessions, 'stop')
    const states: ReturnType<typeof useAppStore.getState>[] = []
    const release = useAppStore.subscribe(state => states.push(state))
    const selected = before.selectLauncherExecution(source, split)
    release()
    const state = useAppStore.getState()
    expect(selected).toEqual({ ...source, projectChanged: false })
    expect(states).toHaveLength(1)
    expect(state.tabs.source!.regions.input).toEqual({ kind: 'launcher', regionId: 'input', workspaceId: 'workspace', agentWorkspaceId: runtime.id })
    expect(state.tabs.source!.regions.sibling).toBe(before.tabs.source!.regions.sibling)
    expect(state.tabs.source!.layout).toBe(before.tabs.source!.layout)
    expect(state.layouts).toBe(before.layouts)
    expect(state.agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(state.launcherNameDrafts).toBe(before.launcherNameDrafts)
    expect(state.launcherOptionDrafts).toBe(before.launcherOptionDrafts)
    expect(useLauncherState.getState().drafts).toBe(utility)
    expect(state.sessions).toBe(before.sessions)
    expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
  })

  it('retains exact Host configuration only within the same runtime source, including same-Host different cwd', () => {
    useAppStore.getState().selectLauncherExecution(source, split)
    useAppStore.setState(state => ({ tabs: { ...state.tabs, source: { ...state.tabs.source!, regions: {
      ...state.tabs.source!.regions, input: { ...state.tabs.source!.regions.input!, kind: 'launcher', regionId: 'input', workspaceId: 'workspace',
        agentWorkspaceId: runtime.id, agentExecutor: { hostId: 'remote', executorId: 'review', executorRevision: 'remote-exact-revision' } }
    } } } }))
    const remoteSecond = { ...runtime, id: 'remote-second', path: '/work/another-cwd' }
    useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [...state.config!.workspaces, remoteSecond] } }))
    useAppStore.getState().selectLauncherExecution(source, { ...split, agentWorkspaceId: remoteSecond.id })
    expect(useAppStore.getState().tabs.source!.regions.input).toMatchObject({ agentWorkspaceId: remoteSecond.id,
      agentExecutor: { hostId: 'remote', executorId: 'review', executorRevision: 'remote-exact-revision' } })
    useAppStore.getState().selectLauncherExecution(source, { ...split, agentWorkspaceId: otherRuntime.id })
    expect(useAppStore.getState().tabs.source!.regions.input).not.toHaveProperty('agentExecutor')
    useAppStore.getState().selectLauncherExecution(source, { ...split, agentWorkspaceId: 'workspace' })
    expect(useAppStore.getState().tabs.source!.regions.input).toMatchObject({ agentWorkspaceId: 'workspace' })
    useAppStore.getState().selectLauncherExecution(source, { ...split, agentWorkspaceId: null })
    expect(useAppStore.getState().tabs.source!.regions.input).not.toHaveProperty('executorId')
  })

  it('keeps an ordinary selected Executor when its exact runtime source remains the same', () => {
    useAppStore.getState().selectLauncherExecution(source, { resourceWorkspaceId: 'workspace', agentWorkspaceId: null })
    expect(useAppStore.getState().tabs.source!.regions.input).toMatchObject({ executorId: 'review' })
    useAppStore.getState().selectLauncherExecution(source, { ...split, agentWorkspaceId: localRuntime.id })
    expect(useAppStore.getState().tabs.source!.regions.input).not.toHaveProperty('executorId')
  })

  it('reuses the destination project Launcher and its own draft in one navigation transaction', () => {
    const target = createWorkbenchTab('remote-launcher', { kind: 'launcher', regionId: 'remote-input', workspaceId: remote.id, executorId: 'remote-original' })
    useAppStore.setState(state => ({ tabs: { ...state.tabs, [target.id]: target },
      layouts: { ...state.layouts, [remote.id]: createWorkspaceLayout('remote-group', [target.id]) },
      agentComposerDrafts: { ...state.agentComposerDrafts, 'remote-input': '@remote-only.ts Destination request' },
      launcherNameDrafts: { ...state.launcherNameDrafts, 'remote-input': { agentName: 'Remote original', tabName: '' } } }))
    const before = useAppStore.getState(), utility = useLauncherState.getState().drafts
    const copy = vi.spyOn(useLauncherState.getState(), 'copyUtilityDraft')
    const observed: unknown[] = []
    const release = useAppStore.subscribe(state => observed.push({ active: state.activeWorkspaceId, region: state.tabs[target.id]!.regions['remote-input'] }))
    const selected = before.selectLauncherExecution(source, { resourceWorkspaceId: remote.id, agentWorkspaceId: null })
    release()
    const state = useAppStore.getState()
    expect(selected).toEqual({ displayWorkspaceId: remote.id, groupId: 'remote-group', tabId: target.id, regionId: 'remote-input', projectChanged: true })
    expect(observed).toEqual([{ active: remote.id, region: { kind: 'launcher', regionId: 'remote-input', workspaceId: remote.id, executorId: 'remote-original' } }])
    expect(state.tabs.source).toBe(before.tabs.source)
    expect(state.agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(state.launcherNameDrafts).toBe(before.launcherNameDrafts)
    expect(state.launcherOptionDrafts).toBe(before.launcherOptionDrafts)
    expect(state.workbenchSpaceSelection).toMatchObject({ workspaceId: remote.id, tabId: target.id, regionId: 'remote-input' })
    expect(useLauncherState.getState().drafts).toBe(utility)
    expect(copy).not.toHaveBeenCalled()
  })

  it('creates the exact destination project workface without moving the source relative references or unknown Note receipt', () => {
    const before = useAppStore.getState(), utility = useLauncherState.getState().drafts
    const selected = before.selectLauncherExecution(source, { resourceWorkspaceId: remote.id, agentWorkspaceId: otherRuntime.id })
    const state = useAppStore.getState()
    expect(selected.displayWorkspaceId).toBe(remote.id)
    expect(state.activeWorkspaceId).toBe(remote.id)
    expect(state.tabs[selected.tabId]).toMatchObject({ workspaceId: remote.id,
      regions: { [selected.regionId]: { kind: 'launcher', workspaceId: remote.id, agentWorkspaceId: otherRuntime.id } } })
    expect(state.tabs.source).toBe(before.tabs.source)
    expect(state.layouts.workspace).toBe(before.layouts.workspace)
    expect(state.agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(state.agentComposerDrafts[selected.regionId]).toBeUndefined()
    expect(useLauncherState.getState().drafts).toBe(utility)
    expect(utility['region:input']!.noteCreation!.status).toBe('unknown')
    expect(state.sessions).toBe(before.sessions)
  })

  it('custom placement keeps the display while giving the other project its own new Launcher', () => {
    const before = useAppStore.getState()
    const selected = before.selectLauncherExecution(source, { resourceWorkspaceId: remote.id, agentWorkspaceId: localRuntime.id }, { navigateProject: false })
    const state = useAppStore.getState()
    expect(selected).toMatchObject({ displayWorkspaceId: 'workspace', groupId: source.groupId, projectChanged: true })
    expect(state.activeWorkspaceId).toBe('workspace')
    expect(state.tabs[selected.tabId]!.workspaceId).toBe(remote.id)
    expect(state.tabs[selected.tabId]!.regions[selected.regionId]).toMatchObject({ workspaceId: remote.id, agentWorkspaceId: localRuntime.id })
    expect(state.agentComposerDrafts[selected.regionId]).toBeUndefined()
    expect(state.tabs.source).toBe(before.tabs.source)
  })

  it('lets an independent projection select its new placement without changing the main workface or physical selection', () => {
    useAppStore.setState({ mainSurface: 'agents' })
    const before = useAppStore.getState()
    const selected = before.selectLauncherExecution(source, { resourceWorkspaceId: remote.id, agentWorkspaceId: localRuntime.id },
      { navigateProject: false, reveal: false })
    const state = useAppStore.getState()
    expect(selected).toMatchObject({ displayWorkspaceId: 'workspace', groupId: source.groupId, projectChanged: true })
    expect(state.mainSurface).toBe('agents')
    expect(state.activeWorkspaceId).toBe(before.activeWorkspaceId)
    expect(state.workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    expect(state.layouts.workspace!.activeGroupId).toBe(before.layouts.workspace!.activeGroupId)
    expect(state.layouts.workspace!.groups[0]!.activeTabId).toBe('source')
    expect(state.tabs.source).toBe(before.tabs.source)
    expect(state.tabs[selected.tabId]!.regions[selected.regionId]).toMatchObject({ workspaceId: remote.id, agentWorkspaceId: localRuntime.id })
  })

  it('leaves an unmaterialized source Group and all of its drafts intact when choosing another project', () => {
    useAppStore.setState({ tabs: {}, layouts: { workspace: createWorkspaceLayout(source.groupId) } })
    useLauncherState.getState().setDraft(`group:${source.groupId}`, 'prompt', '@source.ts Original empty Group')
    useLauncherState.getState().setDraft(`group:${source.groupId}`, 'note', 'Original empty Group Note')
    const before = useAppStore.getState(), utility = useLauncherState.getState().drafts
    const selected = before.selectLauncherExecution({ displayWorkspaceId: 'workspace', groupId: source.groupId, resourceWorkspaceId: 'workspace' },
      { resourceWorkspaceId: remote.id, agentWorkspaceId: runtime.id })
    const state = useAppStore.getState()
    expect(Object.keys(state.tabs)).toEqual([selected.tabId])
    expect(state.layouts.workspace).toBe(before.layouts.workspace)
    expect(state.layouts.workspace!.groups[0]!.tabOrder).toEqual([])
    expect(state.tabs[selected.tabId]!.regions[selected.regionId]).toMatchObject({ workspaceId: remote.id, agentWorkspaceId: runtime.id })
    expect(useLauncherState.getState().drafts).toBe(utility)
  })

  it.each(['group', 'zone'] as const)('claims only the destination empty %s own inputs when creating its first Launcher', owner => {
    useAppStore.setState(state => ({ layouts: { ...state.layouts, [remote.id]: createWorkspaceLayout('remote-empty-group') } }))
    const ownerId = owner === 'group' ? 'group:remote-empty-group'
      : `zone:${JSON.stringify([workspaceZoneId(workspaceProjectId(remote), remote.id), remote.id, 'remote-empty-group'])}`
    useLauncherState.setState(state => ({ drafts: { ...state.drafts, [ownerId]: { prompt: '@remote-only.ts Destination empty request',
      names: { agentName: 'Destination empty Agent', tabName: '' }, optionsByProvider: { codex: { model: 'destination-model' } },
      browser: 'https://destination.example', note: 'Destination own note' } } }))
    const sourceDraft = useLauncherState.getState().drafts['region:input']
    const selected = useAppStore.getState().selectLauncherExecution(source, { resourceWorkspaceId: remote.id, agentWorkspaceId: runtime.id })
    const state = useAppStore.getState()
    expect(state.agentComposerDrafts[selected.regionId]).toBe('@remote-only.ts Destination empty request')
    expect(state.launcherNameDrafts[selected.regionId]?.agentName).toBe('Destination empty Agent')
    expect(state.launcherOptionDrafts[selected.regionId]).toEqual({ codex: { model: 'destination-model' } })
    expect(state.agentComposerDrafts.input).toBe('@src/original.ts Original request')
    expect(useLauncherState.getState().drafts[`region:${selected.regionId}`]).toMatchObject({ browser: 'https://destination.example', note: 'Destination own note' })
    expect(useLauncherState.getState().drafts[ownerId]).not.toHaveProperty('prompt')
    expect(useLauncherState.getState().drafts['region:input']).toBe(sourceDraft)
  })

  it('materializes same-resource Group inputs and complete execution together before observers see a Region', () => {
    useAppStore.setState({ tabs: {}, layouts: { workspace: createWorkspaceLayout(source.groupId) }, agentComposerDrafts: {}, launcherNameDrafts: {}, launcherOptionDrafts: {} })
    const names = { agentName: 'Group Agent', tabName: 'Group work' }, optionsByProvider = { codex: { model: 'group-model' } }
    const sourceLauncherId = `group:${source.groupId}`
    useLauncherState.setState(state => ({ drafts: { ...state.drafts, [sourceLauncherId]: {
      browser: 'https://group.example', note: 'Group Note', prompt: 'Group request', names, optionsByProvider } } }))
    const observed: ReturnType<typeof useAppStore.getState>[] = []
    const release = useAppStore.subscribe(state => observed.push(state))
    const tabId = useAppStore.getState().openLauncher({ workspaceId: 'workspace', tabGroupId: source.groupId, reveal: false,
      initialExecution: split, initialInputs: { prompt: 'Group request', names, optionsByProvider, sourceLauncherId } })!
    release()
    expect(observed).toHaveLength(1)
    const state = observed[0]!, tab = state.tabs[tabId]!, regionId = tab.layout.activeRegionId
    expect(tab.regions[regionId]).toMatchObject({ kind: 'launcher', workspaceId: 'workspace', agentWorkspaceId: runtime.id })
    expect(state.agentComposerDrafts[regionId]).toBe('Group request')
    expect(state.launcherNameDrafts[regionId]).toBe(names)
    expect(state.launcherOptionDrafts[regionId]).toBe(optionsByProvider)
    expect(useLauncherState.getState().drafts[`region:${regionId}`]).toMatchObject({ browser: 'https://group.example', note: 'Group Note' })
    expect(useLauncherState.getState().drafts[sourceLauncherId]).not.toHaveProperty('prompt')
  })

  it('refuses only an invalid exact operation and retains all original work and healthy Session capabilities', () => {
    const before = useAppStore.getState(), utility = useLauncherState.getState().drafts
    expect(() => before.selectLauncherExecution(source, { ...split, agentWorkspaceId: 'not-registered' })).toThrow('exact registered')
    expect(useAppStore.getState()).toBe(before)
    expect(() => before.selectLauncherExecution({ ...source, groupId: 'wrong-occurrence' }, split)).toThrow('original Launcher position')
    expect(useAppStore.getState()).toBe(before)
    expect(() => before.openLauncher({ workspaceId: 'workspace', reveal: true,
      initialExecution: { resourceWorkspaceId: remote.id, agentWorkspaceId: null } })).toThrow('this Launcher project')
    expect(useAppStore.getState()).toBe(before)
    expect(useLauncherState.getState().drafts).toBe(utility)
    expect(before.sessions[0]!.processState).toBe('running')
    useAppStore.setState({ tabs: { source: createWorkbenchTab('source', { kind: 'agent', phase: 'attached', regionId: 'input', workspaceId: 'workspace', sessionId: 'healthy-original' }) } })
    const started = useAppStore.getState()
    expect(() => started.selectLauncherExecution(source, split)).toThrow('original unstarted Launcher')
    expect(useAppStore.getState()).toBe(started)
  })
})
