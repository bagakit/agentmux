import type { ComponentType } from 'react'
import type { SemanticIconId } from './icon-catalog.js'
import { SemanticIcon, type SemanticIconProps } from './semantic-icon.js'
export { ICON_ANIMATIONS, semanticIconHref, type IconAnimation, type SemanticIconPresentation } from './icon-presentation.js'
export { AUTHORED_ICON_DESIGNS } from './icon-authored.js'
export * from './icon-catalog.js'
export { getSemanticIconCatalog } from './icon-catalog-metadata.js'
export { iconShapes } from './icon-assets.js'
export { createSemanticIconElement, iconMaskDataUrl, iconSvgDataUrl, updateIconSprite, removeIconSprite } from './icon-sprite.js'

export { SemanticIcon, type SemanticIconProps } from './semantic-icon.js'
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
