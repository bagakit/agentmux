const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { chooseField } from './helpers/selection-field'
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { HostProjectsPane } from '../src/renderer/src/components/settings/HostProjectsPane'
import { useAppStore, type HostExecutorInventoryState } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { HostConfig } from '../src/shared/contracts'
const dom = composerDOM()
const discoverHostExecutors = useAppStore.getState().discoverHostExecutors
const remote: HostConfig = { id: 'remote', kind: 'ssh', label: 'Remote', hostname: 'original.invalid' }
function inventory(host = remote): HostExecutorInventoryState {
  return { input: host, state: 'ready', result: { routeHostId: host.id, runtimeId: 'target-runtime', executors: [
    { executorId: 'shared', label: 'Remote Agent', providerId: 'claude', command: _hygiene_fixturePath("remote/claude"), executable: _hygiene_fixturePath("remote/claude"), configRevision: 'revision', source: 'registered', availability: 'available' },
    { executorId: 'remote-only', label: 'Remote exclusive Agent', providerId: 'codex', command: _hygiene_fixturePath("remote/exclusive"), executable: _hygiene_fixturePath("remote/exclusive"), configRevision: 'exclusive-revision', source: 'registered', availability: 'available' },
    { executorId: 'missing', label: 'Missing Agent', providerId: 'codex', command: _hygiene_fixturePath("remote/missing"), configRevision: 'missing-revision', source: 'registered', availability: 'missing' }
  ] } }
}
function View({ active = true, hidden = false, hostId = 'remote' }) {
  const config = useAppStore(state => state.config)!
  return <HostProjectsPane config={config} hostId={hostId} active={active} hidden={hidden} connectionChanged={false} />
}
beforeEach(() => {
  useAppStore.setState({ config: { ...composerConfig, hosts: [...composerConfig.hosts, remote], executors: {
    ...composerConfig.executors, shared: { ...composerConfig.executors.codex!, label: 'Local shared', command: _hygiene_fixturePath("local/codex") }
  } }, hostExecutorInventories: { remote: inventory() }, executorDetections: {},
  discoverHostExecutors: vi.fn(async () => {}), launchAgent: vi.fn(async () => {}),
  selectWorkspace: vi.fn(async id => { useAppStore.setState({ activeWorkspaceId: id, layouts: { [id]: createWorkspaceLayout('target-group') } }) }) })
  vi.spyOn(api.workspaces, 'add').mockImplementation(async input => {
    const workspace = { ...input, id: 'new-folder', name: 'New', kind: 'folder' as const }
    const config = useAppStore.getState().config!
    useAppStore.setState({ config: { ...config, workspaces: [...config.workspaces, workspace] } })
    return workspace
  })
})
async function show(props = {}) { await dom.render(<View {...props} />); await dom.click('.host-projects__heading button') }
async function choose(id = 'shared') {
  await chooseField(dom.container.querySelector<HTMLButtonElement>('[aria-label="Prepare an Agent"]')!, id)
}
async function options() {
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Prepare an Agent"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  return [...document.querySelectorAll('.selection-field__menu [role="option"]')]
}
async function open() {
  await act(async () => {
    const input = dom.container.querySelector<HTMLInputElement>('[placeholder="Project directory"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, _hygiene_fixturePath("remote/project"))
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await dom.click('[data-open-folder]')
}
it('gives the optional Executor a full form row for its identity and status', async () => {
  await show()
  expect(dom.container.querySelector('.host-projects__executor')).not.toBeNull()
})
it('projects target-only choices and prepares the selected target in its returned folder without starting', async () => {
  await show()
  const optionItems = await options()
  expect(optionItems.map(item => item.dataset.value)).toEqual(['', 'shared', 'remote-only'])
  expect(optionItems[1]!.textContent).toContain('Remote Agent')
  expect(optionItems[1]!.textContent).toContain('Available')
  await choose('remote-only'); await open()
  expect(useAppStore.getState().launchAgent).not.toHaveBeenCalled()
  const tab = Object.values(useAppStore.getState().tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'launcher' && region.workspaceId === 'new-folder'))!
  expect(tab).toBeDefined()
  expect(tab.regions[tab.layout.activeRegionId]).toMatchObject({kind:'launcher',workspaceId:'new-folder',executorId:'remote-only'})
  expect(useAppStore.getState().activeWorkspaceId).toBe('new-folder')
})
it('retains unknown connection facts without blocking registration or treating commands as missing', async () => {
  const retained = inventory(); retained.state = 'error'; retained.detail = 'SSH observation unavailable'
  useAppStore.setState({ hostExecutorInventories: { remote: retained } })
  await show()
  expect(dom.container.textContent).toContain('SSH observation unavailable')
  expect((await options()).find(item => item.dataset.value === 'shared')!.textContent).toContain('Check failed')
  expect(useAppStore.getState().discoverHostExecutors).not.toHaveBeenCalled()
  await open()
  expect(api.workspaces.add).toHaveBeenCalledOnce()
  await dom.click('[data-refresh-executors]')
  expect(useAppStore.getState().discoverHostExecutors).toHaveBeenCalledExactlyOnceWith('remote')
})
it('does not substitute a same-ID executor after the selected connection changes', async () => {
  await show(); await choose()
  const replacement: HostConfig = { ...remote, hostname: 'replacement.invalid' }
  await act(async () => { const config = useAppStore.getState().config!; useAppStore.setState({ config: { ...config, hosts: [config.hosts[0]!, replacement] }, hostExecutorInventories: { remote: inventory(replacement) } }) })
  const trigger = dom.container.querySelector<HTMLButtonElement>('[aria-label="Prepare an Agent"]')!
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  const oldOption = document.querySelector<HTMLElement>('.selection-field__menu [data-value="shared"]')!
  expect(oldOption.getAttribute('aria-disabled')).toBe('true')
  await act(async () => oldOption.click())
  await open()
  expect(useAppStore.getState().launchAgent).not.toHaveBeenCalled()
  expect(dom.container.textContent).toContain('Agent Launcher was not prepared')
  expect(useAppStore.getState().activeWorkspaceId).toBe('new-folder')
})
it.each(['address', 'keyFile'] as const)('does not reuse the selected Agent after the Tailcat %s changes', async field => {
  const original = { ...remote, transport: 'tailcat' as const, tailcat: { address: 'tcOriginal', keyFile: 'original-key' } } satisfies HostConfig
  useAppStore.setState(state => ({ config: { ...state.config!, hosts: [state.config!.hosts[0]!, original] }, hostExecutorInventories: { remote: inventory(original) } }))
  await show(); await choose()
  const changed: HostConfig = { ...original, tailcat: { ...original.tailcat, [field]: field === 'address' ? 'tcReplacement' : 'replacement-key' } }
  await act(async () => { const config = useAppStore.getState().config!; useAppStore.setState({ config: { ...config, hosts: [config.hosts[0]!, changed] }, hostExecutorInventories: { remote: inventory(changed) } }) })
  const selected = (await options()).find(item => item.getAttribute('data-value') === 'shared')!
  expect(selected.getAttribute('aria-disabled')).toBe('true')
})
it('keeps the selected Agent when only the Host display name changes', async () => {
  await show(); await choose()
  const renamed: HostConfig = { ...remote, label: 'Renamed display' }
  await act(async () => { const config = useAppStore.getState().config!; useAppStore.setState({ config: { ...config, hosts: [config.hosts[0]!, renamed] }, hostExecutorInventories: { remote: inventory(renamed) } }) })
  const selected = (await options()).find(item => item.getAttribute('data-value') === 'shared')!
  expect(selected.getAttribute('aria-disabled')).not.toBe('true')
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Prepare an Agent"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await open()
  const tab = Object.values(useAppStore.getState().tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'launcher' && region.workspaceId === 'new-folder'))
  expect(tab?.regions[tab.layout.activeRegionId]).toMatchObject({kind:'launcher',workspaceId:'new-folder',executorId:'shared'})
})
it('keeps the original Executor inventory when only the Host display name changes', async () => {
  await show(); await choose()
  const renamed: HostConfig = { ...remote, label: 'Renamed display' }
  await act(async () => { const config = useAppStore.getState().config!; useAppStore.setState({ config: { ...config, hosts: [config.hosts[0]!, renamed] } }) })
  expect((await options()).map(item => item.dataset.value)).toContain('remote-only')
  expect(useAppStore.getState().discoverHostExecutors).not.toHaveBeenCalled()
})
it.each([false, true])('accepts an in-flight discovery across a display rename but not a route replacement: replace=%s', async replace => {
  let complete!: (value: NonNullable<HostExecutorInventoryState['result']>) => void
  vi.spyOn(api.executors, 'discover').mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  useAppStore.setState({ discoverHostExecutors, hostExecutorInventories: {} })
  let pending!: Promise<void>
  await act(async () => { pending = discoverHostExecutors(remote.id) })
  const changed: HostConfig = replace ? { ...remote, hostname: 'replacement.invalid' } : { ...remote, label: 'Renamed display' }
  await act(async () => { const config = useAppStore.getState().config!; useAppStore.setState({ config: { ...config, hosts: [config.hosts[0]!, changed] } }) })
  await act(async () => { complete(inventory().result!); await pending })
  const observation = useAppStore.getState().hostExecutorInventories.remote!
  expect(observation.state).toBe(replace ? 'checking' : 'ready')
  expect(observation.result?.runtimeId).toBe(replace ? undefined : 'target-runtime')
})
it('keeps the original Agent when the Host display name changes during folder registration', async () => {
  await show(); await choose()
  const add = vi.mocked(api.workspaces.add).getMockImplementation()!
  vi.mocked(api.workspaces.add).mockImplementationOnce(async input => {
    const result = await add(input), config = useAppStore.getState().config!
    useAppStore.setState({ config: { ...config, hosts: [config.hosts[0]!, { ...remote, label: 'Renamed display' }] } })
    return result
  })
  await open()
  const tab = Object.values(useAppStore.getState().tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'launcher' && region.workspaceId === 'new-folder'))
  expect(tab?.regions[tab.layout.activeRegionId]).toMatchObject({kind:'launcher',workspaceId:'new-folder',executorId:'shared'})
})
it('fences a connection replacement during registration without losing the returned folder', async () => {
  await show(); await choose()
  const add = vi.mocked(api.workspaces.add).getMockImplementation()!
  vi.mocked(api.workspaces.add).mockImplementationOnce(async input => {
    const result = await add(input), config = useAppStore.getState().config!
    const replacement: HostConfig = { ...remote, hostname: 'replacement.invalid' }
    useAppStore.setState({ config: { ...config, hosts: [config.hosts[0]!, replacement] }, hostExecutorInventories: { remote: inventory(replacement) } })
    return result
  })
  await open()
  expect(useAppStore.getState().launchAgent).not.toHaveBeenCalled()
  expect(useAppStore.getState().activeWorkspaceId).toBe('new-folder')
  expect(dom.container.textContent).toContain('Agent Launcher was not prepared')
})
it('fences a connection replacement during folder opening and keeps the registered folder', async () => {
  await show(); await choose()
  useAppStore.setState({ selectWorkspace: vi.fn(async id => {
    const config = useAppStore.getState().config!, replacement: HostConfig = { ...remote, hostname: 'replacement.invalid' }
    useAppStore.setState({ activeWorkspaceId: id, layouts: { [id]: createWorkspaceLayout('target-group') }, config: { ...config, hosts: [config.hosts[0]!, replacement] }, hostExecutorInventories: { remote: inventory(replacement) } })
  }) })
  await open()
  expect(useAppStore.getState().launchAgent).not.toHaveBeenCalled()
  expect(dom.container.querySelector('[data-folder-stage]')!.textContent).toContain('Agent Launcher was not prepared')
})
it('discovers only a visible active form and rejects stale inventory from another route', async () => {
  useAppStore.setState({ hostExecutorInventories: { remote: inventory({ ...remote, hostname: 'old.invalid' }) } })
  await show({ hidden: true })
  expect(useAppStore.getState().discoverHostExecutors).not.toHaveBeenCalled()
  await dom.render(<View active={false} />)
  expect(useAppStore.getState().discoverHostExecutors).not.toHaveBeenCalled()
  await dom.render(<View />)
  expect(useAppStore.getState().discoverHostExecutors).toHaveBeenCalledExactlyOnceWith('remote')
  expect((await options()).map(item => item.dataset.value)).toEqual([''])
})
it('keeps local template choices without a remote discovery', async () => {
  await show({ hostId: 'local' })
  expect((await options()).map(item => item.dataset.value)).toEqual(['', 'codex', 'shared'])
  expect(useAppStore.getState().discoverHostExecutors).not.toHaveBeenCalled()
})
