// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ToolkitSettingsPane } from '../src/renderer/src/components/settings/ToolkitSettingsPane'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { resolvePerformancePreferences } from '../src/shared/toolkit-preferences'
import { composerDOM } from './helpers/composer-dom-fixture'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture'

const dom = composerDOM()
const checkbox = () => dom.container.querySelector<HTMLInputElement>('.toolkit-settings [type="checkbox"]')!
const label = () => dom.container.querySelector<HTMLInputElement>('.toolkit-settings input[value="label"]')!
const save = () => dom.container.querySelector<HTMLButtonElement>('.toolkit-settings .primary-button')!
async function consumer() {
  const f = await configOwnerFixture()
  const publish = f.publish.getMockImplementation()!
  f.publish.mockImplementation(config => { publish(config); useAppStore.getState().setConfig(config) })
  useAppStore.setState({ config:f.owner.current, loading:false, tabs:{}, browserAnnotationsByBrowserId:{} })
  const request = vi.spyOn(api.config,'save').mockImplementation(async (next,expected) => { await f.owner.edit(expected,next) })
  return { ...f, request }
}
describe('Toolkit preferences in the real Settings consumer', () => {
  it('reaches the contributed page and saves first absent preferences through its unique owner', async () => {
    const f = await consumer()
    await dom.render(<SettingsPanel initialSection="toolkit" onClose={() => {}} />)
    expect(dom.container.querySelector('.settings-content__header h2')?.textContent).toBe('Toolkit')
    expect(checkbox().isConnected).toBe(true)
    expect(checkbox().checked).toBe(true)
    await act(async () => label().click())
    await act(async () => save().click())
    await act(async () => { await f.request.mock.results[0]!.value.catch(() => {}) })
    expect(dom.container.querySelector('[role="alert"]')).toBeNull()
    expect(resolvePerformancePreferences(await f.disk())).toEqual({enabled:true,statusBar:'label'})
    expect(save().disabled).toBe(true)
    expect(dom.container.querySelector('[role="status"]')?.textContent).toContain('Changes saved')
    expect(f.request.mock.calls[0]![1]!.toolkit).toEqual({performance:{enabled:true,statusBar:'icon'}})
    expect(dom.container.textContent).toContain('Official, read-only script')
  })
  it('retains authored baseline after a same-field outside write and preserves an unauthored sibling', async () => {
    const f = await consumer()
    await dom.render(<SettingsPanel initialSection="toolkit" onClose={() => {}} />)
    await act(async () => { label().click() })
    await act(async () => { await f.owner.update(config => ({...config,toolkit:{performance:{enabled:false,statusBar:'label'}}})) })
    expect(label().checked).toBe(true)
    expect(checkbox().checked).toBe(false)
    await act(async () => { save().click() })
    await act(async () => { await f.request.mock.results[0]!.value.catch(() => {}) })
    expect(dom.container.querySelector('[role="alert"]')).toBeNull()
    // Two legal values: an outside write already equal to our request is idempotent success.
    expect(f.request.mock.calls[0]![1]!.toolkit).toEqual({performance:{enabled:false,statusBar:'icon'}})
    expect(resolvePerformancePreferences(await f.disk())).toEqual({enabled:false,statusBar:'label'})
    expect(dom.container.querySelector('[role="alert"]')).toBeNull()
  })
  it('keeps a later edit made while its earlier save is pending', async () => {
    const held=deferred<void>(), onSave=vi.fn(() => held.promise)
    await dom.render(<ToolkitSettingsPane active performance={{enabled:true,statusBar:'icon'}} onSave={onSave} />)
    await act(async () => { label().click() })
    await act(async () => { save().click() })
    expect(onSave).toHaveBeenCalledWith({enabled:true,statusBar:'label'},{enabled:true,statusBar:'icon'})
    expect(save().disabled).toBe(true)
    const icon=dom.container.querySelector<HTMLInputElement>('input[value="icon"]')!
    await act(async () => { icon.click() })
    await act(async () => { held.resolve(); await held.promise })
    expect(icon.checked).toBe(true)
    expect(save().disabled).toBe(false)
    expect(dom.container.querySelector('[role="status"]')?.textContent).toContain('Unsaved changes')
  })
  it('keeps a rejected draft editable with an explicit failure', async () => {
    const onSave=vi.fn(async () => { throw new Error('Durable save unavailable') })
    await dom.render(<ToolkitSettingsPane active performance={{enabled:true,statusBar:'icon'}} onSave={onSave} />)
    await act(async () => { checkbox().click() })
    await act(async () => { save().click() })
    expect(checkbox().checked).toBe(false)
    expect(save().disabled).toBe(false)
    expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('Durable save unavailable')
  })
})
