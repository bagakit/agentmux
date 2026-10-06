import { DEFAULT_THEME_ID, resolveTheme, workspaceTerminalPalette } from '@agentmux/client-ui/theme'
import type { AppearanceConfig } from '../shared/contracts.js'
import { configValuesEqual } from '../shared/config-edit.js'
import { terminalPalette } from '../shared/terminal-palettes.js'

/** Main answers OSC queries using its host brightness fact when no Renderer is attached. */
export function terminalPaletteForAppearance(appearance: AppearanceConfig, prefersDark: boolean) {
  return appearance.terminalTheme === 'workspace'
    ? workspaceTerminalPalette(resolveTheme({ themeId: appearance.themeId ?? DEFAULT_THEME_ID, appAppearance: appearance.appAppearance ?? 'dark',
      customThemes: appearance.customThemes && Object.hasOwn(appearance.customThemes, appearance.themeId ?? DEFAULT_THEME_ID)
        ? { [appearance.themeId ?? DEFAULT_THEME_ID]: appearance.customThemes[appearance.themeId ?? DEFAULT_THEME_ID] } : {} }, prefersDark))
    : terminalPalette(appearance.terminalTheme)
}

export function terminalPaletteChanged(next: AppearanceConfig, previous: AppearanceConfig): boolean {
  if (next.terminalTheme !== previous.terminalTheme) return true
  if (next.terminalTheme !== 'workspace') return false
  if (next.themeId !== previous.themeId || next.appAppearance !== previous.appAppearance) return true
  const id = next.themeId ?? DEFAULT_THEME_ID
  return !configValuesEqual(next.customThemes?.[id], previous.customThemes?.[id])
}

/** Subscribe, then sample the current host fact to close asynchronous startup gaps. */
export function observeTerminalBrightness(native: {
  on(event: 'updated', listener: () => void): unknown
  off(event: 'updated', listener: () => void): unknown
}, update: () => void): () => void {
  native.on('updated', update)
  update()
  return () => { native.off('updated', update) }
}
