import { fixturePath as _reshape_fixturePath } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_MOTE_FACE } from '@agentmux/core/mote-face'
import { parseMoteAvatarSeriesResult, type MoteAvatarSeriesCatalog } from '@agentmux/core/mote-avatar-series'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'
import { MoteAvatarSeriesEditor } from '../src/renderer/src/components/MoteAvatarSeriesEditor'
import { api } from '../src/renderer/src/lib/api'
import * as nativeRenderer from '../src/renderer/src/lib/mote-avatar-series-renderer'

const catalog = parseMoteAvatarSeriesResult('space.mote.avatar.list', {
  roots: [{ origin: 'user', path: _reshape_fixturePath("private/avatar-icon-proof"), state: 'available' }],
  series: [{ origin: 'user', seriesId: 'proof', title: 'Proof', entries: [
    { entryId: 'model', title: 'Model', definition: { kind: 'glb', file: 'model.glb' } },
    { entryId: 'image', title: 'Picture', definition: { kind: 'image', file: 'picture.png' } },
    { entryId: 'face', title: 'Face', definition: { kind: 'face2d', face: DEFAULT_MOTE_FACE } }
  ] }], issues: []
}, {}) satisfies MoteAvatarSeriesCatalog
let container: HTMLDivElement, root: Root, dispose: () => void
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) { this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
    disconnect() {} unobserve() {} takeRecords() { return [] }
  })
  dispose = mountThemeRuntime(window)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); dispose(); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function geometry(name: string) {
  const icon = container.querySelector<SVGElement>(`[data-semantic-icon="${name}"]`)
  expect(icon, name).not.toBeNull()
  const href = icon!.querySelector('use')?.getAttribute('href')
  expect(href).toBe(`#agentmux-icon-${name}`)
  const symbol = document.getElementById(href!.slice(1))!
  expect(symbol.childElementCount).toBeGreaterThan(0)
  return symbol
}
it('themes real avatar metadata and recovery controls while keeping original identity artwork and refresh action', async () => {
  const list = vi.spyOn(api.moteAvatars, 'list').mockResolvedValue(catalog)
  const preview = vi.spyOn(api.moteAvatars, 'preview').mockRejectedValue(new Error('original image is unavailable'))
  await act(async () => root.render(createElement(MoteAvatarSeriesEditor, {
    targetKey: 'original-target', visible: true, disabled: false, onDraft: vi.fn()
  })))
  await act(async () => { await Promise.resolve() })
  const identities = [...container.querySelectorAll('[data-series-entry]')].map(element => element.getAttribute('data-series-entry'))
  expect(identities).toEqual(['model', 'image', 'face'])
  expect(container.querySelector('[data-series-entry="image"] [data-preview-state]')?.getAttribute('data-preview-state')).toBe('unavailable')
  expect(preview).toHaveBeenCalledWith({ source: { origin: 'user', seriesId: 'proof', entryId: 'image' } })
  for (const meaning of ['object.model-3d', 'file.image', 'object.profile', 'action.refresh', 'status.unknown']) geometry(meaning)
  const identity = container.querySelector('[data-series-entry="face"] .mote-face') ?? container.querySelector('[data-series-entry="face"] svg:not([data-semantic-icon])')
  expect(identity).not.toBeNull(); const originalArtwork = identity!.outerHTML
  const existingModel = container.querySelector('[data-semantic-icon="object.model-3d"]')
  const custom = structuredClone(GRAPHITE_THEME)
  custom.id = 'custom.avatar-icon-proof'; custom.name = 'Avatar icon proof'
  custom.icons = {
    'object.model-3d': { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z', fill: 'currentColor' }] },
    'status.unknown': { kind: 'glyph', glyph: 'triangle-alert' }
  }
  await act(async () => { expect(previewTheme(custom).applied).toBe(true) })
  expect(container.querySelector('[data-semantic-icon="object.model-3d"]')).toBe(existingModel)
  expect(geometry('object.model-3d').querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z')
  expect(geometry('status.unknown').querySelector('path')).not.toBeNull()
  expect(identity!.outerHTML).toBe(originalArtwork)
  expect([...container.querySelectorAll('[data-series-entry]')].map(element => element.getAttribute('data-series-entry'))).toEqual(identities)
  const refresh = container.querySelector<HTMLButtonElement>('[aria-label="Refresh avatar series"]')!
  expect(refresh.disabled).toBe(false)
  await act(async () => refresh.click())
  expect(list).toHaveBeenCalledTimes(2)
  expect(container.querySelector('[data-series-target]')?.getAttribute('data-series-target')).toBe('original-target')
})

it('keeps selection, native preview recovery and reset controls on the original series entry', async () => {
  vi.spyOn(api.moteAvatars, 'list').mockResolvedValue(catalog)
  vi.spyOn(nativeRenderer, 'createSeriesGlbRenderer').mockRejectedValue(new Error('native renderer unavailable in this component harness'))
  const definition = { kind: 'glb' as const, file: 'model.glb' }
  const preview = vi.spyOn(api.moteAvatars, 'preview').mockImplementation(async ({ source }) => {
    if (source.entryId !== 'model') throw new Error('original image unavailable')
    return { source: { ...source, revision: 'sha256:' + 'a'.repeat(64) }, definition,
      payload: { kind: 'glb', dataBase64: 'AAAA' }, issues: [] }
  })
  const draft = vi.fn()
  await act(async () => root.render(createElement(MoteAvatarSeriesEditor, {
    targetKey: 'original-model-target', visible: true, disabled: false, onDraft: draft
  })))
  const entry = container.querySelector<HTMLButtonElement>('[data-series-entry="model"]')!
  await act(async () => entry.click())
  expect(preview).toHaveBeenCalledWith({ source: { origin: 'user', seriesId: 'proof', entryId: 'model' } })
  expect(entry.getAttribute('aria-pressed')).toBe('true')
  geometry('status.selected'); geometry('action.reset-options')
  expect(container.textContent).toContain('Preview unavailable. Your current draft is kept.')
  const reset = container.querySelector<HTMLButtonElement>('[aria-label="Reset series adjustments"]')!
  expect(reset.disabled).toBe(false)
  const custom = structuredClone(GRAPHITE_THEME)
  custom.id = 'custom.reset-icon-proof'; custom.name = 'Reset icon proof'
  custom.icons = { 'action.reset-options': { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z', fill: 'currentColor' }] } }
  await act(async () => { expect(previewTheme(custom).applied).toBe(true); reset.click() })
  expect(geometry('action.reset-options').querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z')
  expect(container.querySelector('[data-series-entry="model"]')).toBe(entry)
  expect(container.querySelector('[data-series-target]')?.getAttribute('data-series-target')).toBe('original-model-target')
  expect(container.querySelector<HTMLInputElement>('[aria-label="Series model rotation"]')?.value).toBe('0')
})
