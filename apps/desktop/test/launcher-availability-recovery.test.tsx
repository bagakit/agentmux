// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppConfig, ExecutorDetection, HostExecutorInventory } from '../src/shared/contracts'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { api } from '../src/renderer/src/lib/api'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { executorDetectionKey, useAppStore, type ExecutorDetectionState } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture'

vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
const dom = composerDOM(), launcherState = useLauncherState.getState()
let config: AppConfig
const originalDraft = 'Continue the original task\nKeep my second line.'
function result(id: string, availability: ExecutorDetection['availability'] = 'available'): ExecutorDetection {
  const executor = config.executors[id]!
  return { input: { executorId: id, providerId: executor.providerId, command: executor.command, host: config.hosts[0]! },
    executable: executor.command, availability,
    ...(availability === 'check-failed' ? { cause: { code: 'HOST_PENDING', message: 'Original Host observation is unconfirmed.' } } : {}) }
}
function detection(id: string, state: ExecutorDetectionState['state']): ExecutorDetectionState {
  const observed = result(id, state === 'missing' ? 'missing' : state === 'error' ? 'check-failed' : 'available')
  return { input: observed.input, state, result: observed, observedAt: 1,
    ...(state === 'error' ? { detail: 'HOST_PENDING: Original Host observation is unconfirmed.' } : {}) }
}
beforeEach(() => {
  config = structuredClone(composerConfig)
  config.executors.ready = { ...config.executors.codex!, label: 'Ready Agent' }
  config.executors.missing = { ...config.executors.codex!, label: 'Missing Agent' }
  useLauncherState.setState({ sections: { workspace: { terminal: 'collapsed' } }, drafts: {}, executors: {}, persistenceIssue: null })
  useAppStore.setState({ config, activeWorkspaceId: 'workspace',
    tabs: { launcher: createWorkbenchTab('launcher', { regionId: 'region', kind: 'launcher', workspaceId: 'workspace' }) },
    agentComposerDrafts: { region: originalDraft }, sessions: [composerSession()],
    executorDetections: Object.fromEntries([['codex', 'error'], ['ready', 'ready'], ['missing', 'missing']].map(([id, state]) =>
      [executorDetectionKey('local', id!), detection(id!, state as ExecutorDetectionState['state'])])),
    hostExecutorInventories: {}, recoveryCandidates: [], warmTerminals: {}, prewarmTerminal: vi.fn(async () => undefined) })
  vi.spyOn(api.executors, 'detect').mockImplementation(async id => result(id))
  vi.spyOn(api.sessions, 'stop'); vi.spyOn(api.sessions, 'recover'); vi.spyOn(api.sessions, 'submitPrompt')
})
afterEach(async () => { await act(async () => useLauncherState.setState(launcherState, true)); vi.useRealTimers() })
const mount = (visible = true) => dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible={visible} />)
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
function preserved() {
  expect(useAppStore.getState().agentComposerDrafts.region).toBe(originalDraft)
  expect(useAppStore.getState().tabs.launcher?.regions.region?.kind).toBe('launcher')
  expect(useAppStore.getState().sessions[0]?.control.run.runId).toBe('run-agent-1')
  expect(api.sessions.stop).not.toHaveBeenCalled()
  expect(api.sessions.recover).not.toHaveBeenCalled()
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
}

it('the active Launcher retries only the failed exact configuration and closes the notice after the original detector confirms availability', async () => {
  vi.useFakeTimers()
  await mount()
  expect(dom.container.textContent).toContain('Agent check needs attention')
  expect(dom.container.textContent).toContain('HOST_PENDING: Original Host observation is unconfirmed.')
  expect(dom.container.querySelector<HTMLButtonElement>('.launcher-launch-button')?.disabled).toBe(false)
  await advance(1000)
  expect(vi.mocked(api.executors.detect).mock.calls).toEqual([['codex', 'local']])
  expect(useAppStore.getState().executorDetections['local\0codex']?.state).toBe('ready')
  expect(dom.container.textContent).not.toContain('Agent check needs attention')
  await advance(60000)
  expect(api.executors.detect).toHaveBeenCalledTimes(1)
  preserved()
})

it('failed retries are bounded, retain their real cause and leave the direct Check again action usable', async () => {
  vi.useFakeTimers()
  vi.mocked(api.executors.detect).mockImplementation(async id => result(id, 'check-failed'))
  await mount()
  for (const delay of [1000, 3000, 10000]) await advance(delay)
  expect(api.executors.detect).toHaveBeenCalledTimes(3)
  await advance(120000)
  expect(api.executors.detect).toHaveBeenCalledTimes(3)
  expect(dom.container.textContent).toContain('HOST_PENDING: Original Host observation is unconfirmed.')
  expect(dom.container.textContent).not.toContain('Rechecking automatically')
  const retry = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check again')!
  expect(retry.disabled).toBe(false)
  vi.mocked(api.executors.detect).mockImplementation(async id => result(id))
  await act(async () => retry.click())
  expect(api.executors.detect).toHaveBeenCalledTimes(6)
  expect(dom.container.textContent).not.toContain('Agent check needs attention')
  preserved()
})

it('hidden and document-hidden Launchers stop retry timers, and returning to the same surface restores observation without losing its draft', async () => {
  vi.useFakeTimers()
  vi.mocked(api.executors.detect).mockImplementation(async id => result(id, 'check-failed'))
  await mount(); await mount(false); await advance(60000)
  expect(api.executors.detect).not.toHaveBeenCalled()
  await mount(); await advance(1000)
  expect(api.executors.detect).toHaveBeenCalledTimes(1)
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await advance(60000)
  expect(api.executors.detect).toHaveBeenCalledTimes(1)
  hidden.mockReturnValue(false)
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await advance(1000)
  expect(api.executors.detect).toHaveBeenCalledTimes(2)
  preserved()
})

it('concurrent automatic readers join the original in-flight check, and a stale result cannot confirm a replacement command', async () => {
  let release!: (value: ExecutorDetection) => void
  vi.mocked(api.executors.detect).mockReturnValue(new Promise(resolve => { release = resolve }))
  const first = useAppStore.getState().detectExecutors('local', { onlyUnconfirmed: true })
  const joined = useAppStore.getState().detectExecutors('local', { onlyUnconfirmed: true })
  expect(api.executors.detect).toHaveBeenCalledTimes(1)
  const prior = result('codex')
  config = { ...config, executors: { ...config.executors, codex: { ...config.executors.codex!, command: 'replacement-agent' } } }
  useAppStore.setState({ config })
  release(prior); await Promise.all([first, joined])
  expect(useAppStore.getState().executorDetections['local\0codex']?.state).not.toBe('ready')
  preserved()
})

it('Host restoration rechecks existing failed observations without probing an unobserved Host or configuration', async () => {
  config.executors.unobserved = { ...config.executors.codex!, label: 'Unobserved Agent' }
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [composerSession()], recoveryCandidates: [], timelines: {} })
  vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  const restored = (hostId: string) => useAppStore.getState().applyEvent({ type: 'core', hostId,
    event: { type: 'connection-state', state: 'restored', evidence: { source: 'run-process', observedAt: 2 } } })
  await act(async () => { restored('unobserved'); for (let i = 0; i < 30; i++) await Promise.resolve() })
  expect(api.executors.detect).not.toHaveBeenCalled()
  await act(async () => { restored('local'); for (let i = 0; i < 30; i++) await Promise.resolve() })
  expect(vi.mocked(api.executors.detect).mock.calls).toEqual([['codex', 'local']])
  expect(useAppStore.getState().executorDetections['local\0codex']?.state).toBe('ready')
  preserved()
})

it('remote retries reuse the exact Host inventory owner and stop once that inventory is confirmed', async () => {
  const host = { id: 'remote', kind: 'ssh' as const, label: 'Remote', hostname: 'remote.example' }
  config = { ...config, hosts: [...config.hosts, host] }
  useAppStore.setState({ config, hostExecutorInventories: { remote: { input: host, state: 'error', detail: 'Original remote read failed' } } })
  const inventory: HostExecutorInventory = { routeHostId: 'remote', runtimeId: 'remote-runtime', executors: [
    { executorId: 'remote-agent', label: 'Remote Agent', providerId: 'codex', command: 'codex', source: 'registered', configRevision: 'revision', availability: 'available' }
  ] }
  const discover = vi.spyOn(api.executors, 'discover').mockResolvedValue(inventory)
  await Promise.all([useAppStore.getState().detectExecutors('remote', { onlyUnconfirmed: true }),
    useAppStore.getState().detectExecutors('remote', { onlyUnconfirmed: true })])
  await useAppStore.getState().detectExecutors('remote', { onlyUnconfirmed: true })
  expect(discover.mock.calls).toEqual([['remote']])
  expect(api.executors.detect).not.toHaveBeenCalled()
  preserved()
})

it('checking, failed and unchecked status marks are distinct while the selection mark remains independent', async () => {
  const checks = { ...useAppStore.getState().executorDetections,
    'local\0codex': detection('codex', 'checking'), 'local\0ready': detection('ready', 'error') }
  delete checks['local\0missing']
  useAppStore.setState({ executorDetections: checks })
  await mount(false)
  const mark = (id: string) => dom.container.querySelector(`[data-executor-id="${id}"] .agent-pick__unconfirmed`)
  expect(mark('codex')?.getAttribute('aria-label')).toBe('Checking')
  expect(mark('codex')?.querySelector('[data-semantic-icon="status.loading"]')).not.toBeNull()
  expect(mark('ready')?.querySelector('[data-semantic-icon="status.warning"]')).not.toBeNull()
  expect(mark('missing')?.getAttribute('aria-label')).toBe('Not checked')
  expect(dom.container.querySelector('[aria-pressed="true"] .agent-pick__check')).not.toBeNull()
  preserved()
})

it('a pending sibling cannot hold failed checks or disable the selected configuration’s direct recovery', async () => {
  vi.useFakeTimers()
  config.executors.slow = { ...config.executors.codex!, label: 'Slow Agent' }
  useAppStore.setState({ config, executorDetections: { ...useAppStore.getState().executorDetections,
    'local\0slow': detection('slow', 'error') } })
  let release!: (value: ExecutorDetection) => void
  const pending = new Promise<ExecutorDetection>(resolve => { release = resolve })
  vi.mocked(api.executors.detect).mockImplementation(id => id === 'slow' ? pending : Promise.resolve(result(id, 'check-failed')))
  await mount(); await advance(1000)
  expect(useAppStore.getState().executorDetections['local\0slow']?.state).toBe('checking')
  expect(dom.container.textContent).toContain('Agent check needs attention')
  const retry = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check again')!
  expect(retry.disabled).toBe(false)
  await advance(3000); await advance(10000); await advance(60000)
  expect(vi.mocked(api.executors.detect).mock.calls.filter(([id]) => id === 'codex')).toHaveLength(3)
  expect(vi.mocked(api.executors.detect).mock.calls.filter(([id]) => id === 'slow')).toHaveLength(1)
  await act(async () => { release(result('slow')); await pending })
  preserved()
})

it('the remote Host failure keeps its original detail and offers a direct check through the inventory owner', async () => {
  vi.useFakeTimers()
  const host = { id: 'remote', kind: 'ssh' as const, label: 'Remote', hostname: 'remote.example' }
  config = { ...config, hosts: [...config.hosts, host], workspaces: config.workspaces.map(item => ({ ...item, hostId: 'remote' })) }
  const inventory: HostExecutorInventory = { routeHostId: 'remote', runtimeId: 'remote-runtime', executors: [
    { executorId: 'remote-agent', label: 'Remote Agent', providerId: 'codex', command: 'codex', source: 'registered', configRevision: 'revision', availability: 'available' }
  ] }
  useAppStore.setState({ config, hostExecutorInventories: { remote: { input: host, state: 'error', result: inventory, detail: 'REMOTE_PENDING: Original inventory read failed' } } })
  let release!: (value: HostExecutorInventory) => void
  const pending = new Promise<HostExecutorInventory>(resolve => { release = resolve })
  const discover = vi.spyOn(api.executors, 'discover').mockReturnValue(pending)
  await mount()
  expect(dom.container.textContent).toContain('REMOTE_PENDING: Original inventory read failed')
  const retry = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check again')!
  expect(retry.disabled).toBe(false)
  await act(async () => retry.click())
  expect(discover.mock.calls).toEqual([['remote']])
  expect(dom.container.textContent).toContain('Checking agents on this host')
  expect(dom.container.textContent).toContain('REMOTE_PENDING: Original inventory read failed')
  await act(async () => { release(inventory); await pending })
  expect(dom.container.textContent).not.toContain('Host Executor discovery failed')
  preserved()
})
