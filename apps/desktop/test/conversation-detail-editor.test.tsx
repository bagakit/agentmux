// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import { inappConversationSettingsModule } from '../src/renderer/src/components/settings/modules/inapp-conversation.js'
import { api } from '../src/renderer/src/lib/api.js'
import { useAppStore } from '../src/renderer/src/store.js'

it('repairs an unsupported saved choice through the real InApp editor and preserves its draft on a failed ConfigOwner save', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const f = await configOwnerFixture()
  await f.owner.update(config => ({ ...config, appearance: { ...config.appearance, conversationDetailLevel: 'future-choice' } }))
  useAppStore.setState({ config: f.owner.current })
  const get = vi.spyOn(api.config, 'get').mockImplementation(async () => f.owner.current)
  const save = vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => f.owner.edit(expected!, next))
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
  function Pane() { const config = useAppStore(state => state.config)!; return <ClientUiProvider platform={platform}><inappConversationSettingsModule.Pane config={config} onNavigate={() => {}} /></ClientUiProvider> }
  const selected = () => host.querySelector<HTMLInputElement>('[data-settings-field="reading-detail"] input:checked')?.value
  const button = () => host.querySelector<HTMLButtonElement>('[data-inapp-conversation-settings] > [data-settings-save-bar] button')!
  async function choose(value: string) { await act(async () => host.querySelector<HTMLInputElement>(`[data-reading-choice="${value}"] input`)!.click()) }
  async function until(ready: () => boolean) { for(let i=0;i<200&&!ready();i++)await act(async()=>{await new Promise(done=>setTimeout(done,5))});expect(ready(),host.textContent??'').toBe(true) }
  try {
    await act(async () => root.render(<Pane />))
    expect(selected()).toBeUndefined(); expect(host.textContent).toContain('The saved detail choice is unsupported')
    expect(host.querySelectorAll('[data-settings-save-bar]')).toHaveLength(1)
    expect(host.querySelector('[data-settings-field="reading-detail"] [data-settings-save-bar]')).toBeNull()
    await choose('system'); expect(button().disabled).toBe(false)
    await act(async () => button().click())
    await until(()=>f.owner.current.appearance.conversationDetailLevel==='system')
    expect((await f.disk()).appearance.conversationDetailLevel).toBe('system')
    expect(selected()).toBe('system'); expect(host.textContent).not.toContain('The saved detail choice is unsupported')
    await choose('collaboration')
    f.save.mockRejectedValueOnce(new Error('Original private disk write failure'))
    await act(async () => button().click())
    await until(()=>host.textContent?.includes('Original private disk write failure')===true)
    expect(selected(), 'failed-save-retains-authored-reading-choice').toBe('collaboration')
    expect(host.textContent).toContain('Original private disk write failure')
    expect((await f.disk()).appearance.conversationDetailLevel).toBe('system')
    expect(button().disabled).toBe(false)
    await act(async () => button().click())
    await until(()=>f.owner.current.appearance.conversationDetailLevel==='collaboration')
    expect((await f.disk()).appearance.conversationDetailLevel).toBe('collaboration')
  } finally { await act(async () => root.unmount()); host.remove(); get.mockRestore(); save.mockRestore(); vi.unstubAllGlobals() }
})

it('previews the draft through shared records without writing, then saves the InApp fields together', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const f = await configOwnerFixture(), current = f.owner.current
  useAppStore.setState({ config: current })
  const write = vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => f.owner.edit(expected!, next))
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
  function Pane() { const config = useAppStore(state => state.config)!; return <ClientUiProvider platform={platform}><inappConversationSettingsModule.Pane config={config} active onClose={() => {}} onNavigate={() => {}} /></ClientUiProvider> }
  const click = (selector: string) => act(async () => host.querySelector<HTMLElement>(selector)!.click())
  const preview = () => host.querySelector('[data-inapp-preview="reading"]')!
  const shown = (selector: string) => { const node = preview().querySelector(selector); return Boolean(node && !node.closest('[hidden],[inert]')) }
  try {
    await act(async () => root.render(<Pane />))
    expect(shown('[data-native-record-id="peer"]')).toBe(false)
    await click('[data-reading-choice="collaboration"] input')
    expect(shown('[data-native-record-id="peer"]'), 'draft-preference-must-reach-real-shared-preview').toBe(true)
    expect(shown('[data-native-step-id="system"]')).toBe(false)
    await click('[data-receipt-choice="hide"] input')
    await click('[data-inapp-preview="receipts"] [data-surface-mode="confirmed"]')
    const confirmed = host.querySelector('[data-inapp-preview="receipts"] [data-native-record-id="received"]')
    expect(confirmed && !confirmed.closest('[hidden],[inert]'), 'sample-switch-must-show-confirmed-message').toBe(true)
    expect(host.querySelector('[data-inapp-preview="receipts"] .conversation-send-receipt__activity'), 'confirmed-example-must-stop-pending-motion').toBeNull()
    await click('[data-settings-field="send-receipts"] input[type="checkbox"]')
    expect(write, 'preview-must-not-save').not.toHaveBeenCalled()
    expect(useAppStore.getState().config).toBe(current)
    expect(host.querySelector('[data-inapp-conversation-settings] > [data-settings-save-bar]')!.textContent).toContain('Unsaved changes')
    await click('[data-inapp-conversation-settings] > [data-settings-save-bar] button')
    for (let n = 0; n < 100 && f.owner.current.appearance.conversationDetailLevel !== 'collaboration'; n++) await act(async () => new Promise(done => setTimeout(done, 5)))
    expect(write).toHaveBeenCalledTimes(1)
    const disk = await f.disk()
    expect(disk.appearance.conversationDetailLevel).toBe('collaboration')
    expect(disk.appearance.conversationShowSendReceipts).toBe(false)
    expect(disk.appearance.conversationConfirmedSendReceipt).toBe('hide')
    expect(disk.messageToolInitialLayout).toBe(current.messageToolInitialLayout)
  } finally { await act(async () => root.unmount()); host.remove(); write.mockRestore(); vi.unstubAllGlobals() }
})
