import type { AppAppearanceId } from '../../../shared/contracts'
import { APP_APPEARANCE_DATASET_KEY } from './theme-contract'

export function resolveAppAppearance(id: AppAppearanceId | undefined, prefersDark: boolean): 'dark' | 'light' {
  if (id === 'light') return 'light'
  if (id === 'system') return prefersDark ? 'dark' : 'light'
  return 'dark'
}

export function applyAppAppearance(id: AppAppearanceId | undefined, host: Window = window): () => void {
  const media = host.matchMedia('(prefers-color-scheme: dark)')
  const apply = () => {
    const mode = resolveAppAppearance(id, media.matches)
    host.document.documentElement.dataset[APP_APPEARANCE_DATASET_KEY] = mode
    host.document.documentElement.style.colorScheme = mode
  }
  apply()
  const listener = () => apply()
  media.addEventListener?.('change', listener)
  return () => media.removeEventListener?.('change', listener)
}
