// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AppConfig, SshHostConfig } from '../src/shared/contracts'
import { HostSettingsPane } from '../src/renderer/src/components/settings/HostSettingsPane'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const saved: SshHostConfig = { id: '10', kind: 'ssh', label: 'Saved remote', hostname: 'saved.invalid' }
const neighbor: SshHostConfig = { id: '2', kind: 'ssh', label: 'Neighbor', hostname: 'neighbor.invalid' }
let config: AppConfig
const onSave = vi.fn(async () => {})
beforeEach(() => {
  config = { ...structuredClone(composerConfig), hosts: [composerConfig.hosts[0]!, saved, neighbor] }
  useAppStore.setState({ sessions: [], hostChecks: {}, checkHost: vi.fn(async () => {}) })
  onSave.mockClear()
})
const render = () => dom.render(<HostSettingsPane config={config} onSave={onSave} />)
function cards() {
  const found = [...dom.container.querySelectorAll<HTMLElement>('.host-settings-card')]
  expect(found).toHaveLength(3)
  return found
}
function disclosure(index = 1) {
  const node = cards()[index]!.querySelector<HTMLDetailsElement>('details')
  expect(node).not.toBeNull()
  return node!
}
function hostname(details: HTMLDetailsElement) {
  const labels = [...details.querySelectorAll<HTMLLabelElement>('label')]
  expect(labels).toHaveLength(5)
  const label = labels.find(node => node.querySelector('span')?.textContent === 'Hostname')
  expect(label).toBeDefined()
  return label!.querySelector<HTMLInputElement>('input')!
}
async function toggle(details: HTMLDetailsElement, open: boolean) {
  // Happy DOM does not implement native summary activation. The Electron proof owns trusted
  // mouse/Enter/Space; here the real DOM toggle event exercises the component's state binding.
  await act(async () => { details.open = open; details.dispatchEvent(new Event('toggle')) })
}
async function fill(node: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('keeps a new Host open and the same connected input focused through every Hostname prefix', async () => {
  config = { ...config, hosts: [config.hosts[0]!, { ...saved, hostname: '' }, neighbor] }
  await render()
  const details = disclosure(), input = hostname(details)
  expect(details.open).toBe(true)
  input.focus()
  const value = 'private.invalid'
  for (let length = 1; length <= value.length; length++) {
    await fill(input, value.slice(0, length))
    expect(hostname(details)).toBe(input)
    expect(input.isConnected).toBe(true)
    expect(input.value).toBe(value.slice(0, length))
    expect(details.open).toBe(true)
    expect(document.activeElement).toBe(input)
  }
  expect(onSave).not.toHaveBeenCalled()
})

it('preserves manual closing through same-ID clean publication, including an empty Hostname', async () => {
  await render()
  const details = disclosure()
  expect(details.open).toBe(false)
  await toggle(details, true)
  await toggle(details, false)
  config = { ...config, hosts: [config.hosts[0]!, { ...saved, hostname: '', label: 'Published remote' }, neighbor] }
  await render()
  expect(disclosure()).toBe(details)
  expect(details.open).toBe(false)
  expect(hostname(details).value).toBe('')
  expect(cards()[1]!.querySelector('header strong')!.textContent).toBe('Published remote')
})

it('keeps independent disclosure choices attached to stable Host IDs when neighbors move', async () => {
  await render()
  const first = disclosure(), second = disclosure(2)
  await toggle(first, true)
  expect(second.open).toBe(false)
  config = { ...config, hosts: [config.hosts[0]!, { ...neighbor, label: 'Updated neighbor' }, { ...saved, hostname: 'updated.invalid' }] }
  await render()
  expect(cards().map(card => card.querySelector('header strong')!.textContent)).toEqual(['This Mac', 'Updated neighbor', 'Saved remote'])
  expect(disclosure()).toBe(second)
  expect(disclosure(2)).toBe(first)
  expect(second.open).toBe(false)
  expect(first.open).toBe(true)
})

it('retains an open dirty field and focus when Host check facts and unrelated configuration update', async () => {
  await render()
  const details = disclosure(), input = hostname(details)
  await toggle(details, true)
  input.focus()
  await fill(input, 'authored.invalid')
  await act(async () => useAppStore.setState({ hostChecks: { [saved.id]: { state: 'checking' } } }))
  config = { ...config, hosts: [config.hosts[0]!, { ...saved, label: 'External label' }, { ...neighbor, hostname: 'changed.invalid' }] }
  await render()
  expect(hostname(details)).toBe(input)
  expect(input.value).toBe('authored.invalid')
  expect(details.open).toBe(true)
  expect(document.activeElement).toBe(input)
  expect(hostname(disclosure(2)).value).toBe('changed.invalid')
  expect(onSave).not.toHaveBeenCalled()
})
