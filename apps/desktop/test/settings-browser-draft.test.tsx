// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture'
import { composerDOM } from './helpers/composer-dom-fixture'
import { forgetBrowserAppLink } from '../src/main/settings-browser-control'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'

// Reviewed owning counterexamples. Real mounted SettingsPanel + ConfigOwner + durable
// ConfigStore; Runtime preparation is isolated. Native grants are fixture facts,
// never a human-choice proof and never applied to the user's configuration.
const dom = composerDOM()
let f: Awaited<ReturnType<typeof configOwnerFixture>>
let deliverProjection: boolean
beforeEach(async () => {
  f = await configOwnerFixture()
  const publish = f.publish.getMockImplementation()!
  deliverProjection = true
  f.publish.mockImplementation(saved => { publish(saved); if (deliverProjection) useAppStore.setState({ config: saved }) })
  useAppStore.setState({ config: f.owner.current })
  vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => await f.owner.edit(expected!, next))
  vi.spyOn(api.browser, 'forgetAppLinkScheme').mockImplementation(async (scheme, expected) => { await forgetBrowserAppLink(f.owner, scheme, expected) })
})
const pane = () => dom.render(<SettingsPanel initialSection="browser" onClose={() => {}} />)
const checkbox = () => dom.container.querySelector<HTMLInputElement>('[data-settings-pane="browser"] input[type="checkbox"]')!
const saveButton = () => dom.container.querySelector<HTMLButtonElement>('[data-settings-pane="browser"] .settings-pane-actions button')!
it('keeps public Browser settings operations with Main before any Renderer surface action', async () => {
  const before = useAppStore.getState().tabs
  for (const request of [
    { operation: 'settings.browser.links.list' as const },
    { operation: 'settings.browser.links.forget' as const, scheme: 'proof-alpha' }
  ]) await expect(useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'main-owned', ...request }))
    .rejects.toThrow('Settings requests belong to the Main configuration owner.')
  expect(useAppStore.getState().tabs).toEqual(before)
})
async function settled() {
  for (let n = 0; n < 100; n++) {
    await act(async () => { await new Promise(done => setTimeout(done, 5)) })
    const saving = dom.container.querySelector('[data-settings-pane="browser"] .settings-pane-actions [role="status"]')?.textContent?.includes('Saving')
    const forgetting = [...dom.container.querySelectorAll('.app-link-scheme-list button')].some(button => button.textContent?.includes('Forgetting'))
    if (!saving && !forgetting) return
  }
  throw new Error('Private Browser save did not settle.')
}

it('keeps matching external automation dirty until the user explicitly saves', async () => {
  await pane()
  expect(checkbox().checked).toBe(false)
  await dom.click('[data-settings-pane="browser"] input[type="checkbox"]')
  expect(saveButton().disabled).toBe(false)
  await act(async () => { await f.owner.update(current => ({ ...current, browser: { ...current.browser, agentAutomation: true } })) })
  expect(f.owner.current.browser.agentAutomation).toBe(true)
  expect(checkbox().checked).toBe(true)
  expect(saveButton().disabled).toBe(false)
  const bytes = await f.bytes(), publications = f.publish.mock.calls.length, preparations = vi.mocked(f.runtime.prepare).mock.calls.length
  await dom.click('[data-settings-pane="browser"] .settings-pane-actions button'); await settled()
  expect(saveButton().disabled).toBe(true)
  expect(vi.mocked(api.config.save).mock.calls[0]![1]!.browser.agentAutomation).toBe(false)
  expect(await f.bytes()).toBe(bytes); expect(f.publish).toHaveBeenCalledTimes(publications)
  expect(f.runtime.prepare).toHaveBeenCalledTimes(preparations)
})

it('enables a missing effective false against its authored baseline and keeps remembered answers', async () => {
  const answers = Object.fromEntries([['proof-alpha', 'deny'], ['__proto__', 'allow'], ['constructor', 'deny']])
  await f.owner.update(current => {
    const { agentAutomation: _absent, ...browser } = current.browser
    return { ...current, browser: { ...browser, appLinkSchemes: answers } }
  })
  expect(Object.hasOwn(f.owner.current.browser, 'agentAutomation')).toBe(false)
  await pane(); expect(checkbox().checked).toBe(false)
  await dom.click('[data-settings-pane="browser"] input[type="checkbox"]')
  await dom.click('[data-settings-pane="browser"] .settings-pane-actions button'); await settled()
  expect(dom.container.querySelector('[role="alert"]')).toBeNull()
  expect(vi.mocked(api.config.save).mock.calls[0]![1]!.browser.agentAutomation).toBe(false)
  expect((await f.disk()).browser.agentAutomation).toBe(true)
  expect(f.owner.current.browser.appLinkSchemes).toEqual(answers)
  expect(saveButton().disabled).toBe(true)
})

it('keeps a failed automation draft and retries its original expectation without changing permissions', async () => {
  await pane(); await dom.click('[data-settings-pane="browser"] input[type="checkbox"]')
  const bytes = await f.bytes(), publications = f.publish.mock.calls.length
  f.save.mockRejectedValueOnce(new Error('Private disk unavailable'))
  await dom.click('[data-settings-pane="browser"] .settings-pane-actions button'); await settled()
  expect(dom.container.querySelector('[role="alert"]')!.textContent).toBe('Private disk unavailable')
  expect(checkbox().checked).toBe(true); expect(saveButton().disabled).toBe(false)
  expect(await f.bytes()).toBe(bytes); expect(f.publish).toHaveBeenCalledTimes(publications)
  await dom.click('[data-settings-pane="browser"] .settings-pane-actions button'); await settled()
  expect(vi.mocked(api.config.save).mock.calls.map(([, expected]) => expected!.browser.agentAutomation)).toEqual([false, false])
  expect((await f.disk()).browser.agentAutomation).toBe(true)
})

it('retains a later edit back to baseline while the first automation save awaits persistence', async () => {
  await pane()
  const held = deferred<void>(), original = vi.mocked(f.runtime.prepare).getMockImplementation()!
  vi.mocked(f.runtime.prepare).mockImplementationOnce(async (...args) => { await held.promise; return original(...args) })
  await dom.click('[data-settings-pane="browser"] input[type="checkbox"]')
  await dom.click('[data-settings-pane="browser"] .settings-pane-actions button')
  expect(dom.container.querySelector('[role="status"]')!.textContent).toContain('Saving')
  await dom.click('[data-settings-pane="browser"] input[type="checkbox"]')
  expect(checkbox().checked).toBe(false)
  await act(async () => held.resolve())
  await settled()
  expect((await f.disk()).browser.agentAutomation).toBe(true)
  expect(checkbox().checked).toBe(false)
  expect(saveButton().disabled).toBe(false)
})

async function staleForget(external: Record<string, 'allow' | 'deny'>) {
  await f.owner.update(current => ({ ...current, browser: { ...current.browser, appLinkSchemes: { 'proof-alpha': 'deny' } } }))
  await pane()
  const buttons = [...dom.container.querySelectorAll<HTMLButtonElement>('.app-link-scheme-list button')]
  expect(buttons).toHaveLength(1)
  expect(buttons[0]!.closest('li')!.textContent).toContain('proof-alpha:')
  // Main facts become newer before the renderer delivers that snapshot. Release
  // the received snapshot and the original button click in one React batch:
  // the UI action is authored from the previously displayed answer.
  deliverProjection = false
  await f.owner.update(current => ({ ...current, browser: { ...current.browser, appLinkSchemes: external } }))
  expect(f.owner.current.browser.appLinkSchemes).toEqual(external)
  expect(useAppStore.getState().config!.browser.appLinkSchemes).toEqual({ 'proof-alpha': 'deny' })
  deliverProjection = true
  const latest = f.owner.current
  await act(async () => {
    useAppStore.setState({ config: latest })
    expect(buttons[0]!.isConnected).toBe(true)
    buttons[0]!.click()
  })
  expect(api.browser.forgetAppLinkScheme).toHaveBeenCalledWith('proof-alpha', 'deny')
  await settled()
}

it('refuses old Forget after the same remembered answer changed, retaining the new answer', async () => {
  await staleForget({ 'proof-alpha': 'allow' })
  expect(f.owner.current.browser.appLinkSchemes).toEqual({ 'proof-alpha': 'allow' })
  const alert = dom.container.querySelector('[role="alert"]')
  expect(alert).not.toBeNull()
  expect(alert!.textContent).toContain('proof-alpha')
})

it('forgets only the displayed answer and preserves a newly remembered neighboring scheme', async () => {
  await staleForget(Object.fromEntries([['proof-alpha', 'deny'], ['proof-beta', 'allow'], ['__proto__', 'deny']]))
  expect(f.owner.current.browser.appLinkSchemes).toEqual(Object.fromEntries([['proof-beta', 'allow'], ['__proto__', 'deny']]))
})
