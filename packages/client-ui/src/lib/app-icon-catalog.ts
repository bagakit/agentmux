/** App identity is independent of theme glyphs and user-owned Space/Provider identities. */
export const APP_ICON_CATALOG = {
  qingzhuan: { label: '青篆' },
  huihuan: { label: '回环' },
  zheyu: { label: '折玉' },
  lingban: { label: '灵伴' },
  classic: { label: 'Classic' }
} as const

export type AppIconId = keyof typeof APP_ICON_CATALOG
export const APP_ICON_IDS = Object.keys(APP_ICON_CATALOG) as AppIconId[]
export const DEFAULT_APP_ICON: AppIconId = 'qingzhuan'
export function isAppIconId(value: unknown): value is AppIconId {
  return typeof value === 'string' && Object.hasOwn(APP_ICON_CATALOG, value)
}
export function resolveAppIcon(value?: AppIconId): AppIconId { return value ?? DEFAULT_APP_ICON }
