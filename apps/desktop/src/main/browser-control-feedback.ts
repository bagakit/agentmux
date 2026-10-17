import type { BrowserAgentControlPreferences } from '../shared/browser-agent-control.js'
import { browserAgentEffectsCss } from '../shared/browser-agent-control.js'

type ControlFeedback = {
  revision: number; operationId: string; navigationId: string
  active: boolean; deadline: number; css: string; blend: BrowserAgentControlPreferences['glowBlend']
}

/** Coordinate-free ownership decoration. Only Main's live input owner can publish it. */
function applyControlFeedback(payload: ControlFeedback): boolean {
  const key = '__agentMuxBrowserControlFeedback'
  const globals = globalThis as typeof globalThis & { [key: string]: any }
  const previous = globals[key]
  if (previous && previous.revision >= payload.revision) return false
  if (!payload.active && previous && previous.operationId !== payload.operationId) return false
  if (payload.active && Date.now() > payload.deadline) return false
  previous?.dispose()
  const state: any = { revision: payload.revision, operationId: payload.operationId,
    navigationId: payload.navigationId, host: null, shadow: null, dispose: () => {} }
  globals[key] = state
  const hide = () => { state.host?.remove(); state.host = null; state.shadow = null }
  state.hide = hide
  state.dispose = () => {
    hide()
    window.removeEventListener('pagehide', hide)
  }
  if (!payload.active) return true
  const root = document.documentElement
  if (!root) return false
  const host = document.createElement('div')
  host.setAttribute('data-agentmux-browser-control-feedback', '')
  host.setAttribute('data-operation-id', payload.operationId)
  host.setAttribute('data-navigation-id', payload.navigationId)
  host.setAttribute('aria-hidden', 'true')
  // Blend the glow host against the actual page. Containment or a separate isolated
  // stacking group would make screen/multiply blend only against transparency.
  for (const [name, value] of Object.entries({ all: 'initial', display: 'block', background: 'transparent',
    isolation: 'auto', contain: 'none', margin: '0', padding: '0', border: '0', opacity: '1', visibility: 'visible',
    transform: 'none', filter: 'none', 'content-visibility': 'visible', position: 'fixed', inset: '0', 'z-index': '2147483643',
    'pointer-events': 'none', 'user-select': 'none', 'mix-blend-mode': payload.blend })) {
    host.style.setProperty(name, value, 'important')
  }
  const shadow = host.attachShadow({ mode: 'closed' })
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(payload.css + '\n:host,*{pointer-events:none;box-sizing:border-box}:host::before,:host::after{content:none!important;display:none!important;pointer-events:none!important}.amux-browser-agent-glow{mix-blend-mode:normal}')
  shadow.adoptedStyleSheets = [sheet]
  const effects = document.createElement('div'); effects.className = 'amux-browser-agent-effects'
  const glow = document.createElement('div'); glow.className = 'amux-browser-agent-glow'
  effects.appendChild(glow); shadow.appendChild(effects); root.appendChild(host)
  state.host = host; state.shadow = shadow
  window.addEventListener('pagehide', hide)
  return true
}

export function buildBrowserControlFeedbackScript(input: Omit<ControlFeedback, 'css' | 'blend'>,
  preferences: BrowserAgentControlPreferences): string {
  const payload: ControlFeedback = { ...input, css: browserAgentEffectsCss(preferences), blend: preferences.glowBlend }
  return `(${applyControlFeedback.toString()})(${JSON.stringify(payload)})`
}
