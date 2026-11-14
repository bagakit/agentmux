// @vitest-environment happy-dom
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-original-terminal /> }))
import { SourceAgentTargetSetup } from '../src/renderer/src/components/SourceAgentTargetSetup'
import { LauncherAgentDevice } from '../src/renderer/src/components/LauncherAgentDevice'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { useAppStore, type LauncherExecutionSelection } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { spaceMountFixture } from './helpers/space-mount-fixture'
import { createHostRouteInventoryFixture } from '../../../packages/core/test/helpers/host-route-inventory-fixture'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import type { SpaceMountMethods } from '../src/shared/space-mount'
import type { AgentMuxHostExecutorInventory } from '@agentmux/core/executor-contract'
import { sourceCoordinatorInputs } from '../src/renderer/src/lib/source-coordinator-input'

const dom = composerDOM(), cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)!
const tick = async () => { await act(async () => {}) }

it('a planned foreign Agent keeps its identity separate from the project and never borrows a viewer same-name Host or invents a connected route', async () => {
  const project = { ...composerConfig.workspaces[0]!, name: 'Original project' }
  const hosts = [...composerConfig.hosts, { id: 'foreign-alias', kind: 'ssh' as const, label: 'WRONG VIEWER HOST', hostname: 'wrong.invalid' }]
  await dom.render(<LauncherAgentDevice hosts={hosts} workspace={project} agentWorkspace={undefined} explicitAgentWorkspaceId={undefined} disabled={false} active
    sourceExecution={{ project, target: { hostId: project.hostId, reference: { runtimeId: 'project-runtime', spaceId: 'original-space' }, workspaceId: project.id, zoneId: 'zone' },
      agentTarget: { hostId: 'foreign-alias', runtimeId: 'agent-runtime' } }} onSelect={() => true} onPreparingChange={() => {}} />)
  const trigger = dom.container.querySelector<HTMLButtonElement>('[aria-label="Agent location"]')!
  expect(trigger.querySelector('[data-execution-relation]')?.getAttribute('data-execution-relation')).toBe('unconfirmed')
  await act(async () => trigger.focus())
  await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')).not.toBeNull())
  const detail = document.querySelector('[role="tooltip"]')!
  expect(detail.textContent).toContain('Next launch arrangement')
  expect(detail.querySelectorAll('.agent-work-detail__end strong')[1]?.textContent).toBe('foreign-alias')
  expect(detail.textContent).not.toContain('WRONG VIEWER HOST')
  expect(detail.textContent).not.toContain('project device’s selection')
  expect(detail.textContent).toContain('Resolved by the project device at launch')
  expect(detail.textContent).toContain('Execution path unconfirmed')
  expect(detail.textContent).toContain('project-runtime'); expect(detail.textContent).toContain('agent-runtime')
})
async function choose(value: string) {
  await act(async () => dom.container.querySelector('[aria-label="Agent runs on"]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })))
  const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.dataset.value === value)!
  expect(option).toBeDefined(); await act(async () => option.click())
}

it('the same-runtime Source arrangement keeps the already confirmed project startup directory', async () => {
  const project = composerConfig.workspaces[0]!
  await dom.render(<LauncherAgentDevice hosts={composerConfig.hosts} workspace={project} agentWorkspace={undefined} explicitAgentWorkspaceId={undefined} disabled={false} active
    sourceExecution={{ project, target: { hostId: project.hostId, reference: { runtimeId: 'same-runtime', spaceId: 'space' }, workspaceId: project.id, zoneId: 'zone' },
      agentTarget: { hostId: 'local', runtimeId: 'same-runtime' } }} onSelect={() => true} onPreparingChange={() => {}} />)
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Agent location"]')!.focus())
  await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')).not.toBeNull())
  const agent = document.querySelectorAll('.agent-work-detail__end')[1]!
  expect(agent.querySelector('code')?.textContent).toBe(project.path)
  expect(agent.textContent).not.toContain('Resolved by')
})
async function fixture() {
  const f = await spaceMountFixture(cleanup), b = f.cores[1]!, a = f.cores[0]!
  const project = { id: 'original-project-in-A', hostId: b.id, path: b.workspace.path, name: 'Original project', kind: 'folder' as const }
  const config = { ...composerConfig, hosts: [...composerConfig.hosts, { id: b.id, kind: 'ssh' as const, label: 'Original B', hostname: 'private.invalid' }], workspaces: [project] }
  useAppStore.setState({ config, sessions: [], activeWorkspaceId: project.id, mountedSpaceInputs: {}, prewarmTerminal: vi.fn(), detectExecutors: vi.fn() })
  const coordinator = vi.spyOn(api.sessions, 'executionCoordinatorTarget').mockResolvedValue({ hostId: 'local', runtimeId: a.identity.runtimeId })
  const home = vi.spyOn(api.hosts, 'home').mockResolvedValue({ routeHostId: 'local', homeDirectory: '/original/A/home' })
  const inventory: AgentMuxHostExecutorInventory = { runtimeId: a.identity.runtimeId, executors: [{ executorId: 'original-A-executor', configRevision: 'A-original-revision',
    label: 'A executor', providerId: 'codex', command: 'private-executor', source: 'registered', availability: 'unknown', creationContract: { ordinaryLaunch: 1 },
    launchOptions: [{ id: 'model', label: 'Model', choices: [{ id: 'original-A-model', label: 'A original model' }] }] }] }
  const calls: Array<{ method: keyof SpaceMountMethods; input: unknown }> = []
  vi.spyOn(api.spaceMounts, 'call').mockImplementation(async <M extends keyof SpaceMountMethods>(method: M, input: SpaceMountMethods[M]['input'], signal?: AbortSignal): Promise<SpaceMountMethods[M]['result']> => {
    calls.push({ method, input })
    if (method === 'executors') return inventory as SpaceMountMethods[M]['result']
    if (method === 'describe') return { source: { runtimeId: b.identity.runtimeId, ownerInstanceId: b.identity.ownerInstanceId },
      contracts: { ordinaryLaunch: { revision: 1, destination: 'source-zone-background' }, externalAssociation: 1 } } as SpaceMountMethods[M]['result']
    return await f.api.call(method, input, signal)
  })
  return { ...f, a, b, config, project, coordinator, home, calls, inventory }
}

it('the default Source presentation keeps its expanded project card and footer Refresh for shared consumers', async () => {
  const f = await fixture(), selected = vi.fn()
  await initializeSpatialControlFixture()
  await dom.render(<SourceAgentTargetSetup config={f.config} active fixedResourceWorkspaceId={f.project.id} actionLabel="Apply" onApply={selected} />)
  await vi.waitFor(async () => { await tick(); expect(button('Apply').disabled).toBe(false) })
  const setup = dom.container.querySelector<HTMLElement>('.agent-work-setup')!
  expect(setup.dataset.presentation).toBeUndefined()
  expect(setup.querySelector('.agent-work-project-anchor')?.tagName).toBe('DIV')
  expect(setup.querySelector('.agent-work-project-anchor')?.textContent).toContain(f.project.path)
  expect(button('Refresh').closest('.agent-work-setup__actions')).not.toBeNull()
  expect(setup.querySelector('[aria-label="Refresh Agent device choices"]')).toBeNull()
  const summary = [...setup.querySelectorAll('summary')].find(item => item.textContent === 'Launch compatibility')!
  await act(async () => summary.click())
  expect(summary.matches('.agent-work-setup__body > details > summary')).toBe(true)
  expect(readFileSync(resolve('apps/desktop/src/renderer/src/components/agent-work-mode.css'), 'utf8')).toContain('.agent-work-setup__body > details > summary')
})

it('Reach recovery follows externalAssociation rather than ordinaryLaunch', async () => {
  const f = await fixture(), selected = vi.fn(), openHost = vi.fn()
  await initializeSpatialControlFixture()
  const sourceCalls = api.spaceMounts.call.bind(api.spaceMounts)
  vi.spyOn(api.spaceMounts, 'call').mockImplementation((method, input, signal) => method === 'describe'
    ? Promise.resolve({ source: { runtimeId: f.b.identity.runtimeId, ownerInstanceId: f.b.identity.ownerInstanceId }, contracts: { ordinaryLaunch: { revision: 1, destination: 'source-zone-background' }, externalAssociation: null } }) as never
    : sourceCalls(method, input, signal))
  await dom.render(<SourceAgentTargetSetup config={f.config} active fixedResourceWorkspaceId={f.project.id} actionLabel="Apply" presentation="anchored-editor" onChooseCustom={() => {}} onOpenHost={openHost} onApply={selected} />)
  await choose('independent-coordinator')
  await vi.waitFor(async () => { await tick(); expect(dom.container.textContent).toContain('Update AgentMux Core') })
  const recovery = button(`Open ${f.config.hosts.find(host => host.id === f.b.id)!.label} to update Core`)
  expect(recovery).not.toBeUndefined()
  expect(recovery.closest('.agent-work-startup')).toBeNull()
})

it('a healthy Reach does not inherit an ordinaryLaunch Core update requirement', async () => {
  const f = await fixture(), selected = vi.fn(), openHost = vi.fn()
  await initializeSpatialControlFixture()
  const sourceCalls = api.spaceMounts.call.bind(api.spaceMounts)
  vi.spyOn(api.spaceMounts, 'call').mockImplementation((method, input, signal) => method === 'describe'
    ? Promise.resolve({ source: { runtimeId: f.b.identity.runtimeId, ownerInstanceId: f.b.identity.ownerInstanceId }, contracts: { ordinaryLaunch: null, externalAssociation: 1 } }) as never
    : sourceCalls(method, input, signal))
  await dom.render(<SourceAgentTargetSetup config={f.config} active fixedResourceWorkspaceId={f.project.id} actionLabel="Apply" presentation="anchored-editor" onChooseCustom={() => {}} onOpenHost={openHost} onApply={selected} />)
  await choose('independent-coordinator')
  await vi.waitFor(async () => { await tick(); expect(button('Apply').disabled).toBe(false) })
  expect(dom.container.textContent).not.toContain('Update AgentMux Core')
  expect(button('Project device settings').closest('.agent-work-startup')).not.toBeNull()
})

it('a pending A identity read cannot block B project-device preparation after the explicit choice returns to B', async () => {
  const f = await fixture(), selected = vi.fn(), never = new Promise<never>(() => {})
  await initializeSpatialControlFixture()
  f.coordinator.mockReturnValue(never)
  await dom.render(<SourceAgentTargetSetup config={f.config} active fixedResourceWorkspaceId={f.project.id} actionLabel="Apply" onApply={selected} />)
  await vi.waitFor(async () => { await tick(); expect(button('Apply').disabled).toBe(false) })
  expect(f.coordinator).not.toHaveBeenCalled()
  await choose('independent-coordinator'); await vi.waitFor(() => expect(f.coordinator).toHaveBeenCalledOnce())
  expect(button('Apply').disabled).toBe(true)
  await choose(JSON.stringify(['host', 'local']))
  expect(button('Apply').disabled).toBe(false)
  await act(async () => button('Apply').click())
  await vi.waitFor(() => expect(selected, dom.container.textContent ?? '').toHaveBeenCalledOnce())
  expect(selected.mock.calls[0]![0].source).toMatchObject({ agentTarget: { hostId: 'local', runtimeId: f.b.identity.runtimeId } })
  await vi.waitFor(async () => { await tick(); expect(f.calls.some(item => item.method === 'hostChoices')).toBe(true) })
  await choose(JSON.stringify(['host', f.b.id + '-original-remote']))
  await act(async () => button('Apply').click())
  await vi.waitFor(() => expect(selected).toHaveBeenCalledTimes(2))
  expect(selected.mock.calls[1]![0].source).toMatchObject({ agentTarget: { hostId: f.b.id + '-original-remote', runtimeId: f.b.id + '-remote-runtime' } })
  expect(f.home).not.toHaveBeenCalled(); expect(f.calls.some(item => item.method === 'open')).toBe(false)
})

it('Reach preparation uses the original A owner and home without registering an A workspace; the real Launcher dispatches the complete frozen C', async () => {
  const f = await fixture(), selected = vi.fn<(selection: LauncherExecutionSelection) => void>()
  await initializeSpatialControlFixture()
  await dom.render(<SourceAgentTargetSetup config={f.config} active fixedResourceWorkspaceId={f.project.id} actionLabel="Apply" onApply={selected} />)
  await vi.waitFor(async () => { await tick(); expect(button('Apply').disabled).toBe(false) })
  await choose('independent-coordinator')
  await vi.waitFor(async () => { await tick(); expect(button('Apply').disabled).toBe(false) })
  await act(async () => button('Apply').click()); await vi.waitFor(() => expect(selected).toHaveBeenCalledOnce())
  const source = selected.mock.calls[0]![0].source!
  expect(source).toMatchObject({ kind: 'source-coordinator', coordinator: { hostId: 'local', runtimeId: f.a.identity.runtimeId, homeDirectory: '/original/A/home' },
    target: { hostId: f.b.id, reference: { runtimeId: f.b.identity.runtimeId } } })
  expect('agentTarget' in source).toBe(false); expect(useAppStore.getState().config!.workspaces).toEqual([f.project])
  const tab = createWorkbenchTab('original-tab', { kind: 'launcher', regionId: 'original-region', workspaceId: f.project.id })
  useAppStore.setState({ tabs: { [tab.id]: tab }, layouts: { [f.project.id]: createWorkspaceLayout('group', [tab.id]) }, pendingAgentLaunches: {},
    agentComposerDrafts: { 'original-region': ' Original full task\n' }, launcherNameDrafts: { 'original-region': { agentName: 'Original Agent', tabName: 'Original Tab' } },
    launcherOptionDrafts: { 'original-region': { codex: { model: 'original-A-model' } } }, agentComposerNotes: { 'original-region': ' Separate note\n' } })
  useLauncherState.setState({ drafts: { 'region:original-region': { browser: '', note: '', sourceExecution: source } }, sections: {}, executors: {} })
  const sourceCalls = api.spaceMounts.call.bind(api.spaceMounts)
  vi.spyOn(api.spaceMounts, 'call').mockImplementation((method, input, signal) => {
    if (method === 'describe') return Promise.reject(Error('Only the optional Source contract read was denied'))
    return sourceCalls(method, input, signal)
  })
  const launch = vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(Error('Original Coordinator observation is unknown'))
  await dom.render(<NewTabSurface tabGroupId="group" tabId={tab.id} regionId="original-region" />)
  await vi.waitFor(async () => { await tick(); expect(button('Launch').disabled).toBe(false) })
  expect(dom.container.textContent).toContain('Only the optional Source contract read was denied')
  expect(f.calls.filter(item => item.method === 'executors').map(item => item.input)).toEqual([
    { hostId: 'local', expectedRuntimeId: f.a.identity.runtimeId, agentHostId: 'local' },
    { hostId: 'local', expectedRuntimeId: f.a.identity.runtimeId, agentHostId: 'local', executorId: 'original-A-executor' } ])
  await act(async () => button('Launch').click()); await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce())
  const input = launch.mock.calls[0]![0]
  expect(input).toMatchObject({ hostId: 'local', workspacePath: '/original/A/home', executorId: 'original-A-executor', executorRevision: 'A-original-revision',
    toolWorkspace: { id: f.project.id, hostId: f.b.id, path: f.project.path }, sourceCoordinator: { runtimeId: f.a.identity.runtimeId, resourceRuntimeId: f.b.identity.runtimeId },
    prompt: ' Original full task\n', launchOptions: { model: 'original-A-model' }, agentMuxNote: ' Separate note\n' })
  expect(sourceCoordinatorInputs(useAppStore.getState().mountedSpaceInputs, { launcherId: 'region:original-region' }).inputs[0]).toMatchObject({ request: input, submitted: true,
    origin: { names: { agentName: 'Original Agent', tabName: 'Original Tab' } }, association: { submitted: false } })
  expect(f.calls.some(item => item.method === 'open')).toBe(false)
})

it('the Source trigger names the selected device and keyboard hover reads the original entire B route without borrowing an A same-name Host', async () => {
  const f = await createHostRouteInventoryFixture(cleanup as Array<() => Promise<void>>), project = { id: 'project', hostId: 'B-in-A', name: 'B project', path: '/original/B/project', kind: 'folder' as const }
  const hosts = [...composerConfig.hosts, { id: project.hostId, kind: 'ssh' as const, label: 'Original project B', hostname: 'b.invalid' },
    { id: 'collision', kind: 'ssh' as const, label: 'WRONG_A_DIRECTORY_LABEL', hostname: 'a-other.invalid' }]
  await dom.render(<LauncherAgentDevice hosts={hosts} workspace={project} agentWorkspace={undefined} explicitAgentWorkspaceId={undefined} disabled={false} active
    sourceExecution={{ project, target: { hostId: project.hostId, reference: { runtimeId: f.b.identity.runtimeId, spaceId: 'original-space' }, workspaceId: 'workspace', zoneId: 'zone' },
      agentTarget: { hostId: 'collision', runtimeId: f.d.identity.runtimeId, adoptedRoute: f.route } }} onSelect={() => true} onPreparingChange={() => {}} />)
  const trigger = dom.container.querySelector<HTMLButtonElement>('[aria-label="Agent location"]')!
  expect(trigger.querySelector('.launcher-work-arrangement__name')?.textContent).toBe('collision')
  expect(trigger.textContent).not.toContain('WRONG_A_DIRECTORY_LABEL')
  expect(trigger.querySelectorAll('[data-execution-role]')).toHaveLength(2)
  await act(async () => trigger.focus())
  await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')).not.toBeNull())
  const detail = document.querySelector('[role="tooltip"]')!.textContent!
  expect(detail).toContain('Run mode'); expect(detail).toContain('Original project B'); expect(detail).not.toContain('WRONG_A_DIRECTORY_LABEL')
  for (const identity of [f.route.source, ...f.route.hops.map(hop => hop.target)]) expect(detail).toContain(identity.runtimeId)
})
