const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
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
const remote: HostConfig = { id: 'remote', kind: 'ssh', label: 'Remote', hostname: 'original.invalid' }
function inventory(host = remote): HostExecutorInventoryState {
  return { input: host, state: 'ready', result: { routeHostId: host.id, runtimeId: 'target-runtime', executors: [
    { executorId: 'shared', label: 'Remote Agent', providerId: 'claude', command: _hygiene_fixturePath("remote/claude"), configRevision: 'revision', source: 'registered', availability: 'available' },
    { executorId: 'remote-only', label: 'Remote exclusive Agent', providerId: 'codex', command: _hygiene_fixturePath("remote/exclusive"), configRevision: 'exclusive-revision', source: 'registered', availability: 'available' },
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
  await act(async () => { const select = dom.container.querySelector('select')!; select.value = id; select.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function open() {
  await act(async () => {
    const input = dom.container.querySelector<HTMLInputElement>('[placeholder="Project directory"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, _hygiene_fixturePath("remote/project"))
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await dom.click('[data-open-folder]')
}
it('projects target-only choices and starts the selected target on its returned folder', async () => {
  await show()
  const options = [...dom.container.querySelectorAll('option')]
  expect(options.map(item => item.value)).toEqual(['', 'shared', 'remote-only'])
  expect(options[1]!.textContent).toContain('Remote Agent')
  expect(options[1]!.textContent).toContain('Available')
  await choose('remote-only'); await open()
  expect(useAppStore.getState().launchAgent).toHaveBeenCalledExactlyOnceWith('remote-only', '', 'target-group')
  expect(useAppStore.getState().activeWorkspaceId).toBe('new-folder')
})
it('retains unknown connection facts without blocking registration or treating commands as missing', async () => {
  const retained = inventory(); retained.state = 'error'; retained.detail = 'SSH observation unavailable'
  useAppStore.setState({ hostExecutorInventories: { remote: retained } })
  await show()
  expect(dom.container.textContent).toContain('SSH observation unavailable')
  expect(dom.container.querySelector('option[value="shared"]')!.textContent).toContain('Check failed')
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
  await open()
  expect(useAppStore.getState().launchAgent).not.toHaveBeenCalled()
  expect(dom.container.textContent).toContain('Agent was not started')
  expect(useAppStore.getState().activeWorkspaceId).toBe('new-folder')
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
  expect(dom.container.textContent).toContain('Agent was not started')
})
it('fences a connection replacement during folder opening and keeps the registered folder', async () => {
  await show(); await choose()
  useAppStore.setState({ selectWorkspace: vi.fn(async id => {
    const config = useAppStore.getState().config!, replacement: HostConfig = { ...remote, hostname: 'replacement.invalid' }
    useAppStore.setState({ activeWorkspaceId: id, layouts: { [id]: createWorkspaceLayout('target-group') }, config: { ...config, hosts: [config.hosts[0]!, replacement] }, hostExecutorInventories: { remote: inventory(replacement) } })
  }) })
  await open()
  expect(useAppStore.getState().launchAgent).not.toHaveBeenCalled()
  expect(dom.container.querySelector('[data-folder-stage]')!.textContent).toContain('Agent was not started')
})
it('discovers only a visible active form and rejects stale inventory from another route', async () => {
  useAppStore.setState({ hostExecutorInventories: { remote: inventory({ ...remote, hostname: 'old.invalid' }) } })
  await show({ hidden: true })
  expect(useAppStore.getState().discoverHostExecutors).not.toHaveBeenCalled()
  await dom.render(<View active={false} />)
  expect(useAppStore.getState().discoverHostExecutors).not.toHaveBeenCalled()
  await dom.render(<View />)
  expect(useAppStore.getState().discoverHostExecutors).toHaveBeenCalledExactlyOnceWith('remote')
  expect([...dom.container.querySelectorAll('option')].map(item => item.value)).toEqual([''])
})
it('keeps local template choices without a remote discovery', async () => {
  await show({ hostId: 'local' })
  expect([...dom.container.querySelectorAll('option')].map(item => item.value)).toEqual(['', 'codex', 'shared'])
  expect(useAppStore.getState().discoverHostExecutors).not.toHaveBeenCalled()
})
