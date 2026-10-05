import type { AppAppearanceId } from '../../../shared/contracts'
import { resolveTheme } from '@agentmux/client-ui/theme'

/** Brightness adapters share the theme owner; no independent media subscription. */
export function resolveAppAppearance(id: AppAppearanceId | undefined, prefersDark: boolean): 'dark' | 'light' {
  return resolveTheme(id === undefined ? {} : { appAppearance: id }, prefersDark).mode
}
