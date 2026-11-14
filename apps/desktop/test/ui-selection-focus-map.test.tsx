// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FocusMapSettings } from '../src/renderer/src/components/settings/FocusMapSettings'
import { focusMapPreset, type FocusMapPreferences } from '../src/shared/focus-map-preferences'
import { chooseField } from './helpers/selection-field'

let container: HTMLElement, root: Root
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals() })

async function mount() {
  const changed = vi.fn()
  function Scene() {
    const [value, setValue] = useState<FocusMapPreferences>(() => ({ boundary: 'bezier', levels: focusMapPreset(2) }))
    return <FocusMapSettings value={value} onChange={next => { changed(next); setValue(next) }} />
  }
  await act(async () => root.render(<Scene />))
  return { changed }
}

it('uses shared selection fields for LOD count, form and compatible information', async () => {
  const { changed } = await mount()
  expect(container.querySelector('select')).toBeNull()
  expect(container.querySelectorAll('.selection-field').length).toBeGreaterThanOrEqual(3)
  await chooseField(container.querySelector<HTMLButtonElement>('[aria-label="LOD levels"]')!, '3')
  expect(changed).toHaveBeenCalled()
  expect(container.querySelectorAll('.focus-map-settings__levels > details').length).toBe(3)
  await chooseField(container.querySelector<HTMLButtonElement>('[aria-label="Level 1 form"]')!, 'compact')
  expect(container.querySelector('[aria-label="Level 1 information"]')?.textContent).toContain('Identity')
  expect(container.querySelector('[aria-label="Level 1 form"]')?.textContent).toContain('Compact identity')
})
