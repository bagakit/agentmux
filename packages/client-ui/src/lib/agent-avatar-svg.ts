import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentProviderId } from '@agentmux/core/provider-id'
import { AgentAvatarStaticArtwork } from '../components/AgentAvatarStaticArtwork.js'
import type { AgentAvatarFaceAppearance } from '../components/AgentAvatarFace.js'
import { resolveTheme, type ResolvedTheme } from '../theme/catalog.js'
import { iconShapes } from '../theme/icon-assets.js'
import { iconSvgMarkup } from '../theme/icon-sprite.js'

/** The caller reads only the owned bundled raster selected by the original Provider artwork. */
export function agentAvatarSvg(providerId: AgentProviderId, appearance: AgentAvatarFaceAppearance | undefined,
  rasterData: (ownedSource: string, resource: string) => string, theme: ResolvedTheme = resolveTheme()): string {
  const paint = theme.variant.colors
  return renderToStaticMarkup(createElement(AgentAvatarStaticArtwork, { providerId, appearance,
    colors: { mark: paint.textMuted, enamel: paint.surface0, badge: paint.text, badgeBackground: paint.surface1 },
    renderRaster: (source, size, resource) => createElement('image', { href: rasterData(source, resource), width: size, height: size }),
    renderSemantic: (name, size) => createElement('g', { dangerouslySetInnerHTML: { __html:
      iconSvgMarkup(iconShapes(name, theme.value.icons), theme.value.iconStyle, name === 'object.agent' ? paint.textMuted : paint.text)
        .replace('width="24" height="24"', `width="${size}" height="${size}"`) } }) }))
}
