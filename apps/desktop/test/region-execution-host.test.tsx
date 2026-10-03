import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxAgentSession, AgentSessionHistoryDescriptor } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createClientUiRoot } from './helpers/client-ui-render'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'

// The actual mounted Panel registration requires the same browser platform entry as
// the existing Region-close owning suite. Product SessionPane/Header are not mocked.
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})

const initial = useAppStore.getState()
let root: Root, container: HTMLDivElement, agent: Extract<SessionSnapshot, { kind: 'agent' }>, config: AppConfig
const remoteId = 'private-execution-host', directory = _hygiene_fixturePath("srv/private/project")
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const original = (await api.sessions.snapshot()).sessions.find(session => session.kind === 'agent')
  expect(original, 'A real nonempty owning Session fixture is required').toBeDefined()
  if (!original || original.kind !== 'agent') throw new Error('The owning Agent fixture is absent')
  agent = { ...original, id: 'private-agent', hostId: 'local', workspacePath: directory,
    control: { ...original.control, agentSessionId: 'private-agent', hostId: remoteId } }
  config = { ...await api.config.get(), hosts: [
    { id: 'local', kind: 'local', label: 'This Mac' },
    { id: remoteId, kind: 'ssh', label: 'Build machine', hostname: 'private.invalid' }
  ] }
  useAppStore.setState({ ...initial, config, sessions: [agent], activeWorkspaceId: 'local-display',
    viewModes: { [agent.id]: 'terminal' }, agentNames: { [agent.id]: 'Original Agent' } }, true)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  document.body.replaceChildren(); useAppStore.setState(initial, true)
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})
function pane(session: SessionSnapshot, portal: string | null = null, regionId = 'private-region') {
  // Park the heavy terminal through its actual public presentation policy. The owning
  // SessionPane/Header, ordinary-Terminal branch and Focus portal are never mocked.
  // Actual xterm layout/paint is exercised by the independent private Electron producer.
  return <SessionPane sessionId={session.id} surfaceKind={session.kind} interactiveResize={false}
    visible={false} parked readOnly headerPortalTargetId={portal}
    linkOrigin={{ workspaceId: 'local-display', tabGroupId: 'private-group', tabId: 'private-tab', regionId }} />
}
async function mount(session: SessionSnapshot = agent, portal: string | null = null) {
  await act(async () => root.render(pane(session, portal)))
  expect(document.querySelectorAll('.agent-region-header')).toHaveLength(1)
  return document.querySelector<HTMLElement>('.agent-region-header')!
}
const badge = () => {
  const actual = document.querySelector<HTMLElement>('.agent-region-header__execution')
  expect(actual, 'The actual Region must expose its execution Host').not.toBeNull()
  return actual!
}
async function details() {
  const trigger = document.querySelector<HTMLButtonElement>('.agent-region-header__more')
  expect(trigger).not.toBeNull()
  await act(async () => { trigger!.focus(); trigger!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  await act(async () => { await vi.waitFor(() => expect(document.querySelector('.agent-region-menu__context')).not.toBeNull()) })
  return document.querySelector<HTMLElement>('.agent-region-menu__context')!
}

it('the actual Agent Region uses its original control Host even in a local display and with a different snapshot label', async () => {
  const header = await mount()
  expect(badge().dataset.executionHostId).toBe(remoteId)
  expect(badge().dataset.hostKind).toBe('ssh')
  expect(badge().textContent).toBe('Build machine')
  expect(header.getAttribute('aria-label')).toContain('Host Build machine')
  expect(header.querySelector('strong')!.textContent).toBe('Original Agent')
  const context = await details()
  expect(context.textContent).toContain(`Host ID: ${remoteId}`)
  expect(context.textContent).toContain(`Directory: ${directory}`)
  expect(context.textContent).not.toMatch(/connected|healthy/i)
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  // A late appearance configuration must not replace the confirmed Session's name
  // with its SID or a recovery-candidate label while the theme remains unconfirmed.
  await act(async () => useAppStore.setState({ config: null }))
  expect(document.querySelector('.agent-region-header strong')?.textContent).toBe('Original Agent')
  expect(badge().dataset.executionHostId).toBe(remoteId)
  expect((await details()).textContent).toContain(`Executor: ${agent.executorId}`)
})

it('the actual plain Terminal shows its execution Host without manufacturing an Agent identity or lifecycle action', async () => {
  const terminal: SessionSnapshot = { ...agent, kind: 'terminal', providerId: null, id: 'private-shell', label: 'Original shell', hostId: remoteId,
    control: { kind: 'terminal', hostId: 'local', runId: 'private-shell-run', run: { ...agent.control.run, runId: 'private-shell-run' } } }
  useAppStore.setState({ sessions: [terminal] })
  const stop = vi.spyOn(api.sessions, 'stop'), write = vi.spyOn(api.sessions, 'write')
  const header = await mount(terminal)
  expect(header.dataset.sessionKind).toBe('terminal')
  expect(badge().dataset.executionHostId).toBe(remoteId)
  expect(badge().textContent).toBe('Build machine')
  const context = await details()
  expect(context.textContent).toContain('Terminal: private-shell')
  expect(context.textContent).toContain(`Directory: ${directory}`)
  expect(context.textContent).not.toMatch(/Executor:|Session:/)
  expect(document.querySelector('.agent-region-menu')!.getAttribute('data-agent-session-id')).toBeNull()
  expect(stop).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await act(async () => useAppStore.setState({ config: null }))
  expect(document.querySelector('.agent-region-header strong')?.textContent).toBe('Original shell')
  expect(badge().dataset.executionHostId).toBe(remoteId)
})

it('two actual Regions with the same Agent name keep only the remote machine marker without changing either Session', async () => {
  const local = { ...agent, id: 'private-local', hostId: 'local', control: { ...agent.control, agentSessionId: 'private-local', hostId: 'local' } }
  useAppStore.setState({ sessions: [agent, local], agentNames: { [agent.id]: 'Same name', [local.id]: 'Same name' }, viewModes: { [agent.id]: 'terminal', [local.id]: 'terminal' } })
  const before = structuredClone(useAppStore.getState().sessions)
  await act(async () => root.render(<>{pane(agent, null, 'remote-region')}{pane(local, null, 'local-region')}</>))
  const badges = [...document.querySelectorAll<HTMLElement>('.agent-region-header__execution')]
  expect(badges).toHaveLength(1)
  expect(badges.map(item => item.textContent)).toEqual(['Build machine'])
  expect(badges.map(item => item.dataset.executionHostId)).toEqual([remoteId])
  const headers = [...document.querySelectorAll<HTMLElement>('.agent-region-header')]
  expect(headers).toHaveLength(2)
  expect(headers[1]!.querySelector('.agent-region-header__execution')).toBeNull()
  expect(headers[1]!.getAttribute('aria-label')).toContain('Host This Mac')
  expect(useAppStore.getState().sessions).toEqual(before)
})

it('a confirmed local Host stays quiet while More retains its complete execution identity, and missing configuration becomes explicit', async () => {
  agent = { ...agent, control: { ...agent.control, hostId: 'local' } }
  useAppStore.setState({ sessions: [agent] })
  const header = await mount(), before = structuredClone(useAppStore.getState().sessions)
  expect(header.querySelector('.agent-region-header__execution')).toBeNull()
  expect(header.textContent).not.toContain('This Mac')
  const context = await details()
  expect(context.textContent).toContain('Host: This Mac')
  expect(context.textContent).toContain('Host ID: local')
  expect(context.textContent).toContain(`Directory: ${directory}`)
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await act(async () => useAppStore.setState({ config: null }))
  expect(document.querySelector('.agent-region-header')).toBe(header)
  expect(badge().dataset.hostKind).toBe('unknown')
  expect(badge().getAttribute('aria-label')).toContain('Not configured')
  expect(useAppStore.getState().sessions).toEqual(before)
})

it('removing Host configuration keeps the original Host ID and mounted Region, then a label update settles only its projection', async () => {
  const header = await mount(), before = structuredClone(useAppStore.getState().sessions)
  await act(async () => useAppStore.setState({ config: { ...config, hosts: config.hosts.filter(host => host.id !== remoteId) } }))
  expect(document.querySelector('.agent-region-header')).toBe(header)
  expect(badge().dataset.executionHostId).toBe(remoteId)
  expect(badge().dataset.hostKind).toBe('unknown')
  expect(badge().textContent).toBe(remoteId)
  expect(badge().getAttribute('aria-label')).toContain('Not configured')
  await act(async () => useAppStore.setState({ config: { ...config, hosts: config.hosts.map(host => host.id === remoteId ? { ...host, label: 'Renamed machine' } : host) } }))
  expect(document.querySelector('.agent-region-header')).toBe(header)
  expect(badge().textContent).toBe('Renamed machine')
  expect(useAppStore.getState().sessions).toEqual(before)
})

it('an unconfirmed execution identity stays unknown instead of borrowing This Mac from the display', async () => {
  agent = { ...agent, control: { ...agent.control, hostId: '' } }
  useAppStore.setState({ sessions: [agent] })
  await mount()
  expect(badge().dataset.executionHostId).toBe('')
  expect(badge().dataset.hostKind).toBe('unknown')
  expect(badge().textContent).toBe('Host unknown')
  expect((await details()).textContent).toContain('Host ID: Unknown')
})

it('the Focus portal preserves the same Header and original Host, including a long renamed label and the precise keyboard details', async () => {
  // Focus is interactive; only the existing Header is portalled. No terminal or input is mounted.
  const target = document.createElement('div'); target.id = 'private-focus-header'; document.body.append(target)
  const render = () => <SessionPane sessionId={agent.id} surfaceKind="agent" interactiveResize={false} visible={false} parked
    headerPortalTargetId={target.id} linkOrigin={{ workspaceId: 'local-display', tabGroupId: 'private-group', tabId: 'private-tab', regionId: 'private-region' }} />
  await act(async () => root.render(render()))
  const header = target.querySelector<HTMLElement>('.agent-region-header')!
  expect(header).not.toBeNull(); expect(header.querySelector('.agent-region-header__name')).toBeNull()
  expect(badge().dataset.executionHostId).toBe(remoteId)
  const long = 'A very long build machine name with a precise original execution identity'
  await act(async () => useAppStore.setState({ config: { ...config, hosts: config.hosts.map(host => host.id === remoteId ? { ...host, label: long } : host) } }))
  expect(target.querySelector('.agent-region-header')).toBe(header)
  expect(badge().textContent).toBe(long)
  expect(badge().getAttribute('aria-label')).toContain(long)
  expect(header.getAttribute('aria-label')).toContain(long)
  expect((await details()).textContent).toContain(`Host ID: ${remoteId}`)
})

function createdReceipt(): AgentMuxAgentSession {
  // Core's local is relative to the remote server. It is deliberately different
  // from the configured Desktop endpoint captured by the original launch request.
  return { kind: 'agent', agentSessionId: agent.id, hostId: 'local', providerId: agent.providerId,
    executorId: agent.executorId, workspacePath: directory, run: agent.control.run, retiredRuns: [],
    createdAt: agent.createdAt, updatedAt: agent.updatedAt }
}
async function withoutSnapshot(kind: 'agent' | 'terminal' = 'agent', visible = false, workspaceId = 'local-display') {
  await act(async () => root.render(<SessionPane sessionId={agent.id} surfaceKind={kind} interactiveResize={false}
    visible={visible} parked={!visible} readOnly
    linkOrigin={{ workspaceId, tabGroupId: 'private-group', tabId: 'private-tab', regionId: 'private-region' }} />))
}

it('a missing Agent or Terminal snapshot exposes unknown Host while preserving its original connecting surface', async () => {
  useAppStore.setState({ sessions: [], recoveryCandidates: [], pendingAgentLaunches: {} })
  for (const kind of ['agent', 'terminal'] as const) {
    await withoutSnapshot(kind)
    expect(badge().textContent).toBe('Host unknown')
    expect(badge().dataset.executionHostId).toBe('')
    expect(container.textContent).toContain('Connecting to this session')
    expect((await details()).textContent).toContain('Host ID: Unknown')
    expect(document.querySelector('.agent-region-menu__context')!.textContent).toContain('Directory: Unknown')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  }
})

it('the no-snapshot recovery surface shows only its original Core recovery-candidate Host and cwd', async () => {
  useAppStore.setState({ sessions: [], pendingAgentLaunches: {}, recoveryCandidates: [{ agentSessionId: agent.id,
    hostId: remoteId, workspacePath: directory, providerId: agent.providerId, executorId: agent.executorId,
    label: agent.label, capabilities: agent.capabilities, run: agent.control.run, createdAt: agent.createdAt, updatedAt: agent.updatedAt }] })
  const before = structuredClone(useAppStore.getState().recoveryCandidates)
  await withoutSnapshot()
  expect(container.textContent).toContain('Restoring your session')
  expect(badge().dataset.executionHostId).toBe(remoteId)
  expect(badge().textContent).toBe('Build machine')
  expect((await details()).textContent).toContain(`Directory: ${directory}`)
  expect(useAppStore.getState().recoveryCandidates).toEqual(before)
})

it('an accepted remote creation uses the frozen submitted endpoint rather than Core server-local identity', async () => {
  useAppStore.setState({ sessions: [], recoveryCandidates: [], pendingAgentLaunches: { [agent.id]: {
    events: [], overflowed: false, request: { executorId: agent.executorId, hostId: remoteId, workspacePath: directory },
    created: createdReceipt(), projectionFailures: [{ step: 'session', message: 'Private projection unavailable' }] } } })
  const before = structuredClone(useAppStore.getState().pendingAgentLaunches)
  await withoutSnapshot()
  expect(container.textContent).toContain('Agent created')
  expect(badge().dataset.executionHostId).toBe(remoteId)
  expect(badge().textContent).toBe('Build machine')
  expect((await details()).textContent).toContain(`Directory: ${directory}`)
  expect(useAppStore.getState().pendingAgentLaunches).toEqual(before)
})

it('an accepted Core receipt without the original endpoint stays unknown instead of becoming This Mac', async () => {
  useAppStore.setState({ sessions: [], recoveryCandidates: [], pendingAgentLaunches: { [agent.id]: {
    events: [], overflowed: false, request: { executorId: agent.executorId }, created: createdReceipt(), projectionFailures: [] } } })
  await withoutSnapshot()
  expect(container.querySelector('.agent-surface')).not.toBeNull()
  expect(useAppStore.getState().pendingAgentLaunches[agent.id]?.created).toEqual(createdReceipt())
  expect(badge().textContent).toBe('Host unknown')
  expect(badge().dataset.executionHostId).toBe('')
  expect((await details()).textContent).toContain('Host ID: Unknown')
})

it('the pending launch keeps its exact submitted remote target, prompt and original lifecycle untouched', async () => {
  useAppStore.setState({ sessions: [], recoveryCandidates: [], pendingAgentLaunches: { [agent.id]: {
    events: [], overflowed: false, request: { executorId: agent.executorId, hostId: remoteId, workspacePath: directory,
      prompt: 'Original submitted request' } } } })
  const before = structuredClone(useAppStore.getState().pendingAgentLaunches)
  const launch = vi.spyOn(api.sessions, 'launchAgent'), write = vi.spyOn(api.sessions, 'write'), stop = vi.spyOn(api.sessions, 'stop')
  await withoutSnapshot()
  expect(container.textContent).toContain('Starting your agent')
  expect(container.textContent).toContain('Original submitted request')
  expect(badge().dataset.executionHostId).toBe(remoteId)
  expect((await details()).textContent).toContain(`Directory: ${directory}`)
  expect(useAppStore.getState().pendingAgentLaunches).toEqual(before)
  expect(launch).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
})

it('the original retired History keeps its Core Host through the existing reader and More return without a new Run', async () => {
  const descriptor: AgentSessionHistoryDescriptor = { agentSessionId: agent.id, hostId: remoteId, state: 'retired', retiredAt: 42,
    history: { providerId: agent.providerId, executorId: agent.executorId, workspacePath: directory,
      createdAt: agent.createdAt, nativeHandle: { kind: 'provider', providerId: agent.providerId, sessionId: 'private-original-native' } } }
  useAppStore.setState({ config: { ...config, workspaces: [...config.workspaces,
    { id: 'private-original-resource', hostId: remoteId, path: directory, name: 'Original resource', kind: 'folder' }] },
    sessions: [], recoveryCandidates: [], pendingAgentLaunches: {} })
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([descriptor])
  const page = vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ agentSessionId: agent.id,
    source: { providerId: agent.providerId, nativeSessionId: 'private-original-native' }, nextCursor: null,
    items: [{ id: 'private-history-item', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Original saved conversation' }] }] })
  const launch = vi.spyOn(api.sessions, 'launchAgent'), reopen = vi.spyOn(api.sessions, 'reopen'), write = vi.spyOn(api.sessions, 'write')
  await withoutSnapshot('agent', true, 'private-original-resource')
  await act(async () => vi.waitFor(() => expect(container.textContent).toContain('Session closed')))
  const header = document.querySelector('.agent-region-header')
  expect(badge().dataset.executionHostId).toBe(remoteId)
  expect((await details()).textContent).toContain(`Directory: ${directory}`)
  const more = document.querySelector<HTMLButtonElement>('.agent-region-header__more')!
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await act(async () => vi.waitFor(() => expect(document.activeElement).toBe(more)))
  const button = (name: string) => {
    const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === name)
    expect(found, `Original reader action: ${name}`).toBeDefined(); return found!
  }
  await act(async () => button('Read conversation history').click())
  await act(async () => vi.waitFor(() => expect(container.textContent).toContain('Original saved conversation')))
  expect(page).toHaveBeenCalledWith({ hostId: remoteId, agentSessionId: agent.id }, undefined)
  expect(badge().dataset.executionHostId).toBe(remoteId)
  const back = container.querySelector<HTMLButtonElement>('[aria-label="Conversation history"] .session-history__toolbar > button')
  expect(back, 'The original History reader must expose its return action').not.toBeNull()
  expect(back!.textContent?.trim()).toBe('Session')
  await act(async () => back!.click())
  expect(container.textContent).toContain('Session closed')
  expect(document.querySelector('.agent-region-header')).toBe(header)
  expect(badge().dataset.executionHostId).toBe(remoteId)
  expect(launch).not.toHaveBeenCalled(); expect(reopen).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
})

it('the actual Workbench X closes only its unknown-snapshot Region and leaves the other reference and draft untouched', async () => {
  const workspaceId = 'private-unknown-workspace', tabId = 'private-unknown-tab', left = 'unknown-left', right = 'unknown-right'
  let tab = createWorkbenchTab(tabId, { kind: 'agent', regionId: left, workspaceId, sessionId: agent.id, phase: 'attached' })
  tab = addWorkbenchRegion(tab, left, 'right', { kind: 'terminal', regionId: right, workspaceId, sessionId: 'original-unknown-shell', phase: 'attached' })
  useAppStore.setState({ config: { ...config, workspaces: [{ id: workspaceId, name: 'Private', hostId: 'local', path: _hygiene_fixturePath("private/original-workspace"), kind: 'folder' }] },
    sessions: [], recoveryCandidates: [], pendingAgentLaunches: {},
    tabs: { [tabId]: tab }, layouts: { [workspaceId]: createWorkspaceLayout('private-group', [tabId]) },
    activeWorkspaceId: workspaceId, agentComposerDrafts: { [right]: 'Original neighbor draft' } })
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  const stop = vi.spyOn(api.sessions, 'stop'), write = vi.spyOn(api.sessions, 'write')
  await act(async () => root.render(<WorkspaceWorkbench workspaceId={workspaceId} />))
  const region = container.querySelector(`[data-workbench-region-id="${left}"]`)!
  expect(region).not.toBeNull()
  expect(region.querySelector('.agent-region-header__execution')?.textContent).toBe('Host unknown')
  const close = region.querySelector<HTMLButtonElement>('button[aria-label="Close split"]')
  expect(close).not.toBeNull()
  await act(async () => close!.click())
  expect(Object.keys(useAppStore.getState().tabs[tabId]!.regions)).toEqual([right])
  expect(useAppStore.getState().tabs[tabId]!.regions[right]).toMatchObject({ kind: 'terminal', sessionId: 'original-unknown-shell' })
  expect(useAppStore.getState().agentComposerDrafts[right]).toBe('Original neighbor draft')
  expect(stop).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
})
