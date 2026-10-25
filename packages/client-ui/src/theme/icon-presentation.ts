/** Instance presentation only. Callers own work eligibility and current navigation selection. */
export const ICON_ANIMATIONS = ['none', 'work', 'stream', 'execute', 'wait', 'orbit', 'feedback', 'selection', 'spin'] as const
export type IconAnimation = typeof ICON_ANIMATIONS[number]
export type SemanticIconPresentation = {
  size?: number | undefined
  color?: string | undefined
  strokeWidth?: number | string | undefined
  strokeLinecap?: 'butt' | 'round' | 'square' | 'inherit' | undefined
  strokeLinejoin?: 'miter' | 'round' | 'bevel' | 'inherit' | undefined
  animation?: IconAnimation | undefined
}

export const SEMANTIC_ICON_PEN = {
  strokeWidth: 'var(--icon-stroke-width, 1.75)',
  strokeLinecap: 'var(--icon-linecap, round)',
  strokeLinejoin: 'var(--icon-linejoin, round)'
} as const
