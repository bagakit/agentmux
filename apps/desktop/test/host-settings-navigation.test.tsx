// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { hostsSettingsModule } from '../src/renderer/src/components/settings/modules/hosts'
import { composerDOM, composerConfig } from './helpers/composer-dom-fixture'
import type { SettingsNavigationRequest } from '../src/renderer/src/components/SettingsNavigation'
import type { AppConfig } from '../src/shared/contracts'
import { useAppStore } from '../src/renderer/src/store'
const dom = composerDOM()
let config: AppConfig
beforeEach(() => {
  config = { ...composerConfig, hosts: [...composerConfig.hosts,
    { id: 'a', kind: 'ssh', label: 'First', hostname: 'first.invalid' },
    { id: 'b', kind: 'ssh', label: 'Second', hostname: 'second.invalid' }] }
  useAppStore.setState({ config, hostChecks: {}, sessions: [] })
})
const render = (request: SettingsNavigationRequest) => {
  const Pane = hostsSettingsModule.Pane
  return dom.render(<Pane config={config} active={true} onClose={vi.fn()} onNavigate={vi.fn()} navigationRequest={request} />)
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
