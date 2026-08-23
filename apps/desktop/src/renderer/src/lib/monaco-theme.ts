import type { AppAppearanceId } from '../../../shared/contracts'
import { resolveAppAppearance } from './app-appearance'

export type MonacoThemeId = 'vs' | 'vs-dark'

export function monacoThemeForAppAppearance(id: AppAppearanceId | undefined, prefersDark: boolean): MonacoThemeId {
  return resolveAppAppearance(id, prefersDark) === 'light' ? 'vs' : 'vs-dark'
}
