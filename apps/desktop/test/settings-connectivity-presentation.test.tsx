// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
beforeEach(() => useAppStore.setState({ config: composerConfig, loading: false }))

it('Browser keeps both original preference drafts while its saved permission summary remains unchanged', async () => {
  const save = vi.spyOn(api.config, 'save').mockResolvedValue(composerConfig)
  const close = () => {}
  await dom.render(<SettingsPanel initialSection="browser" onClose={close} />)
  const automation = dom.container.querySelector<HTMLInputElement>('.browser-automation-toggle input')!
  const automatic = dom.container.querySelector<HTMLInputElement>('.browser-resources__policy input')!
  expect(automation.checked).toBe(false)
  expect(automatic.checked).toBe(true)
  await act(async () => { automation.click(); automatic.click() })
  expect(automation.checked).toBe(true)
  expect(automatic.checked).toBe(false)
  expect(dom.container.querySelector('.settings-browser__preferences')?.contains(automatic)).toBe(true)
  expect(dom.container.querySelector('.browser-resources')?.contains(automatic)).toBe(false)
  expect(dom.container.querySelector('[data-settings-field="agent-automation"] header')?.textContent).toContain('Saved: Off')
  await dom.render(<SettingsPanel initialSection="overview" onClose={close} />)
  await dom.render(<SettingsPanel initialSection="browser" onClose={close} />)
  expect(dom.container.querySelector('.browser-automation-toggle input')).toBe(automation)
  expect(automation.checked).toBe(true)
  expect(automatic.checked).toBe(false)
  expect(save).not.toHaveBeenCalled()
})

it('Mobile keeps the original device record and makes the full failed observation available separately from recovery guidance', async () => {
  const read = vi.spyOn(api.deviceManagement, 'ls').mockResolvedValue({ hostId: 'host-original', mobileAccess: { state: 'connected', message: 'Ready' },
    devices: [{ deviceId: 'phone-original', name: 'Personal phone', createdAt: 0, online: true }] })
  const revoke = vi.spyOn(api.deviceManagement, 'revoke')
  const link = vi.spyOn(api.deviceManagement, 'link')
  await dom.render(<SettingsPanel initialSection="mobile" onClose={() => {}} />)
  const record = dom.container.querySelector<HTMLDetailsElement>('[data-device-record="phone-original"]')!
  expect(record).not.toBeNull()
  record.open = true
  read.mockRejectedValueOnce(new Error('Original device observation interrupted'))
  const refresh = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Refresh')!
  await act(async () => refresh.click())
  const issue = dom.container.querySelector('.device-management__read-issue')!
  expect(issue?.textContent).toContain('Previous records are kept. Refresh to check again.')
  const details = issue.querySelector<HTMLDetailsElement>('details')!
  expect(details.open).toBe(false)
  expect(details.querySelector('summary')?.textContent).toBe('Observation details')
  details.open = true
  expect(details.textContent).toContain('Original device observation interrupted')
  expect(dom.container.querySelector('[data-device-record="phone-original"]')).toBe(record)
  expect(record.open).toBe(true)
  expect(record.textContent).toContain('Connected')
  expect(dom.container.querySelector('.device-management__service')?.textContent).toContain('Connection service · last observed')
  expect(dom.container.querySelector('.device-management__service')?.textContent).toContain('Ready to connect')
  expect(dom.container.querySelector('.device-management__count')?.textContent).toBe('Last observed: 1 connected · 1 authorized')
  expect(dom.container.querySelector<HTMLDetailsElement>('[data-device-records]')?.open).toBe(false)
  expect(link).not.toHaveBeenCalled()
  expect(revoke).not.toHaveBeenCalled()
})

it('Browser summarizes a failed observation while retaining the original reason and manual refresh', async () => {
  const read = vi.spyOn(api.browser, 'listTargets').mockRejectedValueOnce(new Error('Original page directory interruption'))
  const release = vi.spyOn(api.browser, 'release')
  const restore = vi.spyOn(api.browser, 'restoreResource')
  await dom.render(<SettingsPanel initialSection="browser" onClose={() => {}} />)
  const issue = dom.container.querySelector('.browser-resources .browser-resources__notices')!
  expect(issue.querySelector('[role="status"]')?.textContent).toContain('Previous entries are kept.')
  const details = issue.querySelector<HTMLDetailsElement>('details')!
  expect(details.open).toBe(false)
  details.open = true
  expect(details.textContent).toContain('Original page directory interruption')
  read.mockResolvedValueOnce({ targets: [], coverage: 'complete' })
  const refresh = [...dom.container.querySelectorAll<HTMLButtonElement>('.browser-resources button')].find(button => button.textContent?.trim() === 'Refresh')!
  expect(refresh.disabled).toBe(false)
  await act(async () => refresh.click())
  expect(dom.container.querySelector('.browser-resources')?.textContent).not.toContain('Original page directory interruption')
  expect(release).not.toHaveBeenCalled()
  expect(restore).not.toHaveBeenCalled()
})

it('Hosts returns from the compact toolbar and reopens the exact authored connection draft', async () => {
  const bounds = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return this.classList.contains('remote-management') ? { ...bounds.call(this), width: 500 } : bounds.call(this)
  })
  useAppStore.setState({ config: { ...composerConfig, hosts: [...composerConfig.hosts,
    { id: 'host-review', kind: 'ssh', label: 'Review host', hostname: 'review.invalid' }] }, sessions: [], hostChecks: {} })
  const save = vi.spyOn(api.config, 'save')
  const check = vi.spyOn(api.hosts, 'check')
  await dom.render(<SettingsPanel initialSection="hosts" onClose={() => {}} />)
  const selector = '[data-host-disclosure="host-review"] [data-host-panel="connection"]'
  const choose = () => dom.container.querySelector<HTMLButtonElement>(selector)!
  await act(async () => choose().click())
  const input = dom.container.querySelector<HTMLInputElement>('[data-host-name]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Authored host')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const back = dom.container.querySelector<HTMLButtonElement>('.remote-management__toolbar .settings-resource-back')!
  expect(back).not.toBeNull()
  await act(async () => back.click())
  expect(dom.container.querySelector('.remote-management')?.getAttribute('data-resource-view')).toBe('library')
  expect(dom.container.querySelector('.remote-management__toolbar .settings-resource-back')).toBeNull()
  expect(document.activeElement).toBe(choose())
  await act(async () => choose().click())
  expect(dom.container.querySelector('.remote-management__toolbar .settings-resource-back')).not.toBeNull()
  expect(dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')).toBe('host-review')
  expect(dom.container.querySelector<HTMLInputElement>('[data-host-name]')?.value).toBe('Authored host')
  expect(save).not.toHaveBeenCalled()
  expect(check).not.toHaveBeenCalled()
})
