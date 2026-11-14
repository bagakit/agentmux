import type { CSSProperties, SVGProps } from 'react'
import type { SemanticIconId } from './icon-catalog.js'
import { semanticIconHref, workIconHref, SEMANTIC_ICON_PEN, type SemanticIconPresentation } from './icon-presentation.js'

export type SemanticIconProps = SemanticIconPresentation & SVGProps<SVGSVGElement>

/** Rendering has no media/store/event subscription. The root updates one retained sprite. */
export function SemanticIcon({ name, size = 14, animation = 'none', color, strokeWidth, strokeLinecap, strokeLinejoin, className, style, children, ...props }:
  { name: SemanticIconId } & Omit<SemanticIconProps, 'name'>) {
  // Surfaces own size, color and spacing; the theme owns the pen used by every semantic drawing.
  const iconStyle: CSSProperties = { strokeWidth: SEMANTIC_ICON_PEN.strokeWidth, strokeLinecap: SEMANTIC_ICON_PEN.strokeLinecap as 'round', strokeLinejoin: SEMANTIC_ICON_PEN.strokeLinejoin as 'round', ...style, ...(color !== undefined ? { color } : {}),
    ...(strokeWidth !== undefined ? { strokeWidth } : {}), ...(strokeLinecap !== undefined ? { strokeLinecap } : {}),
    ...(strokeLinejoin !== undefined ? { strokeLinejoin } : {}), pointerEvents: 'none', overflow: 'hidden' }
  const glyph = <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    aria-hidden="true" focusable="false" className={['semantic-icon', animation === 'work' && 'semantic-icon-work-body', className].filter(Boolean).join(' ')}
    data-semantic-icon={name} style={iconStyle} {...props}>{children}<use href={semanticIconHref(name)} /></svg>
  return animation === 'none' ? glyph : <span className="semantic-icon-motion" data-icon-animation={animation} data-semantic-work={animation === 'work' ? name : undefined}>{glyph}
    {animation === 'work' && <span className="semantic-icon-work-pen" data-semantic-icon-part="writing-pen"><svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" style={iconStyle} aria-hidden="true" focusable="false"><use href={workIconHref(name, 'pen')} /></svg></span>}
  </span>
}
