// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig } from '../src/shared/contracts'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { HostSettingsPane } from '../src/renderer/src/components/settings/HostSettingsPane'
import { settingsNavGroups, visibleSettingsSections } from '../src/renderer/src/components/settings/settings-modules'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'
const dom = composerDOM(), close = vi.fn()
let config: AppConfig
const ordinary = { ...composerSession('ordinary-remote'), hostId: 'remote', workspacePath: '/original/remote', control: { ...composerSession('ordinary-remote').control, hostId: 'remote' } }
const split = { ...composerSession('split-project'), workspacePath: '/original/local', workPlacement: { agentHostId: 'local', resourceHostId: 'remote' }, toolExecution: { bindingId: 'original-binding', resourceHostId: 'remote', workspacePath: '/original/remote' } }
beforeEach(() => {
  installNoteCanvasGeometry()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 800, width: 1200, height: 800, toJSON() {} })
  close.mockClear()
  config = { ...composerConfig, hosts: [{ id: 'local', kind: 'local', label: 'Studio' }, { id: 'remote', kind: 'ssh', label: 'Studio', hostname: 'controlled.invalid' }],
    workspaces: [{ id: 'local-project', hostId: 'local', name: 'Atlas', path: '/original/local', kind: 'folder' }, { id: 'remote-project', hostId: 'remote', name: 'Atlas', path: '/original/remote', kind: 'folder' }] }
  const tab = createWorkbenchTab('original-tab', { regionId: 'original-region', kind: 'agent', phase: 'attached', workspaceId: 'remote-project', sessionId: ordinary.id })
  useAppStore.setState({ config, activeWorkspaceId: 'local-project', sessions: [ordinary, split, composerSession('ordinary-local')], tabs: { [tab.id]: tab },
    layouts: { 'local-project': createWorkspaceLayout('local-group'), 'remote-project': createWorkspaceLayout('remote-group', [tab.id]) }, spaceZoneBindings: {}, workbenchSpaceSelection: null,
    agentComposerDrafts: { retained: 'Keep the authored input' }, hostChecks: {} })
  vi.spyOn(api.hosts, 'network').mockRejectedValue(new Error('Controlled network observation unavailable'))
})
async function task(value: 'start' | 'existing') {
  const tab = dom.container.querySelector<HTMLButtonElement>(`.remote-work-tasks [role=tab][aria-controls$="-${value}"]`)!
  expect(tab).not.toBeNull(); await act(async () => tab.click())
}
async function pane(visible = true, initialTask: 'start' | 'existing' = 'existing') {
  await dom.render(<SettingsPanel initialSection="remote-execution" visible={visible} onClose={close} />)
  if (visible) await task(initialTask)
}
async function click(text: string) {
  const found = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].filter(node => !node.closest('[hidden],[inert]') && node.textContent?.trim() === text)
  expect(found).toHaveLength(1); await act(async () => found[0]!.click())
}
async function mode(value: string) { await act(async () => dom.container.querySelector<HTMLInputElement>(`input[type=radio][value="${value}"]`)!.click()) }
async function choose(label: string, value: string) {
  await act(async () => dom.container.querySelector<HTMLButtonElement>(`button.selection-field[aria-label="${label}"]`)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
  const item = document.querySelector<HTMLElement>(`[role=menuitemradio][data-value="${value}"]`)
  expect(item).not.toBeNull(); await act(async () => item!.click())
}

it('visiting Remote without any projects keeps existing work available and does not prepare a directory', async () => {
  config = { ...config, workspaces: [] }; useAppStore.setState({ config, activeWorkspaceId: null })
  const home = vi.spyOn(api.hosts, 'home'), register = vi.spyOn(api.workspaces, 'add'), launch = vi.spyOn(api.sessions, 'launchAgent')
  await dom.render(<SettingsPanel initialSection="remote-execution" onClose={close} />)
  expect(dom.container.querySelector('[role=tab][aria-selected=true]')?.textContent).toContain('Existing work')
  expect(dom.container.querySelector('.agent-work-setup')).toBeNull()
  expect(dom.container.querySelector('[data-resource-row="ordinary-remote"]')).not.toBeNull()
  expect(home).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled()
  await dom.click('.remote-work-hosts')
  expect(dom.container.querySelector('[data-settings-pane="hosts"]')).not.toBeNull()
})

it.each(['remote-project', 'remote-agent', 'remote-workspace'] as const)('new %s work can prepare the exact device home without a pre-registered project', async desiredMode => {
  config = { ...config, workspaces: [] }
  useAppStore.setState({ config, activeWorkspaceId: null, tabs: {}, layouts: {} })
  const home = vi.spyOn(api.hosts, 'home').mockImplementation(async host => ({ routeHostId: host.id, homeDirectory: host.id === 'local' ? '/confirmed/local/home' : '/confirmed/remote/home' }))
  const register = vi.spyOn(api.workspaces, 'add').mockImplementation(async request => ({ id: `${request.hostId}-home`, hostId: request.hostId, name: 'Confirmed device home', path: request.path, kind: 'folder' }))
  const open = vi.spyOn(useAppStore.getState(), 'openLauncher'), launch = vi.spyOn(api.sessions, 'launchAgent')
  await pane(true, 'start'); await mode(desiredMode)
  if (desiredMode === 'remote-agent') await choose('Agent runs on', 'remote')
  else await choose('Working folder device', 'remote')
  expect(home).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled()
  const drafts = useAppStore.getState().agentComposerDrafts
  await click('Open in Launcher')
  const resourceWorkspaceId = desiredMode === 'remote-agent' ? 'local-home' : 'remote-home'
  const agentWorkspaceId = desiredMode === 'remote-workspace' ? null : desiredMode === 'remote-agent' ? 'remote-home' : 'local-home'
  expect(open).toHaveBeenCalledExactlyOnceWith({ workspaceId: resourceWorkspaceId, reveal: true, initialExecution: { resourceWorkspaceId, agentWorkspaceId } })
  expect(register.mock.calls.map(([request]) => request)).toEqual(desiredMode === 'remote-agent'
    ? [{ hostId: 'local', path: '/confirmed/local/home' }, { hostId: 'remote', path: '/confirmed/remote/home' }]
    : desiredMode === 'remote-project' ? [{ hostId: 'remote', path: '/confirmed/remote/home' }, { hostId: 'local', path: '/confirmed/local/home' }]
      : [{ hostId: 'remote', path: '/confirmed/remote/home' }])
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  expect(launch).not.toHaveBeenCalled()
})

it('actual Settings catalog unifies Environment with distinct Host and Remote owners while visited Host drafts survive navigation', async () => {
  expect(settingsNavGroups('').slice(0, 3).map(group => [group.id, group.items.map(item => item.id).filter(id => group.id !== 'environment' || ['hosts', 'remote-execution', 'mobile'].includes(id))])).toMatchObject([
    ['preferences', expect.any(Array)], ['environment', ['hosts', 'remote-execution', 'mobile']], ['agents', expect.any(Array)]])
  expect(visibleSettingsSections('remote execution').map(item => item.id)).toContain('remote-execution')
  await dom.render(<SettingsPanel initialSection="hosts" navigationRequest={{ section: 'hosts', hostId: 'remote' }} onClose={close} />)
  const input = dom.container.querySelector<HTMLInputElement>('[data-host-name]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Authored route draft'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await dom.click('.remote-foundation button')
  expect(dom.container.querySelector('[data-settings-pane="remote-execution"] .agent-work-setup')).toBeNull()
  expect(dom.container.querySelector('[role=tab][aria-selected=true]')?.textContent).toContain('Existing work')
  await dom.click('.settings-sidebar [data-settings-target="hosts"]')
  expect(dom.container.querySelector('[data-host-name]')).toBe(input); expect(input.value).toBe('Authored route draft')
})

it('ordinary remote work is discoverable without a synthetic binding and opens its actual original workface', async () => {
  const observe = vi.spyOn(api.sessions, 'observeExecutionBinding'), launch = vi.spyOn(api.sessions, 'launchAgent')
  await pane()
  expect(dom.container.querySelectorAll('.remote-execution-library [data-resource-row]')).toHaveLength(2)
  expect(dom.container.querySelector('[data-resource-row="ordinary-local"]')).toBeNull()
  await dom.click('[data-resource-row="ordinary-remote"]')
  expect(dom.container.querySelector('[data-remote-session="ordinary-remote"]')?.textContent).toContain('Remote Workspace')
  expect(dom.container.querySelector('[data-remote-session="ordinary-remote"]')?.textContent).toContain('/original/remote')
  expect(observe).not.toHaveBeenCalled()
  await click('Open original work')
  expect(useAppStore.getState().activeWorkspaceId).toBe('remote-project'); expect(close).toHaveBeenCalledOnce(); expect(launch).not.toHaveBeenCalled()
})

it('an unknown reference Host remains explicit and does not hide or relabel retained work as local', async () => {
  config = { ...config, hosts: config.hosts.filter(host => host.kind !== 'local') }; useAppStore.setState({ config })
  const launch = vi.spyOn(api.sessions, 'launchAgent'), stop = vi.spyOn(api.sessions, 'stop')
  await pane()
  expect(dom.container.querySelectorAll('.remote-execution-library [data-resource-row]')).toHaveLength(3)
  expect(dom.container.querySelectorAll('.remote-execution-library [data-work-mode="unknown"]')).toHaveLength(3)
  expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
})

it('the same original binding reverses its relative mode only through the current observer projection', async () => {
  const binding = split.toolExecution
  const fromResource = { ...split, hostId: 'remote', control: { ...split.control, hostId: 'remote' }, workPlacement: { agentHostId: 'remote', resourceHostId: 'local' } }
  useAppStore.setState({ sessions: [fromResource] })
  await pane(); await dom.click('[data-resource-row="split-project"]')
  const detail = dom.container.querySelector<HTMLElement>('[data-remote-session="split-project"]')!
  expect(detail.querySelector('[data-work-mode="remote-agent"]')?.getAttribute('data-project-host-id')).toBe('local')
  expect(detail.querySelector('.remote-execution-endpoints')?.textContent).toContain('Studio · local')
  await act(async () => useAppStore.setState({ sessions: [split] }))
  expect(detail.querySelector('[data-work-mode="remote-project"]')?.getAttribute('data-project-host-id')).toBe('remote')
  expect(useAppStore.getState().sessions[0]).toHaveProperty('toolExecution', binding)
  expect(split.toolExecution).toBe(binding)
})

it('an unmapped resource keeps its original Session usable while only its unknown Host link is disabled', async () => {
  const source = { ...ordinary, toolExecution: split.toolExecution, workPlacement: { agentHostId: 'remote', resourceHostId: null } }
  const stop = vi.spyOn(api.sessions, 'stop'), launch = vi.spyOn(api.sessions, 'launchAgent')
  useAppStore.setState({ sessions: [source] })
  await pane(); await dom.click('[data-resource-row="ordinary-remote"]')
  const detail = dom.container.querySelector<HTMLElement>('[data-remote-session="ordinary-remote"]')!
  expect(detail.querySelector('[data-work-mode="unknown"]')).not.toBeNull()
  const links = detail.querySelectorAll<HTMLButtonElement>('.remote-execution-endpoints button')
  expect(links[0]!.disabled).toBe(false); expect(links[1]!.disabled).toBe(true)
  expect(links[1]!.textContent).toBe('Host unknown')
  await click('Open original work')
  expect(useAppStore.getState().activeWorkspaceId).toBe('remote-project'); expect(close).toHaveBeenCalledOnce()
  expect(useAppStore.getState().sessions).toEqual([source]); expect(stop).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled()
})

it('Remote Project uses the shared form and actual Store to prepare the exact two ends without starting work', async () => {
  vi.spyOn(api.hosts, 'home').mockResolvedValue({ routeHostId: 'local', homeDirectory: '/original/local' })
  const open = vi.spyOn(useAppStore.getState(), 'openLauncher'), launch = vi.spyOn(api.sessions, 'launchAgent')
  await pane(true, 'start'); await mode('remote-project'); await choose('Working folder for this arrangement', 'remote-project'); await click('Open in Launcher')
  expect(open).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'remote-project', reveal: true, initialExecution: { resourceWorkspaceId: 'remote-project', agentWorkspaceId: 'local-project' } })
  const state = useAppStore.getState(), tab = state.tabs[open.mock.results[0]!.value!]!
  expect(tab.regions[tab.layout.activeRegionId]).toMatchObject({ kind: 'launcher', workspaceId: 'remote-project', agentWorkspaceId: 'local-project' })
  expect(state.agentComposerDrafts.retained).toBe('Keep the authored input'); expect(state.sessions).toEqual([ordinary, split, composerSession('ordinary-local')]); expect(launch).not.toHaveBeenCalled()
})

it('same-device Remote Workspace keeps the original ordinary target without manufacturing a tool binding', async () => {
  const open = vi.spyOn(useAppStore.getState(), 'openLauncher'), home = vi.spyOn(api.hosts, 'home'), launch = vi.spyOn(api.sessions, 'launchAgent')
  await pane(true, 'start'); await mode('remote-workspace'); await choose('Working folder for this arrangement', 'remote-project'); await click('Open in Launcher')
  expect(open).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'remote-project', reveal: true, initialExecution: { resourceWorkspaceId: 'remote-project', agentWorkspaceId: null } })
  const tab = useAppStore.getState().tabs[open.mock.results[0]!.value!]!
  expect(tab.regions[tab.layout.activeRegionId]).toMatchObject({ kind: 'launcher', workspaceId: 'remote-project' }); expect(tab.regions[tab.layout.activeRegionId]).not.toHaveProperty('agentWorkspaceId')
  expect(home).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled()
})

it('hiding Settings stops only its selected binding reader and retains original identities and disclosure', async () => {
  const stop = vi.fn(), observe = vi.spyOn(api.sessions, 'observeExecutionBinding').mockReturnValue(stop)
  await pane(); await dom.click('[data-resource-row="split-project"]')
  expect(observe).toHaveBeenCalledExactlyOnceWith('original-binding', expect.any(Function), expect.any(Function))
  const detail = dom.container.querySelector<HTMLElement>('[data-remote-session="split-project"]')!, identities = detail.querySelector<HTMLDetailsElement>('.remote-execution-identities')!
  identities.open = true; await pane(false)
  expect(stop).toHaveBeenCalledOnce(); expect(dom.container.querySelector('[data-remote-session="split-project"]')).toBe(detail); expect(identities.open).toBe(true)
  expect(useAppStore.getState().sessions).toEqual([ordinary, split, composerSession('ordinary-local')])
})

it('Host service observation begins only when its disclosure is opened and closes its own pending read', async () => {
  const signals: AbortSignal[] = []
  const inspect = vi.spyOn(api.hosts, 'inspect').mockImplementation((_host, options) => { signals.push(options!.signal!); return new Promise(() => {}) })
  await dom.render(<HostSettingsPane config={config} active onSave={async () => {}} />)
  expect(inspect).not.toHaveBeenCalled()
  const disclosure = [...dom.container.querySelectorAll<HTMLDetailsElement>('.remote-host-section')].find(node => node.querySelector('summary')!.textContent!.startsWith('Service status'))!
  await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')) })
  expect(inspect).toHaveBeenCalledOnce(); expect(signals[0]!.aborted).toBe(false)
  await act(async () => { disclosure.open = false; disclosure.dispatchEvent(new Event('toggle')) })
  expect(signals[0]!.aborted).toBe(true); expect(useAppStore.getState().agentComposerDrafts.retained).toBe('Keep the authored input')
})

it('task views keep the exact preparation nodes and authored arrangement without preparing or launching', async () => {
  const home = vi.spyOn(api.hosts, 'home'), launch = vi.spyOn(api.sessions, 'launchAgent')
  await pane(true, 'start'); await mode('remote-project'); await choose('Working folder for this arrangement', 'remote-project')
  const setup = dom.container.querySelector('.agent-work-setup')!, project = setup.querySelector('[aria-label="Working folder for this arrangement"]')!
  await task('existing')
  expect(setup.isConnected, 'Changing tasks must keep the original preparation nodes mounted').toBe(true)
  expect(setup.closest<HTMLElement>('[role=tabpanel]')!.hidden).toBe(true)
  await task('start')
  expect(dom.container.querySelector('.agent-work-setup')).toBe(setup)
  expect(setup.querySelector('[aria-label="Working folder for this arrangement"]')).toBe(project)
  expect(setup.getAttribute('data-work-mode')).toBe('remote-project')
  expect(project.textContent).toContain('Atlas')
  expect(setup.closest<HTMLElement>('[role=tabpanel]')!.hidden).toBe(false)
  expect(useAppStore.getState().agentComposerDrafts.retained).toBe('Keep the authored input')
  expect(home).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled()
})

it('switching tasks releases the visible binding reader and returns to the same selected detail and disclosure', async () => {
  const stop = vi.fn(), observe = vi.spyOn(api.sessions, 'observeExecutionBinding').mockReturnValue(stop)
  await pane(); await dom.click('[data-resource-row="split-project"]')
  const detail = dom.container.querySelector('[data-remote-session="split-project"]')!, identities = detail.querySelector<HTMLDetailsElement>('details')!
  identities.open = true
  expect(observe).toHaveBeenCalledOnce()
  await task('start'); expect(stop).toHaveBeenCalledOnce()
  expect(detail.closest<HTMLElement>('[role=tabpanel]')!.hidden).toBe(true)
  await task('existing')
  expect(observe).toHaveBeenCalledTimes(2)
  expect(dom.container.querySelector('[data-remote-session="split-project"]')).toBe(detail)
  expect(identities.open).toBe(true)
  expect(dom.container.querySelector('[data-resource-row="split-project"]')!.getAttribute('aria-selected')).toBe('true')
})

it('the task tabs support keyboard selection while precise field deep links reveal their original task', async () => {
  await pane(true, 'start')
  const start = dom.container.querySelector<HTMLButtonElement>('.remote-work-tasks [role=tab][aria-controls$="-start"]')!
  await act(async () => start.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })))
  const existing = dom.container.querySelector<HTMLButtonElement>('.remote-work-tasks [role=tab][aria-controls$="-existing"]')!
  expect(existing.getAttribute('aria-selected')).toBe('true'); expect(document.activeElement).toBe(existing)
  await act(async () => existing.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })))
  expect(start.getAttribute('aria-selected')).toBe('true'); expect(document.activeElement).toBe(start)
  await act(async () => start.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })))
  expect(existing.getAttribute('aria-selected')).toBe('true'); expect(document.activeElement).toBe(existing)
  await dom.render(<SettingsPanel initialSection="remote-execution" navigationRequest={{ section: 'remote-execution', field: 'prepare' }} onClose={close} />)
  expect(start.getAttribute('aria-selected')).toBe('true')
  await dom.render(<SettingsPanel initialSection="remote-execution" navigationRequest={{ section: 'remote-execution', field: 'bindings' }} onClose={close} />)
  expect(existing.getAttribute('aria-selected')).toBe('true')
})
