import { z } from 'zod'
import { ICON_GLYPH_IDS, SEMANTIC_ICON_IDS } from './icon-catalog.js'
import { validIconPath } from './icon-assets.js'

/** Theme files contain data only. No CSS, URLs, HTML, fonts or executable SVG is accepted. */
export const THEME_FORMAT = 'agentmux.theme' as const
export const THEME_VERSION = 1 as const
export const BUILTIN_THEME_IDS = ['graphite', 'fallout4', 'retro-future'] as const
export const THEME_FILE_MAX_BYTES = 2 * 1024 * 1024
export const APP_APPEARANCE_IDS = ['dark', 'light', 'system'] as const
export type AppAppearanceId = typeof APP_APPEARANCE_IDS[number]
export const APP_APPEARANCE_DEFAULT: AppAppearanceId = 'dark'
export const THEME_MODES = ['dark', 'light'] as const
export type ThemeMode = typeof THEME_MODES[number]
export const THEME_FONT_IDS = ['sans', 'mono', 'humanist'] as const
export const THEME_ELEVATION_IDS = ['soft', 'flat'] as const
export const THEME_COLOR_PROPERTIES = {
  background: '--bg', surface0: '--surface-0', surface1: '--surface-1', surface2: '--surface-2', surface3: '--surface-3',
  line: '--line', lineSoft: '--line-soft', text: '--text', textMuted: '--text-2', textSubtle: '--text-3',
  action: '--green', actionHover: '--green-2', success: '--success', warning: '--amber', danger: '--red', info: '--blue', special: '--purple',
  neutral1: '--neutral-1', neutral2: '--neutral-2', neutral3: '--neutral-3', focus: '--focus-line'
} as const
export type ThemeColorRole = keyof typeof THEME_COLOR_PROPERTIES
export const THEME_COLOR_ROLES = Object.keys(THEME_COLOR_PROPERTIES) as [ThemeColorRole, ...ThemeColorRole[]]
export const themeColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i, 'Use a six-digit hexadecimal color.')
export const themeVariantSchema = z.object({
  colors: z.record(z.enum(THEME_COLOR_ROLES), themeColorSchema),
  font: z.enum(THEME_FONT_IDS),
  radius: z.number().min(0).max(16),
  elevation: z.enum(THEME_ELEVATION_IDS)
}).strict()

// Paths are normalized to a fixed 24×24 viewBox. Active SVG content is unrepresentable.
const pathSchema = z.object({
  d: z.string().min(1).max(4096).refine(validIconPath, 'Use a valid, finite SVG path with at most 256 commands and coordinates within ±96 of its fixed 24-unit viewBox.'),
  fill: z.enum(['none', 'currentColor']).optional()
}).strict()
export const iconAssetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('glyph'), glyph: z.enum(ICON_GLYPH_IDS) }).strict(),
  z.object({ kind: z.literal('paths'), paths: z.array(pathSchema).min(1).max(32) }).strict()
])
export const semanticIconIdSchema = z.enum(SEMANTIC_ICON_IDS)
export const themeValueSchema = z.object({
  format: z.literal(THEME_FORMAT), version: z.literal(THEME_VERSION),
  name: z.string().trim().min(1).max(80), description: z.string().max(240),
  variants: z.object({ dark: themeVariantSchema, light: themeVariantSchema }).strict(),
  icons: z.partialRecord(semanticIconIdSchema, iconAssetSchema),
  iconStyle: z.object({ strokeWidth: z.number().min(1).max(2.5), linecap: z.enum(['round', 'square', 'butt']), linejoin: z.enum(['round', 'miter', 'bevel']) }).strict()
}).strict()
export const themeIdSchema = z.union([z.enum(BUILTIN_THEME_IDS), z.string().max(100).regex(/^custom\.[a-z0-9][a-z0-9.-]*$/)])
export const themeDocumentSchema = themeValueSchema.extend({ id: themeIdSchema }).strict()
export type ThemeVariant = z.infer<typeof themeVariantSchema>
export type ThemeValue = z.infer<typeof themeValueSchema>
export type ThemeDocument = z.infer<typeof themeDocumentSchema>
export type ThemeIconAsset = z.infer<typeof iconAssetSchema>

export function parseThemeFile(text: string): ThemeDocument {
  // This protects one user-selected file and its transient parse allocation, never accumulated themes.
  if (new TextEncoder().encode(text).byteLength > THEME_FILE_MAX_BYTES) throw new Error('Theme file exceeds the 2 MiB import boundary. Choose a smaller theme file; saved themes are unchanged.')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('Theme file is not valid JSON. Saved themes are unchanged.') }
  const parsed = themeDocumentSchema.safeParse(value)
  if (!parsed.success) throw new Error(`Unsupported or invalid theme: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'file'}: ${issue.message}`).join('; ')}`)
  // A compact upload must also fit the canonical file we promise to export.
  serializeThemeFile(parsed.data)
  return parsed.data
}
export function serializeThemeFile(theme: ThemeDocument): string {
  const text = `${JSON.stringify(themeDocumentSchema.parse(theme), null, 2)}\n`
  if (new TextEncoder().encode(text).byteLength > THEME_FILE_MAX_BYTES) throw new Error('Theme exceeds the 2 MiB file boundary. Reduce icon asset size before saving; saved themes are unchanged.')
  return text
}
export function themeValue(document: ThemeDocument): ThemeValue {
  const { id: _id, ...value } = document
  return value
}
