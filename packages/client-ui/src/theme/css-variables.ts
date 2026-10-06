import { THEME_COLOR_PROPERTIES } from './schema.js'
import type { ResolvedTheme } from './catalog.js'

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
