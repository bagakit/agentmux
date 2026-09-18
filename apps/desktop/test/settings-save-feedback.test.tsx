// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { BrowserSettingsPane } from '../src/renderer/src/components/settings/BrowserSettingsPane'
import { NotificationSettingsPane } from '../src/renderer/src/components/settings/NotificationSettingsPane'
import { HostSettingsPane } from '../src/renderer/src/components/settings/HostSettingsPane'
import { ShortcutSettingsPane } from '../src/renderer/src/components/settings/ShortcutSettingsPane'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
async function input(selector: string, value: string) {
  const node = dom.container.querySelector<HTMLInputElement>(selector)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
    node.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

it('shows pending, saving, failure and successful retry without clearing the browser draft', async () => {
  let reject!: (error: Error) => void
  const onSave = vi.fn(() => new Promise<void>((_, fail) => { reject = fail }))
  await dom.render(<BrowserSettingsPane browser={composerConfig.browser} onSave={onSave} />)
  expect(dom.container.querySelector<HTMLButtonElement>('.primary-button')!.disabled).toBe(true)
  await dom.click('input[type="checkbox"]')
  expect(dom.container.querySelector('[role="status"]')!.textContent).toBe('Unsaved changes')
  await dom.click('.primary-button')
  expect(dom.container.querySelector('[role="status"]')!.textContent).toContain('Saving changes')
  expect(onSave).toHaveBeenCalledWith({ ...composerConfig.browser, agentAutomation: true })
  await act(async () => reject(new Error('Disk full')))
  expect(dom.container.querySelector('[role="alert"]')!.textContent).toBe('Disk full')
  expect(dom.container.querySelector<HTMLInputElement>('input')!.checked).toBe(true)
  onSave.mockImplementation(async () => {})
  await dom.click('.primary-button')
  await dom.render(<BrowserSettingsPane browser={{ ...composerConfig.browser, agentAutomation: true }} onSave={onSave} />)
  expect(dom.container.querySelector('[role="alert"]')).toBeNull()
  expect(dom.container.querySelector('[role="status"]')!.textContent).toContain('Changes saved')
  expect(dom.container.querySelector<HTMLButtonElement>('.primary-button')!.disabled).toBe(true)
})

it('preserves notification drafts when an unrelated save returns cloned config values, and reports failure', async () => {
  const notifications = { mode: 'brief' as const, sound: false }
  const onSave = vi.fn(async () => { throw new Error('Cannot save notifications') })
  await dom.render(<NotificationSettingsPane notifications={notifications} onSave={onSave} />)
  await dom.click('input[type="checkbox"]')
  await dom.render(<NotificationSettingsPane notifications={{ ...notifications }} onSave={onSave} />)
  expect(dom.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true)
  await dom.click('.primary-button')
  expect(onSave).toHaveBeenCalledWith({ mode: 'brief', sound: true }, { mode: 'brief', sound: false })
  expect(dom.container.querySelector('[role="alert"]')!.textContent).toBe('Cannot save notifications')
})

it('keeps an unsaved SSH host across cloned configuration and saves the original host/workspace contract', async () => {
  const onSave = vi.fn(async () => {})
  await dom.render(<HostSettingsPane config={composerConfig} onSave={onSave} />)
  await dom.click('.settings-pane-toolbar button')
  await input('[placeholder="dev.example.com"]', 'host.example.test')
  await dom.render(<HostSettingsPane config={structuredClone(composerConfig)} onSave={onSave} />)
  expect(dom.container.querySelector<HTMLInputElement>('[placeholder="dev.example.com"]')!.value).toBe('host.example.test')
  await dom.click('.primary-button')
  expect(onSave).toHaveBeenCalledWith([
    composerConfig.hosts[0],
    expect.objectContaining({ kind: 'ssh', hostname: 'host.example.test', label: 'Remote host' })
  ], composerConfig.workspaces)
})

it('keeps prompt edits across cloned saved arrays', async () => {
  const config = { ...composerConfig, composerShortcuts: [{ id: 'p', keyword: 'explain', label: 'Explain', body: 'Explain clearly' }] }
  await dom.render(<ShortcutSettingsPane config={config} onSave={async () => {}} />)
  await input('[placeholder="eli5"]', 'review')
  await dom.render(<ShortcutSettingsPane config={structuredClone(config)} onSave={async () => {}} />)
  expect(dom.container.querySelector<HTMLInputElement>('[placeholder="eli5"]')!.value).toBe('review')
  expect(dom.container.querySelector('[role="status"]')!.textContent).toBe('Unsaved changes')
})
