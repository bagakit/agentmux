// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { ScratchTopicSnapshot, SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { directoryIdentity, homeZoneId, workspaceZoneId } from '../src/shared/space-addresses'
import { WorkspaceZonesPanel } from '../src/renderer/src/components/WorkspaceZonesPanel'
import { ProjectFilesTool } from '../src/renderer/src/components/ProjectFilesTool'
import { api } from '../src/renderer/src/lib/api'
import { workbenchSelectionCatalog } from '../src/renderer/src/lib/desktop-focus-navigation'
import { createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { openWorkspaceZoneFile, openWorkspaceZoneTerminal } from '../src/renderer/src/lib/workspace-zone-file-actions'
import { useWorkspaceZoneContext, workspaceZoneContext } from '../src/renderer/src/lib/workspace-zone-context'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installFileTreeGeometry } from './helpers/file-tree-geometry'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const display: WorkspaceRecord = { id: 'project', hostId: 'local', path: fixturePath('zones/repo'), name: 'Project', kind: 'folder' }
const first: WorkspaceRecord = { id: 'first', hostId: 'local', path: fixturePath('zones/first'), repoPath: display.path, name: 'Same', branch: 'same', kind: 'worktree' }
const second: WorkspaceRecord = { ...first, id: 'second', path: fixturePath('zones/second') }
const remote: WorkspaceRecord = { id: 'remote', hostId: 'remote', path: fixturePath('zones/remote'), name: 'Remote directory', kind: 'folder' }
const spaceId = directoryIdentity(display.hostId, display.path)
const rootZone = workspaceZoneId(spaceId, display.id)
const firstZone = workspaceZoneId(spaceId, first.id)
const secondZone = workspaceZoneId(spaceId, second.id)
const remoteSpace = directoryIdentity(remote.hostId, remote.path)
const remoteZone = workspaceZoneId(remoteSpace, remote.id)
const duplicateZone = 'retained-second-zone-on-first-resource'
const unknownZone = 'retained-unavailable-zone'

describe('Workspace Zones original Store projection and navigation', () => {
  const dom = composerDOM()
  let raf: typeof requestAnimationFrame

  beforeEach(() => {
    vi.spyOn(api.git, 'worktrees').mockResolvedValue({ kind: 'ready', hostId: display.hostId, workspacePath: display.path,
      repoPath: display.path, checkedAt: 1, warnings: [], worktrees: [
        { path: display.path, branch: 'main', kind: 'main', detached: false, aliases: [] },
        { path: first.path, branch: 'same', kind: 'linked', detached: false, aliases: [] },
        { path: second.path, branch: 'same', kind: 'linked', detached: false, aliases: [] }
      ] })
    raf = globalThis.requestAnimationFrame
    vi.stubGlobal('requestAnimationFrame', undefined)
    vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
    const tab = { ...createWorkbenchTab('first-tab', { kind: 'launcher', workspaceId: first.id, regionId: 'first-region' }),
      space: { spaceId, zoneId: firstZone } }
    useAppStore.setState({ config: { ...composerConfig, workspaces: [display, first, second, remote],
      hosts: [...composerConfig.hosts, { id: 'remote', kind: 'ssh', label: 'Remote', hostname: 'zones-fixture' }] },
      tabs: { [tab.id]: tab }, layouts: { [display.id]: createWorkspaceLayout('display-group'),
        [first.id]: createWorkspaceLayout('first-group', [tab.id]), [second.id]: createWorkspaceLayout('second-group'),
        [remote.id]: createWorkspaceLayout('remote-group') },
      activeWorkspaceId: display.id, mainSurface: 'workbench', workbenchSpaceSelection: null,
      spaceZoneBindings: {
        [duplicateZone]: { spaceId, workspaceId: first.id },
        [unknownZone]: { spaceId, workspaceId: 'missing-resource' },
        [remoteZone]: { spaceId: remoteSpace, workspaceId: remote.id, relations: { [spaceId]: true } }
      }, scratchTopicSnapshots: {}, topicCategories: [], projectGroups: [], spatialRequests: {},
      agentFocus: { execution: { sessionId: 'agent-1', history: [] }, pmo: { sessionId: null } } })
  })
  afterEach(() => { vi.stubGlobal('requestAnimationFrame', raf) })

  function choose(zoneId: string | null, chosenSpace = spaceId, workspaceId = display.id): void {
    useAppStore.setState({ workbenchSpaceSelection: { spaceId: chosenSpace, zoneId, workspaceId,
      tabId: null, groupId: null, regionId: null, topicId: null } })
  }
  function row(zoneId: string): HTMLButtonElement {
    const found = [...dom.container.querySelectorAll<HTMLButtonElement>('[data-zone-id]')].find(value => value.dataset.zoneId === zoneId)
    expect(found, `Missing original Zone ${zoneId}`).toBeDefined()
    return found!
  }
  async function clickZone(zoneId: string): Promise<void> { await act(async () => row(zoneId).click()) }
  function rowName(zoneId: string): string {
    return row(zoneId).querySelector('.workspace-zone-entry__name')!.textContent!
  }

  it('projects every Space binding without merging same-name or same-resource Zones or using Agent cwd', async () => {
    const catalog = workbenchSelectionCatalog(useAppStore.getState())
    const context = workspaceZoneContext(useAppStore.getState(), display)
    expect(context.spaceId).toBe(spaceId)
    expect(context.selectedZoneId).toBe(rootZone)
    expect(context.resource).toBe(display)
    expect(context.zones.map(zone => zone.zoneId)).toEqual([rootZone, firstZone, secondZone, remoteZone, duplicateZone, unknownZone])
    for (const zone of context.zones) expect(catalog.zones).toContain(zone)
    const refs = vi.spyOn(api.workspaces, 'listBranches')
    await dom.render(<WorkspaceZonesPanel workspace={display} onManageWorktrees={vi.fn()} />)
    expect(dom.container.querySelectorAll('[data-zone-id]')).toHaveLength(6)
    expect(row(rootZone).getAttribute('aria-pressed')).toBe('true')
    expect(rowName(firstZone)).toBe(first.name)
    expect(rowName(secondZone)).toBe(second.name)
    expect(row(firstZone).querySelector('.workspace-zone-entry__branch')?.textContent).toBe('same')
    expect(row(secondZone).querySelector('.workspace-zone-entry__branch')?.textContent).toBe('same')
    expect(row(firstZone).querySelector('.workspace-zone-entry__path')?.textContent).toBe('../first')
    expect(row(secondZone).querySelector('.workspace-zone-entry__path')?.textContent).toBe('../second')
    expect(row(firstZone).querySelector('small')?.title).toBe(`${first.path} · local`)
    expect(row(secondZone).querySelector('small')?.title).toBe(`${second.path} · local`)
    expect(row(unknownZone).querySelector('.workspace-zone-entry__kind')?.textContent).toBe('Unknown')
    expect(dom.container.textContent).not.toContain('Branches')
    expect(refs).not.toHaveBeenCalled()
  })

  it('keeps registered names separate from original Home and nested Folder directory facts', async () => {
    const nested = nestedFilesZone(), folderZone = 'retained-nested-folder'
    useAppStore.setState(state => ({ spaceZoneBindings: { ...state.spaceZoneBindings,
      [folderZone]: { spaceId, workspaceId: display.id, directoryPath: `${display.path}/nested-folder` } } }))
    const refs = vi.spyOn(api.workspaces, 'listBranches')
    await dom.render(<WorkspaceZonesPanel workspace={display} onManageWorktrees={vi.fn()} />)
    expect([rootZone, firstZone, secondZone, remoteZone, duplicateZone, unknownZone, nested.zoneId, folderZone]
      .map(zoneId => row(zoneId).querySelector('.workspace-zone-entry__kind')?.textContent))
      .toEqual(['Folder', 'Worktree', 'Worktree', 'Folder', 'Worktree', 'Unknown', 'Home', 'Folder'])
    expect([rootZone, firstZone, secondZone, remoteZone, duplicateZone, unknownZone, nested.zoneId, folderZone].map(rowName))
      .toEqual(['Project', 'Same', 'Same', 'Remote directory', 'Same', 'missing-resource', 'topic', 'nested-folder'])
    expect(row(nested.zoneId).getAttribute('aria-pressed')).toBe('true')
    expect(row(nested.zoneId).querySelector('[aria-label="Selected Zone"]')).not.toBeNull()
    expect(row(rootZone).querySelector('[aria-label="Selected Zone"]')).toBeNull()
    expect(row(nested.zoneId).querySelector('.workspace-zone-entry__path')?.textContent).toBe(nested.directoryPath)
    expect(row(folderZone).querySelector('.workspace-zone-entry__path')?.textContent).toBe(`${display.path}/nested-folder`)
    expect(workspaceZoneContext(useAppStore.getState(), display)).toMatchObject({ resource: null,
      files: { workspace: display, rootPath: 'topic', directoryPath: nested.directoryPath } })
    expect(row(unknownZone).title).toContain(unknownZone)
    expect(refs).not.toHaveBeenCalled()
  })

  it('retains an existing Workspace name for conflicting unknown Zone facts and preserves the original ambiguous focus refusal', async () => {
    useAppStore.setState(state => ({ spaceZoneBindings: { ...state.spaceZoneBindings,
      [firstZone]: { spaceId, workspaceId: second.id } },
      layouts: { ...state.layouts, [display.id]: createWorkspaceLayout('second-location', ['first-tab']) } }))
    choose(firstZone)
    const context = workspaceZoneContext(useAppStore.getState(), display)
    expect(context.zones.find(zone => zone.zoneId === firstZone)).toMatchObject({ workspaceId: first.id,
      kind: 'unknown', hostId: null, directoryPath: null, issue: expect.stringContaining('conflict') })
    expect(context.resource).toBeNull()
    expect(context.files).toBeNull()
    const before = useAppStore.getState(), execute = vi.spyOn(before, 'executeControl'), report = vi.spyOn(before, 'reportError')
    await dom.render(<WorkspaceZonesPanel workspace={display} onManageWorktrees={vi.fn()} />)
    expect(rowName(firstZone)).toBe(first.id)
    expect(row(firstZone).querySelector('.workspace-zone-entry__kind')?.textContent).toBe('Unknown')
    expect(row(firstZone).querySelector('.workspace-zone-entry__path')).toBeNull()
    expect(row(firstZone).title).toContain('conflict')
    expect(dom.container.querySelector('[role="status"]')?.textContent).toContain('conflict')
    expect(row(firstZone).disabled).toBe(false)
    await clickZone(firstZone)
    const result = await execute.mock.results[0]!.value
    expect(result.operation).toBe('focus')
    if (result.operation !== 'focus') throw new Error('The original focus receipt is missing.')
    expect(result.navigation.state).toBe('rejected')
    expect(report).toHaveBeenCalledTimes(1)
    expect(String(report.mock.calls[0]![0])).toContain('exact display Workspace and Group')
    expect(workspaceZoneContext(useAppStore.getState(), display).resource).toBeNull()
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(useAppStore.getState().regionCaretFocus).toBe(before.regionCaretFocus)
  })

  it('only abbreviates confirmed same-project Host paths and keeps complete resource tooltips and visible remote Hosts', async () => {
    useAppStore.setState({ localHome: fixturePath('zones') })
    await dom.render(<WorkspaceZonesPanel workspace={display} onManageWorktrees={vi.fn()} />)
    expect(row(firstZone).querySelector('.workspace-zone-entry__path')?.textContent).toBe('~/first')
    expect(row(firstZone).querySelector('small')?.title).toBe('~/first · local')
    expect(row(firstZone).querySelector('small')?.textContent).not.toContain('local')
    expect(row(remoteZone).querySelector('.workspace-zone-entry__path')?.textContent).toBe(remote.path)
    expect(row(remoteZone).querySelector('small')?.title).toBe(`${remote.path} · remote`)
    expect(row(remoteZone).querySelector('.workspace-zone-entry__host')?.textContent).toBe(remote.hostId)
    const unrelated: WorkspaceRecord = { id: 'unrelated', hostId: display.hostId, path: fixturePath('zones/unrelated'), name: 'Independent folder', kind: 'folder' }
    const unrelatedSpace = directoryIdentity(unrelated.hostId, unrelated.path), unrelatedZone = workspaceZoneId(unrelatedSpace, unrelated.id)
    await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [...state.config!.workspaces, unrelated] },
      spaceZoneBindings: { ...state.spaceZoneBindings, [unrelatedZone]: { spaceId: unrelatedSpace, workspaceId: unrelated.id, relations: { [spaceId]: true } } } })))
    expect(row(unrelatedZone).querySelector('.workspace-zone-entry__path')?.textContent).toBe('~/unrelated')
    expect(row(unrelatedZone).querySelector('small')?.title).toBe('~/unrelated · local')
    await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, copyPathsAsAbsolute: true } })))
    expect(row(firstZone).querySelector('.workspace-zone-entry__path')?.textContent).toBe('../first')
    expect(row(firstZone).querySelector('small')?.title).toBe(`${first.path} · local`)
    expect(row(unrelatedZone).querySelector('.workspace-zone-entry__path')?.textContent).toBe(unrelated.path)
    expect(workspaceZoneContext(useAppStore.getState(), display).zones.find(zone => zone.zoneId === firstZone)?.directoryPath).toBe(first.path)
  })

  it('does not repeat a branch equal to its registered name or invent a local Host label', async () => {
    await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, workspaces: state.config!.workspaces.map(workspace =>
      workspace.id === first.id ? { ...workspace, name: first.branch! } : workspace) } })))
    await dom.render(<WorkspaceZonesPanel workspace={display} onManageWorktrees={vi.fn()} />)
    expect(rowName(firstZone)).toBe('same')
    expect(row(firstZone).querySelector('.workspace-zone-entry__branch')).toBeNull()
    expect(row(firstZone).querySelector('.workspace-zone-entry__host')).toBeNull()
    expect(row(secondZone).querySelector('.workspace-zone-entry__branch')?.textContent).toBe('same')
    expect(row(remoteZone).querySelector('.workspace-zone-entry__host')?.textContent).toBe(remote.hostId)
  })

  it('moves directory keyboard focus without navigating or replacing the selected Zone, input or original workface', async () => {
    const before = useAppStore.getState(), execute = vi.spyOn(before, 'executeControl')
    await dom.render(<WorkspaceZonesPanel workspace={display} onManageWorktrees={vi.fn()} />)
    await act(async () => row(rootZone).focus())
    for (const [key, expectedZone] of [['ArrowUp', rootZone], ['ArrowDown', firstZone], ['ArrowDown', secondZone], ['ArrowUp', firstZone],
      ['End', unknownZone], ['ArrowDown', unknownZone], ['Home', rootZone]] as const) {
      await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))
      expect(document.activeElement).toBe(row(expectedZone))
      expect(row(rootZone).getAttribute('aria-pressed')).toBe('true')
      expect(dom.container.querySelectorAll('[data-zone-id][aria-pressed="true"]')).toHaveLength(1)
      expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
      expect(useAppStore.getState().tabs).toBe(before.tabs)
      expect(useAppStore.getState().layouts).toBe(before.layouts)
      expect(useAppStore.getState().sessions).toBe(before.sessions)
      expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
      expect(useAppStore.getState().regionCaretFocus).toBe(before.regionCaretFocus)
      expect(execute).not.toHaveBeenCalled()
    }
  })

  it('leaves modified and composing directory keys to their original input owner', async () => {
    const execute = vi.spyOn(useAppStore.getState(), 'executeControl')
    await dom.render(<WorkspaceZonesPanel workspace={display} onManageWorktrees={vi.fn()} />)
    const target = row(rootZone), before = useAppStore.getState()
    await act(async () => target.focus())
    for (const options of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }]) {
      const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true, ...options })
      await act(async () => expect(target.dispatchEvent(event)).toBe(true))
      expect(event.defaultPrevented).toBe(false)
      expect(document.activeElement).toBe(target)
      expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
      expect(useAppStore.getState().tabs).toBe(before.tabs)
    }
    expect(execute).not.toHaveBeenCalled()
  })

  it.each(['Enter', ' '] as const)('dispatches real %j events and models the uncancelled browser-default button click through the exact Zone owner', async key => {
    const execute = vi.spyOn(useAppStore.getState(), 'executeControl')
    await dom.render(<WorkspaceZonesPanel workspace={display} onManageWorktrees={vi.fn()} />)
    const target = row(firstZone)
    expect(target.tagName).toBe('BUTTON')
    expect(target.type).toBe('button')
    expect(target.disabled).toBe(false)
    await act(async () => target.focus())
    const down = new KeyboardEvent('keydown', { key, code: key === ' ' ? 'Space' : 'Enter', bubbles: true, cancelable: true })
    const up = new KeyboardEvent('keyup', { key, code: key === ' ' ? 'Space' : 'Enter', bubbles: true, cancelable: true })
    await act(async () => {
      expect(target.dispatchEvent(down)).toBe(true)
      expect(down.defaultPrevented).toBe(false)
      expect(execute).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(target)
      if (key === 'Enter') target.click()
      expect(target.dispatchEvent(up)).toBe(true)
      expect(up.defaultPrevented).toBe(false)
      if (key === ' ') target.click()
    })
    expect(execute).toHaveBeenCalledExactlyOnceWith({ schemaVersion: 5, requestId: expect.any(String), operation: 'focus',
      target: { kind: 'space', spaceId, zoneId: firstZone }, inputPolicy: 'preserve' })
    expect(useAppStore.getState().workbenchSpaceSelection?.zoneId).toBe(firstZone)
    expect(row(firstZone).getAttribute('aria-pressed')).toBe('true')
  })

  it('resolves a cross-bound Zone to its original Workspace, Host and path, not its display context', () => {
    choose(remoteZone)
    expect(workspaceZoneContext(useAppStore.getState(), display)).toMatchObject({ spaceId, selectedZoneId: remoteZone,
      resource: { id: remote.id, hostId: remote.hostId, path: remote.path }, issue: null })
    choose(duplicateZone)
    expect(workspaceZoneContext(useAppStore.getState(), display).resource).toBe(first)
  })

  it('keeps a nested Files scope but rejects Git targeting its registered Workspace root', async () => {
    const directoryPath = `${remote.path}/nested`, nestedZone = 'retained-nested-zone'
    useAppStore.setState(state => ({ spaceZoneBindings: { ...state.spaceZoneBindings,
      [nestedZone]: { spaceId: remoteSpace, workspaceId: remote.id, directoryPath, relations: { [spaceId]: true } } } }))
    choose(nestedZone)
    const context = workspaceZoneContext(useAppStore.getState(), display)
    expect(context.zones.find(zone => zone.zoneId === nestedZone)?.directoryPath).toBe(directoryPath)
    expect(context.resource).toBeNull()
    expect(context.files).toEqual({ workspace: remote, rootPath: 'nested', directoryPath })
    expect(context.files?.workspace).toBe(remote)
    expect(context.issue).toContain('Git scope is unsupported')
    await dom.render(<WorkspaceZonesPanel workspace={display} onManageWorktrees={vi.fn()} />)
    expect(row(nestedZone).disabled).toBe(false)
    expect(dom.container.querySelector('[role="status"]')?.textContent).toContain('Files remain available')
    expect(useAppStore.getState().config?.workspaces.find(value => value.id === remote.id)).toBe(remote)
  })

  it('keeps the registered resource reference across unrelated configuration updates and rejects an unbound known Zone', () => {
    choose(remoteZone)
    expect(workspaceZoneContext(useAppStore.getState(), display).resource).toBe(remote)
    useAppStore.setState(state => ({ config: { ...state.config!, copyPathsAsAbsolute: true } }))
    expect(workspaceZoneContext(useAppStore.getState(), display).resource).toBe(remote)
    useAppStore.setState(state => ({ spaceZoneBindings: { ...state.spaceZoneBindings,
      [remoteZone]: { ...state.spaceZoneBindings[remoteZone]!, relations: { [spaceId]: false } } } }))
    expect(workspaceZoneContext(useAppStore.getState(), display).resource).toBeNull()
    expect(workspaceZoneContext(useAppStore.getState(), display).issue).toBeTruthy()
  })

  it.each([unknownZone, 'not-a-known-zone', workspaceZoneId(remoteSpace, 'unbound')])('never falls back after explicitly selecting %s', zoneId => {
    choose(zoneId)
    const context = workspaceZoneContext(useAppStore.getState(), display)
    expect(context.selectedZoneId).toBe(zoneId)
    expect(context.resource).toBeNull()
    expect(context.files).toBeNull()
    expect(context.issue).toBeTruthy()
    expect(context.zones.some(zone => zone.zoneId === unknownZone)).toBe(true)
  })

  it('takes only this display Workspace selection, retains explicit Space scope, and falls back only without a Zone', () => {
    choose(remoteZone, remoteSpace, first.id)
    expect(workspaceZoneContext(useAppStore.getState(), display)).toMatchObject({ spaceId, selectedZoneId: rootZone, resource: display })
    choose(remoteZone, remoteSpace)
    expect(workspaceZoneContext(useAppStore.getState(), display)).toMatchObject({ spaceId: remoteSpace, selectedZoneId: remoteZone, resource: remote })
    choose(null)
    expect(workspaceZoneContext(useAppStore.getState(), display).resource).toBe(display)
  })

  it('highlights only the catalog original default Zone and never substitutes the first remaining binding', async () => {
    const context = workspaceZoneContext(useAppStore.getState(), first)
    expect(context.selectedZoneId).toBe(firstZone)
    expect(context.resource).toBe(first)
    useAppStore.setState(state => ({ spaceZoneBindings: { ...state.spaceZoneBindings,
      [rootZone]: { spaceId, workspaceId: display.id, relations: { [spaceId]: false } } } }))
    await dom.render(<WorkspaceZonesPanel workspace={display} onManageWorktrees={vi.fn()} />)
    expect(workspaceZoneContext(useAppStore.getState(), display).selectedZoneId).toBeNull()
    expect(workspaceZoneContext(useAppStore.getState(), display).resource).toBe(display)
    expect(dom.container.querySelectorAll('[data-zone-id]')).toHaveLength(5)
    expect(dom.container.querySelector('[data-zone-id][aria-pressed="true"]')).toBeNull()
  })

  it('actual clicks call original focus with exact Space/Zone and preserve original Tab, Region, Run and drafts', async () => {
    const before = useAppStore.getState()
    const execute = vi.spyOn(before, 'executeControl')
    const launch = vi.spyOn(api.sessions, 'launchAgent')
    const openBranch = vi.spyOn(api.workspaces, 'openBranch')
    const activate = vi.spyOn(before, 'activateWorkspaceSelection')
    const create = vi.fn()
    await dom.render(<WorkspaceZonesPanel workspace={display} onManageWorktrees={create} />)
    await clickZone(firstZone)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]![0]).toEqual({ schemaVersion: 5, requestId: expect.any(String), operation: 'focus',
      target: { kind: 'space', spaceId, zoneId: firstZone }, inputPolicy: 'preserve' })
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ spaceId, zoneId: firstZone,
      workspaceId: first.id, tabId: 'first-tab', groupId: 'first-group', regionId: 'first-region' })
    expect(row(firstZone).getAttribute('aria-pressed')).toBe('true')
    expect(useAppStore.getState().tabs).toEqual(before.tabs)
    expect(useAppStore.getState().tabs['first-tab']!.regions['first-region']).toBe(before.tabs['first-tab']!.regions['first-region'])
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(before.agentFocus.execution.sessionId)
    expect(activate).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
    expect(openBranch).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('can select a plain non-Git directory Zone and highlights the exact Zone rather than its resource', async () => {
    choose(duplicateZone)
    await dom.render(<WorkspaceZonesPanel workspace={display} onManageWorktrees={vi.fn()} />)
    expect(row(duplicateZone).getAttribute('aria-pressed')).toBe('true')
    expect(row(firstZone).getAttribute('aria-pressed')).toBe('false')
    await clickZone(rootZone)
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ spaceId, zoneId: rootZone, workspaceId: display.id })
    expect(row(rootZone).getAttribute('aria-pressed')).toBe('true')
    expect(row(duplicateZone).getAttribute('aria-pressed')).toBe('false')
  })

  it('does not guess a first display occurrence when the original focus owner rejects ambiguity', async () => {
    const original = useAppStore.getState()
    useAppStore.setState({ layouts: { ...original.layouts,
      [display.id]: createWorkspaceLayout('second-location', ['first-tab']) } })
    const report = vi.spyOn(useAppStore.getState(), 'reportError')
    const before = useAppStore.getState()
    await dom.render(<WorkspaceZonesPanel workspace={display} onManageWorktrees={vi.fn()} />)
    await clickZone(firstZone)
    expect(report).toHaveBeenCalledTimes(1)
    expect(String(report.mock.calls[0]![0])).toContain('exact display Workspace and Group')
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
  })

  it('keeps unknown Zones selectable and keeps a persistent unknown resource explanation', async () => {
    choose(unknownZone)
    await dom.render(<WorkspaceZonesPanel workspace={display} onManageWorktrees={vi.fn()} />)
    expect(row(unknownZone).disabled).toBe(false)
    expect(row(unknownZone).getAttribute('aria-pressed')).toBe('true')
    expect(dom.container.querySelector('[role="status"]')?.textContent).toContain('unavailable')
    const before = useAppStore.getState()
    await clickZone(unknownZone)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(workspaceZoneContext(useAppStore.getState(), display).resource).toBeNull()
  })

  it('the Worktrees management action only delegates to its consumer and hidden panels expose no rows or footer', async () => {
    const create = vi.fn(), execute = vi.spyOn(useAppStore.getState(), 'executeControl')
    await dom.render(<WorkspaceZonesPanel workspace={display} onManageWorktrees={create} footer={<span>Original scope footer</span>} />)
    const manage = dom.container.querySelector<HTMLButtonElement>('button[aria-label="Manage worktrees"]')!
    expect(manage.textContent).toBe('Worktrees')
    expect(dom.container.querySelector('[aria-label="Create worktree"]')).toBeNull()
    expect(dom.container.querySelector('.workspace-zones-panel')?.textContent).toContain('Original scope footer')
    await dom.click('button[aria-label="Manage worktrees"]')
    expect(create).toHaveBeenCalledExactlyOnceWith()
    expect(execute).not.toHaveBeenCalled()
    await dom.render(<WorkspaceZonesPanel workspace={display} onManageWorktrees={create} footer={<span>Original scope footer</span>} visible={false} />)
    expect(dom.container.querySelector('[data-zone-id]')).toBeNull()
    expect(dom.container.textContent).not.toContain('Original scope footer')
  })

  it('reuses the structural projection and does not rerender consumers on unrelated Session output', async () => {
    const rendered = vi.fn(), values: ReturnType<typeof workspaceZoneContext>[] = []
    function Consumer() { values.push(useWorkspaceZoneContext(display)); return <span>Resource consumer</span> }
    await dom.render(<><Consumer /><Profiler id="zones" onRender={rendered}>
      <WorkspaceZonesPanel workspace={display} onManageWorktrees={vi.fn()} /></Profiler></>)
    const original = workspaceZoneContext(useAppStore.getState(), display)
    const catalog = workbenchSelectionCatalog(useAppStore.getState())
    const commits = rendered.mock.calls.length, consumed = values.length, originalRow = row(firstZone)
    for (let revision = 1; revision <= 20; revision++) {
      await act(async () => useAppStore.setState({ sessions: Array.from({ length: revision }, (_, index) => ({
        ...composerSession(`unrelated-${index}`), latestOutputBytes: revision * 1024, updatedAt: revision
      })) }))
      expect(workbenchSelectionCatalog(useAppStore.getState())).toBe(catalog)
      expect(workspaceZoneContext(useAppStore.getState(), display)).toBe(original)
    }
    expect(values).toHaveLength(consumed)
    expect(rendered).toHaveBeenCalledTimes(commits)
    expect(row(firstZone)).toBe(originalRow)
    await act(async () => choose(secondZone))
    expect(values.at(-1)?.resource).toBe(second)
    expect(row(secondZone).getAttribute('aria-pressed')).toBe('true')
  })

  async function renderFiles(props: Partial<Parameters<typeof ProjectFilesTool>[0]> = {}, fileName = 'note.md') {
    vi.stubGlobal('requestAnimationFrame', raf)
    installFileTreeGeometry()
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
    vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
    vi.spyOn(api.files, 'read').mockImplementation(async (_workspaceId, path) => ({ status: 'read',
      document: { path, content: '# Original Zone file', revision: 'zone-original' } }))
    vi.spyOn(api.files, 'readDirectory').mockImplementation(async (_workspaceId, path) => [
      { name: fileName, path: path ? `${path}/${fileName}` : fileName, isDirectory: false, isSymlink: false },
      { name: 'sub', path: path ? `${path}/sub` : 'sub', isDirectory: true, isSymlink: false }
    ])
    useAppStore.setState({ explorerCollapsed: {}, fileExplorerStates: {}, documents: {}, dirtyDocuments: {},
      documentIssues: {}, documentGenerations: {}, documentObservationGenerations: {}, editorRegionModes: {},
      workspaceFileRevisions: {}, closingWorkbenchViews: {}, lastActiveFileByWorkspace: {} })
    await dom.render(<ProjectFilesTool workspace={display} visible actions={null} {...props} />)
    await act(async () => { await Promise.resolve() })
  }
  async function clickFile(path = 'note.md') {
    await dom.click(`[data-tree-path="${path}"] .tree-row__label`)
  }
  async function openDirectoryTerminal(path: string) {
    const directory = dom.container.querySelector<HTMLElement>(`[data-tree-path="${path}"]`)
    expect(directory).not.toBeNull()
    await act(async () => directory!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 })))
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === 'Open in Terminal')
    expect(item).toBeDefined()
    await act(async () => item!.click())
  }
  function nestedFilesZone() {
    const directoryPath = `${display.path}/topic`, originalSpace = directoryIdentity(display.hostId, directoryPath)
    const zoneId = homeZoneId(originalSpace)
    useAppStore.setState(state => ({ spaceZoneBindings: { ...state.spaceZoneBindings,
      [zoneId]: { spaceId: originalSpace, workspaceId: display.id, directoryPath, relations: { [spaceId]: true } } } }))
    choose(zoneId)
    return { zoneId, directoryPath }
  }

  it('the actual nested home Files tree reads Workspace-relative paths and opens through the original Zone mapping', async () => {
    const nested = nestedFilesZone()
    const execute = vi.spyOn(useAppStore.getState(), 'executeControl')
    await renderFiles()
    expect(workspaceZoneContext(useAppStore.getState(), display)).toMatchObject({ resource: null,
      files: { workspace: display, rootPath: 'topic', directoryPath: nested.directoryPath } })
    expect(api.files.readDirectory).toHaveBeenCalledWith(display.id, 'topic')
    expect(dom.container.querySelector('.workspace-tool-context--explorer > span')?.getAttribute('title')).toBe(nested.directoryPath)
    expect(dom.container.querySelector('.workspace-changes-summary')).toBeNull()
    await clickFile('topic/note.md')
    expect(execute.mock.calls[0]![0]).toEqual({ schemaVersion: 5, requestId: expect.any(String), operation: 'open.file',
      spaceId, zoneId: nested.zoneId, displayWorkspaceId: display.id, groupId: 'display-group', path: 'note.md', focus: true })
    let receipt!: Awaited<ReturnType<ReturnType<typeof useAppStore.getState>['executeControl']>>
    await act(async () => { receipt = await execute.mock.results[0]!.value })
    expect(api.files.read).toHaveBeenCalledExactlyOnceWith(display.id, 'topic/note.md')
    expect(receipt).toMatchObject({ operation: 'open.file', resource: { zoneId: nested.zoneId, path: 'topic/note.md', zonePath: nested.directoryPath }, navigation: 'applied' })
    if (receipt.operation !== 'open.file') throw new Error('The actual File receipt is missing.')
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ spaceId, zoneId: nested.zoneId,
      workspaceId: display.id, tabId: receipt.placement.tabId, regionId: receipt.placement.regionId })
  })

  it('isolates the same resource File across two Zones and uses the returned foreign Region for Diff, not the first matching path', async () => {
    choose(firstZone)
    const execute = vi.spyOn(useAppStore.getState(), 'executeControl')
    const setMode = vi.spyOn(useAppStore.getState(), 'setEditorRegionMode')
    await renderFiles()
    await clickFile()
    const original = await execute.mock.results[0]!.value
    expect(original.operation).toBe('open.file')
    if (original.operation !== 'open.file') throw new Error('The first original File receipt is missing.')
    await act(async () => useAppStore.getState().updateDocument(original.placement.tabId!, '# Unsent original document', original.placement.regionId!))
    const document = useAppStore.getState().documents[documentKey(first.id, 'note.md')]
    const originalTab = useAppStore.getState().tabs[original.placement.tabId!]
    await act(async () => choose(duplicateZone))
    await act(async () => openWorkspaceZoneFile(display, 'note.md', 'diff'))
    const opened = await execute.mock.results[1]!.value
    expect(opened).toMatchObject({ operation: 'open.file', resource: { workspaceId: first.id, zoneId: duplicateZone, path: 'note.md' }, navigation: 'applied' })
    if (opened.operation !== 'open.file') throw new Error('The second original File receipt is missing.')
    expect(opened.placement.regionId).not.toBe(original.placement.regionId)
    expect(opened.placement.tabId).not.toBe(original.placement.tabId)
    expect(setMode).toHaveBeenCalledExactlyOnceWith(opened.placement.regionId, first.id, 'note.md', 'diff')
    expect(useAppStore.getState().editorRegionModes[opened.placement.regionId!]).toBe('diff')
    expect(useAppStore.getState().editorRegionModes[original.placement.regionId!]).toBeUndefined()
    expect(useAppStore.getState().tabs[original.placement.tabId!]).toBe(originalTab)
    expect(useAppStore.getState().tabs[opened.placement.tabId!]!.space?.zoneId).toBe(duplicateZone)
    expect(useAppStore.getState().documents[documentKey(first.id, 'note.md')]).toBe(document)
    expect(useAppStore.getState().dirtyDocuments[documentKey(first.id, 'note.md')]).toBe(true)
    expect(useAppStore.getState().layouts[first.id]!.groups[0]!.tabOrder).not.toContain(opened.placement.tabId)
    expect(useAppStore.getState().layouts[display.id]!.groups[0]!.tabOrder).toContain(opened.placement.tabId)
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ spaceId, zoneId: duplicateZone,
      workspaceId: display.id, groupId: 'display-group', tabId: opened.placement.tabId, regionId: opened.placement.regionId })
  })

  it('late file data stays attached without taking later user navigation or applying a delayed Diff', async () => {
    choose(firstZone)
    await renderFiles()
    let finish!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
    vi.mocked(api.files.read).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const setMode = vi.spyOn(useAppStore.getState(), 'setEditorRegionMode')
    let pending!: Promise<void>
    await act(async () => { pending = openWorkspaceZoneFile(display, 'note.md', 'diff'); await Promise.resolve() })
    await vi.waitFor(() => expect(api.files.read).toHaveBeenCalledTimes(1))
    await act(async () => useAppStore.setState({ mainSurface: 'survey' }))
    const selected = useAppStore.getState().workbenchSpaceSelection, focus = useAppStore.getState().agentFocus
    await act(async () => { finish({ status: 'read', document: { path: 'note.md', content: 'Late original bytes', revision: 'late' } }); await pending })
    expect(useAppStore.getState().mainSurface).toBe('survey')
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(selected)
    expect(useAppStore.getState().agentFocus).toBe(focus)
    expect(useAppStore.getState().documents[documentKey(first.id, 'note.md')]?.content).toBe('Late original bytes')
    expect(setMode).not.toHaveBeenCalled()
  })

  it('a delayed original Topic discovery cannot take later user navigation before the File owner starts reading', async () => {
    choose(firstZone)
    useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [...state.config!.workspaces,
      { ...display, id: SCRATCH_WORKSPACE_ID, path: fixturePath('zones/scratch') }] } }))
    await renderFiles()
    let finish!: (topics: ScratchTopicSnapshot[]) => void
    const discover = vi.spyOn(api.scratch, 'listTopics').mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const setMode = vi.spyOn(useAppStore.getState(), 'setEditorRegionMode')
    const execute = vi.spyOn(useAppStore.getState(), 'executeControl')
    let pending!: Promise<void>
    await act(async () => { pending = openWorkspaceZoneFile(display, 'note.md', 'diff'); await Promise.resolve() })
    expect(discover).toHaveBeenCalledTimes(1)
    expect(api.files.read).not.toHaveBeenCalled()
    await act(async () => useAppStore.setState({ mainSurface: 'survey' }))
    const choice = useAppStore.getState().workbenchSpaceSelection
    await act(async () => { finish([]); await pending })
    expect(useAppStore.getState().mainSurface).toBe('survey')
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(choice)
    expect(api.files.read).toHaveBeenCalledExactlyOnceWith(first.id, 'note.md')
    expect(useAppStore.getState().documents[documentKey(first.id, 'note.md')]?.content).toBe('# Original Zone file')
    expect(await execute.mock.results[0]!.value).toMatchObject({ operation: 'open.file', navigation: 'cancelled',
      data: { kind: 'text' }, placement: { status: 'created' }, outcome: 'partial' })
    expect(setMode).not.toHaveBeenCalled()
  })

  it('names refused original File receipts rather than silently swallowing them', async () => {
    const nested = nestedFilesZone()
    await renderFiles()
    vi.mocked(api.files.read).mockResolvedValueOnce({ status: 'directory' })
    const report = vi.spyOn(useAppStore.getState(), 'reportError')
    await clickFile('topic/note.md')
    expect(report.mock.calls.some(([error]) => String(error).includes('Open Zone file topic/note.md:') && String(error).includes('WORKSPACE_PATH_IS_DIRECTORY'))).toBe(true)
    expect(useAppStore.getState().workbenchSpaceSelection?.zoneId).toBe(nested.zoneId)
  })

  it('opens a nested Terminal through the exact Zone Launcher and directory without stealing later navigation on its reply', async () => {
    const nested = nestedFilesZone()
    await renderFiles()
    let finish!: (value: SessionSnapshot) => void
    const native = vi.spyOn(api.sessions, 'launchTerminal').mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const launcher = vi.spyOn(useAppStore.getState(), 'openLauncher'), launch = vi.spyOn(useAppStore.getState(), 'launchTerminal')
    await openDirectoryTerminal('topic/sub')
    expect(launcher).toHaveBeenCalledExactlyOnceWith({ workspaceId: display.id, displayWorkspaceId: display.id,
      tabGroupId: 'display-group', zoneId: nested.zoneId, reveal: true })
    expect(native).toHaveBeenCalledExactlyOnceWith({ hostId: display.hostId, workspacePath: `${nested.directoryPath}/sub`, createOperationId: expect.any(String) })
    const target = launch.mock.calls[0]![1]!
    expect(useAppStore.getState().tabs[target.tabId]!.space?.zoneId).toBe(nested.zoneId)
    await act(async () => useAppStore.setState({ mainSurface: 'survey' }))
    const choice = useAppStore.getState().workbenchSpaceSelection
    const terminal: SessionSnapshot = { id: 'zone-terminal', kind: 'terminal', providerId: null, hostId: display.hostId,
      workspacePath: `${nested.directoryPath}/sub`, label: 'Zone terminal', createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1), latestOutputBytes: 0,
      processState: 'running', status: { state: 'running', source: 'run-process', observedAt: _historyFixtureEpoch(0, 0, 1) },
      control: { kind: 'terminal', hostId: display.hostId, runId: 'zone-terminal-run', run: { runId: 'zone-terminal-run' } } }
    await act(async () => { finish(terminal); await launch.mock.results[0]!.value })
    expect(useAppStore.getState().mainSurface).toBe('survey')
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(choice)
    expect(useAppStore.getState().tabs[target.tabId]!.regions[target.regionId]).toMatchObject({ kind: 'terminal', sessionId: terminal.id })
  })

  it('preserves explicit parent file and terminal consumers with their Workspace-relative path intent', async () => {
    nestedFilesZone()
    const open = vi.fn(async () => {}), terminal = vi.fn(async () => {})
    const execute = vi.spyOn(useAppStore.getState(), 'executeControl'), launcher = vi.spyOn(useAppStore.getState(), 'openLauncher')
    await renderFiles({ onOpenPath: open, onOpenTerminal: terminal })
    await clickFile('topic/note.md')
    await openDirectoryTerminal('topic/sub')
    expect(open).toHaveBeenCalledExactlyOnceWith('topic/note.md')
    expect(terminal).toHaveBeenCalledExactlyOnceWith('topic/sub')
    expect(execute).not.toHaveBeenCalled()
    expect(launcher).not.toHaveBeenCalled()
  })

  it('launches a cross-resource directory Terminal in its original Zone and foreign display, not the active display Workspace root', async () => {
    choose(firstZone)
    await renderFiles()
    const terminal: SessionSnapshot = { id: 'foreign-zone-terminal', kind: 'terminal', providerId: null, hostId: first.hostId,
      workspacePath: `${first.path}/sub`, label: 'Foreign Zone terminal', createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1), latestOutputBytes: 0,
      processState: 'running', status: { state: 'running', source: 'run-process', observedAt: _historyFixtureEpoch(0, 0, 1) },
      control: { kind: 'terminal', hostId: first.hostId, runId: 'foreign-terminal-run', run: { runId: 'foreign-terminal-run' } } }
    const native = vi.spyOn(api.sessions, 'launchTerminal').mockResolvedValueOnce(terminal)
    const launch = vi.spyOn(useAppStore.getState(), 'launchTerminal')
    await openDirectoryTerminal('sub')
    await act(async () => { await launch.mock.results[0]!.value })
    expect(native.mock.calls[0]![0]).toMatchObject({ hostId: first.hostId, workspacePath: `${first.path}/sub` })
    const target = launch.mock.calls[0]![1]!, tab = useAppStore.getState().tabs[target.tabId]!
    expect(tab.workspaceId).toBe(first.id)
    expect(tab.space?.zoneId).toBe(firstZone)
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ spaceId, zoneId: firstZone,
      workspaceId: display.id, groupId: 'display-group', tabId: target.tabId, regionId: target.regionId })
    expect(useAppStore.getState().layouts[display.id]!.groups[0]!.tabOrder).toContain(target.tabId)
    expect(useAppStore.getState().layouts[first.id]!.groups[0]!.tabOrder).not.toContain(target.tabId)
  })

  it('retains a truly out-of-resource Zone without inventing Files or Git scopes', () => {
    const outsideZone = 'confirmed-outside-directory-zone'
    useAppStore.setState(state => ({ spaceZoneBindings: { ...state.spaceZoneBindings,
      [outsideZone]: { spaceId, workspaceId: display.id, directoryPath: fixturePath('zones/unrelated') } } }))
    choose(outsideZone)
    expect(workspaceZoneContext(useAppStore.getState(), display)).toMatchObject({ selectedZoneId: outsideZone, files: null, resource: null })
    expect(workspaceZoneContext(useAppStore.getState(), display).issue).toContain('outside the original Files scope')
    expect(useAppStore.getState().sessions[0]?.id).toBe('agent-1')
  })

  it('rejects out-of-scope Workspace paths and unknown resources without reading or creating a Terminal elsewhere', async () => {
    nestedFilesZone()
    const execute = vi.spyOn(useAppStore.getState(), 'executeControl'), launcher = vi.spyOn(useAppStore.getState(), 'openLauncher')
    const report = vi.spyOn(useAppStore.getState(), 'reportError')
    await openWorkspaceZoneFile(display, 'topic-sibling/note.md')
    await openWorkspaceZoneTerminal(display, '../elsewhere')
    choose(unknownZone)
    await openWorkspaceZoneFile(display, 'note.md', 'diff')
    expect(execute).not.toHaveBeenCalled()
    expect(launcher).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledTimes(3)
    expect(String(report.mock.calls[0]![0])).toContain('Open Zone file topic-sibling/note.md:')
    expect(String(report.mock.calls[1]![0])).toContain('Open Zone terminal ../elsewhere:')
  })

  it.each(['url', 'webloc'])('preserves default .%s Browser opening through the original owner while Diff and public open.file keep source intent', async extension => {
    choose(firstZone)
    const path = `link.${extension}`, publicPath = `public-source.${extension}`
    await renderFiles({}, path)
    const bookmark = vi.spyOn(api.files, 'readBookmark').mockResolvedValue({ url: 'https://bookmark.example.invalid/original', binary: extension === 'webloc' })
    const browser = vi.spyOn(api.browser, 'create'), execute = vi.spyOn(useAppStore.getState(), 'executeControl')
    const open = vi.spyOn(useAppStore.getState(), 'openFile'), setMode = vi.spyOn(useAppStore.getState(), 'setEditorRegionMode')
    await clickFile(path)
    let opened!: Awaited<ReturnType<ReturnType<typeof useAppStore.getState>['executeControl']>>
    await act(async () => { opened = await execute.mock.results[0]!.value })
    if (opened.operation !== 'open.file') throw new Error('The original bookmark open receipt is missing.')
    expect(execute.mock.calls[0]![2]).toEqual({ fileOpenIntent: 'default', fileInputPolicy: 'target' })
    expect(open.mock.calls[0]![4]).toBe(false)
    expect(open.mock.calls[0]![5]?.fileOnly).toBe(false)
    expect(bookmark).toHaveBeenCalledExactlyOnceWith(first.id, path)
    expect(browser).toHaveBeenCalledExactlyOnceWith(opened.placement.regionId, 'https://bookmark.example.invalid/original', first.id, undefined, undefined)
    expect(api.files.read).not.toHaveBeenCalled()
    expect(useAppStore.getState().documents[documentKey(first.id, path)]).toBeUndefined()
    expect(opened.navigation).toBe('applied')
    expect(opened.placement.status).toBe('created')
    expect(opened.outcome).not.toBe('refused')
    expect(opened.issues.some(issue => issue.code === 'WORKSPACE_PATH_IS_DIRECTORY')).toBe(false)
    const browserTab = useAppStore.getState().tabs[opened.placement.tabId!]
    expect(browserTab?.space?.zoneId).toBe(firstZone)
    expect(browserTab?.regions[opened.placement.regionId!]).toMatchObject({ kind: 'browser', workspaceId: first.id,
      bookmarkOrigin: { path, binary: extension === 'webloc' } })
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ spaceId, zoneId: firstZone,
      workspaceId: display.id, groupId: 'display-group', tabId: opened.placement.tabId, regionId: opened.placement.regionId })
    await act(async () => openWorkspaceZoneFile(display, path, 'diff'))
    const source = await execute.mock.results[1]!.value
    if (source.operation !== 'open.file') throw new Error('The original source open receipt is missing.')
    expect(execute.mock.calls[1]![2]).toEqual({ fileOpenIntent: 'source', fileInputPolicy: 'target' })
    expect(open.mock.calls[1]![4]).toBe(true)
    expect(open.mock.calls[1]![5]?.fileOnly).toBe(true)
    expect(setMode).toHaveBeenCalledExactlyOnceWith(source.placement.regionId, first.id, path, 'diff')
    expect(useAppStore.getState().tabs[opened.placement.tabId!]).toBe(browserTab)
    expect(useAppStore.getState().documents[documentKey(first.id, path)]).toBeDefined()
    await act(async () => {
      await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: crypto.randomUUID(), operation: 'open.file',
        spaceId, zoneId: firstZone, path: publicPath, displayWorkspaceId: display.id, groupId: 'display-group', focus: false })
    })
    expect(open.mock.calls[2]![4]).toBe(true)
    expect(open.mock.calls[2]![5]?.fileOnly).toBe(true)
    expect(api.files.read).toHaveBeenCalledWith(first.id, publicPath)
    expect(useAppStore.getState().documents[documentKey(first.id, publicPath)]).toBeDefined()
    expect(bookmark).toHaveBeenCalledTimes(1)
    expect(browser).toHaveBeenCalledTimes(1)
  })
})
