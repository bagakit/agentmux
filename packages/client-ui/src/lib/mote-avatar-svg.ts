import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MoteFace as FaceDrawing } from '../components/MoteFace.js'
import { resolveTheme, type ResolvedTheme } from '../theme/catalog.js'
import { iconShapes } from '../theme/icon-assets.js'
import { iconSvgMarkup } from '../theme/icon-sprite.js'
import type { MoteFace } from './mote-face.js'
import { SPACE_ICON_CATALOG, type SpaceIconId } from './space-icon-catalog.js'

/**
 * The saved identity, independent of motion, presence or a mounted document.
 * Icons use the theme's neutral text/surface paint for a legible external avatar,
 * not the hover, selection or container-specific CSS of an individual Mote view.
 * Faces retain their saved palette and never read the theme.
 */
export function moteAvatarSvg(choice: null | SpaceIconId | MoteFace, theme?: ResolvedTheme): string {
  if (choice !== null && typeof choice === 'object')
    return renderToStaticMarkup(createElement(FaceDrawing, { face: choice, rendering: 'static' }))
  const resolved = theme ?? resolveTheme(),
    semantic = choice === null ? 'object.mote' : SPACE_ICON_CATALOG[choice].semantic
  return iconSvgMarkup(iconShapes(semantic, resolved.value.icons), resolved.value.iconStyle,
    resolved.variant.colors.text, resolved.variant.colors.surface1)
}
