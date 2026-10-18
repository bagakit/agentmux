import type { BrowserAgentControlPreferences } from '../shared/browser-agent-control.js'
import { browserAgentEffectsCss, DEFAULT_BROWSER_AGENT_CONTROL } from '../shared/browser-agent-control.js'
import type { WebContents } from 'electron'
import { BROWSER_OPERATION_FEEDBACK_WORLD_ID } from './browser-operation-feedback.js'

type ControlFeedback = {
  revision: number; browserId: string; ownerId: string; navigationId: string
  active: boolean; deadline: number; css: string; blend: BrowserAgentControlPreferences['glowBlend']
}

/** Coordinate-free ownership decoration. Only Main's live input owner can publish it. */
function applyControlFeedback(payload: ControlFeedback): boolean {
  const key = '__agentMuxBrowserControlFeedback'
  const globals = globalThis as typeof globalThis & { [key: string]: any }
  const previous = globals[key]
  if (previous && previous.revision >= payload.revision) return false
  if (!payload.active && previous && previous.ownerId !== payload.ownerId) return false
  if (payload.active && Date.now() > payload.deadline) return false
  previous?.dispose()
  const state: any = { revision: payload.revision, browserId: payload.browserId, ownerId: payload.ownerId,
    navigationId: payload.navigationId, host: null, shadow: null, dispose: () => {} }
  globals[key] = state
  let observer: MutationObserver | undefined
  const hide = () => { observer?.disconnect(); state.host?.remove(); state.host = null; state.shadow = null }
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
  host.setAttribute('data-browser-id', payload.browserId)
  host.setAttribute('data-owner-id', payload.ownerId)
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
  // Website root-content replacement does not change the native input owner.
  // Observe only direct root/document changes and restore this exact decoration;
  // no page-subtree scan, target lookup or animation restarts are needed.
  observer = new MutationObserver(() => {
    const currentRoot = document.documentElement
    if (globals[key] !== state || state.host !== host || host.isConnected || !currentRoot) return
    observer!.disconnect()
    currentRoot.appendChild(host)
    observer!.observe(currentRoot, { childList: true })
    observer!.observe(document, { childList: true })
  })
  observer.observe(root, { childList: true })
  observer.observe(document, { childList: true })
  window.addEventListener('pagehide', hide)
  return true
}

export function buildBrowserControlFeedbackScript(input: Omit<ControlFeedback, 'css' | 'blend'>,
  preferences: BrowserAgentControlPreferences): string {
  const payload: ControlFeedback = { ...input, css: browserAgentEffectsCss(preferences), blend: preferences.glowBlend }
  return `(${applyControlFeedback.toString()})(${JSON.stringify(payload)})`
}

/** Decoration follows one exact native page incarnation, independently of its operations. */
export class BrowserControlFeedback {
  private signature = ''
  private mayExist = false
  private request = 0
  constructor(private readonly input: {
    contents: Pick<WebContents, 'executeJavaScriptInIsolatedWorld' | 'isDestroyed'>
    browserId: string; ownerId: string; navigationId(): string
    nextRevision(): number; isCurrent(): boolean; report(available: boolean): void
    preferences?(): BrowserAgentControlPreferences
  }) {}

  private async publish(active: boolean, navigationId: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const value = await Promise.race([
        this.input.contents.executeJavaScriptInIsolatedWorld(BROWSER_OPERATION_FEEDBACK_WORLD_ID, [{ code:
          buildBrowserControlFeedbackScript({ revision: this.input.nextRevision(), browserId: this.input.browserId,
            ownerId: this.input.ownerId, navigationId, active, deadline: active ? Date.now() + 120 : 0 },
          this.input.preferences?.() ?? DEFAULT_BROWSER_AGENT_CONTROL) }]),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Control display deadline')), 120) })
      ])
      return !active || value !== false
    } catch { return false } finally { clearTimeout(timer) }
  }
  private report(available: boolean): void {
    try { this.input.report(available) } catch { /* Decoration cannot disable the page. */ }
  }
  async synchronize(force = false): Promise<void> {
    if (this.input.contents.isDestroyed()) return
    const active = this.input.isCurrent(), navigationId = this.input.navigationId()
    const signature = JSON.stringify([active, navigationId, this.input.preferences?.() ?? DEFAULT_BROWSER_AGENT_CONTROL])
    if (!force && this.signature === signature) return
    this.signature = signature
    if (active) this.mayExist = true
    else if (!this.mayExist) return
    const request = ++this.request
    const ok = await this.publish(active, navigationId)
    if (request !== this.request) return
    if (!ok) this.signature = ''
    if (ok && !active) this.mayExist = false
    this.report(ok)
  }
  async hide(): Promise<void> {
    if (!this.mayExist) return
    const request = ++this.request
    this.signature = ''
    if (this.input.contents.isDestroyed()) return
    const ok = await this.publish(false, this.input.navigationId())
    if (request !== this.request) return
    if (ok) this.mayExist = false
    this.report(ok)
  }
}
