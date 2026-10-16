// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
it('General has no loading gate and its actual save preserves historical data and concurrent authored fields', async () => {
  const f = await configOwnerFixture({ startup: { skipAgentAvailabilityCheckWait: false } })
  useAppStore.setState({ config: f.owner.current })
  const release = f.owner.subscribe(saved => useAppStore.setState({ config: saved }))
  const save = vi.spyOn(api.config, 'save').mockImplementation((next, expected) => f.owner.edit(expected!, next))
  try {
    await dom.render(<SettingsPanel initialSection="general" onClose={() => {}} />)
    expect(dom.container.querySelector('[data-settings-field="startup-checks"]')).toBeNull()
    expect(dom.container.textContent).not.toContain('Wait for Agent availability')
    await dom.click('[data-settings-pane="general"] input[type="checkbox"]')
    await act(async () => { await f.owner.update(current => ({ ...current, notes: { fontSize: 18 } })) })
    const button = dom.container.querySelector<HTMLButtonElement>('[data-settings-pane="general"] [data-settings-save-bar] button')!
    await act(async () => button.click())
    expect(save).toHaveBeenCalledOnce()
    await act(async () => { await save.mock.results[0]!.value })
    expect((await f.disk()).copyPathsAsAbsolute).toBe(true)
    expect((await f.disk()).startup).toEqual({ skipAgentAvailabilityCheckWait: false })
    expect(f.owner.current.notes).toEqual({ fontSize: 18 })
  } finally { release() }
})
