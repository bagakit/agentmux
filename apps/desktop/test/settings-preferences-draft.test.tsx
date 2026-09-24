// @vitest-environment happy-dom
import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { NotificationSettingsPane } from '../src/renderer/src/components/settings/NotificationSettingsPane'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { SearchBrowserTools } from '../src/renderer/src/components/SearchBrowserTools'
import { NOTIFICATION_TIERS, type NotificationModeId } from '../src/shared/notification-presentation'
import { BROWSER_TOOLBAR_ITEM_ORDER } from '../src/shared/browser-toolbar'
import { BROWSER_TOOLBAR_ITEM_LABELS } from '../src/renderer/src/lib/browser-toolbar'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const notificationSave = () => dom.container.querySelector<HTMLButtonElement>('.settings-pane-actions button')!
async function changeMode(mode: NotificationModeId) {
  const input = dom.container.querySelector<HTMLInputElement>('[aria-label="Notification dwell"]')!
  const index = NOTIFICATION_TIERS.findIndex((tier) => tier.id === mode)
  expect(index).toBeGreaterThan(-1)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(index))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const modeValue = () => Number(dom.container.querySelector<HTMLInputElement>('[aria-label="Notification dwell"]')?.value)
function toolbarInput(item: typeof BROWSER_TOOLBAR_ITEM_ORDER[number]) {
  const label = [...dom.container.querySelectorAll<HTMLLabelElement>('.browser-tools-preferences label')]
    .find((node) => node.textContent?.trim() === BROWSER_TOOLBAR_ITEM_LABELS[item])
  expect(label).toBeDefined()
  return label!.querySelector<HTMLInputElement>('input')!
}
const toolbarSave = () => dom.container.querySelector<HTMLButtonElement>('.browser-tools-preferences button')!

async function ownerConsumer(overrides: Parameters<typeof configOwnerFixture>[0]) {
  const fixture = await configOwnerFixture(overrides)
  const publish = fixture.publish.getMockImplementation()!
  fixture.publish.mockImplementation((config) => {
    publish(config)
    useAppStore.getState().setConfig(config)
  })
  useAppStore.setState({ config: fixture.owner.current, tabs: {}, browserAnnotationsByBrowserId: {} })
  const save = vi.spyOn(api.config, 'save').mockImplementation((next, expected) => fixture.owner.edit(expected, next))
  return { ...fixture, uiSave: save }
}
async function committedSave(fixture: Awaited<ReturnType<typeof ownerConsumer>>) {
  await act(async () => { await fixture.uiSave.mock.results.at(-1)!.value })
}

describe('ordinary preference drafts on actual consumers', () => {
  it('keeps a dirty notification mode while an external sound commit refreshes its clean field', async () => {
    const onSave = vi.fn(async () => {})
    await dom.render(<NotificationSettingsPane notifications={{ mode: 'standard', sound: false }} onSave={onSave} />)
    await changeMode('brief')
    await dom.render(<NotificationSettingsPane notifications={{ mode: 'standard', sound: true }} onSave={onSave} />)
    expect(modeValue()).toBe(NOTIFICATION_TIERS.findIndex((tier) => tier.id === 'brief'))
    expect(dom.container.querySelector<HTMLInputElement>('[type="checkbox"]')?.checked).toBe(true)
    await dom.click('.settings-pane-actions button')
    expect(onSave).toHaveBeenCalledWith({ mode: 'brief', sound: true }, { mode: 'standard', sound: true })
  })

  it('forwards the original notification expectation through SettingsPanel and reports a real durable-owner conflict', async () => {
    const f = await ownerConsumer({ notifications: { mode: 'standard', sound: false } })
    await dom.render(<SettingsPanel initialSection="notifications" onClose={() => {}} />)
    await changeMode('brief')
    await act(async () => { await f.owner.update((config) => ({ ...config, notifications: { mode: 'patient', sound: true } })) })
    const bytes = await f.bytes(), publications = f.publish.mock.calls.length
    await dom.click('.settings-pane-actions button')
    expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('notifications.mode')
    expect(modeValue()).toBe(NOTIFICATION_TIERS.findIndex((tier) => tier.id === 'brief'))
    expect(notificationSave().disabled).toBe(false)
    expect(f.uiSave.mock.calls[0]![1]!.notifications).toEqual({ mode: 'standard', sound: true })
    expect(await f.bytes()).toBe(bytes)
    expect(f.publish).toHaveBeenCalledTimes(publications)
  })

  it('preserves a pending notification edit back to the old baseline after Main publishes the submitted value', async () => {
    let finish!: () => void
    const onSave = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    await dom.render(<NotificationSettingsPane notifications={{ mode: 'standard' }} onSave={onSave} />)
    await changeMode('brief')
    await dom.click('.settings-pane-actions button')
    await changeMode('standard')
    await dom.render(<NotificationSettingsPane notifications={{ mode: 'brief' }} onSave={onSave} />)
    await act(async () => finish())
    expect(modeValue()).toBe(NOTIFICATION_TIERS.findIndex((tier) => tier.id === 'standard'))
    expect(notificationSave().disabled).toBe(false)
    await dom.click('.settings-pane-actions button')
    expect(onSave.mock.calls[1]).toEqual([{ mode: 'standard', sound: false }, { mode: 'brief', sound: false }])
    await act(async () => finish())
  })

  it('keeps a failed notification draft and its expectation on retry, including an absent optional sound', async () => {
    const f = await ownerConsumer({ notifications: { mode: 'standard' } })
    await dom.render(<SettingsPanel initialSection="notifications" onClose={() => {}} />)
    await dom.click('[type="checkbox"]')
    f.save.mockRejectedValueOnce(new Error('disk full'))
    const bytes = await f.bytes()
    await dom.click('.settings-pane-actions button')
    expect(dom.container.querySelector('[role="alert"]')?.textContent).toBe('disk full')
    expect(dom.container.querySelector<HTMLInputElement>('[type="checkbox"]')?.checked).toBe(true)
    expect(await f.bytes()).toBe(bytes)
    await dom.click('.settings-pane-actions button')
    await committedSave(f)
    expect(f.uiSave.mock.calls.map(([, expected]) => expected.notifications)).toEqual([
      { mode: 'standard', sound: false }, { mode: 'standard', sound: false }
    ])
    expect((await f.disk()).notifications).toEqual({ mode: 'standard', sound: true })
    expect(notificationSave().disabled).toBe(true)
  })

  it('saves only authored toolbar fields through SearchBrowserTools while preserving external fields and remembered scheme answers', async () => {
    const f = await ownerConsumer({ workspaces: [{ id: 'w', name: 'Private project', hostId: 'local', path: '/private', kind: 'folder' }] })
    await dom.render(<SearchBrowserTools workspace={f.owner.current.workspaces[0]!} />)
    expect(BROWSER_TOOLBAR_ITEM_ORDER.length).toBeGreaterThan(1)
    const [first, second] = BROWSER_TOOLBAR_ITEM_ORDER
    await act(async () => toolbarInput(first).click())
    await act(async () => { await f.owner.update((config) => ({ ...config, browser: {
      ...config.browser, agentAutomation: false, appLinkSchemes: { privateapp: 'deny' },
      toolbar: { ...config.browser.toolbar, [second]: false }
    } })) })
    expect(toolbarInput(first).checked).toBe(false)
    expect(toolbarInput(second).checked).toBe(false)
    await dom.click('.browser-tools-preferences button')
    await committedSave(f)
    expect(f.uiSave.mock.calls[0]![1]!.browser.toolbar[first]).toBe(true)
    expect(f.uiSave.mock.calls[0]![1]!.browser.toolbar[second]).toBe(false)
    expect(f.owner.current.browser.appLinkSchemes).toEqual({ privateapp: 'deny' })
    expect(f.owner.current.browser.agentAutomation).toBe(false)
    expect((await f.disk()).browser).toEqual(f.owner.current.browser)
    expect(toolbarSave().disabled).toBe(true)
  })

  it('keeps a matching external toolbar value dirty until explicit Save acknowledges it without another commit', async () => {
    const f = await ownerConsumer({ workspaces: [{ id: 'w', name: 'Private project', hostId: 'local', path: '/private', kind: 'folder' }] })
    await dom.render(<SearchBrowserTools workspace={f.owner.current.workspaces[0]!} />)
    const item = BROWSER_TOOLBAR_ITEM_ORDER[0]
    await act(async () => toolbarInput(item).click())
    await act(async () => { await f.owner.update((config) => ({ ...config, browser: { ...config.browser, toolbar: { ...config.browser.toolbar, [item]: false } } })) })
    expect(toolbarSave().disabled).toBe(false)
    const bytes = await f.bytes(), publications = f.publish.mock.calls.length
    await dom.click('.browser-tools-preferences button')
    await committedSave(f)
    expect(f.uiSave.mock.calls[0]![1]!.browser.toolbar[item]).toBe(true)
    expect(await f.bytes()).toBe(bytes)
    expect(f.publish).toHaveBeenCalledTimes(publications)
    expect(toolbarSave().disabled).toBe(true)
  })

  it('reports a failed toolbar save locally and keeps the original draft and expected fields for retry', async () => {
    const f = await ownerConsumer({ workspaces: [{ id: 'w', name: 'Private project', hostId: 'local', path: '/private', kind: 'folder' }] })
    await dom.render(<SearchBrowserTools workspace={f.owner.current.workspaces[0]!} />)
    const item = BROWSER_TOOLBAR_ITEM_ORDER[0]
    await act(async () => toolbarInput(item).click())
    f.save.mockRejectedValueOnce(new Error('disk full'))
    const bytes = await f.bytes()
    await dom.click('.browser-tools-preferences button')
    expect(dom.container.querySelector('.browser-tools-preferences [role="alert"]')?.textContent).toBe('disk full')
    expect(toolbarInput(item).checked).toBe(false)
    expect(await f.bytes()).toBe(bytes)
    expect(toolbarSave().disabled).toBe(false)
    await dom.click('.browser-tools-preferences button')
    await committedSave(f)
    expect(f.uiSave.mock.calls.map(([, expected]) => expected.browser.toolbar[item])).toEqual([true, true])
    expect((await f.disk()).browser.toolbar[item]).toBe(false)
    expect(toolbarSave().disabled).toBe(true)
  })
})
