// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AppConfig, SshHostConfig } from '../src/shared/contracts'
import { HostSettingsPane } from '../src/renderer/src/components/settings/HostSettingsPane'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { selectSettingsHost } from './helpers/settings-host-ui'

const dom = composerDOM()
const saved: SshHostConfig = { id: '10', kind: 'ssh', label: 'Saved remote', hostname: 'saved.invalid' }
const neighbor: SshHostConfig = { id: '2', kind: 'ssh', label: 'Neighbor', hostname: 'neighbor.invalid' }
let config: AppConfig
const onSave = vi.fn(async () => {})
beforeEach(() => {
  config = { ...structuredClone(composerConfig), hosts: [composerConfig.hosts[0]!, saved, neighbor] }
  useAppStore.setState({ config, sessions: [], hostChecks: {}, checkHost: vi.fn(async () => {}) })
  onSave.mockClear()
})
const render = () => dom.render(<HostSettingsPane active={true} config={config} onSave={onSave} />)
const select = (id = saved.id) => selectSettingsHost(dom.container, id)
function card() {
  const found = dom.container.querySelectorAll<HTMLElement>('.host-settings-card')
  expect(found).toHaveLength(1)
  return found[0]!
}
function disclosure() {
  const node = card().querySelector<HTMLDetailsElement>('.host-edit-disclosure')
  expect(node).not.toBeNull()
  return node!
}
function hostname() {
  const label = [...card().querySelectorAll<HTMLLabelElement>('.host-edit-grid--basic label')]
    .find(node => node.querySelector('span')?.textContent?.startsWith('Host or SSH alias'))
  expect(label).toBeDefined()
  return label!.querySelector<HTMLInputElement>('input')!
}
async function toggle(details: HTMLDetailsElement, open: boolean) {
  await act(async () => { details.open = open; details.dispatchEvent(new Event('toggle')) })
}
async function fill(node: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('keeps the basic Host field connected and focused through every prefix without requiring advanced options', async () => {
  config = { ...config, hosts: [config.hosts[0]!, { ...saved, hostname: '' }, neighbor] }
  await render(); await select()
  const details = disclosure(), input = hostname()
  expect(details.open).toBe(false)
  input.focus()
  const value = 'private.invalid'
  for (let length = 1; length <= value.length; length++) {
    await fill(input, value.slice(0, length))
    expect(hostname()).toBe(input)
    expect(input.isConnected).toBe(true)
    expect(input.value).toBe(value.slice(0, length))
    expect(details.open).toBe(false)
    expect(document.activeElement).toBe(input)
  }
  expect(onSave).not.toHaveBeenCalled()
})

it('preserves manual closing through same-ID clean publication, including an empty Hostname', async () => {
  await render(); await select()
  const details = disclosure()
  await toggle(details, true); await toggle(details, false)
  config = { ...config, hosts: [config.hosts[0]!, { ...saved, hostname: '', label: 'Published remote' }, neighbor] }
  await render()
  expect(disclosure()).toBe(details)
  expect(details.open).toBe(false)
  expect(hostname().value).toBe('')
  expect(card().querySelector('header strong')!.textContent).toBe('Published remote')
})

it('keeps independent disclosure choices attached to stable Host IDs when neighbors move', async () => {
  await render(); await select()
  await toggle(disclosure(), true)
  await select(neighbor.id)
  const second = disclosure()
  expect(second.open).toBe(false)
  config = { ...config, hosts: [config.hosts[0]!, { ...neighbor, label: 'Updated neighbor' }, { ...saved, hostname: 'updated.invalid' }] }
  await render()
  expect([...dom.container.querySelectorAll<HTMLElement>('[data-host-disclosure]')].map(node => node.dataset.hostDisclosure)).toEqual(['local', neighbor.id, saved.id])
  expect(disclosure()).toBe(second)
  expect(card().dataset.resourceEditor).toBe(neighbor.id)
  await select(saved.id)
  expect(disclosure().open).toBe(true)
  expect(hostname().value).toBe('updated.invalid')
  await select(neighbor.id)
  expect(disclosure().open).toBe(false)
})

it('retains an open dirty field and focus when Host check facts and unrelated configuration update', async () => {
  await render(); await select()
  const details = disclosure(), input = hostname()
  await toggle(details, true); input.focus(); await fill(input, 'authored.invalid')
  await act(async () => useAppStore.setState({ hostChecks: { [saved.id]: { state: 'checking', input: saved } } }))
  config = { ...config, hosts: [config.hosts[0]!, { ...saved, label: 'External label' }, { ...neighbor, hostname: 'changed.invalid' }] }
  await render()
  expect(hostname()).toBe(input)
  expect(input.value).toBe('authored.invalid')
  expect(details.open).toBe(true)
  expect(document.activeElement).toBe(input)
  await select(neighbor.id)
  expect(hostname().value).toBe('changed.invalid')
  expect(onSave).not.toHaveBeenCalled()
})
