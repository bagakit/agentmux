// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { getSemanticIconCatalog } from '../../../packages/client-ui/src/theme/icon-catalog-metadata.js'
import { ICON_GLYPHS, AUTHORED_ICON_GLYPH_IDS } from '../../../packages/client-ui/src/theme/icon-catalog.js'
import { removeIconSprite } from '../../../packages/client-ui/src/theme/icon-sprite.js'
import { APP_ICON_CATALOG, APP_ICON_IDS, DEFAULT_APP_ICON, ORIGIN_REALM } from '../../../packages/client-ui/src/lib/app-icon-catalog.js'
import { appIconUrl } from '../../../packages/client-ui/src/lib/app-icon-url.js'
import { BUILT_IN_AGENT_PROVIDER_IDS } from '../../../packages/core/src/agent-provider-id.js'
import manifest from '../../../packages/client-ui/brand/brand-manifest.json'
import { resolveBrandHero } from '../src/renderer/src/lib/brand-hero.js'
import { createReviewCatalog } from '../scripts/icon-review/catalog.mjs'

afterEach(() => { window.dispatchEvent(new Event('pagehide')); removeIconSprite(document); document.body.replaceChildren(); localStorage.clear(); vi.unstubAllGlobals() })

it('opens on the Brand view, shows every realm through the product resolver and every manifest artwork', async () => {
  const catalog = await createReviewCatalog({ getSemanticIconCatalog, ICON_GLYPHS, AUTHORED_ICON_GLYPH_IDS })
  const html = await readFile('apps/desktop/scripts/icon-review/index.html', 'utf8')
  const page = new DOMParser().parseFromString(html.replace(/<link[^>]*>|<script[^>]*><\/script>/g, ''), 'text/html')
  page.querySelectorAll('link,script').forEach(node => node.remove())
  document.documentElement.innerHTML = page.documentElement.innerHTML
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  const reviewManifest = await readFile('apps/desktop/scripts/icon-review/review-manifest.json', 'utf8')
  vi.stubGlobal('fetch', async (url: string) => new Response(url.endsWith('catalog.json') ? JSON.stringify(catalog) : reviewManifest))
  window.location.hash = ''
  await import('../scripts/icon-review/app.js')
  await vi.waitFor(() => expect((window as unknown as { iconReview?: { ready: boolean } }).iconReview?.ready).toBe(true))

  expect(document.getElementById('view-brand')?.getAttribute('aria-pressed')).toBe('true')
  // The header shows the real default App icon, not a drawn text logo.
  expect(document.querySelector<HTMLImageElement>('#brand-mark')?.getAttribute('src')).toBe(appIconUrl(DEFAULT_APP_ICON))

  const tabs = [...document.querySelectorAll<HTMLElement>('[data-brand-realm]')]
  expect(tabs.map(tab => tab.dataset.brandRealm)).toEqual(APP_ICON_IDS)
  expect(document.querySelector('[data-brand-realm][aria-selected="true"]')?.getAttribute('data-brand-realm')).toBe(DEFAULT_APP_ICON)
  for (const tab of tabs) {
    const id = tab.dataset.brandRealm as (typeof APP_ICON_IDS)[number]
    // Each tab leads with its realm name and says in words whether its heroes are borrowed.
    expect(tab.querySelector('strong')?.textContent).toBe(APP_ICON_CATALOG[id].realm.split(' · ')[0])
    expect(tab.textContent).toContain(resolveBrandHero('launch', id).artRealm !== id ? '借原境的画' : '有自己的大图')
  }
  // Selection is marked by a shape as well as colour, on the selected tab only.
  expect([...document.querySelectorAll('.brand-realm-tabs__check')].map(node => node.closest<HTMLElement>('[data-brand-realm]')?.dataset.brandRealm)).toEqual([DEFAULT_APP_ICON])
  for (const id of APP_ICON_IDS) {
    document.querySelector<HTMLElement>(`[data-brand-realm="${id}"]`)!.click()
    const panel = document.querySelector<HTMLElement>('.brand-realm')!
    expect(panel.dataset.realm).toBe(id)
    for (const [place, surface, colophon] of [['launch', 'launch', true], ['launcher', 'banner', false], ['overview', 'banner', true]] as const) {
      const hero = resolveBrandHero(surface, id), figure = panel.querySelector(`.brand-hero--${place}`)!
      expect(figure.getAttribute('data-surface')).toBe(surface)
      expect(figure.getAttribute('data-realm')).toBe(id)
      expect(figure.getAttribute('data-art-realm')).toBe(hero.artRealm)
      expect(figure.querySelector('img')?.getAttribute('src')).toBe(hero.art)
      // Like the product: launch and the Settings strip name the art's realm; the Launcher does not.
      expect(figure.querySelector('.brand-colophon')?.textContent).toBe(colophon ? hero.colophon : undefined)
      expect(figure.getAttribute('data-borrowed')).toBe(String(hero.artRealm !== id))
    }
    expect(panel.textContent).toContain(APP_ICON_CATALOG[id].material)
    // Borrowed art is explained once for the realm; a realm with its own painting has no note.
    expect(panel.querySelectorAll('[data-lineage]')).toHaveLength(resolveBrandHero('launch', id).artRealm !== id ? 1 : 0)
  }
  // Arrow keys move the realm in focus across all columns together.
  document.querySelector<HTMLElement>(`[data-brand-realm="${ORIGIN_REALM}"]`)!.click()
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  expect(document.querySelector('.brand-realm')?.getAttribute('data-realm')).toBe(APP_ICON_IDS[(APP_ICON_IDS.indexOf(ORIGIN_REALM) + 1) % APP_ICON_IDS.length])

  const commons = manifest.entries.filter(entry => entry.realm === 'commons').map(entry => entry.id).sort()
  expect([...document.querySelectorAll<HTMLElement>('[data-brand-entry]')].map(node => node.dataset.brandEntry).sort()).toEqual(commons)
  for (const image of document.querySelectorAll<HTMLImageElement>('.brand-art img, .brand-avatar img')) expect(image.getAttribute('src'), image.outerHTML).toMatch(/\S/)
  expect(document.querySelectorAll('.brand-vendor')).toHaveLength(BUILT_IN_AGENT_PROVIDER_IDS.length)
  // Each slot holds the product's own drawing of that vendor's mark.
  for (const slot of document.querySelectorAll<HTMLElement>('[data-provider-mark]')) expect(slot.querySelector('svg, img'), slot.dataset.providerMark).not.toBeNull()
}, 20000)
