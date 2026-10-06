import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { GRAPHITE_THEME, RETRO_THEME, mountThemeRuntime, readResolvedTheme, themeValue, updateThemeSelection } from '@agentmux/client-ui/theme'
import { ConfigOwner } from '../src/main/config-owner'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { appearanceSettingsModule } from '../src/renderer/src/components/settings/modules/appearance'
import { composerConfig } from './helpers/composer-dom-fixture'
import type { AppConfig, AppearanceConfig } from '../src/shared/contracts'

const originalState = useAppStore.getState()
let original: AppConfig, root: Root, container: HTMLDivElement
let save: MockInstance<typeof api.config.save>
let setConfig: MockInstance<ReturnType<typeof useAppStore.getState>['setConfig']>
const invokeOriginalPane = () => appearanceSettingsModule.Pane({ config: original, active: true }).props.onSave as
  (next: AppearanceConfig, expected: AppearanceConfig) => Promise<void>

// The actual Store drives the production Root runtime. Full DesktopApp startup is
// exercised by the separately recorded native Main; this carrier opens no Runtime.
function AppearanceConsumer() {
  const config = useAppStore(state => state.config)
  useLayoutEffect(() => mountThemeRuntime(window, useAppStore.getState().config?.appearance ?? {}), [])
  useLayoutEffect(() => { if (config) updateThemeSelection(config.appearance) }, [config?.appearance])
  return config ? appearanceSettingsModule.Pane({ config, active: true }) : null
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ media: query, matches: false, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }))
  original = { ...structuredClone(composerConfig), appearance: { ...composerConfig.appearance, appAppearance: 'light', themeId: 'graphite',
    customThemes: { 'custom.unsupported': { version: 999, original: 'Keep this record' } } } }
  useAppStore.setState({ ...originalState, config: original, tabs: {}, sessions: [], layouts: {}, loading: false, error: null,
    agentComposerDrafts: { 'retained-agent': 'Keep my authored draft' } }, true)
  save = vi.spyOn(api.config, 'save')
  setConfig = vi.spyOn(useAppStore.getState(), 'setConfig')
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(<AppearanceConsumer />))
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  useAppStore.setState(originalState, true)
  document.documentElement.removeAttribute('style')
})

describe('original Appearance settings save receipt', () => {
  it('applies the committed owner receipt when an idempotent retry has no change event', async () => {
    const documentValue = structuredClone(GRAPHITE_THEME)
    documentValue.id = 'custom.saved'; documentValue.name = 'Saved owner receipt'
    documentValue.variants.light.colors.surface0 = '#faf0ce'
    documentValue.icons['action.close'] = { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z' }] }
    const appearance = { ...original.appearance, themeId: documentValue.id,
      customThemes: { ...original.appearance.customThemes, [documentValue.id]: themeValue(documentValue) } }
    let main = original
    const persist = vi.fn(async (next: AppConfig) => next)
    const publish = vi.fn((committed: AppConfig) => {
      main = committed
      // The original owner has committed, but its native event/first receipt is lost.
      throw new Error('Committed publication could not be delivered')
    })
    const owner = new ConfigOwner({ read: () => main, save: persist, publish })
    save.mockImplementation((next, before) => owner.edit(before!, next))
    await act(async () => {
      await expect(invokeOriginalPane()(appearance, original.appearance)).rejects.toThrow('Committed publication could not be delivered')
    })
    expect(main.appearance.themeId).toBe(documentValue.id)
    expect(useAppStore.getState().config).toBe(original)
    expect(readResolvedTheme().id).toBe('graphite')
    await act(async () => invokeOriginalPane()(appearance, original.appearance))
    expect(persist).toHaveBeenCalledTimes(1); expect(publish).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().config).toBe(main)
    expect(setConfig).toHaveBeenCalledExactlyOnceWith(main)
    expect(readResolvedTheme().id).toBe(documentValue.id)
    expect(document.documentElement.style.getPropertyValue('--surface-0')).toBe('#faf0ce')
    expect(document.getElementById('agentmux-icon-action.close')?.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z')
    expect(Object.keys(main.appearance.customThemes!).filter(id => id === documentValue.id)).toHaveLength(1)
    expect(main.appearance.customThemes!['custom.unsupported']).toEqual(original.appearance.customThemes!['custom.unsupported'])
    expect(useAppStore.getState().agentComposerDrafts['retained-agent']).toBe('Keep my authored draft')
  })
  it('retains a later observed publication when an earlier save acknowledgment arrives', async () => {
    let main = original
    let forwardPublication = false
    let acknowledge!: (committed: AppConfig) => void
    let confirmCommit!: () => void
    const committed = new Promise<void>(done => { confirmCommit = done })
    const owner = new ConfigOwner({ read: () => main, save: async next => next, publish: next => {
      main = next
      if (forwardPublication) useAppStore.getState().setConfig(next)
    } })
    save.mockImplementation(async (next, before) => {
      const result = await owner.edit(before!, next)
      confirmCommit()
      return await new Promise<AppConfig>(done => { acknowledge = done })
    })
    const earlier = { ...original.appearance, themeId: 'fallout4' }
    let pending!: Promise<void>
    await act(async () => { pending = invokeOriginalPane()(earlier, original.appearance); await committed })
    const oldReceipt = main
    expect(oldReceipt.appearance.themeId).toBe('fallout4')
    expect(useAppStore.getState().config).toBe(original)
    forwardPublication = true
    let later!: AppConfig
    await act(async () => {
      later = await owner.edit(main, { ...main, appearance: { ...main.appearance, themeId: 'retro-future', terminalFontSize: 17 } })
    })
    expect(useAppStore.getState().config).toBe(later)
    expect(readResolvedTheme().id).toBe('retro-future')
    await act(async () => { acknowledge(oldReceipt); await pending })
    expect(useAppStore.getState().config).toBe(later)
    expect(setConfig).toHaveBeenCalledExactlyOnceWith(later)
    expect(readResolvedTheme().id).toBe('retro-future')
    expect(document.documentElement.style.getPropertyValue('--surface-0')).toBe(RETRO_THEME.variants.light.colors.surface0)
    expect(later.appearance.terminalFontSize).toBe(17)
    expect(later.appearance.customThemes!['custom.unsupported']).toEqual(original.appearance.customThemes!['custom.unsupported'])
    expect(useAppStore.getState().agentComposerDrafts['retained-agent']).toBe('Keep my authored draft')
  })
  it('leaves the observed configuration intact when the owner rejects the save', async () => {
    save.mockRejectedValue(new Error('Unconfirmed commit'))
    await expect(invokeOriginalPane()({ ...original.appearance, themeId: 'fallout4' }, original.appearance)).rejects.toThrow('Unconfirmed commit')
    expect(useAppStore.getState().config).toBe(original)
    expect(setConfig).not.toHaveBeenCalled()
  })
  it('reports unavailable configuration without a fabricated successful save', async () => {
    await act(async () => useAppStore.setState({ config: null }))
    await expect(invokeOriginalPane()(original.appearance, original.appearance)).rejects.toThrow('Your appearance draft is retained')
    expect(save).not.toHaveBeenCalled()
    expect(setConfig).not.toHaveBeenCalled()
  })
})
