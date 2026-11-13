// @vitest-environment happy-dom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { APP_ICON_CATALOG, APP_ICON_IDS, DEFAULT_APP_ICON, ORIGIN_REALM } from '@agentmux/client-ui/app-icon-catalog'
import { resolveBrandHero, resolveBrandHeroFrom } from '../src/renderer/src/lib/brand-hero'
import { themeBootstrap } from '../src/main/theme-bootstrap'
import { api } from '../src/renderer/src/lib/api'
import { FullPageLoadingSurface } from '../src/renderer/src/components/FullPageLoadingSurface'
import { composerConfig } from './helpers/composer-dom-fixture'

const originalInitialTheme = api.ui.initialTheme
afterEach(() => { api.ui.initialTheme = originalInitialTheme })

describe('brand realm hero resolution', () => {
  it('names the realm of the art actually shown, for every saved choice and every surface', () => {
    for (const surface of ['launch', 'banner'] as const) {
      const origin = resolveBrandHero(surface, ORIGIN_REALM)
      expect(origin.artRealm).toBe(ORIGIN_REALM)
      expect(origin.art).toMatch(/origin-(launch|banner).*\.avif/)
      for (const id of APP_ICON_IDS) {
        const hero = resolveBrandHero(surface, id)
        // Today only Origin is painted, so every realm shows its ancestor's art; the colophon
        // must describe that art rather than the viewer's realm.
        expect(hero.art).toBe(origin.art)
        expect(hero.colophon).toBe(APP_ICON_CATALOG[hero.artRealm].realm)
      }
    }
    expect(resolveBrandHero('launch', 'launch').art).not.toBe(resolveBrandHero('banner', 'launch').art)
  })

  it('treats unset as the documented default and an unknown or unobserved value as Origin with no lineage claim', () => {
    expect(resolveBrandHero('banner', undefined)).toEqual(resolveBrandHero('banner', DEFAULT_APP_ICON))
    for (const unknown of ['from-a-newer-client', null, 7, {}]) {
      expect(resolveBrandHero('banner', unknown)).toEqual(resolveBrandHero('banner', ORIGIN_REALM))
    }
    expect(resolveBrandHero('launch', DEFAULT_APP_ICON, false)).toEqual(resolveBrandHero('launch', ORIGIN_REALM))
  })

  it('a realm with its own painting shows it; the others keep borrowing from Origin', () => {
    // A second painted realm makes every branch observable before its real art exists.
    const heroes = { classic: { launch: 'origin-launch', banner: 'origin-banner' }, qingzhuan: { launch: 'woodcut-launch', banner: 'woodcut-banner' } }
    expect(resolveBrandHeroFrom(heroes, 'banner', 'qingzhuan')).toEqual({ realm: 'qingzhuan', art: 'woodcut-banner', artRealm: 'qingzhuan', colophon: APP_ICON_CATALOG.qingzhuan.realm })
    expect(resolveBrandHeroFrom(heroes, 'launch', undefined)).toMatchObject({ art: 'woodcut-launch', artRealm: DEFAULT_APP_ICON })
    expect(resolveBrandHeroFrom(heroes, 'banner', 'huihuan')).toEqual({ realm: 'huihuan', art: 'origin-banner', artRealm: ORIGIN_REALM, colophon: APP_ICON_CATALOG[ORIGIN_REALM].realm })
    expect(resolveBrandHeroFrom(heroes, 'banner', 'from-a-newer-client').artRealm).toBe(ORIGIN_REALM)
    expect(resolveBrandHeroFrom(heroes, 'banner', 'qingzhuan', false).artRealm).toBe(ORIGIN_REALM)
  })
})

describe('first launch frame', () => {
  it('Main projects the saved App icon into the synchronous bootstrap exactly as read', () => {
    const appearance = { ...composerConfig.appearance, appIcon: 'huihuan' as const }
    expect(themeBootstrap(appearance, true).appIcon).toBe('huihuan')
    const { appIcon: _unset, ...withoutIcon } = appearance
    expect('appIcon' in themeBootstrap(withoutIcon, true)).toBe(false)
  })

  it('the launch surface draws one resolved image and its colophon from the bootstrap realm', () => {
    const snapshot = themeBootstrap({ ...composerConfig.appearance, appIcon: 'lingban' }, true)
    api.ui.initialTheme = snapshot
    const markup = renderToStaticMarkup(createElement(FullPageLoadingSurface, { phase: 'loading', scope: 'app', title: 'Starting', detail: '' }))
    const expected = resolveBrandHero('launch', 'lingban')
    expect(markup.match(/<img /g)).toHaveLength(1)
    expect(markup).toContain(`src="${expected.art}"`)
    expect(markup).toContain('data-realm="lingban"')
    expect(markup).toContain(`data-art-realm="${expected.artRealm}"`)
    expect(markup).toContain(`>${expected.colophon}</span>`)
  })

  it('an unavailable bootstrap still paints Origin art and its own colophon', () => {
    api.ui.initialTheme = { status: 'unavailable', message: 'not confirmed' }
    const markup = renderToStaticMarkup(createElement(FullPageLoadingSurface, { phase: 'loading', scope: 'app', title: 'Starting', detail: '' }))
    expect(markup).toContain(`data-realm="${ORIGIN_REALM}"`)
    expect(markup).toContain(`data-art-realm="${ORIGIN_REALM}"`)
    expect(markup).toContain(`>${APP_ICON_CATALOG[ORIGIN_REALM].realm}</span>`)
  })
})

describe('saved-choice surfaces', () => {
  it('Settings Overview shows the saved realm, never an Appearance draft, and names the art it shows', async () => {
    const { SettingsOverviewPane } = await import('../src/renderer/src/components/settings/SettingsOverviewPane')
    for (const appIcon of ['zheyu', undefined, 'from-a-newer-client'] as const) {
      const config = { ...composerConfig, appearance: { ...composerConfig.appearance, ...(appIcon === undefined ? {} : { appIcon }) } } as typeof composerConfig
      const markup = renderToStaticMarkup(createElement(SettingsOverviewPane, { config, groups: [], onOpen: () => {} }))
      const expected = resolveBrandHero('banner', appIcon)
      expect(markup).toContain(`data-realm="${expected.realm}"`)
      expect(markup).toContain(`src="${expected.art}"`)
      expect(markup).toContain(`>${expected.colophon}</span>`)
    }
  })

  it('the Launcher stylesheet places only the image its surface is given', async () => {
    const { readFile } = await import('node:fs/promises')
    const css = await readFile('apps/desktop/src/renderer/src/styles/launcher.css', 'utf8')
    const launch = css.match(/\.launch-surface \{([^}]+)\}/)![1]!
    expect(launch).toContain('var(--launcher-hero, none)')
    expect(launch).not.toMatch(/url\(/)
    const surface = await readFile('apps/desktop/src/renderer/src/components/NewTabSurface.tsx', 'utf8')
    expect(surface).toMatch(/resolveBrandHero\('banner', config\?\.appearance\.appIcon, config !== null\)/)
    expect(surface).toContain("'--launcher-hero': `url(\"${launcherHero}\")`")
  })
})
