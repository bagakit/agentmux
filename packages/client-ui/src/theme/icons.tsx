import type { ComponentType, CSSProperties, SVGProps } from 'react'
import type { SemanticIconId } from './icon-catalog.js'
import { semanticIconHref } from './icon-sprite.js'
export * from './icon-catalog.js'
export { iconShapes } from './icon-assets.js'
export { semanticIconHref, createSemanticIconElement, iconMaskDataUrl, iconSvgDataUrl, updateIconSprite, removeIconSprite } from './icon-sprite.js'

export type SemanticIconProps = { size?: number } & SVGProps<SVGSVGElement>
export type SemanticIconComponent = ComponentType<SemanticIconProps>
const components = new Map<SemanticIconId, SemanticIconComponent>()
/** Dynamic product catalogs keep a stable React component type while choosing a semantic meaning. */
export function semanticIconComponent(name: SemanticIconId): SemanticIconComponent {
  let Icon = components.get(name)
  if (!Icon) {
    Icon = props => <SemanticIcon {...props} name={name} />
    Icon.displayName = `SemanticIcon(${name})`
    components.set(name, Icon)
  }
  return Icon
}

/** Rendering has no media/store/event subscription. The root updates one retained sprite. */
export function SemanticIcon({ name, size = 14, className, style, strokeWidth, children, ...props }:
  { name: SemanticIconId; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  const iconStyle: CSSProperties = { pointerEvents: 'none', overflow: 'hidden', strokeWidth: strokeWidth ?? 'var(--icon-stroke-width, 1.75)', strokeLinecap: 'var(--icon-linecap, round)' as 'round', strokeLinejoin: 'var(--icon-linejoin, round)' as 'round', ...style }
  const glyph = <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    aria-hidden="true" focusable="false" className={['semantic-icon', name === 'status.working' ? 'semantic-icon--working' : null, className].filter(Boolean).join(' ')}
    data-semantic-icon={name} style={iconStyle} {...props}>{children}<use href={semanticIconHref(name)} /></svg>
  return name === 'status.working' ? <span className="semantic-icon-motion semantic-icon-motion--working">{glyph}</span> : glyph
}
