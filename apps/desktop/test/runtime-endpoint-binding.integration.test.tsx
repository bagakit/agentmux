import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { App } from '../src/renderer/src/App'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, RuntimeEvent, RuntimeSnapshot, RuntimeEndpointWarning, SessionSnapshot } from '../src/shared/contracts'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { HostSettingsPane } from '../src/renderer/src/components/settings/HostSettingsPane'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const subscriptions: Array<() => void> = []
afterEach(() => { for (const dispose of subscriptions.splice(0)) dispose() })
const remote = { id: 'remote', kind: 'ssh' as const, label: 'Build host', hostname: 'build.invalid', runtimeId: 'durable-owner-23' }
const config: AppConfig = { ...composerConfig, hosts: [...composerConfig.hosts, remote], workspaces: [
  ...composerConfig.workspaces, { id: 'remote-space', name: 'Remote project', hostId: remote.id, path: _hygiene_fixturePath("remote/project"), kind: 'folder' }
] }
const warning: RuntimeEndpointWarning = { hostId: remote.id, step: 'Reading Runtime sessions', code: 'REMOTE_OFFLINE',
  message: 'This endpoint is unavailable. Its last observation and original workbench are kept; current status is unconfirmed.',
  recovery: 'Restore the SSH connection to the bound Runtime, then reconnect.' }
const local = composerSession('local-agent')
const agent: Extract<SessionSnapshot, { kind: 'agent' }> = { ...composerSession('remote-agent'), hostId: remote.id, workspacePath: _hygiene_fixturePath("remote/project"),
  semanticStatus: { state: 'working', source: 'native-hook', observedAt: 1, stateEnteredAt: 1 },
  control: { ...composerSession('remote-agent').control, hostId: remote.id } }
const terminal: Extract<SessionSnapshot, { kind: 'terminal' }> = {
  id: 'remote-terminal', kind: 'terminal', providerId: null, hostId: remote.id, workspacePath: _hygiene_fixturePath("remote/project"), label: 'Remote terminal',
  createdAt: 1, updatedAt: 1, latestOutputBytes: 0, processState: 'running', status: { state: 'running', source: 'run-process', observedAt: 1 },
  control: { kind: 'terminal', hostId: remote.id, runId: 'remote-terminal-run', run: { runId: 'remote-terminal-run' } }
}
function snapshot(sessions: SessionSnapshot[], warnings: RuntimeEndpointWarning[] = []): RuntimeSnapshot {
  return { sessions, recoveryCandidates: [], runtimeEndpointWarnings: warnings,
    timelines: Object.fromEntries(sessions.filter(item => item.kind === 'agent').map(item => [item.id, { agentSessionId: item.id, revision: 1, items: [] }])) }
}
function connection(state: 'lost' | 'restored', endpointWarning?: RuntimeEndpointWarning | null): RuntimeEvent {
  return { type: 'core', hostId: remote.id, ...(endpointWarning === undefined ? {} : { endpointWarning }),
    event: { type: 'connection-state', state, evidence: { source: 'agentmux', observedAt: 2 } } }
}
function gap(): RuntimeEvent {
  return { type: 'core', hostId: 'local', event: { type: 'agent-status', agentSessionId: 'not-projected', state: 'working',
    evidence: { source: 'agentmux', observedAt: 3 } } }
}
async function settled() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
beforeEach(() => {
  let tab = createWorkbenchTab('original', { regionId: 'agent-region', kind: 'agent', phase: 'attached', sessionId: agent.id, workspaceId: 'remote-space' })
  tab = addWorkbenchRegion(tab, 'agent-region', 'right', { regionId: 'terminal-region', kind: 'terminal', phase: 'attached', sessionId: terminal.id, workspaceId: 'remote-space' })
  tab = addWorkbenchRegion(tab, 'terminal-region', 'down', { regionId: 'unknown-region', kind: 'terminal', phase: 'attached', sessionId: 'unknown-owner', workspaceId: 'remote-space' })
  useAppStore.setState({ config, loading: false, sessions: [local, agent, terminal], timelines: snapshot([local, agent]).timelines,
    tabs: { original: tab }, layouts: { 'remote-space': createWorkspaceLayout('original-group', ['original']) },
    activeWorkspaceId: 'remote-space', runtimeEndpointWarnings: [], runtimeOwnershipWarnings: [], environmentWarning: null,
    agentComposerDrafts: { [agent.id]: 'Original remote draft' }, agentSteerQueues: {}, pendingAgentLaunches: {} })
})

it('keeps failed-owner Agent, Terminal and unknown-owner saved surface when the healthy local snapshot is nonempty', async () => {
  const original = useAppStore.getState()
  const read = vi.spyOn(api.sessions, 'snapshot').mockResolvedValue(snapshot([local], [warning]))
  await dom.render(<GlobalSystemNotices />)
  await act(async () => useAppStore.getState().applyEvent(gap()))
  await settled()
  expect(read).toHaveBeenCalledTimes(1)
  const current = useAppStore.getState()
  expect(current.sessions.map(item => item.id)).toEqual([local.id, agent.id, terminal.id])
  expect(current.tabs).toBe(original.tabs)
  expect(current.layouts).toBe(original.layouts)
  expect(current.activeWorkspaceId).toBe('remote-space')
  expect(current.agentComposerDrafts).toBe(original.agentComposerDrafts)
  expect(current.runtimeEndpointWarnings).toEqual([warning])
  const unverified = current.sessions.find(item => item.id === agent.id)!
  expect(unverified.status).toEqual({ ...agent.status, state: 'disconnected', detail: warning.message })
  expect(unverified.control).toBe(agent.control)
  expect(unverified.processState).toBe(agent.processState)
  expect(unverified.updatedAt).toBe(agent.updatedAt)
  expect(unverified.kind === 'agent' ? unverified.semanticStatus : undefined).toBe(agent.semanticStatus)
  const notices = [...dom.container.querySelectorAll('.service-window__step')].map(item => item.textContent)
  expect(notices).toEqual(['Build host: Reading Runtime sessions'])
  expect(dom.container.textContent).toContain('current status is unconfirmed')
})

it('retains the endpoint notice across hot events and reconnect until a fresh complete snapshot arrives', async () => {
  await dom.render(<GlobalSystemNotices />)
  await act(async () => useAppStore.getState().applyEvent(connection('lost', warning)))
  const retained = useAppStore.getState().runtimeEndpointWarnings
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: {
    type: 'agent-status', agentSessionId: local.id, state: 'working', evidence: { source: 'agentmux', observedAt: 3 }
  } }))
  expect(useAppStore.getState().runtimeEndpointWarnings).toBe(retained)
  let finish!: (value: RuntimeSnapshot) => void
  const read = vi.spyOn(api.sessions, 'snapshot').mockReturnValue(new Promise(resolve => { finish = resolve }))
  await act(async () => useAppStore.getState().applyEvent(connection('restored', null)))
  expect(read).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().runtimeEndpointWarnings).toEqual([warning])
  expect(dom.container.textContent).toContain('Build host: Reading Runtime sessions')
  await act(async () => finish(snapshot([local, agent, terminal])))
  await settled()
  expect(useAppStore.getState().runtimeEndpointWarnings).toEqual([])
  expect(useAppStore.getState().sessions.find(item => item.id === agent.id)?.status).toEqual(agent.status)
  expect(dom.container.textContent).not.toContain('Build host: Reading Runtime sessions')
  expect(useAppStore.getState().tabs.original?.regions['agent-region']).toMatchObject({ sessionId: agent.id })
  expect(useAppStore.getState().agentComposerDrafts[agent.id]).toBe('Original remote draft')
})

it('does not replay a prepared uncertain mutation on reconnect; leaves its original operation and a service notice', async () => {
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue(snapshot([local, agent, terminal]))
  subscriptions.push(await useAppStore.getState().initialize())
  const originalCondition = { expectedRun: agent.control.run, afterSubmissionId: null }
  useAppStore.setState({ agentSteerQueues: { [agent.id]: [{ operationId: 'original-operation', text: 'Unconfirmed mutation', runId: agent.control.run.runId,
    status: 'deferred', promptCondition: originalCondition, error: 'The reply was lost.' }] } })
  const submit = vi.spyOn(api.sessions, 'submitPrompt')
  const flush = vi.spyOn(useAppStore.getState(), 'flushAgentSteerQueue')
  await dom.render(<GlobalSystemNotices />)
  await act(async () => useAppStore.getState().flushAgentSteerQueue(agent.id))
  expect(submit).not.toHaveBeenCalled()
  flush.mockClear()
  await act(async () => useAppStore.getState().applyEvent(connection('restored', null)))
  await settled()
  expect(submit).not.toHaveBeenCalled()
  expect(flush).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentSteerQueues[agent.id]).toEqual([{ operationId: 'original-operation', text: 'Unconfirmed mutation', runId: agent.control.run.runId,
    status: 'deferred', promptCondition: originalCondition, error: 'The original message delivery is unconfirmed after reconnect. Inspect the outbox before retrying.' }])
  expect(dom.container.textContent).toContain('original message delivery is unconfirmed after reconnect')
})

it('requires a later complete cut when reconnect arrives during an unavailable snapshot read', async () => {
  await dom.render(<GlobalSystemNotices />)
  let first!: (value: RuntimeSnapshot) => void, second!: (value: RuntimeSnapshot) => void
  const read = vi.spyOn(api.sessions, 'snapshot')
    .mockReturnValueOnce(new Promise(resolve => { first = resolve }))
    .mockReturnValueOnce(new Promise(resolve => { second = resolve }))
  await act(async () => useAppStore.getState().applyEvent(gap()))
  await act(async () => useAppStore.getState().applyEvent(connection('restored', null)))
  await act(async () => first(snapshot([local], [warning])))
  await settled()
  expect(read).toHaveBeenCalledTimes(2)
  expect(useAppStore.getState().runtimeEndpointWarnings).toEqual([warning])
  expect(useAppStore.getState().sessions.map(item => item.id)).toEqual([local.id, agent.id, terminal.id])
  expect(dom.container.textContent).toContain('Build host: Reading Runtime sessions')
  await act(async () => second(snapshot([local, agent, terminal])))
  await settled()
  expect(useAppStore.getState().runtimeEndpointWarnings).toEqual([])
  expect(useAppStore.getState().sessions.find(item => item.id === agent.id)?.status).toEqual(agent.status)
})

it('wakes an explicitly queued never-dispatched message only after fresh authority', async () => {
  useAppStore.setState({ agentSteerQueues: { [agent.id]: [{ operationId: 'queued-operation', text: 'Explicit queued task', runId: agent.control.run.runId,
    status: 'queued', promptCondition: null }] } })
  let finish!: (value: RuntimeSnapshot) => void
  vi.spyOn(api.sessions, 'snapshot').mockReturnValue(new Promise(resolve => { finish = resolve }))
  const flush = vi.spyOn(useAppStore.getState(), 'flushAgentSteerQueue').mockResolvedValue(undefined)
  await act(async () => useAppStore.getState().applyEvent(connection('restored', null)))
  expect(flush).not.toHaveBeenCalled()
  await act(async () => finish(snapshot([local, agent, terminal])))
  await settled()
  expect(flush).toHaveBeenCalledExactlyOnceWith(agent.id)
})

it('uses complete healthy-owner facts to remove missing sessions once the endpoint is available', async () => {
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue(snapshot([local]))
  await act(async () => useAppStore.getState().applyEvent(gap()))
  await settled()
  expect(useAppStore.getState().sessions.map(item => item.id)).toEqual([local.id])
  expect(useAppStore.getState().tabs).toEqual({})
})

it('keeps a connected binding-save notice beside authoritative healthy facts and permits an explicit message', async () => {
  const connected: RuntimeEndpointWarning = { ...warning, availability: 'connected', step: 'Saving Runtime binding', code: 'BINDING_SAVE_FAILED',
    message: 'The Runtime is connected. Its binding could not be saved.', recovery: 'Retry saving the binding.' }
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue(snapshot([local, agent, terminal], [connected]))
  await dom.render(<GlobalSystemNotices />)
  await act(async () => useAppStore.getState().applyEvent(gap()))
  await settled()
  const current = useAppStore.getState()
  expect(current.sessions.map(item => item.id)).toEqual([local.id, agent.id, terminal.id])
  expect(current.sessions.find(item => item.id === agent.id)?.status).toEqual(agent.status)
  expect(Object.keys(current.tabs.original!.regions)).toEqual(['agent-region', 'terminal-region'])
  expect(current.runtimeEndpointWarnings).toEqual([connected])
  expect(dom.container.textContent).toContain('Build host: Saving Runtime binding')
  const condition = { expectedRun: agent.control.run, afterSubmissionId: null }
  await act(async () => useAppStore.setState({ agentSteerQueues: { [agent.id]: [{ operationId: 'healthy-explicit', text: 'New explicit input', runId: agent.control.run.runId,
    status: 'queued', promptCondition: condition }] } }))
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
  await act(async () => useAppStore.getState().flushAgentSteerQueue(agent.id, 'healthy-explicit'))
  expect(submit.mock.calls.map(call => [call[1], call[2]])).toEqual([['New explicit input', 'healthy-explicit']])
  expect(useAppStore.getState().agentSteerQueues[agent.id]).toBeUndefined()
})

it('keeps unavailable cached facts disconnected through later Run publications and does not dispatch input', async () => {
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue(snapshot([local], [warning]))
  await act(async () => useAppStore.getState().applyEvent(gap()))
  await settled()
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: remote.id, event: {
    type: 'process-state', run: agent.control.run, state: 'running', pid: 123, evidence: { source: 'run-process', observedAt: 4, run: agent.control.run }
  } }))
  const current = useAppStore.getState().sessions.find(item => item.id === agent.id)!
  expect(current.status.state).toBe('disconnected')
  expect(current.status.detail).toBe(warning.message)
  expect(current.processState).toBe('running')
  expect(current.control).toBe(agent.control)
  useAppStore.setState({ agentSteerQueues: { [agent.id]: [{ operationId: 'unverified-explicit', text: 'Kept input', runId: agent.control.run.runId,
    status: 'queued', promptCondition: { expectedRun: agent.control.run, afterSubmissionId: null } }] } })
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
  await useAppStore.getState().flushAgentSteerQueue(agent.id, 'unverified-explicit')
  expect(submit).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentSteerQueues[agent.id]?.map(item => item.operationId)).toEqual(['unverified-explicit'])
})

it('saves existing service configuration from mounted settings while keeping the Runtime identity read-only', async () => {
  const save = vi.fn(async (_hosts: AppConfig['hosts'], _workspaces: AppConfig['workspaces'], _expected: Pick<AppConfig, 'hosts' | 'workspaces'>) => {})
  await dom.render(<HostSettingsPane config={config} active={true} onSave={save} />)
  const input = (text: string) => {
    const labels = [...dom.container.querySelectorAll('label')]
    expect(labels.length).toBeGreaterThan(0)
    const label = labels.find(item => item.querySelector('span')?.textContent?.startsWith(text))
    expect(label).toBeDefined()
    return label!.querySelector('input')!
  }
  const command = input('Service command'), socket = input('Service socket path'), identity = input('Bound Runtime ID')
  expect(identity.value).toBe(remote.runtimeId)
  expect(identity.readOnly).toBe(true)
  command.focus()
  const fill = async (node: HTMLInputElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await fill(command, _hygiene_fixturePath("opt/agentmux/bin/agentmux-rpc"))
  expect(input('Service command')).toBe(command)
  expect(document.activeElement).toBe(command)
  await fill(socket, _hygiene_fixturePath("run/user/1000/agentmux/public.sock"))
  const button = [...dom.container.querySelectorAll('button')].find(item => item.textContent === 'Save hosts')
  expect(button).toBeDefined()
  await act(async () => button!.click())
  expect(save).toHaveBeenCalledTimes(1)
  expect(save.mock.calls[0]?.[0]).toEqual([config.hosts[0], { ...remote, remoteCommand: _hygiene_fixturePath("opt/agentmux/bin/agentmux-rpc"), remoteSocketPath: _hygiene_fixturePath("run/user/1000/agentmux/public.sock") }])
  expect(dom.container.textContent).not.toContain('Remote sessions and saving SSH connections are unavailable')
})


it('initializes and mounts the unavailable endpoint notice through the actual App footer', async () => {
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue(snapshot([local], [warning]))
  useAppStore.setState({ loading: true, tabs: {}, layouts: {}, sessions: [] })
  await dom.render(<App />)
  for (let attempt = 0; attempt < 50 && useAppStore.getState().loading; attempt++) await settled()
  expect(useAppStore.getState().loading).toBe(false)
  expect(dom.container.querySelector('main.main-shell')).not.toBeNull()
  expect(dom.container.querySelector('footer.window-status-bar')?.textContent).toContain('Build host: Reading Runtime sessions')
  expect(dom.container.textContent).toContain('current status is unconfirmed')
})
