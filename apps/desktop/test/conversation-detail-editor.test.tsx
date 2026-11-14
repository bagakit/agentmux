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
  const select = () => host.querySelector<HTMLSelectElement>('[aria-label="阅读详情"]')!
  const button = () => host.querySelector<HTMLButtonElement>('[data-settings-field="reading-detail"] [data-settings-save-bar] button')!
  async function choose(value: string) { await act(async () => { select().value=value; select().dispatchEvent(new Event('change',{bubbles:true})) }) }
  async function until(ready: () => boolean) { for(let i=0;i<200&&!ready();i++)await act(async()=>{await new Promise(done=>setTimeout(done,5))});expect(ready(),host.textContent??'').toBe(true) }
  try {
    await act(async () => root.render(<Pane />))
    expect(select().value).toBe(''); expect(select().selectedOptions[0]!.textContent).toContain('未识别')
    await choose('system'); expect(button().disabled).toBe(false)
    await act(async () => button().click())
    await until(()=>f.owner.current.appearance.conversationDetailLevel==='system')
    expect((await f.disk()).appearance.conversationDetailLevel).toBe('system')
    expect(select().value).toBe('system'); expect(host.textContent).not.toContain('保存的档位未识别')
    await choose('collaboration')
    f.save.mockRejectedValueOnce(new Error('Original private disk write failure'))
    await act(async () => button().click())
    await until(()=>host.textContent?.includes('Original private disk write failure')===true)
    expect(select().value, 'failed-save-retains-authored-reading-choice').toBe('collaboration')
    expect(host.textContent).toContain('Original private disk write failure')
    expect((await f.disk()).appearance.conversationDetailLevel).toBe('system')
    expect(button().disabled).toBe(false)
    await act(async () => button().click())
    await until(()=>f.owner.current.appearance.conversationDetailLevel==='collaboration')
    expect((await f.disk()).appearance.conversationDetailLevel).toBe('collaboration')
  } finally { await act(async () => root.unmount()); host.remove(); get.mockRestore(); save.mockRestore(); vi.unstubAllGlobals() }
})
