import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'

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
})

it('two actual Regions with the same Agent name distinguish their own local and remote machines without changing either Session', async () => {
  const local = { ...agent, id: 'private-local', hostId: 'local', control: { ...agent.control, agentSessionId: 'private-local', hostId: 'local' } }
  useAppStore.setState({ sessions: [agent, local], agentNames: { [agent.id]: 'Same name', [local.id]: 'Same name' }, viewModes: { [agent.id]: 'terminal', [local.id]: 'terminal' } })
  const before = structuredClone(useAppStore.getState().sessions)
  await act(async () => root.render(<>{pane(agent, null, 'remote-region')}{pane(local, null, 'local-region')}</>))
  const badges = [...document.querySelectorAll<HTMLElement>('.agent-region-header__execution')]
  expect(badges).toHaveLength(2)
  expect(badges.map(item => item.textContent)).toEqual(['Build machine', 'This Mac'])
  expect(badges.map(item => item.dataset.executionHostId)).toEqual([remoteId, 'local'])
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
