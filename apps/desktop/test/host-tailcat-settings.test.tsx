// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AppConfig, HostConfig, SshHostConfig } from '../src/shared/contracts'
import { parseHostConfiguration, parseHostConfigurations } from '@agentmux/host/host-configuration'
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
  useAppStore.setState({ sessions: [], hostChecks: {}, checkHost })
})
const show = (hostId = remote.id) => dom.render(<HostSettingsPane config={config} active={true} onSave={onSave} navigationRequest={{ section: 'hosts', hostId }} />)
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
  const select = dom.container.querySelector<HTMLSelectElement>('[aria-label="Connection transport"]')!
  expect(select).not.toBeNull()
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
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

it('the real Host editor saves Tailcat-only with no SSH hostname and tests the same original bound Host', async () => {
  const test = vi.spyOn(api.hosts, 'check').mockImplementation(async host => ({ input: host, outcome: 'ready', detail: 'Original Runtime confirmed' }))
  const upgrade = vi.spyOn(api.hosts, 'upgradeCheck')
  await show()
  expect(dom.container.querySelector<HTMLSelectElement>('[aria-label="Connection transport"]')!.value).toBe('ssh')
  expect(dom.container.querySelector('[data-tailcat-client]')).toBeNull()
  await transport('tailcat')
  expect(dom.container.querySelector<HTMLSelectElement>('[aria-label="Connection transport"]')!.value).toBe('tailcat')
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

it('the local switch remains a draft until Save hosts and displays the original listener failure without closing work', async () => {
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
  expect(dom.container.querySelector('[data-tailcat-listener]')!.textContent).toContain('Save hosts to apply')
  await button('Save hosts')
  expect(onSave.mock.calls[0]![0][0]).toEqual({ ...local, tailcat: { ...local.tailcat, enabled: false } })
  expect(useAppStore.getState().sessions).toEqual([original])
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
