import { useAppStore } from '../store'

/** The App owns the inherited typography; do not persist a second default. */
export function readAppEditorFontSize(): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fs-body'))
}

export function useEditorTypography(): { fontSize: number; lineHeight: number } {
  const override = useAppStore(state => state.config?.appearance.editorFontSize)
  const fontSize = override ?? readAppEditorFontSize()
  return { fontSize, lineHeight: Math.round(fontSize * 1.5) }
}
