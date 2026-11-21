// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { HostSettingsPane } from '../src/renderer/src/components/settings/HostSettingsPane'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { composerDOM, composerConfig } from './helpers/composer-dom-fixture'
import type { SettingsNavigationRequest } from '../src/renderer/src/components/SettingsNavigation'
import type { AppConfig } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
const dom = composerDOM()
let config: AppConfig
beforeEach(() => {
  config = { ...composerConfig, hosts: [...composerConfig.hosts,
    { id: 'a', kind: 'ssh', label: 'First', hostname: 'first.invalid' },
    { id: 'b', kind: 'ssh', label: 'Second', hostname: 'second.invalid' }] }
  useAppStore.setState({ config, hostChecks: {}, sessions: [] })
})
const render = async (request: SettingsNavigationRequest) => {
  await act(async () => useAppStore.setState({ config }))
  await dom.render(<SettingsPanel navigationRequest={request} onClose={vi.fn()} />)
  expect(dom.container.querySelector('[data-cluster-node-panel="mesh-devices"]')?.closest('[hidden]')).toBeNull()
}
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
it('consumes the original settings module route by stable Host ID and preserves drafts through another and repeated route', async () => {
  await render({ section: 'hosts', hostId: 'b' })
  expect(dom.container.querySelector('[data-resource-editor]')!.getAttribute('data-resource-editor')).toBe('b')
  await fill(dom.container.querySelector<HTMLInputElement>('[data-host-name]')!, 'Authored second draft')
  await render({ section: 'hosts', hostId: 'a' })
  expect(dom.container.querySelector('[data-resource-editor]')!.getAttribute('data-resource-editor')).toBe('a')
  await render({ section: 'hosts', hostId: 'b' })
  expect(dom.container.querySelector<HTMLInputElement>('[data-host-name]')!.value).toBe('Authored second draft')
  await fill(dom.container.querySelector<HTMLInputElement>('[aria-label="Filter hosts"]')!, 'First')
  await render({ section: 'hosts', hostId: 'b' })
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Filter hosts"]')!.value).toBe('')
  expect(dom.container.querySelector<HTMLInputElement>('[data-host-name]')!.value).toBe('Authored second draft')
})
it('does not select an arbitrary connection when an explicitly requested Host no longer exists', async () => {
  await render({ section: 'hosts', hostId: 'missing-host' })
  expect(dom.container.querySelector('[data-resource-editor]')).toBeNull()
  expect(dom.container.textContent).toContain('Connection no longer available')
  expect(dom.container.textContent).toContain('missing-host')
})

it('does not launch maintenance for a hidden connection editor after returning to the library', async () => {
  const call = vi.spyOn(api.hosts, 'upgradeCheck').mockImplementation(async input => ({ input, eligible: false, reason: 'unverified',
    detail: 'Controlled observation', current: { state: 'unavailable', observedAt: Date.now(), code: 'CONTROL_UNAVAILABLE', detail: 'Private observation unavailable' }, candidate: null }))
  const request: SettingsNavigationRequest = { section: 'hosts', hostId: 'a' }
  await render(request)
  expect(call).toHaveBeenCalledTimes(1)
  await dom.click('.settings-resource-back')
  expect(dom.container.querySelector('[data-resource-view]')!.getAttribute('data-resource-view')).toBe('library')
  config = { ...config, hosts: config.hosts.map(host => host.id === 'a' ? { ...host, hostname: 'replacement.invalid' } : host) }
  await render(request)
  expect(call).toHaveBeenCalledTimes(1)
  await dom.click('[data-host-disclosure="a"] [data-host-panel="connection"]')
  expect(call).toHaveBeenCalledTimes(2)
  expect(call.mock.calls[1]![0]).toMatchObject({ id: 'a', hostname: 'replacement.invalid' })
})

it('automatically checks a newly added SSH connection only after its exact input is saved', async () => {
  const call = vi.spyOn(api.hosts, 'upgradeCheck').mockImplementation(async input => ({ input, eligible: false, reason: 'unverified',
    detail: 'Controlled observation', current: { state: 'unavailable', observedAt: Date.now(), code: 'CONTROL_UNAVAILABLE', detail: 'Private observation unavailable' }, candidate: null }))
  const onSave = vi.fn(async (hosts: AppConfig['hosts']) => { config = { ...config, hosts } })
  const show = () => dom.render(<HostSettingsPane config={config} active onSave={onSave} />)
  await show()
  await dom.click('[data-add-host]')
  const id = dom.container.querySelector('[data-resource-editor]')!.getAttribute('data-resource-editor')!
  await fill(dom.container.querySelectorAll<HTMLInputElement>('.host-edit-grid--basic input')[1]!, 'new-saved.invalid')
  expect(call).not.toHaveBeenCalled()
  await dom.click('[data-resource-view] > [data-settings-save-bar] button')
  expect(onSave).toHaveBeenCalledTimes(1)
  await show()
  expect(call).toHaveBeenCalledTimes(1)
  expect(call.mock.calls[0]![0]).toMatchObject({ id, hostname: 'new-saved.invalid' })
})
