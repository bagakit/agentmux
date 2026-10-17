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
  expect(link).not.toHaveBeenCalled()
  expect(revoke).not.toHaveBeenCalled()
})
