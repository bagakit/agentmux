// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AppConfig, HostCheckResult, SshHostConfig } from '../src/shared/contracts'
import { HostSettingsPane } from '../src/renderer/src/components/settings/HostSettingsPane'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const checkHost = useAppStore.getState().checkHost
const dom = composerDOM()
const remote: SshHostConfig = { id: 'remote', kind: 'ssh', label: 'Saved remote', hostname: 'private.invalid' }
const config: AppConfig = { ...composerConfig, hosts: [composerConfig.hosts[0]!, remote] }
const unavailable = 'Remote AgentMux Runs are not available until the ctxmux Remote contract is delivered.'
const ready = 'Runtime private-build · protocol 1'
const onSave = vi.fn(async () => {})

beforeEach(() => {
  useAppStore.setState({ sessions: [], hostChecks: {}, checkHost })
  onSave.mockClear()
})
const mount = () => dom.render(<HostSettingsPane config={config} onSave={onSave} />)
function card(index: number) {
  const found = [...dom.container.querySelectorAll<HTMLElement>('.host-settings-card')]
  expect(found).toHaveLength(2)
  return found[index]!
}
function testButton(index: number) {
  const found = [...card(index).querySelectorAll<HTMLButtonElement>('button')].filter(node => node.textContent === 'Test')
  expect(found).toHaveLength(1)
  return found[0]!
}
const status = (index: number) => card(index).querySelector('[role="status"]')?.textContent

it('projects real checkHost pending and ready facts, retaining technical detail in a native disclosure', async () => {
  let resolve!: (value: HostCheckResult) => void
  const pending = new Promise<HostCheckResult>(done => { resolve = done })
  const check = vi.spyOn(api.hosts, 'check').mockReturnValue(pending)
  await mount()
  await act(async () => testButton(0).click())
  expect(check).toHaveBeenCalledExactlyOnceWith(config.hosts[0])
  expect(status(0)).toBe('Testing')
  expect(testButton(0).disabled).toBe(true)
  await act(async () => resolve({ ok: true, detail: ready }))
  expect(status(0)).toBe('Ready')
  expect(testButton(0).disabled).toBe(false)
  const details = card(0).querySelector<HTMLDetailsElement>('.host-check-details')
  expect(details).not.toBeNull()
  expect(details!.open).toBe(false)
  expect(details!.querySelector('summary')?.textContent?.trim()).toBe('Test details')
  await act(async () => { details!.open = true; details!.dispatchEvent(new Event('toggle')) })
  expect(details!.querySelector('.host-check-detail')?.textContent).toBe(ready)
  expect(card(0).querySelector('header')?.textContent).not.toContain(ready)
  expect(useAppStore.getState().hostChecks.local?.result).toEqual({ ok: true, detail: ready })
})

it('keeps the complete refusal visible outside connection editing and states the current saving limit honestly', async () => {
  vi.spyOn(api.hosts, 'check').mockResolvedValue({ ok: false, detail: unavailable })
  await mount()
  const connection = card(1).querySelector<HTMLDetailsElement>('.host-edit-disclosure')!
  expect(connection.open).toBe(false)
  await act(async () => testButton(1).click())
  expect(status(1)).toBe('Unavailable')
  const detail = card(1).querySelector('.host-check-detail')
  expect(detail).not.toBeNull()
  expect(detail!.textContent).toBe(unavailable)
  expect(detail!.closest('details')).toBeNull()
  expect(connection.open).toBe(false)
  const hint = card(1).querySelector('.host-edit-grid .field-hint')?.textContent
  expect(hint).toContain('saving SSH connections are unavailable')
  expect(hint).toContain('draft')
  expect(hint).not.toContain('can save and test')
  expect(useAppStore.getState().hostChecks.remote?.result).toEqual({ ok: false, detail: unavailable })
  expect(onSave).not.toHaveBeenCalled()
})

it('preserves literal long diagnostics and per-Host results without replacing the draft or check owner', async () => {
  const detail = `/private/${'unbrokendiagnostic'.repeat(15)}\nOriginal detail <kept> & unchanged.`
  vi.spyOn(api.hosts, 'check').mockImplementation(async host => ({ ok: host.kind === 'local', detail: host.kind === 'local' ? ready : detail }))
  await mount()
  const connection = card(1).querySelector<HTMLDetailsElement>('.host-edit-disclosure')!
  await act(async () => { connection.open = true; connection.dispatchEvent(new Event('toggle')) })
  const input = connection.querySelectorAll('input')[1]!
  input.focus()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'authored.invalid')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { testButton(1).click(); testButton(0).click() })
  expect([status(0), status(1)]).toEqual(['Ready', 'Unavailable'])
  expect(card(1).querySelector('.host-check-detail')?.textContent).toBe(detail)
  expect(useAppStore.getState().hostChecks.remote?.detail).toBe(detail)
  expect(useAppStore.getState().hostChecks.local?.detail).toBe(ready)
  expect(card(1).querySelector('.host-edit-disclosure')).toBe(connection)
  expect(connection.open).toBe(true)
  expect(connection.querySelectorAll('input')[1]).toBe(input)
  expect(input.value).toBe('authored.invalid')
  expect(onSave).not.toHaveBeenCalled()
})

it('shows a thrown check reason without interpreting idle or missing facts as ready', async () => {
  vi.spyOn(api.hosts, 'check').mockRejectedValue(new Error('Check facts could not be read.'))
  await mount()
  expect(status(0)).toBeUndefined()
  await act(async () => useAppStore.setState({ hostChecks: { local: { state: 'idle' } } }))
  expect(status(0)).toBe('Not tested')
  await act(async () => testButton(1).click())
  expect(status(1)).toBe('Check failed')
  expect(useAppStore.getState().hostChecks.remote?.state).toBe('error')
  expect(useAppStore.getState().hostChecks.remote?.result).toBeUndefined()
  expect(card(1).querySelector('.host-check-detail')?.textContent).toContain('Check facts could not be read.')
  expect(status(0)).toBe('Not tested')
})
