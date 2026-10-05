import { expect, it } from 'vitest'
import { GRAPHITE_THEME } from '../src/theme/catalog.js'
import { iconShapes, iconMaskDataUrl, iconSvgDataUrl } from '../src/theme/icons.js'

it('native backgrounds and masks serialize the same semantic geometry and bounded style', () => {
  const shapes = iconShapes('navigation.disclosure', {
    'navigation.disclosure': { kind: 'paths', paths: [{ d: 'M3 12L21 12', fill: 'currentColor' }] }
  })
  const url = iconSvgDataUrl(shapes, GRAPHITE_THEME.iconStyle, '#17201a')
  const svg = decodeURIComponent(url)
  expect(url).toMatch(/^url\("data:image\/svg\+xml,/)
  expect(svg).toContain('width="24" height="24" viewBox="0 0 24 24"')
  expect(svg).toContain('stroke="#17201a"')
  expect(svg).toContain('color="#17201a"')
  expect(svg).toContain('d="M3 12L21 12" fill="currentColor"')
  expect(svg).toContain(`stroke-width="${GRAPHITE_THEME.iconStyle.strokeWidth}"`)
  expect(iconMaskDataUrl(shapes, GRAPHITE_THEME.iconStyle)).toBe(iconSvgDataUrl(shapes, GRAPHITE_THEME.iconStyle, '#000000'))
})

it('native background colors use the same theme-file color boundary', () => {
  const shapes = iconShapes('navigation.disclosure')
  for (const color of ['red', '#123', 'url(https://example.org/icon)', '#17201a" onload="script', 'currentColor']) {
    expect(() => iconSvgDataUrl(shapes, GRAPHITE_THEME.iconStyle, color), color).toThrow()
  }
})

it('native serialization escapes attributes of trusted geometry', () => {
  const svg = decodeURIComponent(iconSvgDataUrl([['path', { d: 'M3 12L21 12', 'data-note': '"<&' }]], GRAPHITE_THEME.iconStyle, '#17201a'))
  expect(svg).toContain('data-note="&quot;&lt;&amp;"')
  expect(svg).not.toContain('data-note=""<')
})
