// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-original-warm-terminal /> }))
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { SourceAgentTargetSetup } from '../src/renderer/src/components/SourceAgentTargetSetup'
import { RemoteExecutionSettingsPane } from '../src/renderer/src/components/settings/RemoteExecutionSettingsPane'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { useAppStore } from '../src/renderer/src/store'
import * as storeModule from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { mountedAgentOpenInput, mountedAgentOpenKey } from '../src/renderer/src/lib/space-mount-launch'
import { api } from '../src/renderer/src/lib/api'
import { spaceMountFixture, spaceMountTransport } from './helpers/space-mount-fixture'
import { createHostRouteInventoryFixture } from '../../../packages/core/test/helpers/host-route-inventory-fixture'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import type { AgentMuxRpcMethod, AgentMuxRpcParams, AgentMuxRpcResult } from '@agentmux/core'
import type { AgentMuxHostedForwardRpc } from '../../../packages/core/src/hosted-client-contract'
import type { LauncherSourceExecution } from '../src/renderer/src/lib/launcher-source'
import type { SpaceMountMethods } from '../src/shared/space-mount'

const dom = composerDOM(), cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const project = { id: 'original-A-project', hostId: 'source-B', name: 'Original project', path: '/original/project', kind: 'folder' as const }
const sourceHost = { id: 'source-B', kind: 'ssh' as const, label: 'Project device B', hostname: 'private-original.invalid' }
const button = (label: string) => [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === label)!

it('Remote preparation hands the original confirmed Source selection to its real Launcher draft without creating an Agent', async () => {
  const f = await spaceMountFixture(cleanup), b = f.cores[1]!, closed = vi.fn(), calls: string[] = []
  const config = { ...composerConfig, hosts: [...composerConfig.hosts, { ...sourceHost, id: b.id }], workspaces: [{ ...project, hostId: b.id }] }
  const tab = createWorkbenchTab('prepared-tab', { kind: 'launcher', regionId: 'prepared-slot', workspaceId: project.id })
  // This original local Launcher metadata port opens a retained tab; all Source
  // reads/registration below cross the actual trusted Main and original B owner.
  const openLauncher = vi.fn().mockReturnValue(tab.id)
  useAppStore.setState({ config, sessions: [], agentNames: {}, activeWorkspaceId: project.id, mountedSpaceInputs: {}, tabs: { [tab.id]: tab }, openLauncher })
  useLauncherState.setState({ drafts: { 'region:prepared-slot': { browser: 'Retained browser draft', note: 'Retained note draft' } }, sections: {}, executors: {} })
  vi.spyOn(api.spaceMounts, 'call').mockImplementation((method, input, signal) => { calls.push(method); return f.api.call(method, input, signal) })
  vi.spyOn(storeModule, 'checkpointMountedSpaceInputs').mockResolvedValue(undefined)
  await dom.render(<RemoteExecutionSettingsPane config={config} active onClose={closed} onNavigate={vi.fn()} />)
  const prepareTab = dom.container.querySelector<HTMLButtonElement>('[role="tab"][id$="-start-tab"]')!
  expect(prepareTab.closest('[hidden],[inert]')).toBeNull()
  await act(async () => prepareTab.click())
  await vi.waitFor(async () => { await act(async () => {}); expect(button('Open in Launcher').disabled).toBe(false) })
  await act(async () => button('Open in Launcher').click())
  await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce())
  expect(openLauncher).toHaveBeenCalledOnce()
  const selection = openLauncher.mock.calls[0]![0]
  expect(selection).toMatchObject({ workspaceId: project.id, reveal: true, initialExecution: { source: { target: { hostId: b.id, reference: { runtimeId: b.identity.runtimeId } }, agentTarget: { hostId: 'local', runtimeId: b.identity.runtimeId } } } })
  expect(useLauncherState.getState().drafts['region:prepared-slot']).toEqual({ browser: 'Retained browser draft', note: 'Retained note draft', sourceExecution: selection.initialExecution.source })
  expect(calls.filter(method => method === 'register')).toHaveLength(1); expect(calls).not.toContain('open')
  expect((await b.store.read())?.graph.regions).toHaveLength(0)
})

it('explicit ordinary preparation reads the original Source catalogue and registers only its exact project through actual Main without starting an Agent', async () => {
  const f = await spaceMountFixture(cleanup), b = f.cores[1]!, selected = vi.fn()
  let releaseChoices!: () => void
  b.hostChoiceReads.wait = new Promise<void>(resolve => { releaseChoices = resolve })
  try {
  const config = { ...composerConfig, hosts: [composerConfig.hosts[0]!, { ...sourceHost, id: b.id }], workspaces: [{ ...project, hostId: b.id }] }
  useAppStore.setState({ config, mountedSpaceInputs: {} })
  const calls: string[] = []
  vi.spyOn(api.spaceMounts, 'call').mockImplementation(async (method, input, signal) => { calls.push(method); return await f.api.call(method, input, signal) })
  const checkpoint = vi.spyOn(storeModule, 'checkpointMountedSpaceInputs').mockResolvedValue(undefined)
  await dom.render(<SourceAgentTargetSetup config={config} fixedResourceWorkspaceId={project.id} active actionLabel="Apply" onApply={selected} />)
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain('Update AgentMux Core') })
  await vi.waitFor(async () => { await act(async () => {}); expect(button('Apply').disabled).toBe(false) })
  expect(calls).not.toContain('register'); expect(await b.store.read()).toBeNull()
  await act(async () => button('Apply').click())
  await vi.waitFor(() => expect(selected).toHaveBeenCalledOnce())
  expect(selected.mock.calls[0]![0]).toMatchObject({ resourceWorkspaceId: project.id, agentWorkspaceId: null,
    source: { target: { hostId: b.id, reference: { runtimeId: b.identity.runtimeId } }, agentTarget: { hostId: 'local', runtimeId: b.identity.runtimeId } } })
  expect(checkpoint).toHaveBeenCalledOnce(); expect(calls.filter(method => method === 'register')).toHaveLength(1)
  expect(calls).not.toContain('open'); expect((await b.store.read())?.graph.regions).toHaveLength(0)
  expect(await f.cores[0]!.store.read()).toBeNull()
  expect(b.hostChoiceReads.calls).toBe(1)
  } finally { releaseChoices() }
})

async function routedLauncher(catalogue?: Promise<void>) {
  const route = await createHostRouteInventoryFixture(cleanup as Array<() => Promise<void>>)
  const source: LauncherSourceExecution = { project: { id: project.id, hostId: project.hostId, path: project.path },
    target: { hostId: project.hostId, reference: { runtimeId: route.b.identity.runtimeId, spaceId: 'original-space-B' }, workspaceId: 'B-project', zoneId: 'B-zone' },
    agentTarget: { hostId: 'collision', runtimeId: route.d.identity.runtimeId, adoptedRoute: route.route }, executorId: 'same-executor' }
  let supported = true
  let inspected: SpaceMountMethods['open']['result'] | undefined
  const opens: SpaceMountMethods['open']['input']['request'][] = [], methods: Array<{ method: string; params: unknown }> = []
  async function dispatch(method: AgentMuxRpcMethod, params: AgentMuxRpcParams<AgentMuxRpcMethod>, context?: Parameters<AgentMuxHostedForwardRpc>[2]): Promise<AgentMuxRpcResult<AgentMuxRpcMethod>> {
    methods.push({ method, params })
    // Only original Source identity/describe and final creation are controlled leaves.
    // D Provider options and selected inventory cross the real signed four-Core route.
    if (method === 'runtime.owner.identity') return { owner: { runtimeId: route.b.identity.runtimeId, ownerInstanceId: 'B-original-instance', protocolVersion: 2, processId: process.pid, ctxmux: null, availability: 'connected' } }
    if (method === 'agent.open.describe') return { source: { runtimeId: route.b.identity.runtimeId, ownerInstanceId: 'B-original-instance' }, contracts: { ordinaryLaunch: supported ? { revision: 1, destination: 'source-zone-background' } : null, externalAssociation: null } }
    if (method === 'agent.open') {
      const request = params as AgentMuxRpcParams<'agent.open'>; if (!request.operationId) throw Error('The original request must carry its operation.'); opens.push(request)
      return { operationId: request.operationId, outcome: 'unknown', from: null, to: null, agent: null, resource: null,
        save: { layoutApplied: false, clientStateWritten: false, storageFlushRequested: false, diskDurability: 'unconfirmed', reason: null }, issues: [] }
    }
    if (method === 'space.inspect') { const input = params as AgentMuxRpcParams<'space.inspect'>; if (!('operationId' in input.target)) throw Error('Only the original operation is inspected.'); return { request: inspected ? { known: true, requestId: input.target.operationId, report: inspected } : { known: false, requestId: input.target.operationId } } }
    if (method === 'route.executors' && !(params as AgentMuxRpcParams<'route.executors'>).executorId) await catalogue
    return await route.rpc.call(method, params, context)
  }
  const forwardRpc: AgentMuxHostedForwardRpc = async <M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>, context?: Parameters<AgentMuxHostedForwardRpc>[2]) => await dispatch(method, params, context) as AgentMuxRpcResult<M>
  const transport = spaceMountTransport(cleanup, [{ id: project.hostId, carrier: { forwardRpc, subscribeRpc: route.rpc.subscribe.bind(route.rpc) } }])
  vi.spyOn(api.spaceMounts, 'call').mockImplementation((method, input, signal) => transport.api.call(method, input, signal))
  const checkpoint = vi.spyOn(storeModule, 'checkpointMountedSpaceInputs').mockResolvedValue(undefined)
  const localLaunch = vi.fn(), detect = vi.fn(), tab = createWorkbenchTab('original-tab', { kind: 'launcher', regionId: 'original-slot', workspaceId: project.id })
  useAppStore.setState({ config: { ...composerConfig, hosts: [...composerConfig.hosts, sourceHost], workspaces: [project] }, tabs: { [tab.id]: tab },
    layouts: { [project.id]: createWorkspaceLayout('group', [tab.id]) }, activeWorkspaceId: project.id, workbenchSpaceSelection: null, mountedSpaceInputs: {},
    agentComposerDrafts: { 'original-slot': '  original task\n' }, launcherNameDrafts: { 'original-slot': { agentName: 'Agent name', tabName: 'Tab name' } },
    launcherOptionDrafts: { 'original-slot': { claude: { 'original-unknown-option': 'retain-exact-value' } } }, agentComposerNotes: { 'original-slot': '  separate note\n' },
    launchAgent: localLaunch, detectExecutors: detect, prewarmTerminal: vi.fn(), sessions: [] })
  useLauncherState.setState({ drafts: { 'region:original-slot': { browser: '', note: '', sourceExecution: source } }, sections: {}, executors: {} })
  await dom.render(<NewTabSurface tabId={tab.id} regionId="original-slot" tabGroupId="group" />)
  await vi.waitFor(async () => { await act(async () => {}); expect(button('Launch').disabled).toBe(false) })
  return { route, source, opens, methods, localLaunch, detect, checkpoint, unsupported: () => { supported = false }, inspect: (value: typeof inspected) => { inspected = value } }
}

it('real ordinary Launcher uses selected D declarations and the complete Source request; unknown retains both names and Check never replays', async () => {
  const f = await routedLauncher(), before = useAppStore.getState()
  expect(f.methods.filter(call => call.method === 'route.executors').map(call => call.params)).toEqual([
    { agentTarget: f.source.agentTarget, refresh: false }, { agentTarget: f.source.agentTarget, executorId: 'same-executor', refresh: false } ])
  expect(f.detect).not.toHaveBeenCalled(); expect(f.route.native).not.toHaveBeenCalled(); expect(f.route.creation).not.toHaveBeenCalled()
  await act(async () => button('Launch').click()); await vi.waitFor(() => expect(f.opens).toHaveLength(1))
  const key = mountedAgentOpenKey(f.source.target, { kind: 'region', tabId: 'original-tab', regionId: 'original-slot' })
  const retained = mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, key)!
  expect(retained.request).toEqual(f.opens[0]); expect(retained.origin?.names).toEqual({ agentName: 'Agent name', tabName: 'Tab name' })
  expect(f.opens[0]).toMatchObject({ content: { kind: 'new-agent', executorId: 'same-executor', agentTarget: f.source.agentTarget,
    prompt: '  original task\n', agentMuxNote: '  separate note\n', launchOptions: { 'original-unknown-option': 'retain-exact-value' } },
    destination: { spaceId: 'original-space-B', zoneId: 'B-zone', newTab: true }, focus: false })
  expect(f.checkpoint).toHaveBeenCalledOnce(); expect(f.localLaunch).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().agentComposerDrafts['original-slot']).toBe('  original task\n')
  await act(async () => button('Check original task').click())
  await vi.waitFor(() => expect(f.methods.some(call => call.method === 'space.inspect')).toBe(true)); expect(f.opens).toHaveLength(1)
  f.unsupported()
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Refresh agents on this device"]')!.click())
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Update AgentMux Core'))
  await act(async () => button('Continue original task').click()); await vi.waitFor(() => expect(f.opens).toHaveLength(2))
  expect(f.opens[1]).toEqual(retained.request); expect(f.route.creation).not.toHaveBeenCalled()
})

it('a late actual project registration retains its original confirmation without applying to a different ordinary Launcher', async () => {
  const f = await spaceMountFixture(cleanup), b = f.cores[1]!, actualProject = { ...project, hostId: b.id }
  const first = createWorkbenchTab('first-tab', { kind: 'launcher', regionId: 'first-slot', workspaceId: project.id })
  const second = createWorkbenchTab('second-tab', { kind: 'launcher', regionId: 'second-slot', workspaceId: project.id })
  let release!: () => void
  const delayedReply = new Promise<void>(resolve => { release = resolve }), calls: string[] = []
  vi.spyOn(api.spaceMounts, 'call').mockImplementation(async (method, input, signal) => {
    calls.push(method); const result = await f.api.call(method, input, signal)
    if (method === 'register') await delayedReply
    return result
  })
  vi.spyOn(storeModule, 'checkpointMountedSpaceInputs').mockResolvedValue(undefined)
  useAppStore.setState({ config: { ...composerConfig, hosts: [...composerConfig.hosts, { ...sourceHost, id: b.id }], workspaces: [actualProject] },
    tabs: { [first.id]: first, [second.id]: second }, layouts: { [project.id]: createWorkspaceLayout('group', [first.id, second.id]) },
    activeWorkspaceId: project.id, workbenchSpaceSelection: null, mountedSpaceInputs: {}, prewarmTerminal: vi.fn(), detectExecutors: vi.fn(),
    agentComposerDrafts: { 'first-slot': 'Original first draft', 'second-slot': 'Original second draft' } })
  useLauncherState.setState({ drafts: {}, sections: {}, executors: {} })
  await dom.render(<NewTabSurface tabId={first.id} regionId="first-slot" tabGroupId="group" />)
  const action = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text)!
  try {
    await dom.click('[aria-label="Agent location"]')
    if (action('Choose through the project device and its saved routes')) await act(async () => action('Choose through the project device and its saved routes').click())
    await vi.waitFor(async () => { await act(async () => {}); expect(action('Apply').disabled).toBe(false) })
    await act(async () => action('Apply').click()); await vi.waitFor(() => expect(calls).toContain('register'))
    await vi.waitFor(async () => expect((await b.store.read())?.graph.spaces).toHaveLength(1))
    await dom.render(<NewTabSurface tabId={second.id} regionId="second-slot" tabGroupId="group" />)
    await act(async () => { release(); await delayedReply }); await act(async () => {})
    expect(useLauncherState.getState().drafts['region:first-slot']?.sourceExecution).toBeUndefined()
    expect(useLauncherState.getState().drafts['region:second-slot']?.sourceExecution).toBeUndefined()
    expect(useAppStore.getState().agentComposerDrafts).toMatchObject({ 'first-slot': 'Original first draft', 'second-slot': 'Original second draft' })
    expect(Object.values(useAppStore.getState().mountedSpaceInputs as Record<string, unknown>)).toContainEqual(expect.objectContaining({ kind: 'folder-registration', submitted: true, confirmed: true }))
    expect(calls).not.toContain('open'); expect(calls.filter(method => method === 'register')).toHaveLength(1)
  } finally { release() }
})

it('a failed original private checkpoint retains the complete unsent Source request and does not dispatch or mint a replacement', async () => {
  const f = await routedLauncher()
  f.checkpoint.mockRejectedValueOnce(Error('Private original user document was not acknowledged.'))
  await act(async () => button('Launch').click())
  const key = mountedAgentOpenKey(f.source.target, { kind: 'region', tabId: 'original-tab', regionId: 'original-slot' })
  await vi.waitFor(() => expect(mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, key)?.submitted).toBe(false))
  const original = mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, key)!
  expect(original.issue).toContain('not sent')
  expect(original.submitted).toBe(false); expect(f.opens).toHaveLength(0)
  await act(async () => button('Check original task').click())
  expect(mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, key)?.request).toBe(original.request)
  expect(f.opens).toHaveLength(0); expect(useAppStore.getState().agentComposerDrafts['original-slot']).toBe('  original task\n')
})

it('the actual selected declaration preserves Provider options when the optional unselected Executor catalogue remains pending', async () => {
  let release!: () => void
  const catalogue = new Promise<void>(resolve => { release = resolve })
  try {
    const f = await routedLauncher(catalogue)
    const declaration = f.route.original.client.catalog().find(provider => provider.id === 'claude')!.launchOptions
    expect(declaration.length).toBeGreaterThan(0)
    await dom.click('[aria-label="Launch options"]')
    expect(document.querySelector('.launch-refine__panel')?.textContent).toContain(declaration[0]!.label)
    await act(async () => button('Launch').click()); await vi.waitFor(() => expect(f.opens).toHaveLength(1))
    expect(f.opens[0]?.content).toMatchObject({ kind: 'new-agent', executorId: 'same-executor',
      launchOptions: { 'original-unknown-option': 'retain-exact-value' }, agentMuxNote: '  separate note\n' })
    expect(f.localLaunch).not.toHaveBeenCalled(); expect(f.detect).not.toHaveBeenCalled()
  } finally { release() }
})

it('a known unsupported Source is explained before a new Launch and leaves the original prompt and ordinary slot intact', async () => {
  const f = await routedLauncher(), before = useAppStore.getState()
  f.unsupported()
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Refresh agents on this device"]')!.click())
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain('Update AgentMux Core') })
  await vi.waitFor(() => expect(f.route.inventory).toHaveBeenCalledTimes(4))
  await dom.click('[aria-label="Launch options"]')
  await vi.waitFor(() => expect(document.querySelector('.launch-refine__panel')?.textContent).toContain(f.route.original.client.catalog().find(provider => provider.id === 'claude')!.launchOptions[0]!.label))
  expect(button('Launch').disabled).toBe(true); expect(f.opens).toHaveLength(0)
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().agentComposerDrafts['original-slot']).toBe('  original task\n')
  expect(f.route.creation).not.toHaveBeenCalled(); expect(f.route.native).not.toHaveBeenCalled()
})

it('checking the same original Source operation updates the visible outcome while its old unknown receipt and draft remain retained', async () => {
  const f = await routedLauncher()
  await act(async () => button('Launch').click()); await vi.waitFor(() => expect(f.opens).toHaveLength(1))
  const key = mountedAgentOpenKey(f.source.target, { kind: 'region', tabId: 'original-tab', regionId: 'original-slot' })
  await vi.waitFor(() => expect(mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, key)?.receipt).toBeDefined())
  const original = mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, key)!
  f.inspect({ ...original.receipt!, outcome: 'opened' })
  await act(async () => button('Check original task').click())
  await vi.waitFor(() => expect(dom.container.textContent).toContain('The project device confirmed this Agent.'))
  expect(button('Continue original task')).toBeUndefined(); expect(f.opens).toHaveLength(1)
  expect(mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, key)?.receipt?.outcome).toBe('unknown')
  expect(useAppStore.getState().agentComposerDrafts['original-slot']).toBe('  original task\n')
})

it('a future private arrangement remains opaque on an attempted edit and cannot fall through to a local launch', async () => {
  const f = await routedLauncher(), future = { revision: 'future-contract', selected: { original: 'private intent' } }
  await act(async () => useLauncherState.setState(state => ({ drafts: { ...state.drafts,
    'region:original-slot': { ...state.drafts['region:original-slot']!, sourceExecution: future } } })))
  expect(button('Launch').disabled).toBe(true)
  await act(async () => { expect(useLauncherState.getState().setSourceExecution('region:original-slot', f.source)).toBe(false) })
  expect(useLauncherState.getState().drafts['region:original-slot']?.sourceExecution).toBe(future)
  const serialized = JSON.parse(JSON.stringify(useLauncherState.getState().drafts))
  expect(serialized['region:original-slot'].sourceExecution).toEqual(future)
  expect(f.localLaunch).not.toHaveBeenCalled(); expect(f.opens).toHaveLength(0)
  expect(useAppStore.getState().agentComposerDrafts['original-slot']).toBe('  original task\n')
})
