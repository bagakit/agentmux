import { updateIconSprite, removeIconSprite } from './icon-sprite.js'
import { resolveTheme, resolveThemeDocument, type ResolvedTheme, type ThemeSelection } from './catalog.js'
import { THEME_COLOR_PROPERTIES, themeDocumentSchema, serializeThemeFile, APP_APPEARANCE_IDS, type AppAppearanceId, type ThemeDocument, type ThemeMode } from './schema.js'

export const THEME_CHANGE_EVENT = 'agentmux-theme-change'
const FONTS = {
  sans: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  mono: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
  humanist: '"Avenir Next", Avenir, "Trebuchet MS", ui-sans-serif, sans-serif'
} as const
export function themeCssVariables(theme: ResolvedTheme): Record<string, string> {
  const { variant, mode, value } = theme
  const vars: Record<string, string> = {}
  for (const role of Object.keys(THEME_COLOR_PROPERTIES) as Array<keyof typeof THEME_COLOR_PROPERTIES>) vars[THEME_COLOR_PROPERTIES[role]] = variant.colors[role]
  Object.assign(vars, {
    '--font-sans': FONTS[variant.font], '--radius': `${variant.radius}px`,
    '--radius-sm': `${Math.max(0, variant.radius - 3)}px`, '--radius-lg': `${variant.radius + 3}px`,
    '--icon-stroke-width': String(value.iconStyle.strokeWidth),
    '--scrim-1': mode === 'light' ? '#15251c20' : '#00000040',
    '--scrim-2': mode === 'light' ? '#15251c38' : '#00000073',
    '--scrim-3': mode === 'light' ? '#15251c60' : '#000000a6',
    '--wash-1': mode === 'light' ? '#17201a05' : '#ffffff08',
    '--wash-2': mode === 'light' ? '#17201a0a' : '#ffffff14',
    '--wash-3': mode === 'light' ? '#17201a14' : '#ffffff24',
    '--elev-1': variant.elevation === 'flat' ? 'none' : mode === 'light' ? '0 1px 2px #17201a0d' : '0 1px 2px #00000045',
    '--elev-2': variant.elevation === 'flat' ? 'none' : mode === 'light' ? '0 6px 18px #17201a18' : '0 6px 18px #0000005a',
    '--elev-3': variant.elevation === 'flat' ? 'none' : mode === 'light' ? '0 16px 44px #17201a24' : '0 16px 44px #00000070',
    '--hl': mode === 'light' ? 'inset 0 1px 0 #ffffffa6' : 'inset 0 1px 0 #ffffff0c',
    '--hl-strong': mode === 'light' ? 'inset 0 1px 0 #ffffffcc' : 'inset 0 1px 0 #ffffff14'
  })
  return vars
}
type ThemeInput = { kind: 'selection'; selection: ThemeSelection } | { kind: 'observed'; document: ThemeDocument; appearance: AppAppearanceId }
type Controller = { input: ThemeInput; preview?: ThemeDocument; previewMode?: ThemeMode; resolved: ResolvedTheme; signature?: string; apply(): void }
const controllers = new WeakMap<Window, Controller>()

/** Exactly one root media subscription. Consumers observe this projection, never resolve independently. */
export function mountThemeRuntime(host: Window = window, initial: ThemeSelection = {}): () => void {
  if (controllers.has(host)) throw new Error('Theme runtime is already mounted for this window.')
  const media = host.matchMedia('(prefers-color-scheme: dark)')
  const controller: Controller = {
    input: { kind: 'selection', selection: initial }, resolved: resolveTheme(initial, media.matches),
    apply() {
      const input = controller.input
      const base = input.kind === 'selection' ? resolveTheme(input.selection, media.matches)
        : resolveThemeDocument(input.document, input.appearance, media.matches)
      const resolved = controller.preview ? resolveThemeDocument(controller.preview, controller.previewMode ?? base.mode, media.matches) : base
      controller.resolved = resolved
      const signature = JSON.stringify({ id: resolved.id, mode: resolved.mode, variant: resolved.variant, icons: resolved.value.icons, iconStyle: resolved.value.iconStyle })
      if (controller.signature === signature) return
      controller.signature = signature
      const root = host.document.documentElement
      updateIconSprite(host.document, resolved.value)
      root.dataset.theme = resolved.id
      root.dataset.appearance = resolved.mode
      root.style.colorScheme = resolved.mode
      for (const [key, value] of Object.entries(themeCssVariables(resolved))) root.style.setProperty(key, value)
      host.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: resolved }))
    }
  }
  controllers.set(host, controller)
  const update = () => controller.apply()
  media.addEventListener?.('change', update)
  controller.apply()
  return () => {
    media.removeEventListener?.('change', update)
    if (controllers.get(host) === controller) { controllers.delete(host); removeIconSprite(host.document) }
  }
}
export function updateThemeSelection(selection: ThemeSelection, host: Window = window): { applied: boolean; reason?: string } {
  const controller = controllers.get(host)
  if (!controller) return { applied: false, reason: 'Theme runtime is not mounted for this window.' }
  controller.input = { kind: 'selection', selection }
  controller.apply()
  return { applied: true }
}
/** Host observations are runtime inputs, never another persisted mobile theme directory. */
export function updateObservedTheme(document: ThemeDocument, appearance: AppAppearanceId, host: Window = window): { applied: boolean; reason?: string } {
  const controller = controllers.get(host)
  if (!controller) return { applied: false, reason: 'Theme runtime is not mounted for this window.' }
  const parsed = themeDocumentSchema.safeParse(document)
  if (!parsed.success || !APP_APPEARANCE_IDS.includes(appearance)) return { applied: false, reason: 'Host theme observation is unsupported. The last confirmed theme is retained.' }
  try { serializeThemeFile(parsed.data) } catch (error) {
    return { applied: false, reason: `Host theme observation is unsupported. The last confirmed theme is retained. ${error instanceof Error ? error.message : 'Invalid theme file.'}` }
  }
  controller.input = { kind: 'observed', document: parsed.data, appearance }
  controller.apply()
  return { applied: true }
}
export function previewTheme(document: ThemeDocument | undefined, host: Window = window, mode?: ThemeMode): { applied: boolean; reason?: string } {
  const controller = controllers.get(host)
  if (!controller) return { applied: false, reason: 'Theme runtime is not mounted for this window. Preview is unavailable; saved themes are unchanged.' }
  if (document) {
    const parsed = themeDocumentSchema.safeParse(document)
    if (!parsed.success) return { applied: false, reason: 'Theme draft is invalid. The last valid preview and saved themes are retained.' }
    try { serializeThemeFile(parsed.data) } catch (error) {
      return { applied: false, reason: `Theme draft is invalid. The last valid preview and saved themes are retained. ${error instanceof Error ? error.message : 'Invalid theme file.'}` }
    }
    controller.preview = { ...parsed.data, id: 'custom.preview' }
    if (mode) controller.previewMode = mode
    else delete controller.previewMode
  } else { delete controller.preview; delete controller.previewMode }
  controller.apply()
  return { applied: true }
}
export function readResolvedTheme(host: Window = window): ResolvedTheme {
  return controllers.get(host)?.resolved ?? resolveTheme({ appAppearance: host.document.documentElement.dataset.appearance === 'light' ? 'light' : 'dark' }, host.matchMedia('(prefers-color-scheme: dark)').matches)
}
export function observeResolvedTheme(listener: (theme: ResolvedTheme) => void, host: Window = window): () => void {
  const update = () => listener(readResolvedTheme(host))
  host.addEventListener(THEME_CHANGE_EVENT, update)
  update()
  return () => host.removeEventListener(THEME_CHANGE_EVENT, update)
}
