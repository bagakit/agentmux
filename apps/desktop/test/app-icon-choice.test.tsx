// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { BrandIcon } from '../src/renderer/src/components/BrandIcon'
import { appearanceSettingsModule } from '../src/renderer/src/components/settings/modules/appearance'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => vi.restoreAllMocks())

it('saves a real Appearance choice through the original module and keeps drafts separate from committed branding', async () => {
  const f = await configOwnerFixture({ appearance: { terminalTheme: 'graphite' } })
  useAppStore.setState({ config: f.owner.current })
  const publish = f.owner.subscribe(saved => useAppStore.getState().setConfig(saved))
  let pendingSave: Promise<unknown> | undefined
  vi.spyOn(api.config, 'save').mockImplementation((next, expected) => {
    const promise = f.owner.edit(expected, next); pendingSave = promise; return promise
  })
  const node = document.createElement('div'); document.body.append(node)
  const root = createRoot(node), releaseTheme = mountThemeRuntime(window)
  function Host() {
    const config = useAppStore(state => state.config)!
    return <><div data-committed-brand><BrandIcon size={32} /></div><appearanceSettingsModule.Pane config={config} active /></>
  }
  const choose = async (id: string) => act(async () => node.querySelector<HTMLInputElement>(`input[name$="-app-icon"][value="${id}"]`)!.click())
  const save = async () => act(async () => {
    pendingSave = undefined
    ;[...node.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save appearance')!.click()
    await pendingSave?.catch(() => {})
  })
  const committed = () => node.querySelector('[data-committed-brand] img')?.getAttribute('data-app-icon')
  try {
    await act(async () => root.render(<Host />))
    const choices = node.querySelectorAll('input[name$="-app-icon"]')
    expect([...choices].map(input => input.getAttribute('value'))).toEqual(['qingzhuan', 'huihuan', 'zheyu', 'lingban', 'classic'])
    expect(committed()).toBe('qingzhuan')
    expect(f.owner.current.appearance.appIcon).toBeUndefined()
    await choose('huihuan')
    expect(committed()).toBe('qingzhuan')
    await save()
    expect(committed()).toBe('huihuan')
    expect((await f.disk()).appearance.appIcon).toBe('huihuan')
    expect(node.querySelector('[data-committed-brand] img')?.getAttribute('src')).toContain('huihuan.png')
    await choose('classic')
    f.save.mockRejectedValueOnce(new Error('Private image-choice disk failure'))
    await save()
    expect(node.querySelector('[role="alert"]')?.textContent).toContain('Private image-choice disk failure')
    expect(committed()).toBe('huihuan')
    expect((await f.disk()).appearance.appIcon).toBe('huihuan')
    await act(async () => { await f.owner.update(config => ({ ...config, copyPathsAsAbsolute: true })) })
    await save()
    expect(committed()).toBe('classic')
    expect((await f.disk()).copyPathsAsAbsolute).toBe(true)
    expect((await f.disk()).appearance.appIcon).toBe('classic')
  } finally {
    await act(async () => root.unmount()); releaseTheme(); publish(); node.remove()
  }
})
