import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const core = new URL('../', import.meta.url)
const contract = JSON.parse(readFileSync(new URL('src/ctxmux-artifact-contract.json', core), 'utf8')) as {
  sources: Record<string, { commit: string }>
  protocol: number
}
const platforms = Object.keys(contract.sources)
const { bin } = JSON.parse(readFileSync(new URL('package.json', core), 'utf8')) as { bin: Record<string, string> }

// The entry links to the version owner instead of copying a commit/protocol that drifts at every upgrade.
// Derive the platform set from the bundled artifact contract; check both language editions.
describe.each(['README.md', 'README.zh-CN.md'])('%s artifact sources', edition => {
  const readmeUrl = new URL(`../../${edition}`, core)
  const readme = readFileSync(readmeUrl, 'utf8')
  const links = [...readme.matchAll(/\]\(([^\s)]+)\)/g)].map(match => new URL(match[1], readmeUrl).href)

  it('reads nonempty documentation, artifact platforms and executable declarations', () => {
    expect(readme.length).toBeGreaterThan(2000)
    expect(platforms.length).toBeGreaterThan(0)
    expect(Object.keys(bin).length).toBeGreaterThan(0)
    expect(links.length).toBeGreaterThan(0)
  })

  it('links to the authoritative manifest for every bundled platform', () => {
    for (const platform of platforms) {
      const manifestUrl = new URL(`vendor/ctxmux/${platform}/manifest.json`, core)
      expect(links, `Missing ${platform} manifest link`).toContain(manifestUrl.href)
      const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as {
        source: { commit: string }
        product: { protocol: number }
        support: { platform: string; architecture: string }
      }
      expect(manifest.source.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(manifest.source.commit).toBe(contract.sources[platform].commit)
      expect(manifest.product.protocol).toBeGreaterThan(0)
      expect(manifest.product.protocol).toBe(contract.protocol)
      expect(`${manifest.support.platform}-${manifest.support.architecture}`).toBe(platform)
    }
  })

  it('names every executable declared by the Core package', () => {
    for (const executable of Object.keys(bin)) expect(readme).toContain(`\`${executable}\``)
  })
})
