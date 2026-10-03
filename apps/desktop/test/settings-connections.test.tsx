import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig, HostConfig, HostCheckResult, SshHostConfig } from '../src/shared/contracts'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { HostSettingsPane } from '../src/renderer/src/components/settings/HostSettingsPane'
import { hostsSettingsModule } from '../src/renderer/src/components/settings/modules/hosts'
import { devicesSettingsModule } from '../src/renderer/src/components/settings/modules/devices'
import { settingsModules, settingsNavGroups, visibleSettingsSections } from '../src/renderer/src/components/settings/settings-modules'
import type { SettingsPageId } from '../src/renderer/src/components/settings/settings-modules'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { connectionsConfig, deviceInvitation, deviceList } from '../scripts/fixtures/settings-connections/data'

const dom = composerDOM(), H = 'host-01', J = 'host-02'
const originalCheckHost = useAppStore.getState().checkHost
let config: AppConfig, unsubscribe: (() => void) | undefined
beforeEach(async () => {
  const before = await api.config.get()
  config = await api.config.save(connectionsConfig(before), before)
  useAppStore.setState({ config, providerCatalog: await api.providers.list(), sessions: [], sessionSnapshots: {},
    activeWorkspaceId: 'project-a', hostChecks: {}, checkHost: originalCheckHost })
  unsubscribe = api.config.onChange(next => useAppStore.setState({ config: next }))
  vi.spyOn(api.deviceManagement, 'ls').mockResolvedValue(structuredClone(deviceList))
})
afterEach(() => unsubscribe?.())
function LiveHost() {
  const current = useAppStore(state => state.config)!, Pane = hostsSettingsModule.Pane
  return <div className="settings-page"><Pane config={current} active={true} onClose={() => {}} /></div>
}
function Shell({ section }: { section: SettingsPageId }) {
  return <SettingsPanel initialSection={section} onClose={() => {}} />
}
const pane = () => dom.container.querySelector<HTMLElement>('[data-settings-pane="hosts"]') ?? dom.container
const editor = () => pane().querySelector<HTMLElement>('[data-resource-editor]')!
const name = () => editor().querySelector<HTMLInputElement>('[data-host-name]')!
const search = () => pane().querySelector<HTMLInputElement>('[aria-label="Filter hosts"]')!
function field(label: string): HTMLInputElement {
  const node = [...editor().querySelectorAll('label')].find(node => node.querySelector('span')?.textContent?.startsWith(label))?.querySelector<HTMLInputElement>('input')
  expect(node, `Original Host field ${label} exists`).toBeDefined(); return node!
}
async function fill(node: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function select(id: string, panel = 'connection') {
  const node = pane().querySelector<HTMLButtonElement>(`[data-host-disclosure="${id}"] [data-host-panel="${panel}"]`)!
  expect(node).not.toBeNull(); await act(async () => node.click())
}
async function toggleAdvanced(open: boolean) {
  const node = editor().querySelector<HTMLDetailsElement>('.host-edit-disclosure')!
  // Happy DOM only prepares disclosure state; actual trusted native activation is the Renderer gate.
  await act(async () => { node.open = open; node.dispatchEvent(new Event('toggle')) })
}
async function save() { await dom.click('[data-settings-save-bar] button'); await act(async () => {}) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

describe('Connections settings', () => {
  it('catalog: every navigation projection has the same Connections contributions without authorization guesses', async () => {
    const groups = settingsNavGroups(''), connections = groups.find(group => group.id === 'connections')
    expect(connections?.items.map(item => item.id), 'Connections group owns exactly hosts and devices').toEqual(['hosts', 'devices'])
    expect(groups.find(group => group.id === 'resources')!.items.some(item => item.id === 'hosts' || item.id === 'devices')).toBe(false)
    expect(visibleSettingsSections('手机').map(item => item.id)).toContain('devices')
    expect(visibleSettingsSections('ssh').map(item => item.id)).toContain('hosts')
    expect(new Set(settingsModules.map(item => item.id)).size).toBe(settingsModules.length)
    expect(devicesSettingsModule.savedSummary()).toBe('Pairing & access')
    await dom.render(<Shell section="overview" />)
    expect(dom.container.querySelector('#settings-overview-connections')).not.toBeNull()
    expect(dom.container.querySelector('[data-settings-section="devices"]')).not.toBeNull()
    expect(dom.container.querySelectorAll('[data-settings-pane]')).toHaveLength(0)
    expect(api.deviceManagement.ls).not.toHaveBeenCalled()
  })
  it('single: mounts only the exact current connection fields and Projects uses its own committed Host form', async () => {
    await dom.render(<LiveHost />)
    expect(pane().querySelectorAll('[data-host-disclosure]')).toHaveLength(24)
    expect(pane().querySelectorAll('.host-connection-fields'), 'Only the selected Host has an editable connection subtree').toHaveLength(0)
    await select(H)
    expect(pane().querySelectorAll('.host-connection-fields'), 'Only the selected Host has an editable connection subtree').toHaveLength(1)
    expect(pane().querySelectorAll('[data-resource-editor]')).toHaveLength(1)
    expect(editor().dataset.resourceEditor).toBe(H)
    expect(field('Bound Runtime ID').readOnly).toBe(true)
    await select(H, 'projects')
    expect(pane().querySelectorAll('.host-connection-fields')).toHaveLength(0)
    expect(pane().querySelectorAll('[data-resource-editor]')).toHaveLength(1)
    expect(editor().dataset.hostView).toBe('projects')
    expect(pane().querySelector('[data-host-projects="host-01"]')).not.toBeNull()
    expect(pane().querySelectorAll('[data-host-projects]:not([hidden])')).toHaveLength(1)
    expect(document.activeElement).toBe(editor())
  })
  it('drafts: same-ID panel switching and B/A keep every authored field and per-ID disclosure', async () => {
    await dom.render(<LiveHost />); await select(H); await toggleAdvanced(true)
    const values = { Name: 'Authored connection', 'Host or SSH alias': 'literal-alias', User: 'authored-user', Port: '2201',
      'Identity file path': '~/.ssh/authored key', 'Service command': (_hygiene_fixturePath("opt/authored") + " --literal"), 'Service socket path': _hygiene_fixturePath("srv/authored.sock") }
    for (const [label, value] of Object.entries(values)) await fill(field(label), value)
    await select(H, 'projects'); await select(J); await select(H)
    expect(name().value, 'Submenu selection preserves the original authored Host draft').toBe(values.Name)
    for (const [label, value] of Object.entries(values)) expect(field(label).value).toBe(value)
    expect(field('Bound Runtime ID').value).toBe('controlled-bound-runtime')
    expect(editor().querySelector<HTMLDetailsElement>('.host-edit-disclosure')!.open).toBe(true)
    const input = field('User'); input.focus()
    for (const value of ['x', 'xy', 'xyz']) {
      await fill(input, value)
      expect(field('User')).toBe(input); expect(input.isConnected).toBe(true); expect(document.activeElement).toBe(input)
      expect(editor().querySelector<HTMLDetailsElement>('.host-edit-disclosure')!.open).toBe(true)
    }
    await save()
    expect((await api.config.get()).hosts.find(host => host.id === H)).toMatchObject({ label: values.Name, hostname: values['Host or SSH alias'],
      user: 'xyz', port: 2201, identityFile: values['Identity file path'], remoteCommand: values['Service command'], remoteSocketPath: values['Service socket path'] })
  })
  it('projects use exact workspace host IDs even with duplicate names and identical project paths', async () => {
    await dom.render(<LiveHost />); await select(H, 'projects')
    expect(config.hosts.find(host => host.id === H)!.label).toBe(config.hosts.find(host => host.id === J)!.label)
    expect(pane().querySelector(`[data-host-projects="${editor().dataset.resourceEditor}"]`)!.textContent).toContain('Application on A')
    expect(pane().querySelector(`[data-host-projects="${editor().dataset.resourceEditor}"]`)!.textContent).not.toContain('Application on B')
    expect(pane().querySelectorAll(`[data-host-projects="${editor().dataset.resourceEditor}"] [data-registered-folder]`)).toHaveLength(2)
    await select(J, 'projects')
    expect(pane().querySelector(`[data-host-projects="${editor().dataset.resourceEditor}"]`)!.textContent).toContain('Application on B')
    expect(pane().querySelector(`[data-host-projects="${editor().dataset.resourceEditor}"]`)!.textContent).not.toContain('Application on A')
    expect(pane().querySelectorAll(`[data-host-projects="${editor().dataset.resourceEditor}"] [data-registered-folder]`)).toHaveLength(1)
    expect(pane().querySelector(`[data-host-projects="${J}"] code`)!.textContent).toBe(_hygiene_fixturePath("controlled/shared"))
    await select('host-03', 'projects'); expect(pane().querySelector('[data-host-projects="host-03"]')!.textContent).toContain('No projects yet')
    expect(api.deviceManagement.ls).not.toHaveBeenCalled()
  })
  it('search retains exact selected identity through each rename and filtering never selects a neighbor', async () => {
    await dom.render(<LiveHost />); await select(H); await fill(search(), H)
    const input = name(); input.focus()
    for (const value of ['x', 'xy', 'xyz']) {
      await fill(input, value)
      expect(name()).toBe(input); expect(input.isConnected).toBe(true); expect(document.activeElement).toBe(input)
      expect(pane().querySelector(`[data-host-disclosure="${H}"]`)).not.toBeNull()
      expect(pane().querySelectorAll('[data-host-disclosure]')).toHaveLength(1)
    }
    await fill(search(), J)
    expect(editor().dataset.resourceEditor).toBe(H); expect(name().value).toBe('xyz')
    await dom.click('.settings-resource-back')
    expect(search().value).toBe(''); expect(document.activeElement).toBe(pane().querySelector(`[data-host-disclosure="${H}"] [data-host-panel="connection"]`))
  })
  it('visited Host instance and draft survive devices while hidden reads stop and short invitations clear', async () => {
    vi.spyOn(api.deviceManagement, 'invite').mockResolvedValue(structuredClone(deviceInvitation))
    await dom.render(<Shell section="hosts" />); await select(H); await toggleAdvanced(true); await fill(name(), 'Across device section')
    const originalPane = pane(), originalField = name(), originalDisclosure = editor().querySelector('.host-edit-disclosure')
    await dom.click('[data-settings-target="devices"]')
    expect(api.deviceManagement.ls).toHaveBeenCalledExactlyOnceWith({})
    expect(pane()).toBe(originalPane); expect(originalPane.hidden).toBe(true); expect(originalField.isConnected).toBe(true)
    const invite = [...dom.container.querySelectorAll<HTMLButtonElement>('[data-settings-pane="devices"] button')].find(node => node.textContent?.includes('生成短时邀请'))!
    await act(async () => invite.click())
    expect(api.deviceManagement.invite).toHaveBeenCalledExactlyOnceWith({})
    expect(dom.container.querySelector('[aria-label="短时设备邀请"]')).not.toBeNull()
    await dom.click('[data-settings-target="hosts"]')
    expect(pane()).toBe(originalPane); expect(name()).toBe(originalField); expect(name().value).toBe('Across device section')
    expect(editor().querySelector('.host-edit-disclosure')).toBe(originalDisclosure)
    expect((originalDisclosure as HTMLDetailsElement).open).toBe(true)
    expect(dom.container.querySelector('[aria-label="短时设备邀请"]')).toBeNull()
    const reads = vi.mocked(api.deviceManagement.ls).mock.calls.length
    await fill(field('Host or SSH alias'), 'hidden-device-no-read')
    await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, appearance: { ...state.config!.appearance, terminalFontSize: 17 } } })))
    await select(H, 'projects'); await select(H)
    expect(api.deviceManagement.ls).toHaveBeenCalledTimes(reads)
    await dom.click('[data-settings-target="devices"]')
    expect(api.deviceManagement.ls).toHaveBeenCalledTimes(reads + 1)
    expect(dom.container.querySelector('[aria-label="短时设备邀请"]')).toBeNull()
    expect(api.deviceManagement.invite).toHaveBeenCalledTimes(1)
  })
  it('captures complete Host Test and never reuses Ready after a later input', async () => {
    await dom.render(<LiveHost />); await select(H); await toggleAdvanced(true)
    const held = deferred<HostCheckResult>(), check = vi.spyOn(api.hosts, 'check').mockReturnValueOnce(held.promise)
    for (const [label, value] of Object.entries({ 'Host or SSH alias': 'controlled-alias', User: 'typed-user', Port: '2301',
      'Identity file path': '~/.ssh/captured', 'Service command': _hygiene_fixturePath("opt/captured"), 'Service socket path': _hygiene_fixturePath("srv/captured.sock") })) await fill(field(label), value)
    await act(async () => [...editor().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Test')!.click())
    const captured: SshHostConfig = { ...(config.hosts.find(host => host.id === H) as SshHostConfig), hostname: 'controlled-alias', user: 'typed-user',
      port: 2301, identityFile: '~/.ssh/captured', remoteCommand: _hygiene_fixturePath("opt/captured"), remoteSocketPath: _hygiene_fixturePath("srv/captured.sock") }
    expect(check.mock.calls[0]![0]).toEqual(captured)
    await select(H, 'projects'); await select(H)
    expect(check).toHaveBeenCalledTimes(1)
    await fill(field('Service socket path'), _hygiene_fixturePath("srv/later.sock"))
    await act(async () => held.resolve({ input: captured, outcome: 'ready', detail: 'Controlled service readback' }))
    expect(editor().querySelector('[role="status"]')!.textContent).toBe('Not tested')
    expect(useAppStore.getState().hostChecks[H]!.input).toEqual(captured)
  })
  it('keeps original pending, clean merge, conflict and externally deleted Host save facts', async () => {
    await dom.render(<LiveHost />); await select(H)
    await fill(name(), 'First submission')
    const held = deferred<void>(), realSave = api.config.save.bind(api.config)
    const spy = vi.spyOn(api.config, 'save').mockImplementationOnce(async (next, expected) => { const accepted = await realSave(next, expected); await held.promise; return accepted })
    await dom.click('[data-settings-save-bar] button'); await fill(name(), 'Development')
    await act(async () => held.resolve()); await act(async () => {})
    expect(name().value).toBe('Development'); await save()
    expect(spy.mock.calls[1]![1]!.hosts.find(host => host.id === H)!.label).toBe('First submission')
    await fill(name(), 'Local authored')
    let current = await api.config.get()
    await act(async () => realSave({ ...current, hosts: current.hosts.map(host => host.id === H && host.kind === 'ssh' ? { ...host, user: 'external-clean' } : host) }, current)); await save()
    expect(spy.mock.calls.at(-1)![1]!.hosts.find(host => host.id === H)).toMatchObject({ user: 'external-clean' })
    await fill(name(), 'Local conflict'); current = await api.config.get()
    await act(async () => realSave({ ...current, hosts: current.hosts.map(host => host.id === H ? { ...host, label: 'External conflict' } : host) }, current)); await save()
    expect(name().value).toBe('Local conflict'); expect(pane().querySelector('[role="alert"]')!.textContent).toContain(`hosts.${H}.label`)
    current = await api.config.get()
    await act(async () => realSave({ ...current, hosts: current.hosts.filter(host => host.id !== H) }, current)); await save()
    expect(name().value).toBe('Local conflict'); expect(pane().querySelector('[role="alert"]')!.textContent).toContain(`hosts.${H}`)
  })
  it('preserves exact workspace removal confirmation, cancel and Session reference protection', async () => {
    await dom.render(<LiveHost />); await select(H)
    await dom.click('[aria-label="Remove Development"]')
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('2 linked workspace registrations')
    await act(async () => document.querySelector<HTMLButtonElement>('.confirmation-dialog__cancel')!.click())
    expect((await api.config.get()).hosts.some(host => host.id === H)).toBe(true)
    const session = { ...composerSession('existing-reference'), hostId: H }
    await act(async () => useAppStore.setState({ sessions: [session] }))
    expect(editor().querySelector<HTMLButtonElement>('[aria-label="Remove Development"]')!.disabled).toBe(true)
    expect(editor().textContent).toContain('1 Session reference')
  })
  it('filtered removal keeps the original writer and accurate connected return destinations', async () => {
    await dom.render(<LiveHost />); await select(H); await fill(search(), H)
    // Programmatic Happy DOM click does not focus its native trigger. Prepare that exact original target,
    // matching the separately qualified Renderer click before the original dialog captures previousFocus.
    const remove = pane().querySelector<HTMLButtonElement>('[aria-label="Remove Development"]')!
    remove.focus(); expect(document.activeElement).toBe(remove)
    await dom.click('[aria-label="Remove Development"]')
    await act(async () => document.querySelector<HTMLButtonElement>('[data-confirm-label="Remove Host"]')!.click())
    expect(search().value).toBe(''); expect(editor().dataset.resourceEditor).toBe('local')
    const leaf = pane().querySelector<HTMLButtonElement>('[data-host-disclosure="local"] [data-host-panel="connection"]')!
    // The exact native focus/visibility contract is checked by the same-input Chromium deletion gate.
    // Happy DOM's dialog close focus is explicitly unknown; BODY is never accepted as focus success.
    expect(leaf.isConnected).toBe(true); expect(leaf.dataset.resourceRow).toBe('local')
    expect((await api.config.get()).workspaces.map(workspace => workspace.id)).toEqual(['project-c'])
    const last = config.hosts.find(host => host.id === J)!
    await dom.render(<HostSettingsPane config={{ ...config, hosts: [last], workspaces: [] }} active={true} onSave={async () => {}} />)
    const lastRemove = pane().querySelector<HTMLButtonElement>('[aria-label="Remove Development"]')!
    lastRemove.focus(); expect(document.activeElement).toBe(lastRemove)
    await dom.click('[aria-label="Remove Development"]')
    await act(async () => document.querySelector<HTMLButtonElement>('[data-confirm-label="Remove Host"]')!.click())
    expect(pane().querySelectorAll('[data-resource-editor]')).toHaveLength(0)
    // Sole-SSH props exercise a component empty state, not a valid Main configuration or native focus.
    expect(search().isConnected).toBe(true)
  })
})
