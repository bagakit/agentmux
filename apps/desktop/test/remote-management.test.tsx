// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { HostSettingsPane } from '../src/renderer/src/components/settings/HostSettingsPane'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { installDesktopPresentationOwner } from '../src/renderer/src/lib/desktop-presentation'
import { executorEnvironmentRevision } from '../src/shared/executor-probe-context'
import type { SessionSnapshot } from '../src/shared/contracts'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'
import { connectionsConfig } from '../scripts/fixtures/settings-connections/data'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const dom = composerDOM(), H = 'host-01', J = 'host-02'
let config = connectionsConfig(composerConfig)
const onSave = vi.fn(async () => {})
beforeEach(() => {
  installNoteCanvasGeometry()
  config = connectionsConfig(composerConfig)
  useAppStore.setState({ config, sessions: [], hostChecks: {} })
  onSave.mockClear()
})
const show = (active = true) => dom.render(<HostSettingsPane config={config} active={active} onSave={onSave} />)
const editor = () => dom.container.querySelector<HTMLElement>('[data-resource-editor]')!
async function mode(name: 'Topology' | 'List') {
  await dom.click(`[aria-label="${name}"]`)
}
async function leaf(id: string, panel = 'connection') {
  await mode('List')
  await dom.click(`[data-host-disclosure="${id}"] [data-host-panel="${panel}"]`)
}
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function graph(id: string) {
  await mode('Topology')
  await vi.waitFor(() => expect(dom.container.querySelector(`[data-host-node="${id}"]`)).not.toBeNull())
  const node = dom.container.querySelector<HTMLButtonElement>(`[data-host-node="${id}"]`)!
  node.focus()
  await act(async () => node.click())
  return node
}

it('graph: an actual topology node selects the exact Host overview without moving focus into its editor', async () => {
  await show()
  const node = await graph(J)
  expect(editor()?.dataset.resourceEditor, 'Topology activation selects its exact Host detail').toBe(J)
  expect(editor().dataset.hostView).toBe('overview')
  expect(dom.container.querySelectorAll('[data-host-node]')).toHaveLength(24)
  expect(dom.container.querySelector('[data-host-disclosure]')).toBeNull()
  expect(dom.container.querySelector('[data-host-name]')).toBeNull()
  expect(document.activeElement, 'Node selection retains the graph keyboard target').toBe(node)
  expect(onSave).not.toHaveBeenCalled()
})

it('mode changes and same-name Host nodes preserve the original connection draft and explicit edit navigation', async () => {
  const check = vi.spyOn(api.hosts, 'check')
  await show(); await leaf(H)
  const original = dom.container.querySelector<HTMLInputElement>('[data-host-name]')!
  await fill(original, 'Authored topology draft')
  await graph(J)
  expect(editor().dataset.resourceEditor).toBe(J)
  expect(editor().dataset.hostView).toBe('overview')
  await graph(H)
  expect(editor().dataset.resourceEditor).toBe(H)
  await leaf(H)
  expect(dom.container.querySelector<HTMLInputElement>('[data-host-name]')!.value).toBe('Authored topology draft')
  expect(document.activeElement).toBe(dom.container.querySelector('[data-host-name]'))
  expect(dom.container.querySelector('[data-host-node]')).toBeNull()
  expect(dom.container.querySelectorAll('[data-resource-editor]')).toHaveLength(1)
  expect(check).not.toHaveBeenCalled()
  expect(onSave).not.toHaveBeenCalled()
})

it('inactive Settings release the graph while the original Host draft remains available on return', async () => {
  await show(); await leaf(H)
  await fill(dom.container.querySelector<HTMLInputElement>('[data-host-name]')!, 'Retained while away')
  await graph(H)
  await show(false)
  expect(dom.container.querySelector('[data-host-node]')).toBeNull()
  await show(true); await leaf(H)
  expect(dom.container.querySelector<HTMLInputElement>('[data-host-name]')!.value).toBe('Retained while away')
})


it('existing Agent and Terminal rows on same-path Hosts navigate through the original Store action to their original projections', async () => {
  const base = composerSession('host-a-agent')
  const agent: SessionSnapshot = { ...base, hostId: H, workspacePath: config.workspaces[0]!.path,
    control: { ...base.control, hostId: H } }
  const shell: SessionSnapshot = { ...base, id: 'host-a-terminal', kind: 'terminal', providerId: null,
    hostId: H, workspacePath: agent.workspacePath, label: 'Original terminal',
    control: { kind: 'terminal', hostId: H, runId: 'terminal-run', run: { runId: 'terminal-run' } } }
  const other: SessionSnapshot = { ...base, id: 'host-b-agent', hostId: J, workspacePath: agent.workspacePath,
    control: { ...base.control, hostId: J, agentSessionId: 'host-b-agent' } }
  const tabs = [agent, shell, other].map(session => createWorkbenchTab(`tab-${session.id}`, {
    kind: session.kind, phase: 'attached', regionId: `region-${session.id}`, workspaceId: 'project-a', sessionId: session.id
  }))
  const originalSelect = useAppStore.getState().selectSession
  const select = vi.fn((...args: Parameters<typeof originalSelect>) => originalSelect(...args))
  useAppStore.setState({ sessions: [agent, shell, other], tabs: Object.fromEntries(tabs.map(tab => [tab.id, tab])),
    layouts: { 'project-a': createWorkspaceLayout('original-group', tabs.map(tab => tab.id)) },
    activeWorkspaceId: 'project-a', workbenchSpaceSelection: null, selectSession: select,
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  const releasePresentation = installDesktopPresentationOwner(() => ({ loading: false, overlays: { settings: true, quickSwitcher: false }, floating: null }))
  try {
  await show(); await graph(H)
  expect([...dom.container.querySelectorAll<HTMLElement>('[data-host-session]')].map(node => node.dataset.hostSession)).toEqual([agent.id, shell.id])
  for (const session of [agent, shell]) {
    await dom.click(`[data-host-session="${session.id}"]`)
    expect(select).toHaveBeenLastCalledWith(session.id)
    expect(useAppStore.getState().workbenchSpaceSelection?.regionId, 'Original Store navigates despite the Settings overlay').toBe(`region-${session.id}`)
    expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(session.id)
    expect(useAppStore.getState().tabs[`tab-${session.id}`]!.layout.activeRegionId).toBe(`region-${session.id}`)
  }
  await graph(J)
  expect([...dom.container.querySelectorAll<HTMLElement>('[data-host-session]')].map(node => node.dataset.hostSession)).toEqual([other.id])
  expect(useAppStore.getState().sessions).toEqual([agent, shell, other])
  expect(Object.keys(useAppStore.getState().tabs)).toEqual(tabs.map(tab => tab.id))
  expect(onSave).not.toHaveBeenCalled()
  } finally { releasePresentation() }
})

it('Agent configuration Refresh uses original local detection and exact remote discovery rather than guessing from a global template', async () => {
  const originalDetect = useAppStore.getState().detectExecutors
  const detect = vi.fn((id: string) => originalDetect(id))
  const local = vi.spyOn(api.executors, 'detect').mockImplementation(async (executorId, hostId) => {
    const executor = config.executors[executorId]!, host = config.hosts.find(value => value.id === hostId)!
    return { input: { executorId, providerId: executor.providerId, command: executor.command,
      environmentRevision: executorEnvironmentRevision(executor.env), host }, availability: 'available', executable: executor.command }
  })
  const remote = vi.spyOn(api.executors, 'discover').mockImplementation(async hostId => ({ routeHostId: hostId,
    runtimeId: `runtime-${hostId}`, executors: [] }))
  useAppStore.setState({ detectExecutors: detect, hostExecutorInventories: {}, executorDetections: {} })
  await show(); await leaf('local', 'agents')
  expect(local).toHaveBeenCalledWith('codex', 'local')
  expect(remote).not.toHaveBeenCalled()
  local.mockClear(); detect.mockClear()
  await act(async () => [...editor().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Refresh')!.click())
  expect(detect).toHaveBeenCalledExactlyOnceWith('local')
  expect(local).toHaveBeenCalledExactlyOnceWith('codex', 'local')
  await leaf(J, 'agents')
  expect(remote).toHaveBeenCalledWith(J)
  remote.mockClear(); detect.mockClear()
  await act(async () => [...editor().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Refresh')!.click())
  expect(detect).toHaveBeenCalledExactlyOnceWith(J)
  expect(remote).toHaveBeenCalledExactlyOnceWith(J)
})


it('access: source trust belongs to the exact Apps & access facet and retains its owner across navigation', async () => {
  const trust = vi.spyOn(api.hosts, 'creationTrust').mockRejectedValue(new Error('Controlled trust read unavailable'))
  await show(); await leaf(H, 'agents')
  expect(editor().textContent).toContain('Apps & access')
  const access = dom.container.querySelector<HTMLElement>(`[data-host-access="${H}"]`)!
  expect(access.hidden, 'Source trust belongs to the Apps & access facet').toBe(false)
  expect(trust).toHaveBeenCalledExactlyOnceWith(config.hosts.find(host => host.id === H))
  const original = access.querySelector('.host-creation-trust')
  await leaf(J, 'connection')
  expect(access.hidden).toBe(true)
  await leaf(H, 'agents')
  expect(access.querySelector('.host-creation-trust')).toBe(original)
  expect(access.textContent).toContain('Controlled trust read unavailable')
  await leaf(H, 'connection')
  expect(access.hidden).toBe(true)
  expect(dom.container.querySelector('[data-host-access="host-02"]')?.hasAttribute('hidden')).toBe(true)
})

it('connection action: a typed failed check opens its exact original connection without testing or writing', async () => {
  const input = config.hosts.find(host => host.id === H)!
  const check = vi.spyOn(api.hosts, 'check'), trust = vi.spyOn(api.hosts, 'creationTrust')
  useAppStore.setState({ hostChecks: { [H]: { state: 'error', input, result: { input, outcome: 'check-failed', detail: 'Original reader failure' }, detail: 'Original reader failure', observedAt: _historyFixtureEpoch(0, 1, 0) } } })
  await show(); await leaf(H, 'overview')
  expect(editor().textContent).toContain('Original reader failure')
  await dom.click('.remote-overview__connection-action')
  expect(editor().dataset.resourceEditor).toBe(H)
  expect(editor().dataset.hostView).toBe('connection')
  expect(dom.container.querySelector('[data-host-name]')).not.toBeNull()
  expect(check).not.toHaveBeenCalled()
  expect(trust).not.toHaveBeenCalled()
  expect(onSave).not.toHaveBeenCalled()
})


it('keeps an unconfirmed original approval across Apps, Connection, other Host and inactive Settings without replay', async () => {
  const input = config.hosts.find(host => host.id === H)!
  const snapshot = { source: { runtimeId: 'source-runtime', publicKey: 'source-key', fingerprint: 'a'.repeat(64) },
    target: { routeHostId: H, authority: { runtimeId: 'target-runtime', publicKey: 'target-key', fingerprint: 'b'.repeat(64) }, sources: [] } }
  const read = vi.spyOn(api.hosts, 'creationTrust').mockResolvedValue(snapshot)
  const approve = vi.spyOn(api.hosts, 'trustCreationSource').mockRejectedValue(new Error('Original response lost'))
  await show(); await leaf(H, 'agents')
  const access = `[data-host-access="${H}"]`
  await dom.click(`${access} input[type="checkbox"]`)
  await dom.click(`${access} .primary-button`)
  expect(approve).toHaveBeenCalledExactlyOnceWith(input, snapshot)
  expect(dom.container.querySelector(access)?.textContent).toContain('Approval result unconfirmed')
  await leaf(H, 'connection'); await leaf(J, 'overview'); await show(false); await show(true); await leaf(H, 'agents')
  expect(dom.container.querySelector(access)?.textContent).toContain('Approval result unconfirmed')
  expect(dom.container.querySelector(access)?.textContent).toContain('Original response lost')
  expect(dom.container.querySelector<HTMLInputElement>(`${access} input[type="checkbox"]`)?.checked).toBe(false)
  expect(read).toHaveBeenCalledTimes(1)
  expect(approve).toHaveBeenCalledTimes(1)
  expect(onSave).not.toHaveBeenCalled()
})
