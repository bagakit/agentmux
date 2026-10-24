import { projectMonogram } from '../lib/project-monogram.js'
import { SemanticIcon } from '../theme/icons.js'
import { SPACE_ICON_CATALOG } from '../lib/space-icon-catalog.js'
/** Original observed decoration only. Unknown image reads stay visibly unconfirmed. */
export function SpaceAppearanceIcon({ glyph, image, preset, name, size = 20 }: { glyph?: string | undefined; image?: string | null | undefined; preset?: string | undefined; name: string; size?: number }) {
  const Glyph = glyph && Object.hasOwn(SPACE_ICON_CATALOG, glyph) ? SPACE_ICON_CATALOG[glyph as keyof typeof SPACE_ICON_CATALOG].Icon : null
  if (Glyph) return <Glyph size={size} />
  if (image) return <img src={image} alt="" draggable={false} />
  if (preset === 'repository' || preset === 'directory') {
    const monogram = projectMonogram(name)
    return monogram ? <span aria-hidden="true">{monogram}</span> : <SemanticIcon name={preset === 'repository' ? 'object.branch' : 'object.folder'} size={size} />
  }
  return null
}
