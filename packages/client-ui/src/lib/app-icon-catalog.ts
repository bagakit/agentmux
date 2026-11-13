/**
 * App identity is independent of theme glyphs and user-owned Space/Provider identities.
 *
 * Each App icon is the dragon's portrait in one realm (境). A realm is a rendering language;
 * the dragon, Mote and the working UI never change with it. This catalog holds only plain
 * text, because Node consumers (Main, Host, the brand build) import it directly.
 */
export const APP_ICON_CATALOG = {
  qingzhuan: { label: '青篆', realm: '青篆 · QINGZHUAN', material: '象牙底上的森林绿木刻侧像' },
  huihuan: { label: '回环', realm: '回环 · HUIHUAN', material: '墨绿底上盘成玉璧的长龙' },
  zheyu: { label: '折玉', realm: '折玉 · ZHEYU', material: '平面玉片折成的正面龙首' },
  lingban: { label: '灵伴', realm: '灵伴 · LINGBAN', material: '复古未来的陶瓷伙伴头像' },
  classic: { label: 'Classic', realm: '原境 · ORIGIN', material: '发光的翡翠低多边形龙，所有境的祖先' }
} as const

export type AppIconId = keyof typeof APP_ICON_CATALOG
export const APP_ICON_IDS = Object.keys(APP_ICON_CATALOG) as AppIconId[]
export const DEFAULT_APP_ICON: AppIconId = 'qingzhuan'
/** The realm every other realm descends from; the only one guaranteed to have hero art. */
export const ORIGIN_REALM = 'classic' satisfies AppIconId
export function isAppIconId(value: unknown): value is AppIconId {
  return typeof value === 'string' && Object.hasOwn(APP_ICON_CATALOG, value)
}
export function resolveAppIcon(value?: AppIconId): AppIconId { return value ?? DEFAULT_APP_ICON }
