// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { TailcatKeyPreparation } from '@agentmux/core'
import type { AppConfig, HostConfig, SshHostConfig } from '../src/shared/contracts'
import { HostSettingsPane } from '../src/renderer/src/components/settings/HostSettingsPane'
import { NetworkNodeSettingsPane } from '../src/renderer/src/components/settings/NetworkNodeSettingsPane'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

const dom = composerDOM(), onSave = vi.fn(async (_hosts: HostConfig[], _workspaces: AppConfig['workspaces'], _expected: Pick<AppConfig, 'hosts' | 'workspaces'>) => {})
const remote: SshHostConfig = { id: 'studio', kind: 'ssh', label: 'Studio Mac', hostname: '', transport: 'tailcat', tailcat: { address: 'tc-retained-private-address', keyFile: 'saved-client' }, runtimeId: 'original-runtime' }
const publicKey = 'nodekey:' + 'ab'.repeat(32)
let config: AppConfig
beforeEach(() => {
  installNoteCanvasGeometry()
  config = { ...structuredClone(composerConfig), hosts: [structuredClone(composerConfig.hosts[0]!), structuredClone(remote)] }
  useAppStore.setState({ config, sessions: [], hostChecks: {} }); onSave.mockClear()
  vi.spyOn(api.hosts, 'inspect').mockImplementation(async host => ({ routeHostId: host.id, configuration: host, tailcat: { state: 'disabled' } }) as never)
  vi.spyOn(api.hosts, 'network').mockRejectedValue(new Error('Local network not observed in this controlled connection test'))
  vi.spyOn(api.nodePublishing, 'call').mockRejectedValue(new Error('Publication identity is outside this incoming-connection test'))
  vi.spyOn(api.config, 'save').mockImplementation(async next => next)
})
const show = (hostId = 'studio') => hostId === 'local'
  ? dom.render(<NetworkNodeSettingsPane config={config} active={true} onSave={async () => {}} onNavigate={() => {}} navigationRequest={{ section: 'network-node', hostId }} />)
  : dom.render(<HostSettingsPane config={config} active={true} onSave={onSave} navigationRequest={{ section: 'hosts', hostId }} />)
const input = (label: string) => dom.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
async function click(text: string) {
  const buttons = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].filter(node => node.textContent?.trim() === text)
  expect(buttons).toHaveLength(1)
  await act(async () => buttons[0]!.click())
}
async function fill(label: string, value: string) {
  const node = input(label)
  await act(async () => {
    Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const prepared = (role: 'server' | 'client', key = 'agentmux-' + role): TailcatKeyPreparation => ({ role, key, created: role === 'server', ...(role === 'client' ? { publicKey } : {}) })

it('the receiving Mac prepares its missing server key as a draft, focuses approval, and saves only after the user supplies a connection code', async () => {
  const prepare = vi.spyOn(api.hosts, 'prepareTailcatKey').mockResolvedValue(prepared('server'))
  await show('local')
  await click('Prepare this Mac to receive')
  expect(prepare).toHaveBeenCalledExactlyOnceWith({ role: 'server' })
  expect(input('Tailcat server key').value).toBe('agentmux-server')
  expect((input('Allow Tailcat connections') as HTMLInputElement).checked).toBe(true)
  expect(document.activeElement).toBe(input('Tailcat allowed clients'))
  expect(onSave).not.toHaveBeenCalled()
  expect(input('Tailcat allowed clients').value).toBe('')
  await fill('Tailcat allowed clients', publicKey)
  await click('Save incoming connections')
  expect(api.config.save).toHaveBeenCalledOnce()
  expect(vi.mocked(api.config.save).mock.calls[0]![0].hosts[0]).toEqual({ ...config.hosts[0], tailcat: { keyFile: 'agentmux-server', enabled: true, allowedClients: [publicKey] } })
})

it('the sending Mac reuses its chosen key, copies only the public code, and keeps the private destination and Runtime binding', async () => {
  const prepare = vi.spyOn(api.hosts, 'prepareTailcatKey').mockResolvedValue(prepared('client', 'studio.client'))
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await show()
  await fill('Tailcat client key', 'studio.client')
  await click('Use this Mac’s key')
  expect(prepare).toHaveBeenCalledExactlyOnceWith({ role: 'client', key: 'studio.client' })
  expect(input('This Mac’s connection code').readOnly).toBe(true)
  expect(input('This Mac’s connection code').value).toBe(publicKey)
  expect(input('Tailcat address').value).toBe(remote.tailcat!.address)
  await click('Copy code')
  expect(copy).toHaveBeenCalledExactlyOnceWith(publicKey)
  expect(dom.container.textContent).toContain('Reusing key')
  expect(onSave).not.toHaveBeenCalled()
  await click('Save hosts')
  expect(onSave.mock.calls[0]![0][1]).toEqual({ ...remote, tailcat: { ...remote.tailcat!, keyFile: 'studio.client' } })
})

it('an empty client field uses the Host default while a later destination edit survives an outstanding preparation', async () => {
  let finish!: (value: TailcatKeyPreparation) => void
  const prepare = vi.spyOn(api.hosts, 'prepareTailcatKey').mockImplementationOnce(() => new Promise(done => { finish = done })).mockResolvedValue(prepared('client'))
  await show()
  await fill('Tailcat client key', '')
  await click('Use this Mac’s key')
  await fill('Tailcat address', 'tc-new-private-address')
  await act(async () => finish(prepared('client')))
  expect(input('Tailcat address').value).toBe('tc-new-private-address')
  expect(input('Tailcat client key').value).toBe('')
  expect(dom.container.textContent).toContain('Your later draft edits were kept')
  await click('Use this Mac’s key')
  expect(input('Tailcat client key').value).toBe('agentmux-client')
  expect(input('Tailcat address').value).toBe('tc-new-private-address')
  expect(prepare).toHaveBeenCalledTimes(2)
})

it('a later approval edit cannot be overwritten or enabled by an earlier server preparation', async () => {
  let finish!: (value: TailcatKeyPreparation) => void
  vi.spyOn(api.hosts, 'prepareTailcatKey').mockImplementation(() => new Promise(done => { finish = done }))
  const original = composerSession('healthy-original')
  useAppStore.setState({ sessions: [original] })
  await show('local')
  await click('Prepare this Mac to receive')
  await fill('Tailcat allowed clients', publicKey)
  await act(async () => finish(prepared('server')))
  expect(input('Tailcat allowed clients').value).toBe(publicKey)
  expect(input('Tailcat server key').value).toBe('')
  expect((input('Allow Tailcat connections') as HTMLInputElement).checked).toBe(false)
  expect(useAppStore.getState().sessions).toEqual([original])
})

it('missing CLI and copy failures stay local and retryable without clearing custom fields or saving the Host', async () => {
  const prepare = vi.spyOn(api.hosts, 'prepareTailcatKey').mockRejectedValueOnce(Object.assign(new Error('Original serving environment error'), { code: 'TAILCAT_CLI_MISSING' })).mockResolvedValue(prepared('client', 'custom-client'))
  config.hosts[1] = { ...remote, tailcat: { ...remote.tailcat!, keyFile: 'custom-client' } }
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockRejectedValue(new Error('Clipboard unavailable'))
  await show()
  await click('Use this Mac’s key')
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('Install the official Tailcat CLI')
  expect(input('Tailcat client key').value).toBe('custom-client')
  expect(input('Tailcat address').value).toBe(remote.tailcat!.address)
  await click('Use this Mac’s key')
  expect(prepare).toHaveBeenCalledTimes(2)
  await click('Copy code')
  expect(copy).toHaveBeenCalledExactlyOnceWith(publicKey)
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('Copy failed')
  expect(onSave).not.toHaveBeenCalled()
})
