import { resolveAppIcon, type AppIconId } from './app-icon-catalog.js'

/** Browser bundlers project the same five authoritative assets; no configuration is held here. */
export function appIconUrl(icon?: AppIconId): string {
  const id = resolveAppIcon(icon)
  return new URL(`../assets/app-icons/${id}.png`, import.meta.url).href
}
