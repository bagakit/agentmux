import { ICON_GLYPHS, SEMANTIC_ICON_IDS, type SemanticIconId, type IconShape } from './icon-catalog.js'
import { iconShapes } from './icon-assets.js'
import { themeColorSchema, type ThemeValue } from './schema.js'
import { SEMANTIC_ICON_PEN, type SemanticIconPresentation } from './icon-presentation.js'

/** CSS and native widgets consume these semantic masks while retaining their original DOM state. */
const NATIVE_ICON_PROJECTIONS = {
  '--native-checkbox-mask': 'control.checkbox-checked',
  '--native-radio-mask': 'control.radio-checked',
  '--native-disclosure-mask': 'navigation.disclosure',
  '--native-select-open-mask': 'control.select-open',
  '--native-window-resize-mask': 'layout.resize-window',
  '--native-connection-connected-mask': 'status.connection-connected',
  '--native-connection-unconfirmed-mask': 'status.connection-unconfirmed',
  '--native-presence-unknown-mask': 'status.presence-unknown',
  '--native-presence-starting-mask': 'status.presence-starting',
  '--native-presence-neutral-mask': 'status.presence-neutral',
  '--native-presence-working-mask': 'status.presence-working',
  '--native-presence-running-mask': 'status.presence-running',
  '--native-presence-waiting-mask': 'status.presence-waiting',
  '--native-presence-blocked-mask': 'status.presence-blocked',
  '--native-presence-error-mask': 'status.presence-error',
  '--native-presence-exited-mask': 'status.presence-exited',
  '--native-presence-done-mask': 'status.presence-done',
  '--native-presence-disconnected-mask': 'status.presence-disconnected',
  '--native-permission-safe-mask': 'status.permission-safe',
  '--native-permission-caution-mask': 'status.permission-caution',
  '--native-permission-danger-mask': 'status.permission-danger',
  '--native-permission-unknown-mask': 'status.permission-unknown'
} as const satisfies Record<string, SemanticIconId>

const NATIVE_ICON_IMAGES = {
  '--native-select-open-image': 'control.select-open',
  '--native-date-open-image': 'control.date-open',
  '--native-time-open-image': 'control.time-open'
} as const satisfies Record<string, SemanticIconId>

const SVG_NS = 'http://www.w3.org/2000/svg'
const sprites = new WeakMap<Document, { element: SVGSVGElement; signature: string; nativeSignature: string; imageSignature: string }>()
export function semanticIconHref(name: SemanticIconId): string { return `#agentmux-icon-${name}` }

export const WORK_ICON_PARTS = ['body', 'pen'] as const
export function workIconHref(name: SemanticIconId, part: typeof WORK_ICON_PARTS[number]): string {
  return `${semanticIconHref(name)}${part === 'pen' ? '--work-pen' : ''}`
}

/** The document root owns one sprite. Existing React and editor DOM keep stable references. */
export function updateIconSprite(document: Document, theme: Pick<ThemeValue, 'icons' | 'iconStyle'>, nativeTextColor: string): void {
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
    sprite = { element, signature: '', nativeSignature: '', imageSignature: '' }
    sprites.set(document, sprite)
  }
  const root = document.documentElement.style
  // Retained avatar nodes follow the same resolved asset, without per-avatar subscriptions.
  const companion = iconShapes('object.mote', theme.icons) === ICON_GLYPHS['mote-companion']
  root.setProperty('--mote-companion-rest-display', companion ? 'none' : 'inline')
  root.setProperty('--mote-companion-rig-display', companion ? 'inline' : 'none')
  root.setProperty('--icon-stroke-width', String(theme.iconStyle.strokeWidth))
  root.setProperty('--icon-linecap', theme.iconStyle.linecap)
  root.setProperty('--icon-linejoin', theme.iconStyle.linejoin)
  const nativeSignature = JSON.stringify([theme.icons, theme.iconStyle])
  if (sprite.nativeSignature !== nativeSignature) {
    for (const [property, name] of Object.entries(NATIVE_ICON_PROJECTIONS)) root.setProperty(property, iconMaskDataUrl(iconShapes(name, theme.icons), theme.iconStyle))
    sprite.nativeSignature = nativeSignature
  }
  const imageSignature = JSON.stringify([Object.values(NATIVE_ICON_IMAGES).map(name => theme.icons[name]), theme.iconStyle, nativeTextColor])
  if (sprite.imageSignature !== imageSignature) {
    for (const [property, name] of Object.entries(NATIVE_ICON_IMAGES)) root.setProperty(property, iconSvgDataUrl(iconShapes(name, theme.icons), theme.iconStyle, nativeTextColor))
    sprite.imageSignature = imageSignature
  }
  if (sprite.signature === signature) return
  const symbols = document.createDocumentFragment()
  const workRules: string[] = []
  for (const name of SEMANTIC_ICON_IDS) {
    const symbol = document.createElementNS(SVG_NS, 'symbol')
    symbol.id = semanticIconHref(name).slice(1)
    symbol.setAttribute('viewBox', '0 0 24 24')
    const pen = document.createElementNS(SVG_NS, 'symbol')
    pen.id = `${symbol.id}--work-pen`
    pen.setAttribute('viewBox', '0 0 24 24')
    for (const [tag, attributes] of iconShapes(name, theme.icons)) {
      const shape = document.createElementNS(SVG_NS, tag)
      for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value)
      symbol.append(shape)
      if (attributes['data-semantic-icon-part'] === 'writing-pen') {
        const drawing = shape.cloneNode(true) as SVGElement
        drawing.removeAttribute('data-semantic-icon-part')
        pen.append(drawing)
      }
    }
    symbols.append(symbol)
    if (pen.childElementCount) {
      symbols.append(pen)
      workRules.push(`.semantic-icon-motion[data-semantic-work="${name}"]{--icon-work-part-animation:semantic-icon-work-pen}`)
    }
  }
  const workStyle = document.createElementNS(SVG_NS, 'style')
  workStyle.textContent = workRules.join('\n')
  symbols.append(workStyle)
  sprite.element.replaceChildren(symbols)
  sprite.signature = signature
}
export function removeIconSprite(document: Document): void {
  sprites.get(document)?.element.remove()
  sprites.delete(document)
}

type NativeIconOptions = SemanticIconPresentation & { className?: string }
export function createSemanticIconElement(name: SemanticIconId, document: Document, options?: NativeIconOptions & { animation?: 'none' }): SVGSVGElement
export function createSemanticIconElement(name: SemanticIconId, document: Document, options: NativeIconOptions): SVGSVGElement | HTMLSpanElement
export function createSemanticIconElement(name: SemanticIconId, document: Document, options: NativeIconOptions = {}): SVGSVGElement | HTMLSpanElement {
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
  element.setAttribute('class', ['semantic-icon', options.animation === 'work' && 'semantic-icon-work-body', options.className].filter(Boolean).join(' '))
  element.style.pointerEvents = 'none'
  element.style.overflow = 'hidden'
  if (options.color !== undefined) element.style.color = options.color
  element.style.strokeWidth = String(options.strokeWidth ?? SEMANTIC_ICON_PEN.strokeWidth)
  element.style.strokeLinecap = options.strokeLinecap ?? SEMANTIC_ICON_PEN.strokeLinecap as 'round'
  element.style.strokeLinejoin = options.strokeLinejoin ?? SEMANTIC_ICON_PEN.strokeLinejoin as 'round'
  const use = document.createElementNS(SVG_NS, 'use')
  use.setAttribute('href', semanticIconHref(name))
  element.append(use)
  if (!options.animation || options.animation === 'none') return element
  const carrier = document.createElement('span')
  carrier.className = 'semantic-icon-motion'
  carrier.dataset.iconAnimation = options.animation
  carrier.append(element)
  if (options.animation === 'work') {
    carrier.dataset.semanticWork = name
    const bone = document.createElement('span')
    bone.className = 'semantic-icon-work-pen'
    bone.dataset.semanticIconPart = 'writing-pen'
    const drawing = element.cloneNode(false) as SVGSVGElement
    drawing.removeAttribute('class'); drawing.removeAttribute('data-semantic-icon')
    drawing.setAttribute('width', '100%'); drawing.setAttribute('height', '100%')
    const pen = document.createElementNS(SVG_NS, 'use')
    pen.setAttribute('href', workIconHref(name, 'pen'))
    drawing.append(pen); bone.append(drawing); carrier.append(bone)
  }
  return carrier
}

function attributes(attributes: Readonly<Record<string, string>>): string {
  // Only trusted geometry or validated path data reaches here. Escaping remains explicit for serialization.
  return Object.entries(attributes).map(([key, value]) => ` ${key}="${value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}"`).join('')
}
/** Standalone and native projections share trusted geometry and the existing bounded color contract. */
export function iconSvgMarkup(shapes: readonly IconShape[], style: ThemeValue['iconStyle'], color: string, background?: string): string {
  const validatedColor = themeColorSchema.parse(color)
  const backdrop = background === undefined ? '' : `<rect width="24" height="24" fill="${themeColorSchema.parse(background)}" stroke="none"/>`
  const nodes = shapes.map(([tag, attrs]) => `<${tag}${attributes(attrs)}/>`).join('')
  return `<svg xmlns="${SVG_NS}" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${validatedColor}" stroke-width="${style.strokeWidth}" stroke-linecap="${style.linecap}" stroke-linejoin="${style.linejoin}" color="${validatedColor}">${backdrop}${nodes}</svg>`
}
/** Native backgrounds project the same standalone SVG without adding another serializer. */
export function iconSvgDataUrl(shapes: readonly IconShape[], style: ThemeValue['iconStyle'], color: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(iconSvgMarkup(shapes, style, color))}")`
}
/** A native mask projects the same geometry, never a separate editable icon mapping. */
export function iconMaskDataUrl(shapes: readonly IconShape[], style: ThemeValue['iconStyle']): string {
  return iconSvgDataUrl(shapes, style, '#000000')
}
