/** Presentation preferences only. Browser control/input eligibility never depends on these. */
export type BrowserAgentControlPreferences = {
  showCursor: boolean
  showCursorLabel: boolean
  showDiscussion: boolean
  pointerTween: boolean
  pointerDurationMs: number
  clickRipple: boolean
  clickDurationMs: number
  clickRadius: number
  glowEnabled: boolean
  glowColor: string
  glowBlend: 'normal' | 'screen' | 'multiply' | 'overlay'
  glowAnimation: 'none' | 'breathe' | 'pulse'
  glowWidth: number
  glowSoftness: number
  glowOpacity: number
  glowDurationMs: number
}

export const BROWSER_AGENT_GLOW_BLENDS = ['normal', 'screen', 'multiply', 'overlay'] as const
export const BROWSER_AGENT_GLOW_ANIMATIONS = ['none', 'breathe', 'pulse'] as const
export const BROWSER_AGENT_CONTROL_LIMITS = {
  pointerDurationMs: { min: 0, max: 1000, step: 10 },
  clickDurationMs: { min: 100, max: 1500, step: 10 },
  clickRadius: { min: 8, max: 64, step: 1 },
  glowWidth: { min: 2, max: 80, step: 1 },
  glowSoftness: { min: 0, max: 64, step: 1 },
  glowOpacity: { min: 0.05, max: 1, step: 0.05 },
  glowDurationMs: { min: 600, max: 8000, step: 100 }
} as const
export const DEFAULT_BROWSER_AGENT_CONTROL: Readonly<BrowserAgentControlPreferences> = Object.freeze({
  showCursor: true,
  showCursorLabel: true,
  showDiscussion: false,
  pointerTween: true,
  pointerDurationMs: 180,
  clickRipple: true,
  clickDurationMs: 420,
  clickRadius: 24,
  glowEnabled: true,
  glowColor: '#78dda0',
  glowBlend: 'normal',
  glowAnimation: 'none',
  glowWidth: 24,
  glowSoftness: 18,
  glowOpacity: 0.6,
  glowDurationMs: 2400
})

export function resolveBrowserAgentControl(value?: Partial<BrowserAgentControlPreferences>): BrowserAgentControlPreferences {
  return { ...DEFAULT_BROWSER_AGENT_CONTROL, ...value }
}

export const validBrowserAgentGlowColor = (value: string): boolean => /^#[0-9a-f]{6}$/i.test(value)

/** Shared by the isolated native feedback document and the Settings simulation. No host state. */
export function browserAgentEffectsCss(preferences: BrowserAgentControlPreferences): string {
  const p = preferences
  const rgb = [1, 3, 5].map(offset => parseInt(p.glowColor.slice(offset, offset + 2), 16)).join(',')
  const inner = p.glowWidth * 0.55 + p.glowSoftness
  const outer = p.glowWidth + p.glowSoftness * 1.6
  const animation = p.glowAnimation === 'none' ? 'none' : `amux-agent-glow-${p.glowAnimation} ${p.glowDurationMs}ms ease-in-out infinite`
  return `
.amux-browser-agent-effects{position:absolute;inset:0;overflow:hidden;pointer-events:none;font:12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--amux-agent-color:${p.glowColor};--amux-agent-rgb:${rgb}}
.amux-browser-agent-effects[data-active="false"]{display:none}
.amux-browser-agent-glow{position:absolute;inset:0;pointer-events:none;display:${p.glowEnabled ? 'block' : 'none'};mix-blend-mode:${p.glowBlend};opacity:${p.glowOpacity};box-shadow:inset 0 0 2px 1px rgba(${rgb},.95),inset 0 0 ${inner}px ${p.glowWidth * .18}px rgba(${rgb},.7),inset 0 0 ${outer}px ${p.glowWidth * .3}px rgba(${rgb},.28);animation:${animation}}
.amux-browser-agent-pointer{position:absolute;left:0;top:0;display:${p.showCursor ? 'flex' : 'none'};align-items:flex-start;gap:7px;will-change:transform;transition:${p.pointerTween ? `transform ${p.pointerDurationMs}ms cubic-bezier(.22,.7,.24,1)` : 'none'};filter:drop-shadow(0 2px 3px #0006)}
.amux-browser-agent-arrow{width:17px;height:22px;flex:none;fill:var(--amux-agent-color);stroke:#142019;stroke-width:1.25;overflow:visible}
.amux-browser-agent-label{position:absolute;left:22px;top:10px;display:${p.showCursorLabel ? 'flex' : 'none'};align-items:center;gap:6px;padding:4px 8px 4px 4px;max-width:var(--amux-agent-label-width,200px);border:1px solid #ffffff2e;border-radius:18px;background:#17231f;color:#f1fff6;box-shadow:0 3px 10px #0002;white-space:nowrap}
.amux-browser-agent-pointer[data-label-side="left"] .amux-browser-agent-label{left:auto;right:12px}
.amux-browser-agent-pointer[data-label-above="true"] .amux-browser-agent-label{top:auto;bottom:5px}
.amux-browser-agent-avatar{display:grid;place-items:center;flex:none;width:23px;height:23px;border-radius:50%;background:var(--amux-agent-color);color:#142019;font-size:10px;font-weight:700;overflow:hidden}
.amux-browser-agent-label-text{min-width:0;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.amux-browser-agent-label small{display:block;font-size:10px;opacity:.72;font-weight:400}
.amux-browser-agent-ripple{position:absolute;width:${p.clickRadius * 2}px;height:${p.clickRadius * 2}px;margin:${-p.clickRadius}px 0 0 ${-p.clickRadius}px;border:2px solid var(--amux-agent-color);border-radius:50%;box-sizing:border-box;opacity:0;display:${p.clickRipple ? 'block' : 'none'};animation:amux-agent-click ${p.clickDurationMs}ms ease-out both}
@keyframes amux-agent-click{0%{transform:scale(.12);opacity:.95;background:rgba(${rgb},.28)}100%{transform:scale(1);opacity:0;background:transparent}}
@keyframes amux-agent-glow-breathe{0%,100%{opacity:${p.glowOpacity * .55}}50%{opacity:${p.glowOpacity}}}
@keyframes amux-agent-glow-pulse{0%,100%{opacity:${p.glowOpacity * .72}}35%{opacity:${p.glowOpacity}}65%{opacity:${p.glowOpacity * .85}}}
@media(prefers-reduced-motion:reduce){.amux-browser-agent-pointer{transition:none}.amux-browser-agent-glow{animation:none}.amux-browser-agent-ripple{animation:none;opacity:.65;transform:scale(.7);background:transparent}}
`
}
