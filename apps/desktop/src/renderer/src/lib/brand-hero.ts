import { APP_ICON_CATALOG, ORIGIN_REALM, isAppIconId, resolveAppIcon, type AppIconId } from '@agentmux/client-ui/app-icon-catalog'
import originLaunch from '@agentmux/client-ui/brand/heroes/origin-launch.avif'
import originBanner from '@agentmux/client-ui/brand/heroes/origin-banner.avif'

/** Launch is the full-bleed app start; banner backs the Launcher and the Settings Overview. */
export type BrandHeroSurface = 'launch' | 'banner'
type BrandHero = Record<BrandHeroSurface, string>

/**
 * Hero art painted for each realm. Origin is required by the type; any other realm without
 * its own painting shows Origin's, which is that realm's ancestor. Add a realm's art here and
 * every hero surface picks it up; nothing else lists hero files.
 */
export type BrandHeroTable = Partial<Record<AppIconId, BrandHero>> & Record<typeof ORIGIN_REALM, BrandHero>
const BRAND_HEROES: BrandHeroTable = {
  classic: { launch: originLaunch, banner: originBanner }
}

export type ResolvedBrandHero = {
  /** The realm this surface was set to show; Origin when the choice is unknown or unobserved. */
  realm: AppIconId
  /** URL of the one image this surface loads. */
  art: string
  /** The realm the shown art belongs to, which is what its colophon names. */
  artRealm: AppIconId
  /** Colophon text: a description of the art itself, never of the viewer's choice. */
  colophon: string
}

/**
 * The saved App icon decides the realm. Unset means the documented default. A saved value
 * this client doesn't know, or no observation at all, shows Origin art and makes no claim
 * about the user's realm. Nothing here writes or remembers a choice.
 */
export function resolveBrandHeroFrom(heroes: BrandHeroTable, surface: BrandHeroSurface, saved: unknown, observed = true): ResolvedBrandHero {
  const realm = observed && (saved === undefined || isAppIconId(saved)) ? resolveAppIcon(saved) : ORIGIN_REALM
  const artRealm = heroes[realm] ? realm : ORIGIN_REALM
  const hero = heroes[artRealm] ?? heroes[ORIGIN_REALM]
  return { realm, art: hero[surface], artRealm, colophon: APP_ICON_CATALOG[artRealm].realm }
}

/** Hero art for a surface from the product's own table. */
export function resolveBrandHero(surface: BrandHeroSurface, saved: unknown, observed = true): ResolvedBrandHero {
  return resolveBrandHeroFrom(BRAND_HEROES, surface, saved, observed)
}
