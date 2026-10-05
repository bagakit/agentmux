import { SVGPathData } from 'svg-pathdata'
import { ICON_GLYPHS, SEMANTIC_ICON_CATALOG, type IconShape, type SemanticIconId } from './icon-catalog.js'
import type { ThemeIconAsset } from './schema.js'

/** One imported icon is a small 24-unit drawing, not an unbounded SVG document. */
export const ICON_PATH_MAX_COMMANDS = 256
export const ICON_PATH_MAX_COORDINATE = 96
export function validIconPath(d: string): boolean {
  try {
    const path = new SVGPathData(d)
    if (!path.commands.length || path.commands.length > ICON_PATH_MAX_COMMANDS || path.commands[0]!.type !== SVGPathData.MOVE_TO) return false
    if (path.commands.some(command => Object.values(command).some(value => typeof value === 'number' && !Number.isFinite(value)))) return false
    // Absolute coordinates protect against small relative commands accumulating enormous extents.
    const absolute = path.toAbs()
    if (absolute.commands.some(command => Object.entries(command).some(([key, value]) => /^(?:x[12]?|y[12]?|rX|rY)$/.test(key) && typeof value === 'number' && Math.abs(value) > ICON_PATH_MAX_COORDINATE))) return false
    const bounds = absolute.getBounds()
    return [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(value => Number.isFinite(value) && Math.abs(value) <= ICON_PATH_MAX_COORDINATE)
      && (bounds.maxX > bounds.minX || bounds.maxY > bounds.minY)
  } catch { return false }
}
export function iconShapes(name: SemanticIconId, overrides: Readonly<Partial<Record<SemanticIconId, ThemeIconAsset>>> = {}): readonly IconShape[] {
  const asset = overrides[name]
  if (asset?.kind === 'paths') return asset.paths.map(path => ['path', { d: path.d, ...(path.fill ? { fill: path.fill } : {}) }] as const)
  const glyph = asset?.kind === 'glyph' ? asset.glyph : SEMANTIC_ICON_CATALOG[name].glyph
  return ICON_GLYPHS[glyph]
}
