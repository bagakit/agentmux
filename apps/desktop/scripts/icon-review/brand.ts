import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { APP_ICON_CATALOG, APP_ICON_IDS, DEFAULT_APP_ICON, ORIGIN_REALM, type AppIconId } from '../../../../packages/client-ui/src/lib/app-icon-catalog.js'
import { appIconUrl } from '../../../../packages/client-ui/src/lib/app-icon-url.js'
import { AgentProviderArtwork } from '../../../../packages/client-ui/src/components/AgentProviderIcon.js'
import { BUILT_IN_AGENT_PROVIDER_IDS, builtInAgentProviderLabel } from '../../../../packages/core/src/agent-provider-id.js'
import manifest from '../../../../packages/client-ui/brand/brand-manifest.json'
import silhouetteSeries from '../../resources/avatar-series/mote-silhouettes/series.json'
import lowpolySeries from '../../resources/avatar-series/lowpoly/series.json'
import { resolveBrandHero, type BrandHeroSurface } from '../../src/renderer/src/lib/brand-hero.js'

type ManifestEntry = (typeof manifest.entries)[number]

/** Brand files resolve through the bundler from their one source, never a copied path. */
const brandFiles = import.meta.glob('../../../../packages/client-ui/brand/**/*.{png,avif,svg}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
const seriesFiles = import.meta.glob('../../resources/avatar-series/{mote-silhouettes,lowpoly}/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
export function brandFileUrl(file: string): string | undefined {
  return brandFiles['../../../../packages/client-ui/brand/' + file]
}
function seriesUrl(directory: string, file: string): string | undefined {
  return seriesFiles[`../../resources/avatar-series/${directory}/${file}`]
}

export type BrandRealm = {
  id: AppIconId; label: string; realm: string; material: string; icon: string
  isDefault: boolean; isOrigin: boolean
  heroes: Record<BrandHeroSurface, { realm: AppIconId; art: string; artRealm: AppIconId; colophon: string; borrowed: boolean }>
}

/** Every realm, rendered through the product's own catalog, App icon projection and hero resolver. */
export function brandRealms(): BrandRealm[] {
  return APP_ICON_IDS.map(id => {
    const hero = (surface: BrandHeroSurface) => {
      const resolved = resolveBrandHero(surface, id)
      return { realm: resolved.realm, art: resolved.art, artRealm: resolved.artRealm, colophon: resolved.colophon, borrowed: resolved.artRealm !== resolved.realm }
    }
    return { id, label: APP_ICON_CATALOG[id].label, realm: APP_ICON_CATALOG[id].realm, material: APP_ICON_CATALOG[id].material,
      icon: appIconUrl(id), isDefault: id === DEFAULT_APP_ICON, isOrigin: id === ORIGIN_REALM, heroes: { launch: hero('launch'), banner: hero('banner') } }
  })
}

export type BrandArtwork = ManifestEntry & { url: string | undefined }
/** Commons illustrations, grouped as their directories group them. */
export function brandCommons(): { group: string; items: BrandArtwork[] }[] {
  const groups = new Map<string, BrandArtwork[]>()
  for (const entry of manifest.entries.filter(item => item.realm === 'commons')) {
    const group = entry.file.split('/')[1] ?? 'other'
    groups.set(group, [...(groups.get(group) ?? []), { ...entry, url: brandFileUrl(entry.file) }])
  }
  return [...groups].map(([group, items]) => ({ group, items }))
}

export function brandManifest() { return manifest }

export type BrandAvatar = { series: string; id: string; title: string; url: string | undefined }
/** Mote's own multiverse and the low-poly companions, read from the series the product ships. */
export function brandAvatars(): BrandAvatar[] {
  const from = (directory: string, series: { title?: string; entries: { id: string; title: string; definition: { kind: string; file?: string } }[] }) =>
    series.entries.filter(entry => entry.definition.kind === 'image' && entry.definition.file)
      .map(entry => ({ series: series.title ?? directory, id: entry.id, title: entry.title, url: seriesUrl(directory, entry.definition.file!) }))
  return [...from('mote-silhouettes', silhouetteSeries), ...from('lowpoly', lowpolySeries)]
}

export type BrandMark = { id: string; label: string }
/** Built-in Provider marks; they belong to each vendor and are shown, never restyled. */
export function providerMarks(): BrandMark[] {
  return BUILT_IN_AGENT_PROVIDER_IDS.map(id => ({ id, label: builtInAgentProviderLabel(id) }))
}
/** Draws each mark into its slot with the same component the product uses. */
export function mountProviderMarks(host: HTMLElement, size = 28) {
  const roots = [...host.querySelectorAll<HTMLElement>('[data-provider-mark]')].map(slot => {
    const root = createRoot(slot)
    flushSync(() => root.render(createElement(AgentProviderArtwork, { providerId: slot.dataset.providerMark!, size })))
    return root
  })
  return { dispose: () => { for (const root of roots) root.unmount() } }
}
