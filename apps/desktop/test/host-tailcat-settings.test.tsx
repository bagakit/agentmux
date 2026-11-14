// @vitest-environment happy-dom
import { act } from 'react'
import { chooseField } from './helpers/selection-field'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AppConfig, HostConfig, SshHostConfig } from '../src/shared/contracts'
import { parseHostConfiguration, parseHostConfigurations } from '@agentmux/host/host-configuration'
import { NetworkNodeSettingsPane } from '../src/renderer/src/components/settings/NetworkNodeSettingsPane'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { HostSettingsPane } from '../src/renderer/src/components/settings/HostSettingsPane'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

const dom = composerDOM(), onSave = vi.fn<(hosts: HostConfig[], workspaces: AppConfig['workspaces'], expected: Pick<AppConfig, 'hosts' | 'workspaces'>) => Promise<void>>(async () => {})
const remote: SshHostConfig = { id: 'remote-tailcat', kind: 'ssh', label: 'Other Mac', hostname: 'saved.invalid',
  user: 'saved-user', port: 2222, remoteCommand: '/saved/amux', runtimeId: 'original-runtime' }
let config: AppConfig
const checkHost = useAppStore.getState().checkHost
beforeEach(() => {
  installNoteCanvasGeometry()
  config = { ...structuredClone(composerConfig), hosts: [composerConfig.hosts[0]!, structuredClone(remote)] }
  onSave.mockClear()
  useAppStore.setState({ config, sessions: [], hostChecks: {}, checkHost, tailcatConnectionDrafts: {} })
  vi.spyOn(api.hosts, 'configureTailcat').mockResolvedValue({} as never)
  vi.spyOn(api.hosts, 'network').mockRejectedValue(new Error('No local network fixture'))
  vi.spyOn(api.nodePublishing, 'call').mockRejectedValue(new Error('No Node publication fixture'))
})
const show = (hostId = remote.id) => dom.render(<HostSettingsPane config={config} active={true} onSave={onSave} navigationRequest={{ section: 'hosts', hostId }} />)
const node = (hostId = 'local') => dom.render(<NetworkNodeSettingsPane config={config} active={true} onClose={() => {}} onNavigate={() => {}} navigationRequest={{ section: 'network-node', hostId }} />)
const visibleIncoming = () => [...dom.container.querySelectorAll<HTMLElement>('[data-settings-field="incoming"]')].filter(node => !node.hidden && !node.closest('[hidden]') && !node.inert && !node.closest('[inert]'))
function input(label: string) {
  const node = dom.container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)
  expect(node).not.toBeNull()
  return node!
}
async function fill(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function transport(value: string) {
  const field = dom.container.querySelector<HTMLElement>('[aria-label="Connection transport"]')!
  expect(field).not.toBeNull()
  await chooseField(field, value)
}
async function button(text: string) {
  const found = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].filter(node => node.textContent?.trim() === text)
  expect(found).toHaveLength(1)
  await act(async () => found[0]!.click())
}

it('strict Host codec round trips original local/SSH and optional transport records without erasing SSH fields', () => {
  const records: HostConfig[] = [config.hosts[0]!, remote,
    { ...remote, id: 'backup', transport: 'ssh-tailcat', tailcat: { address: 'tcfixturecredential', keyFile: 'saved-client' } },
    { ...remote, id: 'only', hostname: '', transport: 'tailcat', tailcat: { address: 'tcfixturecredential', keyFile: 'saved-client' } }]
  expect(parseHostConfigurations(records)).toEqual({ success: true, data: records })
  for (const record of [
    { ...remote, transport: 'other' },
    { ...remote, transport: 'tailcat' },
    { ...remote, transport: 'tailcat', tailcat: { address: 'not-an-address', keyFile: 'saved-client' } },
    { ...remote, transport: 'ssh-tailcat', hostname: '', tailcat: { address: 'tcfixturecredential', keyFile: 'saved-client' } },
    { ...config.hosts[0], tailcat: { enabled: true, keyFile: 'saved-server', allowedClients: [] } },
    { ...config.hosts[0], tailcat: { enabled: true, keyFile: 'saved-server', allowedClients: ['client'], arbitrary: true } }
  ]) expect(parseHostConfiguration(record).success).toBe(false)
  expect(parseHostConfiguration({ ...remote, transport: 'tailcat', tailcat: { address: 'tcFixture_-0123', keyFile: 'saved-client' } }).success).toBe(true)
  expect(parseHostConfiguration({ ...remote, tailcat: { address: '', keyFile: '' } }).success).toBe(true)
  expect(parseHostConfiguration({ ...config.hosts[0], tailcat: { enabled: false, keyFile: '', allowedClients: [] } }).success).toBe(true)
})

it('keeps an unknown transport raw without inferring SSH or creating a draft', async () => {
  config.hosts[1] = { ...remote, transport: 'other' as never }
  await show()
  const trigger = dom.container.querySelector<HTMLButtonElement>('[aria-label="Connection transport"]')!
  expect(trigger.dataset.value).toBe('other')
  expect(trigger.textContent).toContain('Not in current options')
  expect(trigger.title).toContain('other')
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  await vi.waitFor(() => expect(document.querySelector('[data-missing]')).not.toBeNull())
  expect(document.querySelector('[data-missing]')?.textContent).toContain('Not in current options')
  expect(document.querySelector('[data-missing] [title="other"]')).not.toBeNull()
  await act(async () => document.querySelector<HTMLElement>('[data-missing]')!.click())
  expect(trigger.dataset.value).toBe('other')
  expect(useAppStore.getState().tailcatConnectionDrafts).toEqual({ hostSelection: { hostId: remote.id } })
  expect(onSave).not.toHaveBeenCalled()
  await transport('ssh')
  expect(trigger.dataset.value).toBe('ssh')
})

it('the real Host editor saves Tailcat-only with no SSH hostname and tests the same original bound Host', async () => {
  const test = vi.spyOn(api.hosts, 'check').mockImplementation(async host => ({ input: host, outcome: 'ready', detail: 'Original Runtime confirmed' }))
  const upgrade = vi.spyOn(api.hosts, 'upgradeCheck')
  await show()
  const trigger = dom.container.querySelector<HTMLElement>('[aria-label="Connection transport"]')!
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  await vi.waitFor(() => expect(document.querySelectorAll('.selection-field__menu [role="menuitemradio"]')).toHaveLength(3))
  expect([...document.querySelectorAll('.selection-field__menu [role="menuitemradio"]')].map(node => [node.getAttribute('data-value'), node.textContent])).toEqual([['ssh', 'SSH'], ['ssh-tailcat', 'SSH first, Tailcat backup'], ['tailcat', 'Tailcat only']])
  expect(document.querySelector('.selection-field__search')).toBeNull()
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
  expect(document.querySelector('.selection-field__menu')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(trigger.dataset.value).toBe('ssh')
  expect(useAppStore.getState().tailcatConnectionDrafts).toEqual({ hostSelection: { hostId: remote.id } })
  expect([...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Save hosts')?.disabled).toBe(true)
  const describedBy = trigger.getAttribute('aria-describedby')!.split(/\s+/)
  expect(describedBy).toContain('host-transport-hint')
  expect(describedBy).toHaveLength(2)
  expect(document.getElementById(describedBy.find(id => id !== 'host-transport-hint')!)?.textContent).toContain('SSH')
  expect(document.getElementById('host-transport-hint')?.textContent).toContain('Test verifies this connection.')
  expect(dom.container.querySelector('[data-tailcat-client]')).toBeNull()
  await transport('tailcat')
  expect(trigger.dataset.value).toBe('tailcat')
  expect(useAppStore.getState().tailcatConnectionDrafts).toMatchObject({ hosts: { [remote.id]: { value: { tailcat: { address: '', keyFile: '' } } } } })
  upgrade.mockClear()
  await fill(input('Tailcat address'), 'tcfixturecredential')
  await fill(input('Tailcat client key'), 'saved-client')
  const hostname = [...dom.container.querySelectorAll<HTMLInputElement>('input')].find(node => node.value === remote.hostname)!
  await fill(hostname, '')
  expect(input('Tailcat address').type).toBe('password')
  const expected = { ...remote, hostname: '', transport: 'tailcat', tailcat: { address: 'tcfixturecredential', keyFile: 'saved-client' } }
  await button('Test')
  expect(test).toHaveBeenCalledExactlyOnceWith(expected)
  expect(upgrade).not.toHaveBeenCalled()
  await button('Save hosts')
  expect(onSave).toHaveBeenCalledExactlyOnceWith([config.hosts[0], expected], config.workspaces, { hosts: config.hosts, workspaces: config.workspaces })
  expect(dom.container.querySelector('.settings-resource-editor__header')!.textContent).not.toContain('tcfixturecredential')
})

it('turning Tailcat off preserves its credentials and the complete original SSH command configuration', async () => {
  config.hosts[1] = { ...remote, transport: 'ssh-tailcat', tailcat: { address: 'tcfixturecredential', keyFile: 'saved-client' } }
  await show()
  await transport('ssh')
  expect(dom.container.querySelector('[data-tailcat-client]')).toBeNull()
  await button('Save hosts')
  expect(onSave.mock.calls[0]![0][1]).toEqual({ ...config.hosts[1], transport: 'ssh' })
})

it('the local switch remains a draft until Save incoming connections and displays the original listener failure without closing work', async () => {
  const local = { ...config.hosts[0]!, tailcat: { enabled: true, keyFile: 'saved-server', allowedClients: ['nodekey:fixture'] } } as HostConfig
  config.hosts[0] = local
  const original = composerSession('original-retained')
  useAppStore.setState({ sessions: [original] })
  const inspect = vi.spyOn(api.hosts, 'inspect').mockResolvedValue({ routeHostId: 'local', configuration: local,
    tailcat: { state: 'failed', detail: 'Tailcat CLI could not start. Install it on PATH and re-enable this listener.' } } as never)
  await show('local')
  expect(inspect.mock.calls[0]![0]).toEqual(local)
  expect(dom.container.querySelector('[data-tailcat-listener]')!.textContent).toContain('Tailcat listener · failed')
  expect(dom.container.querySelector('[data-tailcat-listener]')!.textContent).toContain('Install it on PATH')
  expect(onSave).not.toHaveBeenCalled()
  await act(async () => input('Allow Tailcat connections').click())
  expect(dom.container.querySelector('[data-tailcat-listener]')!.textContent).toContain('Save incoming connections to apply')
  const literalAllowed = '  nodekey:fixture  \n'
  await fill(input('Tailcat allowed clients'), literalAllowed)
  const drafts = useAppStore.getState().tailcatConnectionDrafts as { incoming?: Record<string, { value?: HostConfig; allowedText?: string }>; hosts?: Record<string, unknown> }
  expect(drafts.incoming?.local?.value).toMatchObject({ kind: 'local', tailcat: { ...local.tailcat, enabled: false } })
  expect(drafts.incoming?.local?.allowedText).toBe(literalAllowed)
  expect(drafts.hosts?.local).toBeUndefined()
  const saveHosts = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === 'Save hosts')!
  expect(saveHosts.disabled).toBe(true)
  await button('Save incoming connections')
  expect(api.hosts.configureTailcat).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', expected: local.tailcat, candidate: { ...local.tailcat, enabled: false } })
  expect(onSave).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toEqual([original])
})

it('relocates the only visible local listener into the local Host Connection while remote and Node keep their own editors', async () => {
  const local = { ...config.hosts[0]!, tailcat: { enabled: false, keyFile: 'saved-server', allowedClients: [] } } as HostConfig
  config.hosts[0] = local
  vi.spyOn(api.hosts, 'inspect').mockImplementation(async host => ({ routeHostId: host.id, configuration: host, tailcat: { state: 'disabled' } }) as never)
  await show('local')
  expect(dom.container.querySelector('[data-resource-editor="local"][data-host-view="connection"]')).not.toBeNull()
  expect(visibleIncoming()).toHaveLength(1)
  expect(visibleIncoming()[0]!.querySelector('[data-tailcat-listener]')).not.toBeNull()
  await show(remote.id)
  expect(dom.container.querySelector('[data-resource-editor="remote-tailcat"][data-host-view="connection"]')).not.toBeNull()
  expect(dom.container.querySelector('[data-host-name]')).not.toBeNull()
  expect(visibleIncoming()).toHaveLength(0)
})

it('removes the incoming editor from local and remote Node without removing Node management', async () => {
  await node()
  expect(dom.container.querySelector('[aria-label="Node to manage"]')).not.toBeNull()
  expect(dom.container.querySelector('[data-settings-field="incoming"]')).toBeNull()
  config.hosts[1] = { ...remote, runtimeId: 'original-runtime' }
  await node(remote.id)
  expect(dom.container.querySelector('[aria-label="Node to manage"]')).not.toBeNull()
  expect(dom.container.querySelector('[data-settings-field="incoming"]')).toBeNull()
})

it('the local Node assistance link targets publishing while the listener stays in Connection', async () => {
  vi.spyOn(api.hosts, 'inspect').mockImplementation(async host => ({ routeHostId: host.id, configuration: host, tailcat: { state: 'disabled' } }) as never)
  const open = vi.fn()
  await dom.render(<SettingsNavigation.Provider value={{ open, openToolkit: vi.fn(), openHost: vi.fn(), openChannel: vi.fn(), channelEntries: [], channelPresentation: () => null, openMoteLark: vi.fn(), chooseAgent: vi.fn() }}>
    <HostSettingsPane config={config} active={true} onSave={onSave} navigationRequest={{ section: 'hosts', hostId: 'local' }} />
  </SettingsNavigation.Provider>)
  expect(visibleIncoming()).toHaveLength(1)
  await button('Open Node publishing')
  expect(open).toHaveBeenCalledExactlyOnceWith('network-node', undefined, 'publishing', 'local')
})

it('listener address is a masked credential and Copy uses the existing clipboard owner', async () => {
  const local = config.hosts[0]!
  vi.spyOn(api.hosts, 'inspect').mockResolvedValue({ routeHostId: 'local', configuration: local,
    tailcat: { state: 'listening', address: 'tcfixturecredential' } } as never)
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await show('local')
  expect(input('Private Tailcat address').type).toBe('password')
  expect(input('Private Tailcat address').readOnly).toBe(true)
  expect(dom.container.textContent).not.toContain('tcfixturecredential')
  await button('Copy address')
  expect(copy).toHaveBeenCalledExactlyOnceWith('tcfixturecredential')
})
