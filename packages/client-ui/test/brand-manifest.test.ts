import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_ICON_IDS, ORIGIN_REALM } from '../src/lib/app-icon-catalog.js'

const brand = join(import.meta.dirname, '..', 'brand')
const repository = join(import.meta.dirname, '..', '..', '..')
type Entry = { id: string; kind: string; file: string; realm: string; origin: string; followsAppIcon: boolean; surface?: string }
type External = { id: string; kind: string; path: string; origin: string; license?: string }
const manifest = JSON.parse(readFileSync(join(brand, 'brand-manifest.json'), 'utf8')) as { schema: string; entries: Entry[]; external: External[] }

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : [relative(brand, path)]
  })
}

describe('brand manifest', () => {
  it('lists every brand file exactly once and only files that exist', () => {
    const listed = manifest.entries.map(entry => entry.file)
    expect(new Set(listed).size).toBe(listed.length)
    const actual = files(brand).filter(path => path !== 'README.md' && path !== 'brand-manifest.json').sort()
    expect(actual.length).toBeGreaterThan(0)
    expect([...listed].sort()).toEqual(actual)
    expect(new Set(manifest.entries.map(entry => entry.id)).size).toBe(manifest.entries.length)
  })

  it('names a known realm for every entry and an App icon source for every realm', () => {
    const realms = new Set<string>([...APP_ICON_IDS, 'commons'])
    for (const entry of manifest.entries) expect(realms.has(entry.realm), entry.id).toBe(true)
    for (const id of APP_ICON_IDS) expect(manifest.entries.some(entry => entry.kind === 'app-icon' && entry.realm === id), id).toBe(true)
    // Origin is the one realm every hero surface can always fall back to.
    for (const surface of ['launch', 'banner']) {
      expect(manifest.entries.some(entry => entry.kind === 'hero' && entry.realm === ORIGIN_REALM && entry.surface === surface), surface).toBe(true)
    }
    // Commons art belongs to every realm and never switches with the App icon.
    for (const entry of manifest.entries.filter(entry => entry.realm === 'commons')) expect(entry.followsAppIcon, entry.id).toBe(false)
  })

  it('points every referenced external asset at a real path and records third-party licensing', () => {
    expect(manifest.external.length).toBeGreaterThan(0)
    for (const asset of manifest.external) expect(existsSync(join(repository, asset.path)), asset.path).toBe(true)
    const geometry = manifest.external.find(asset => asset.id === 'avatar-series.geometry')
    expect(geometry?.license).toBe('CC0-1.0')
  })
})
