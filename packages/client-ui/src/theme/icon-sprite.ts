import { SEMANTIC_ICON_IDS, type SemanticIconId, type IconShape } from './icon-catalog.js'
import { iconShapes } from './icon-assets.js'
import { themeColorSchema, type ThemeValue } from './schema.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
const sprites = new WeakMap<Document, { element: SVGSVGElement; signature: string }>()
export function semanticIconHref(name: SemanticIconId): string { return `#agentmux-icon-${name}` }

/** The document root owns one sprite. Existing React and editor DOM keep stable references. */
export function updateIconSprite(document: Document, theme: Pick<ThemeValue, 'icons' | 'iconStyle'>): void {
  let sprite = sprites.get(document)
  const signature = JSON.stringify(theme.icons)
  if (!sprite) {
    const element = document.createElementNS(SVG_NS, 'svg')
    element.setAttribute('aria-hidden', 'true')
    element.setAttribute('width', '0')
    element.setAttribute('height', '0')
    element.setAttribute('data-semantic-icon-sprite', '')
    element.style.cssText = 'position:absolute;overflow:hidden;pointer-events:none'
    // No display:none: several browsers omit its referenced symbols from rendering.
    document.body.prepend(element)
    sprite = { element, signature: '' }
    sprites.set(document, sprite)
  }
  const root = document.documentElement.style
  root.setProperty('--icon-stroke-width', String(theme.iconStyle.strokeWidth))
  root.setProperty('--icon-linecap', theme.iconStyle.linecap)
  root.setProperty('--icon-linejoin', theme.iconStyle.linejoin)
  if (sprite.signature === signature) return
  const symbols = document.createDocumentFragment()
  for (const name of SEMANTIC_ICON_IDS) {
    const symbol = document.createElementNS(SVG_NS, 'symbol')
    symbol.id = semanticIconHref(name).slice(1)
    symbol.setAttribute('viewBox', '0 0 24 24')
    for (const [tag, attributes] of iconShapes(name, theme.icons)) {
      const shape = document.createElementNS(SVG_NS, tag)
      for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value)
      symbol.append(shape)
    }
    symbols.append(symbol)
  }
  sprite.element.replaceChildren(symbols)
  sprite.signature = signature
}
export function removeIconSprite(document: Document): void {
  sprites.get(document)?.element.remove()
  sprites.delete(document)
}

export function createSemanticIconElement(name: SemanticIconId, document: Document, options: { size?: number; className?: string } = {}): SVGSVGElement {
  const element = document.createElementNS(SVG_NS, 'svg')
  const size = options.size ?? 14
  element.setAttribute('width', String(size))
  element.setAttribute('height', String(size))
  element.setAttribute('viewBox', '0 0 24 24')
  element.setAttribute('fill', 'none')
  element.setAttribute('stroke', 'currentColor')
  element.setAttribute('aria-hidden', 'true')
  element.setAttribute('focusable', 'false')
  element.setAttribute('data-semantic-icon', name)
  element.setAttribute('class', ['semantic-icon', options.className].filter(Boolean).join(' '))
  element.style.pointerEvents = 'none'
  element.style.overflow = 'hidden'
  element.style.strokeWidth = 'var(--icon-stroke-width, 1.75)'
  element.style.strokeLinecap = 'var(--icon-linecap, round)' as 'round'
  element.style.strokeLinejoin = 'var(--icon-linejoin, round)' as 'round'
  const use = document.createElementNS(SVG_NS, 'use')
  use.setAttribute('href', semanticIconHref(name))
  element.append(use)
  return element
}

function attributes(attributes: Readonly<Record<string, string>>): string {
  // Only trusted geometry or validated path data reaches here. Escaping remains explicit for serialization.
  return Object.entries(attributes).map(([key, value]) => ` ${key}="${value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}"`).join('')
}
/** Native backgrounds project trusted geometry using the theme's existing bounded color contract. */
export function iconSvgDataUrl(shapes: readonly IconShape[], style: ThemeValue['iconStyle'], color: string): string {
  const validatedColor = themeColorSchema.parse(color)
  const nodes = shapes.map(([tag, attrs]) => `<${tag}${attributes(attrs)}/>`).join('')
  const svg = `<svg xmlns="${SVG_NS}" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${validatedColor}" stroke-width="${style.strokeWidth}" stroke-linecap="${style.linecap}" stroke-linejoin="${style.linejoin}" color="${validatedColor}">${nodes}</svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}
/** A native mask projects the same geometry, never a separate editable icon mapping. */
export function iconMaskDataUrl(shapes: readonly IconShape[], style: ThemeValue['iconStyle']): string {
  return iconSvgDataUrl(shapes, style, '#000000')
}
