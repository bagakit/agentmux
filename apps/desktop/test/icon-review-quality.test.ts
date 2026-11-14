// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getSemanticIconCatalog } from '../../../packages/client-ui/src/theme/icon-catalog-metadata.js'
import { ICON_GLYPHS, AUTHORED_ICON_GLYPH_IDS } from '../../../packages/client-ui/src/theme/icon-catalog.js'
import { removeIconSprite, semanticIconHref } from '../../../packages/client-ui/src/theme/icon-sprite.js'
import { createReviewCatalog, sourceRoots } from '../scripts/icon-review/catalog.mjs'
import { TOOLKIT_ICON_OPTIONS } from '../src/shared/toolkit-preferences.js'

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  window.dispatchEvent(new Event('pagehide'))
  removeIconSprite(document)
  document.body.replaceChildren()
  localStorage.clear()
  vi.unstubAllGlobals()
})

it('the actual workbench finds shared Toolkit mappings and current drawings, compares real sizes and returns to visible editing without changing drafts', async () => {
  const catalog = await createReviewCatalog({ getSemanticIconCatalog, ICON_GLYPHS, AUTHORED_ICON_GLYPH_IDS })
  expect(TOOLKIT_ICON_OPTIONS.length).toBeGreaterThan(0)
  expect(sourceRoots).toContain('apps/desktop/src/shared')
  expect(catalog.scanScope.roots).toEqual(sourceRoots)
  // This is the same option registry consumed by the actual ToolkitIcon, not a
  // duplicate hardcoded list of expected semantic IDs.
  for (const option of TOOLKIT_ICON_OPTIONS) {
    const role = catalog.roles.find((role: { id: string }) => role.id === option.semanticId)
    expect(role?.sources.some((ref: { file: string }) => ref.file === 'apps/desktop/src/shared/toolkit-preferences.ts'), option.semanticId).toBe(true)
  }
  const html = await readFile('apps/desktop/scripts/icon-review/index.html', 'utf8')
  const page = new DOMParser().parseFromString(html.replace(/<link[^>]*>|<script[^>]*><\/script>/g, ''), 'text/html')
  page.querySelectorAll('link,script').forEach(node => node.remove())
  document.documentElement.innerHTML = page.documentElement.innerHTML
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  const manifest = await readFile('apps/desktop/scripts/icon-review/review-manifest.json', 'utf8')
  vi.stubGlobal('fetch', async (url: string) => new Response(url.endsWith('catalog.json') ? JSON.stringify(catalog) : manifest))
  localStorage.clear()
  await import('../scripts/icon-review/app.js')
  const review = () => (window as unknown as { iconReview: { ready: boolean; exportTheme(): string; buildPacket(): { history: unknown[] } } }).iconReview
  await vi.waitFor(() => expect(review()?.ready).toBe(true))
  const input = (selector: string, value: string) => {
    const field = document.querySelector<HTMLInputElement>(selector)!
    field.value = value
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const click = (selector: string) => document.querySelector<HTMLElement>(selector)!.click()
  const theme = JSON.parse(review().exportTheme())
  theme.icons['object.disk'] = { kind: 'glyph', glyph: 'work-writing' }
  theme.icons['object.mote'] = { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z' }] }
  const file = { size: JSON.stringify(theme).length, text: async () => JSON.stringify(theme) }
  Object.defineProperty(document.getElementById('import-file'), 'files', { configurable: true, value: [file] })
  document.getElementById('import-file')!.dispatchEvent(new Event('change', { bubbles: true }))
  await vi.waitFor(() => expect(JSON.parse(review().exportTheme()).icons['object.disk'].glyph).toBe('work-writing'))
  click('#view-matrix')
  input('#search', 'work-writing')
  expect(document.querySelector('[data-role="object.disk"]')).not.toBeNull()
  input('#search', 'hard-drive')
  expect(document.querySelector('[data-role="object.disk"]')).not.toBeNull()
  click('[data-role="object.disk"] button')
  const sizes = (selector: string) => [...document.querySelectorAll<SVGElement>(selector + ' svg')].map(svg => [svg.getAttribute('width'), svg.getAttribute('height')])
  expect(sizes('[aria-label="目录默认实际尺寸"]')).toEqual([['12','12'], ['16','16'], ['24','24']])
  expect(sizes('[aria-label="当前主题实际尺寸"]')).toEqual([['12','12'], ['16','16'], ['24','24']])
  expect(document.querySelectorAll('[aria-label="当前主题实际尺寸"] use')).toHaveLength(3)
  for (const use of document.querySelectorAll('[aria-label="当前主题实际尺寸"] use')) expect(use.getAttribute('href')).toBe(semanticIconHref('object.disk'))
  expect(document.querySelector('[aria-label="目录默认实际尺寸"] path')?.getAttribute('d')).toBeDefined()

  input('#edit-note', 'Retained review note')
  const stored = localStorage.getItem('agentmux.icon-review.v1')
  const beforeTheme = review().exportTheme(), beforeHistory = structuredClone(review().buildPacket().history)
  const filter = document.getElementById('modified-only') as HTMLInputElement
  filter.checked = true; filter.dispatchEvent(new Event('change', { bubbles: true }))
  click('#view-mote')
  expect(document.querySelectorAll('[data-mote-family]')).toHaveLength(5)
  expect(document.querySelector('[aria-label="Goal 角色造型参照"] img')?.getAttribute('src')).toContain('goal-next')
  expect(document.querySelector('[data-mote-family="mote-main-session"] h3')?.textContent).toBe('Leader')
  expect(document.querySelector('[data-mote-family="agent"] use')?.getAttribute('href')).toBe(semanticIconHref('object.agent'))
  expect(document.querySelector('[data-mote-family="mote"] use')?.getAttribute('href')).toBe(semanticIconHref('object.mote'))
  expect(document.querySelector('[data-mote-family="mote-main-session"]')?.textContent).toContain('待采用候选')
  expect(document.querySelector('[data-mote-family="mote-main-session"] path')?.getAttribute('fill-rule')).toBe('evenodd')
  expect(document.querySelector('[data-mote-family="mote-promotion-b2"] path[stroke="none"]')).not.toBeNull()
  expect(document.querySelectorAll('[aria-label="Agent 体量比较"] [transform]')).toHaveLength(3)
  expect(JSON.stringify(JSON.parse(review().exportTheme()).icons)).not.toContain('mote-main-session')
  expect(review().exportTheme()).toBe(beforeTheme)
  expect(localStorage.getItem('agentmux.icon-review.v1')).toBe(stored)
  click('[data-role="object.mote"]')
  expect(document.querySelector('[data-role="object.mote"]')).not.toBeNull()
  expect(document.getElementById('search')).toHaveProperty('value', 'object.mote')
  expect(filter.checked).toBe(false)
  expect(sizes('[aria-label="当前主题实际尺寸"]')).toEqual([['12','12'], ['16','16'], ['24','24']])
  for (const use of document.querySelectorAll('[aria-label="当前主题实际尺寸"] use')) expect(use.getAttribute('href')).toBe(semanticIconHref('object.mote'))
  expect(document.getElementById(semanticIconHref('object.mote').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z')
  expect(document.querySelector('[aria-label="当前主题实际尺寸"] [data-icon-animation]')).toBeNull()
  expect(review().exportTheme()).toBe(beforeTheme)
  expect(review().buildPacket().history).toEqual(beforeHistory)
  expect(localStorage.getItem('agentmux.icon-review.v1')).toBe(stored)
}, 20000)

it('finds native mask consumers in every stylesheet under the scanned roots, including nested Mobile styles', async () => {
  const catalog = await createReviewCatalog({ getSemanticIconCatalog, ICON_GLYPHS, AUTHORED_ICON_GLYPH_IDS })
  const nativeFiles = (id: string) => catalog.roles.find((role: { id: string }) => role.id === id)!.sources
    .filter((ref: { kind: string }) => ref.kind === 'native').map((ref: { file: string }) => ref.file)
  // Only Mobile styles draw the connection masks; nested presence masks live one directory down.
  expect(nativeFiles('status.connection-connected')).toEqual(['apps/mobile/src/mobile.css'])
  expect(nativeFiles('status.presence-working')).toContain('apps/mobile/src/conversation/conversation.css')
  for (const role of catalog.roles) for (const ref of role.sources.filter((ref: { kind: string }) => ref.kind === 'native')) {
    expect(sourceRoots.some((root: string) => ref.file.startsWith(root + '/')), ref.file).toBe(true)
  }
})

it('the exported review manifest names exactly the views the page offers', async () => {
  const html = await readFile('apps/desktop/scripts/icon-review/index.html', 'utf8')
  const manifest = JSON.parse(await readFile('apps/desktop/scripts/icon-review/review-manifest.json', 'utf8')) as { views: { id: string }[] }
  const pageViews = [...html.matchAll(/id="view-([a-z]+)"/g)].map(match => match[1])
  expect(pageViews.length).toBeGreaterThan(0)
  expect(manifest.views.map(view => view.id)).toEqual(pageViews)
})
