import { describe, expect, it } from 'vitest'
import { magicWandOutline, magicWandRegion, outlineContains, unionMagicWandRegions } from '@agentmux/client-ui/image-annotation'

/** An RGBA image from rows of single-letter colors. */
function pixels(rows: string[], palette: Record<string, [number, number, number]>) {
  const height = rows.length, width = rows[0]!.length, data = new Uint8ClampedArray(width * height * 4)
  rows.forEach((row, y) => [...row].forEach((letter, x) => { data.set([...palette[letter]!, 255], (y * width + x) * 4) }))
  return { width, height, data }
}
const colors: Record<string, [number, number, number]> = { a: [200, 40, 40], b: [20, 20, 20], c: [205, 45, 40], w: [255, 255, 255] }
/** The selected pixels, row by row, as `#` and `.`. */
function picture(region: NonNullable<ReturnType<typeof magicWandRegion>>) {
  return Array.from({ length: region.height }, (_, y) => Array.from({ length: region.width }, (_, x) => region.mask[y * region.width + x] ? '#' : '.').join(''))
}
/** How many pixels a selection holds. */
const selected = (region: NonNullable<ReturnType<typeof magicWandRegion>>) => region.mask.reduce((total, value) => total + value, 0)
/** Every pixel centre the even-odd outline fills must be a selected pixel, and the reverse. */
function outlineMatchesMask(region: NonNullable<ReturnType<typeof magicWandRegion>>) {
  const outline = magicWandOutline(region)
  for (let y = 0; y < region.height; y++) for (let x = 0; x < region.width; x++)
    expect(outlineContains(outline, { x: x + 0.5, y: y + 0.5 }), `pixel ${x},${y}`).toBe(region.mask[y * region.width + x] === 1)
  return outline
}

describe('magic wand selection', () => {
  it('selects one connected solid-color region and traces it as one closed ring on pixel corners', () => {
    const image = pixels(['bbbbb', 'baaab', 'baaab', 'bbbbb'], colors)
    const region = magicWandRegion(image, { x: 2.7, y: 1.2 }, 0)!
    expect(picture(region)).toEqual(['.....', '.###.', '.###.', '.....'])
    expect(selected(region)).toBe(6)
    expect(region.bounds).toEqual({ x: 1, y: 1, width: 3, height: 2 })
    const outline = outlineMatchesMask(region)
    expect(outline, 'only the four corners where the edge turns remain').toEqual([[{ x: 1, y: 1 }, { x: 1, y: 3 }, { x: 4, y: 3 }, { x: 4, y: 1 }]])
  })

  it('grows with tolerance across near colors and stops at distant ones', () => {
    const image = pixels(['aac', 'acb', 'bbb'], colors)
    expect(picture(magicWandRegion(image, { x: 0, y: 0 }, 0)!), 'tolerance 0 keeps only the exact seed color').toEqual(['##.', '#..', '...'])
    expect(picture(magicWandRegion(image, { x: 0, y: 0 }, 5)!), 'a small tolerance reaches the near red').toEqual(['###', '##.', '...'])
    expect(picture(magicWandRegion(image, { x: 0, y: 0 }, 100)!), 'the full tolerance selects everything connected').toEqual(['###', '###', '###'])
    const ramp = { width: 6, height: 1, data: new Uint8ClampedArray([0, 30, 60, 90, 120, 150].flatMap(value => [value, value, value, 255])) }
    // Each step is 30 · √3 ≈ 52 of the 441.7 maximum: 11.8 per step on the 0–100 scale, measured from the seed.
    expect(picture(magicWandRegion(ramp, { x: 0, y: 0 }, 12)!), 'a gradient is measured from the seed color').toEqual(['##....'])
    expect(picture(magicWandRegion(ramp, { x: 0, y: 0 }, 24)!)).toEqual(['###...'])
  })

  it('keeps holes as inner rings so even-odd filling leaves them untouched', () => {
    const image = pixels(['aaaaa', 'abbba', 'abwba', 'abbba', 'aaaaa'], colors)
    const region = magicWandRegion(image, { x: 0, y: 0 }, 0)!
    expect(selected(region)).toBe(16)
    const outline = outlineMatchesMask(region)
    expect(outline).toHaveLength(2)
    expect(outlineContains(outline, { x: 2.5, y: 2.5 }), 'the hole is not filled').toBe(false)
  })

  it('keeps diagonally touching pixels as separate rings and unions Shift-click selections', () => {
    const image = pixels(['ab', 'ba'], colors)
    const first = magicWandRegion(image, { x: 0, y: 0 }, 0)!
    expect(selected(first), '4-neighbour fill never crosses a diagonal').toBe(1)
    const both = unionMagicWandRegions(first, magicWandRegion(image, { x: 1, y: 1 }, 0)!)
    expect(selected(both)).toBe(2)
    expect(both.bounds).toEqual({ x: 0, y: 0, width: 2, height: 2 })
    expect(outlineMatchesMask(both)).toHaveLength(2)
    expect(() => unionMagicWandRegions(first, magicWandRegion(pixels(['a'], colors), { x: 0, y: 0 }, 0)!)).toThrow('different images')
  })

  it('selects nothing for a seed outside the image and gives the same answer for the same input', () => {
    const image = pixels(['ab', 'ba'], colors)
    for (const seed of [{ x: -1, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }, { x: Number.NaN, y: 0 }]) expect(magicWandRegion(image, seed, 50), JSON.stringify(seed)).toBeNull()
    const large = pixels(['abab', 'aaaa', 'bbba'], colors)
    expect(magicWandOutline(magicWandRegion(large, { x: 0, y: 0 }, 10)!)).toEqual(magicWandOutline(magicWandRegion(large, { x: 0, y: 0 }, 10)!))
  })

  it('selects and outlines a full-HD frame within an interactive budget', () => {
    const width = 1920, height = 1080, data = new Uint8ClampedArray(width * height * 4)
    // A light page with a dark text-like stripe pattern: the largest region and many inner rings.
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const dark = y % 24 < 3 && x % 16 < 10
      data.set(dark ? [30, 30, 30, 255] : [245, 246, 248, 255], (y * width + x) * 4)
    }
    const started = performance.now()
    const region = magicWandRegion({ width, height, data }, { x: 5, y: 10 }, 8)!
    const outline = magicWandOutline(region)
    const elapsed = performance.now() - started
    expect(selected(region)).toBe(width * height - 45 * 120 * 30)
    // Stripes on the top row and left column touch the border, so they notch the outer ring instead of making holes.
    expect(outline.length, 'one outer ring and one per enclosed dark stripe').toBe(1 + 44 * 119)
    expect(elapsed, `full-HD click took ${elapsed.toFixed(0)} ms`).toBeLessThan(1000)
  })
})
