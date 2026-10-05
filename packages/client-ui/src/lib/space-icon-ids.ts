/** Data-only icon identity contract, also consumed by persistence validation. */
export const SPACE_ICON_IDS = ['bot', 'book', 'bookmark', 'brain', 'code', 'compass', 'database', 'document', 'flask', 'folder', 'gem', 'layers', 'library', 'lightbulb', 'notebook', 'package', 'puzzle', 'rocket', 'shapes', 'terminal', 'wrench'] as const
export type SpaceIconId = typeof SPACE_ICON_IDS[number]
export function isSpaceIconId(value: unknown): value is SpaceIconId {
  return typeof value === 'string' && (SPACE_ICON_IDS as readonly string[]).includes(value)
}
