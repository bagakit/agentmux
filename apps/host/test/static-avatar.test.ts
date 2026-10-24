import { expect, it } from 'vitest'
import { Resvg } from '@resvg/resvg-js'
import { BUILT_IN_AGENT_PROVIDER_IDS } from '@agentmux/core/provider-id'
import { DEFAULT_MOTE_FACE } from '@agentmux/core/mote-face'
import { savedAgentAvatarDrawing, savedMoteAvatarDrawing, rasterizeStaticAvatar } from '../src/static-avatar.js'

it.each(BUILT_IN_AGENT_PROVIDER_IDS)('independent Node renders the existing %s artwork including its selected bundled raster', async providerId => {
  const { svg } = savedAgentAvatarDrawing({ appearance: {} }, providerId)
  const image = await rasterizeStaticAvatar(svg, 64)
  expect(image).toMatchObject({ width: 64, height: 64 })
  expect(image.byteLength).toBeGreaterThan(150)
  expect(image.byteLength).toBeLessThan(64 * 1024)
  const pixels = new Resvg(svg, { font: { loadSystemFonts: false } }).render().pixels
  expect(pixels.filter((_value, index) => index % 4 === 3 && pixels[index]! > 0).length).toBeGreaterThan(100)
  expect(svg).not.toMatch(/<(?:use|script|foreignObject|text)\b|href="(?:file:|https?:)/u)
})

it.each([null, 'rocket', DEFAULT_MOTE_FACE])('renders the original static Mote choice without Desktop, files or a document sprite', async choice => {
  const svg = savedMoteAvatarDrawing(choice, {})!
  expect(svg).toContain('<svg'); expect(svg).not.toMatch(/<use\b|<text\b|<script\b/u)
  const image = await rasterizeStaticAvatar(svg, 256)
  expect(image).toMatchObject({ width: 256, height: 256 })
  expect(image.byteLength).toBeGreaterThan(1000)
})

it('uses exact local Executor decorations and original theme artwork rather than equal labels or a second icon set', async () => {
  const config = { appearance: { themeId: 'retro-future' }, executors: {
    first: { label: 'Same name', providerId: 'codex', avatar: { tint: '#67b9ef', badge: 'bolt' } },
    second: { label: 'Same name', providerId: 'codex', avatar: { tint: '#ed7777', badge: 'shield' } }
  } }
  const first = savedAgentAvatarDrawing(config, 'codex', 'first'), second = savedAgentAvatarDrawing(config, 'codex', 'second')
  expect(first.svg).toContain('feMorphology'); expect(first.svg).toContain('data-avatar-badge="bolt"')
  expect(second.svg).toContain('data-avatar-badge="shield"'); expect(first.revision).not.toBe(second.revision)
  expect((await rasterizeStaticAvatar(first.svg, 64)).dataUrl).not.toBe((await rasterizeStaticAvatar(second.svg, 64)).dataUrl)
  expect(() => savedAgentAvatarDrawing(config, 'gemini', 'first')).toThrow('original Executor Provider changed')
  const unknown = savedAgentAvatarDrawing({}, 'independent-provider')
  expect(unknown.svg).not.toContain('<use'); expect((await rasterizeStaticAvatar(unknown.svg, 64)).byteLength).toBeGreaterThan(150)
})

it('does not resolve arbitrary external SVG images, fonts, paths or active content', async () => {
  for (const svg of ['<svg><image href="file:///foreign.png"/></svg>', '<svg><image href="https://external.test/x.png"/></svg>',
    '<svg><text>System font discovery</text></svg>', '<svg><use href="#missing"/></svg>', '<svg><script/></svg>'])
    await expect(rasterizeStaticAvatar(svg, 64)).rejects.toThrow('unsupported external drawing resource')
})

it('gives each native render its own cancellation scope while retaining the same Host lane signal', async () => {
  const svg = savedAgentAvatarDrawing({}, 'codex').svg, owner = new AbortController()
  const images = await Promise.all([rasterizeStaticAvatar(svg, 64, owner.signal), rasterizeStaticAvatar(svg, 64, owner.signal)])
  expect(images[0]).toEqual(images[1]); expect(await rasterizeStaticAvatar(svg, 64, owner.signal)).toEqual(images[0])
  expect(owner.signal.aborted).toBe(false)
  owner.abort(); await expect(rasterizeStaticAvatar(svg, 64, owner.signal)).rejects.toThrow()
})
