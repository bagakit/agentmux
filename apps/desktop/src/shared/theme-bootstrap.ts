import type { AppAppearanceId, ThemeDocument, ThemeMode } from '@agentmux/client-ui/theme'

export const THEME_BOOTSTRAP_CHANNEL = 'ui:themeBootstrap'
/** One read-only projection of the original Main appearance, never another persistence owner. */
export type ThemeBootstrap = {
  status: 'available'
  document: ThemeDocument
  appearance: AppAppearanceId
  mode: ThemeMode
  variables: Record<string, string>
} | { status: 'unavailable'; message: string }
