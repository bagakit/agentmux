import { useEffect, useState } from 'react'
import { monacoThemeForAppAppearance } from '../lib/monaco-theme'
import { useAppStore } from '../store'

export function useMonacoTheme() {
  const appearance = useAppStore((state) => state.config?.appearance?.appAppearance)
  const [theme, setTheme] = useState(() => monacoThemeForAppAppearance(
    appearance, typeof window === 'undefined' ? true : window.matchMedia('(prefers-color-scheme: dark)').matches
  ))
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setTheme(monacoThemeForAppAppearance(appearance, media.matches))
    update()
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [appearance])
  return theme
}
