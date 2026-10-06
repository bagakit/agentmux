import { updateIconSprite, removeIconSprite } from './icon-sprite.js'
import { resolveTheme, resolveThemeDocument, type ResolvedTheme, type ThemeSelection } from './catalog.js'
import { themeDocumentSchema, serializeThemeFile, APP_APPEARANCE_IDS, type AppAppearanceId, type ThemeDocument, type ThemeMode } from './schema.js'

export const THEME_CHANGE_EVENT = 'agentmux-theme-change'
import { themeCssVariables } from './css-variables.js'
export { themeCssVariables } from './css-variables.js'

export type ThemeInitialDocument = { kind: 'observed'; document: ThemeDocument; appearance: AppAppearanceId }
type ThemeInput = { kind: 'selection'; selection: ThemeSelection } | ThemeInitialDocument
type Controller = { input: ThemeInput; preview?: ThemeDocument; previewMode?: ThemeMode; resolved: ResolvedTheme; signature?: string; transitionFrame?: number; apply(): void }
const controllers = new WeakMap<Window, Controller>()

/** Exactly one root media subscription. Consumers observe this projection, never resolve independently. */
export function mountThemeRuntime(host: Window = window, initial: ThemeSelection | ThemeInitialDocument = {}): () => void {
  if (controllers.has(host)) throw new Error('Theme runtime is already mounted for this window.')
  let input: ThemeInput
  if ('kind' in initial) {
    const checked = themeDocumentSchema.safeParse(initial.document)
    if (!checked.success) throw new Error('Initial observed theme is invalid. The current document projection is retained. ' + checked.error.issues[0]?.message)
    serializeThemeFile(checked.data)
    if (!(APP_APPEARANCE_IDS as readonly string[]).includes(initial.appearance)) throw new Error('Initial observed appearance is unsupported. The current document projection is retained.')
    input = { ...initial, document: checked.data }
  } else input = { kind: 'selection', selection: initial }
  const media = host.matchMedia('(prefers-color-scheme: dark)')
  const controller: Controller = {
    input, resolved: input.kind === 'observed' ? resolveThemeDocument(input.document, input.appearance, media.matches) : resolveTheme(input.selection, media.matches),
    apply() {
      const input = controller.input
      const base = input.kind === 'selection' ? resolveTheme(input.selection, media.matches)
        : resolveThemeDocument(input.document, input.appearance, media.matches)
      const resolved = controller.preview ? resolveThemeDocument(controller.preview, controller.previewMode ?? base.mode, media.matches) : base
      controller.resolved = resolved
      const signature = JSON.stringify({ id: resolved.id, mode: resolved.mode, variant: resolved.variant, icons: resolved.value.icons, iconStyle: resolved.value.iconStyle })
      if (controller.signature === signature) return
      const hadProjection = controller.signature !== undefined
      controller.signature = signature
      const root = host.document.documentElement
      if (hadProjection) {
        if (controller.transitionFrame !== undefined) host.cancelAnimationFrame(controller.transitionFrame)
        root.dataset.themeChanging = ''
        // Keep the whole palette atomic through its first paint, then restore ordinary hover motion.
        controller.transitionFrame = host.requestAnimationFrame(() => {
          controller.transitionFrame = host.requestAnimationFrame(() => {
            delete root.dataset.themeChanging
            delete controller.transitionFrame
          })
        })
      }
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
    if (controllers.get(host) === controller) {
      if (controller.transitionFrame !== undefined) host.cancelAnimationFrame(controller.transitionFrame)
      delete host.document.documentElement.dataset.themeChanging
      controllers.delete(host); removeIconSprite(host.document)
    }
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
