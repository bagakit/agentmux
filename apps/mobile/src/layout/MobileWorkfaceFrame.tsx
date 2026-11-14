import type { ComponentProps } from 'react'
import type { MobilePanePresentation, MobileWorkfacePresentation } from './workface-presentation'
import './workface.css'

/** Stable slots and geometry. Selection, Back, readers and retention belong to the caller. */
export function MobileWorkfaceFrame({ presentation, className = '', ...props }: ComponentProps<'div'> & { presentation: MobileWorkfacePresentation }) {
  return <div {...props} className={`mobile-workface-frame ${className}`.trim()} data-split={presentation.split || undefined}
    data-single-pane={presentation.navigation.presented ? 'navigation' : 'content'} />
}
export function MobileWorkfacePane({ presentation, pane, className = '', ...props }: Omit<ComponentProps<'div'>, 'hidden'> & {
  presentation: MobilePanePresentation; pane: 'navigation' | 'content'
}) {
  return <div {...props} className={`mobile-workface-pane ${className}`.trim()} data-pane={pane} hidden={!presentation.presented} />
}
