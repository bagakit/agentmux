import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GRAPHITE_THEME, type ThemeDocument } from '@agentmux/client-ui/theme'
import { getSemanticIconCatalog, SEMANTIC_ICON_CATALOG, SEMANTIC_ICON_IDS, ICON_GLYPH_IDS } from '@agentmux/client-ui/icons'
import { ThemeIconEditor } from '../src/renderer/src/components/settings/ThemeIconEditor'

let root: Root, host: HTMLDivElement, draft: ThemeDocument
const validation = vi.fn()
function Harness() {
  const [value, setValue] = useState<ThemeDocument>({ id: 'custom.icon-proof', ...structuredClone(GRAPHITE_THEME) })
  draft = value
  return <ThemeIconEditor draft={value} onValidation={validation} onChange={(icons, iconStyle) => setValue(current => ({ ...current, icons, iconStyle }))} />
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  validation.mockReset(); host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<Harness />))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
async function click(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent?.trim() === label)
  expect(button, label).toBeTruthy(); await act(async () => button!.click())
}
async function fill(label: string, value: string) {
  const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
  expect(field, label).toBeTruthy()
  await act(async () => { Object.getOwnPropertyDescriptor(field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}
it('browses a complete same-source catalog with meaningful groups, labels and actual drawings', () => {
  const metadata = getSemanticIconCatalog()
  expect(metadata.icons.length).toBeGreaterThan(400)
  expect(metadata.icons.map(icon => icon.id)).toEqual(SEMANTIC_ICON_IDS)
  expect(metadata.glyphs).toEqual(ICON_GLYPH_IDS)
  expect(host.querySelectorAll('.theme-icon-editor__meaning').length).toBe(metadata.icons.length)
  for (const icon of metadata.icons) {
    expect(icon.defaultGlyph).toBe(SEMANTIC_ICON_CATALOG[icon.id].glyph)
    expect(metadata.groups.some(group => group.id === icon.groupId)).toBe(true)
    expect(icon.label.length).toBeGreaterThan(0); expect(icon.description.length).toBeGreaterThan(icon.label.length)
  }
  expect(host.querySelector('.theme-icon-editor__meaning svg')?.children.length).toBeGreaterThan(0)
})
it('searches meaning or drawing name and changes exactly one meaning through the visual picker', async () => {
  await fill('Find semantic icon', 'activity')
  expect(host.querySelectorAll('.theme-icon-editor__meaning').length).toBeGreaterThan(1)
  await click('Edit status.working'); await click('Choose a drawing'); await fill('Find icon drawing', 'circle-play')
  expect(host.querySelectorAll('.theme-icon-editor__glyphs button').length).toBe(1)
  await click('Use circle-play')
  expect(draft.icons).toEqual({ 'status.working': { kind: 'glyph', glyph: 'circle-play' } })
  expect(host.querySelector('.theme-icon-editor__comparison')?.textContent).toContain('circle-play')
  await act(async () => host.querySelector<HTMLInputElement>('.theme-icon-editor__modified input')!.click())
  expect(host.querySelectorAll('.theme-icon-editor__meaning').length).toBe(1)
  await click('Restore default drawing'); expect(draft.icons).toEqual({})
  expect(host.textContent).toContain('No meanings match these filters.')
  await click('Clear filters'); expect(host.querySelectorAll('.theme-icon-editor__meaning').length).toBeGreaterThan(400)
})
it('filters by function and retains an invalid path draft across selecting another meaning', async () => {
  const select = host.querySelector<HTMLSelectElement>('[aria-label="Semantic icon group"]')!
  await act(async () => { select.value = 'control'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  const rows = [...host.querySelectorAll('.theme-icon-editor__meaning')]
  expect(rows.length).toBeGreaterThan(5); expect(rows.every(row => row.getAttribute('aria-label')!.startsWith('Edit control.'))).toBe(true)
  await click('Edit control.key-up'); await click('Use custom paths'); await fill('Semantic icon paths', '[unfinished')
  expect(validation).toHaveBeenLastCalledWith(expect.stringContaining('control.key-up'))
  await click('Edit control.key-down'); await click('Edit control.key-up')
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Semantic icon paths"]')!.value).toBe('[unfinished')
  expect(draft.icons['control.key-up']?.kind).toBe('paths')
  await click('Restore default drawing'); expect(validation).toHaveBeenLastCalledWith(''); expect(draft.icons['control.key-up']).toBeUndefined()
})
it('handles empty drawing search and preserves the semantic ID on a focusable native button', async () => {
  await click('Choose a drawing'); await fill('Find icon drawing', 'no-such-glyph')
  expect(host.textContent).toContain('No drawings match this search.'); expect(draft.icons).toEqual({})
  await fill('Find icon drawing', 'circle-play')
  const button = host.querySelector<HTMLButtonElement>('[aria-label="Use circle-play"]')!
  button.focus(); expect(document.activeElement).toBe(button)
  await act(async () => button.click())
  expect(draft.icons['action.close']).toEqual({ kind: 'glyph', glyph: 'circle-play' })
  expect(host.querySelector('[aria-label="Selected semantic icon"] code')?.textContent).toBe('action.close')
})
