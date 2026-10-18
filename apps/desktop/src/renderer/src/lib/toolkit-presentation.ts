import { TERMINAL_THEME_IDS, type TerminalThemeId } from '../../../shared/contracts'

export type ToolkitPanelSize = { width: number; height: number }
export type ToolkitPresentation = { theme?: TerminalThemeId; size?: ToolkitPanelSize }
export type ToolkitPresentations = Record<string, ToolkitPresentation>
export type ToolkitPresentationPatch = { theme?: TerminalThemeId | null; size?: ToolkitPanelSize | null }

/** Client presentation only. Missing theme means follow the global terminal palette. */
export function restoreToolkitPresentations(value: unknown): ToolkitPresentations {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([id, raw]) => {
    if (!id || !raw || typeof raw !== 'object' || Array.isArray(raw)) return []
    const { theme, size } = raw as ToolkitPresentation
    const choice: ToolkitPresentation = {}
    if (theme !== undefined && TERMINAL_THEME_IDS.includes(theme)) choice.theme = theme
    if (size && Number.isFinite(size.width) && size.width > 0 && Number.isFinite(size.height) && size.height > 0)
      choice.size = { width: size.width, height: size.height }
    return choice.theme || choice.size ? [[id, choice]] : []
  }))
}

export function updateToolkitPresentation(current: ToolkitPresentations, id: string, patch: ToolkitPresentationPatch): ToolkitPresentations {
  const previous = current[id]
  const next = { ...previous }
  if (patch.theme === null) delete next.theme
  else if (patch.theme !== undefined) next.theme = patch.theme
  if (patch.size === null) delete next.size
  else if (patch.size !== undefined) next.size = patch.size
  if (next.theme === previous?.theme && next.size?.width === previous?.size?.width && next.size?.height === previous?.size?.height) return current
  const result = { ...current }
  if (next.theme || next.size) result[id] = next
  else delete result[id]
  return result
}
