import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type { BrowserPageNode } from '../shared/contracts.js'
import type { BrowserCdpSender } from './browser-page-snapshot.js'

export const BROWSER_OPERATION_FEEDBACK_WORLD_ID = 1209
export const BROWSER_OPERATION_FEEDBACK_WORLD_NAME = 'agentmux-browser-operation-feedback'
const DISPLAY_BUDGET_MS = 120
const COMPLETED_CUE_MS = 900
const ACTION_LABELS: Record<string, string> = {
  click: 'Click', hover: 'Hover', fillInput: 'Fill', typeText: 'Type', pressKey: 'Key', scroll: 'Scroll',
  download: 'Download', uploadFiles: 'Upload', gotoUrl: 'Navigate', js: 'Operate', cdp: 'Operate'
}

type FeedbackPayload = {
  revision: number; operationId: string; navigationId: string; phase: 'running' | 'completed' | 'clear'
  kind: 'page' | 'target'; token: string; label: string; method: string; keyLabel: string
  deadline: number; completedMs: number; moveMs: number; clearReason: 'replace' | 'invalidate'
}

/** Runs only in our isolated world; no HTML strings, page-authored labels or input values. */
function applyFeedback(payload: FeedbackPayload, target?: Element): boolean {
  const key = '__agentMuxBrowserOperationFeedback'
  const globals = globalThis as typeof globalThis & { [key: string]: any }
  const previous = globals[key]
  if (previous && payload.phase !== 'running' && (previous.operationId !== payload.operationId || previous.navigationId !== payload.navigationId || previous.token !== payload.token)) return false
  if (previous && previous.revision >= payload.revision) return false
  if (payload.phase !== 'clear' && Date.now() > payload.deadline) return false
  const viewport = () => [innerWidth, innerHeight, scrollX, scrollY,
    window.visualViewport?.width ?? innerWidth, window.visualViewport?.height ?? innerHeight,
    window.visualViewport?.offsetLeft ?? 0, window.visualViewport?.offsetTop ?? 0, window.visualViewport?.scale ?? 1]
  const equal = (a: number[], b: number[]) => a.length === b.length && a.every((n, i) => Number.isFinite(n) && n === b[i])
  const rectOf = (element: Element) => {
    if (!element.isConnected || element.ownerDocument !== document) return null
    const r = element.getBoundingClientRect()
    return [r.left, r.top, r.right, r.bottom]
  }
  let point: { x: number; y: number } | null = null
  let anchor: number[] | null = null
  if (target) {
    anchor = rectOf(target)
    if (!anchor) return false
    const [left, top, right, bottom] = [Math.max(0, anchor[0]!), Math.max(0, anchor[1]!), Math.min(innerWidth, anchor[2]!), Math.min(innerHeight, anchor[3]!)]
    if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return false
    point = { x: (left + right) / 2, y: (top + bottom) / 2 }
  }
  const bridgeKey = '__agentMuxBrowserOperationFeedbackBridge'
  let bridge = globals[bridgeKey]
  if (payload.kind === 'page' && !bridge) {
    bridge = { source: null, token: '', operationId: '', navigationId: '' }
    bridge.clear = (reason: 'replace' | 'invalidate') => {
      bridge.source?.postMessage({ channel: 'agentmux-feedback', type: 'clear', token: bridge.token,
        operationId: bridge.operationId, navigationId: bridge.navigationId, reason }, '*')
      // Invisible history still belongs to this actual document, so human input can invalidate it after detach.
      if (reason === 'invalidate') bridge.source = null
    }
    bridge.listener = (event: MessageEvent) => {
      const data = event.data
      if (!data || data.channel !== 'agentmux-feedback' || data.type !== 'register' || !event.source) return
      const current = globals[key]
      const accepted = current && current.token === data.token && current.operationId === data.operationId && current.navigationId === data.navigationId && current.phase !== 'clear'
      if (!accepted) {
        ;(event.source as Window).postMessage({ channel: 'agentmux-feedback', type: 'clear', token: data.token,
          operationId: data.operationId, navigationId: data.navigationId, reason: current && current.token === data.token && current.operationId === data.operationId && current.navigationId === data.navigationId && current.clearReason === 'invalidate' ? 'invalidate' : 'replace' }, '*')
        return
      }
      if (bridge.source && bridge.source !== event.source) bridge.clear('invalidate')
      bridge.source = event.source; bridge.token = data.token; bridge.operationId = data.operationId; bridge.navigationId = data.navigationId
    }
    window.addEventListener('message', bridge.listener)
    globals[bridgeKey] = bridge
  }
  if (payload.phase === 'completed' && previous) {
    previous.revision = payload.revision
    previous.complete(payload) // Preserve the actual host and any already-running move; completion never restarts it.
    return true
  }
  if (payload.kind === 'page') bridge?.clear(payload.phase === 'clear' ? payload.clearReason : 'replace')
  previous?.hide?.(payload.phase === 'clear' && payload.clearReason === 'invalidate' ? 'invalidate' : 'replace')
  let history = previous?.history ?? null
  if (history && (history.navigationId !== payload.navigationId || !equal(history.viewport, viewport()))) history = null
  previous?.cleanup?.()
  const state: any = { revision: payload.revision, operationId: payload.operationId, navigationId: payload.navigationId,
    phase: payload.phase, kind: payload.kind, token: payload.token, clearReason: payload.clearReason, point, history, host: null, shadow: null,
    expiresAt: 0, cleanup: () => {}, hide: () => {}, complete: () => {} }
  globals[key] = state // A single local history fact carries no old target, owner, permissions or visible cue.
  let timer: ReturnType<typeof setTimeout> | undefined
  let animation: Animation | undefined
  let pointer: HTMLElement | null = null
  let visibleTarget = target ?? null
  const media = matchMedia('(prefers-reduced-motion: reduce)')
  const placeLabel = () => {
    const label = state.shadow?.querySelector('.label') as HTMLElement | null
    if (!label || !state.point) return
    const r = label.getBoundingClientRect(), p = state.point
    const x = Math.max(6, Math.min(p.x + 15, innerWidth - r.width - 6))
    const below = p.y + 21
    const y = Math.max(6, Math.min(below + r.height > innerHeight - 6 ? p.y - r.height - 4 : below, innerHeight - r.height - 6))
    label.style.transform = `translate(${x}px,${y}px)`
  }
  state.hide = (reason: 'replace' | 'invalidate') => {
    if (globals[key] !== state) return
    if (reason === 'replace' && pointer && state.point) {
      const current = visibleTarget && rectOf(visibleTarget)
      const r = pointer.getBoundingClientRect()
      state.history = current && anchor && equal(anchor, current) && equal(displayViewport, viewport()) && Number.isFinite(r.left) && Number.isFinite(r.top)
        ? { point: { x: r.left, y: r.top }, navigationId: state.navigationId, viewport: displayViewport } : null
    }
    if (reason === 'invalidate') state.history = null
    clearTimeout(timer); animation?.cancel(); animation = undefined
    state.host?.remove(); state.host = null; state.shadow = null; pointer = null; visibleTarget = null
    state.point = null; state.phase = 'clear'; state.clearReason = reason; state.expiresAt = 0
  }
  const invalidate = () => {
    if (globals[key] !== state) return
    if (payload.kind === 'page') bridge?.clear('invalidate')
    state.hide('invalidate')
  }
  const onGeometry = () => {
    if (globals[key] !== state) return
    // scrollIntoView can queue a scroll after we measured its final rect. Only actual geometry changes invalidate it.
    if (visibleTarget && anchor) {
      const current = rectOf(visibleTarget)
      if (!current || !equal(anchor, current) || !equal(displayViewport, viewport())) invalidate()
    } else if (state.history && !equal(state.history.viewport, viewport())) invalidate()
  }
  const displayViewport = viewport()
  const onClear = (event: MessageEvent) => {
    if (event.source !== window.top || event.data?.channel !== 'agentmux-feedback' || event.data.type !== 'clear' ||
        event.data.token !== state.token || event.data.operationId !== state.operationId || event.data.navigationId !== state.navigationId) return
    state.hide(event.data.reason === 'replace' ? 'replace' : 'invalidate')
  }
  const onHuman = (event: Event) => { if (event.isTrusted) invalidate() }
  const onVisibility = () => { if (document.hidden) invalidate() }
  const onMotion = () => { if (media.matches) { animation?.cancel(); animation = undefined } }
  state.cleanup = () => {
    clearTimeout(timer); animation?.cancel()
    window.removeEventListener('message', onClear)
    document.removeEventListener('pointerdown', onHuman, true)
    document.removeEventListener('keydown', onHuman, true)
    document.removeEventListener('wheel', onHuman, true)
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', invalidate)
    window.removeEventListener('scroll', onGeometry, true)
    window.removeEventListener('resize', onGeometry, true)
    document.removeEventListener('scroll', onGeometry, true)
    media.removeEventListener('change', onMotion)
    state.host?.remove()
  }
  state.complete = (completed: FeedbackPayload) => {
    if (globals[key] !== state || state.phase !== 'running') return
    state.phase = 'completed'; state.host?.setAttribute('data-phase', 'completed')
    state.shadow?.querySelector('.glow')?.remove()
    state.shadow?.querySelector('.executor')?.classList.remove('executing')
    pointer?.classList.add('complete')
    const label = state.shadow?.querySelector('.label') as HTMLElement | null
    if (label) { label.classList.add('complete'); label.textContent = completed.label; placeLabel() }
    if (!pointer && !state.shadow?.querySelector('.executor')) { state.hide('replace'); state.phase = 'completed'; return }
    state.expiresAt = Date.now() + completed.completedMs
    timer = setTimeout(() => state.hide('replace'), completed.completedMs)
  }
  // These listeners remain while the single invisible history fact is valid; none poll or wake unrelated documents.
  window.addEventListener('message', onClear)
  window.addEventListener('scroll', onGeometry, true)
  document.addEventListener('scroll', onGeometry, true)
  window.addEventListener('resize', onGeometry, true)
  document.addEventListener('pointerdown', onHuman, true)
  document.addEventListener('keydown', onHuman, true)
  document.addEventListener('wheel', onHuman, { capture: true, passive: true })
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', invalidate)
  media.addEventListener('change', onMotion)
  if (payload.phase === 'clear') return true
  const root = document.documentElement
  if (!root) return false
  const host = document.createElement('div')
  host.setAttribute('data-agentmux-browser-operation-feedback', '')
  host.setAttribute('data-operation-id', payload.operationId); host.setAttribute('data-navigation-id', payload.navigationId)
  host.setAttribute('data-phase', payload.phase); host.setAttribute('data-kind', payload.kind); host.setAttribute('aria-hidden', 'true')
  for (const [name, value] of Object.entries({ position: 'fixed', inset: '0', 'z-index': '2147483645',
    'pointer-events': 'none', cursor: 'default', 'user-select': 'none', contain: 'layout style paint', overflow: 'hidden' })) {
    host.style.setProperty(name, value, 'important')
  }
  const shadow = host.attachShadow({ mode: 'closed' })
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(`:host,*{pointer-events:none;cursor:default;box-sizing:border-box}.glow{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 100%,rgba(120,221,160,.065),transparent 65%);box-shadow:inset 0 -10px 35px -24px rgba(120,221,160,.55)}.pointer{position:absolute;left:0;top:0;width:18px;height:22px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.4))}.pointer.hover svg{animation:float 1600ms ease-in-out infinite}.label{position:absolute;left:0;top:0;max-width:144px;padding:3px 6px;border-radius:5px;background:rgba(20,29,24,.92);color:#cbf3d8;font:500 10px/1.35 -apple-system,BlinkMacSystemFont,sans-serif;white-space:normal;overflow-wrap:anywhere}.label.complete{color:#c1cbc5}.complete{opacity:.85}.executor{position:absolute;right:12px;bottom:12px;color:#78dda0;font:600 15px/1 monospace}.executor.executing{animation:execute 900ms ease-in-out infinite}@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-1.5px)}}@keyframes execute{0%,100%{transform:scale(1);opacity:.65}50%{transform:scale(1.08);opacity:1}}@media (prefers-reduced-motion: reduce){.pointer.hover svg,.executor.executing{animation:none}}`)
  shadow.adoptedStyleSheets = [sheet]
  state.host = host; state.shadow = shadow
  if (payload.kind === 'page') {
    const glow = document.createElement('div'); glow.className = 'glow'; shadow.appendChild(glow)
    if (payload.method === 'js' || payload.method === 'cdp') {
      const executor = document.createElement('span'); executor.className = 'executor executing'; executor.textContent = '‹/›'; shadow.appendChild(executor)
    }
  }
  if (point && payload.kind === 'target') {
    pointer = document.createElement('span'); pointer.className = payload.method === 'hover' ? 'pointer hover' : 'pointer'
    pointer.style.transform = `translate(${point.x}px,${point.y}px)`
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '18'); svg.setAttribute('height', '22'); svg.setAttribute('viewBox', '0 0 18 22')
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    arrow.setAttribute('d', 'M1 1L1 17L5.5 13L9 21L12 19.5L8.5 12L15 12Z')
    arrow.setAttribute('fill', '#78dda0'); arrow.setAttribute('stroke', '#16251c'); arrow.setAttribute('stroke-width', '1')
    svg.appendChild(arrow); pointer.appendChild(svg)
    const label = document.createElement('span'); label.className = 'label'; label.textContent = payload.label
    label.style.maxWidth = `${Math.max(1, Math.min(144, innerWidth - 12))}px`
    shadow.appendChild(pointer); shadow.appendChild(label)
  }
  root.appendChild(host); placeLabel()
  if (point && pointer && history && !media.matches && (history.point.x !== point.x || history.point.y !== point.y)) {
    // The action never awaits the browser's local animation or its finished promise.
    animation = pointer.animate([{ transform: `translate(${history.point.x}px,${history.point.y}px)` },
      { transform: `translate(${point.x}px,${point.y}px)` }], { duration: payload.moveMs, easing: 'cubic-bezier(0.2,0.8,0.2,1)' })
  }
  if (payload.kind === 'target') window.top?.postMessage({ channel: 'agentmux-feedback', type: 'register',
    token: payload.token, operationId: payload.operationId, navigationId: payload.navigationId }, '*')
  return true
}

// Function bytes are bundled by TypeScript/esbuild; the page never receives a second handwritten implementation.
export function buildBrowserOperationFeedbackScript(payload: FeedbackPayload): string {
  return `(${applyFeedback.toString()})(${JSON.stringify(payload)})`
}
export function buildBrowserOperationTargetFeedbackDeclaration(): string {
  return `function(payload){return (${applyFeedback.toString()})(payload,this)}`
}

type TargetContext = { send: BrowserCdpSender; id: number }
type FeedbackInput = {
  contents: Pick<WebContents, 'executeJavaScriptInIsolatedWorld' | 'isDestroyed'>
  operationId: string; navigationId(): string; operatorName: string
  nextRevision(): number; isCurrent(): boolean; warn(): void
}

/** One operation owns only its page and actually touched target document. */
export class BrowserOperationFeedback {
  private generation = 0
  private target: TargetContext | undefined
  private mode: 'clear' | 'running' | 'completed' = 'clear'
  private method = ''
  private keyLabel = ''
  private warned = false
  private token = ''
  private navigationId = ''
  constructor(private readonly input: FeedbackInput) {}
  private current(): boolean { return this.input.isCurrent() && this.input.navigationId() === this.navigationId }
  private payload(phase: FeedbackPayload['phase'], kind: FeedbackPayload['kind'], deadline: number): FeedbackPayload {
    const action = this.method === 'pressKey' ? `Key ${this.keyLabel}` : ACTION_LABELS[this.method] ?? 'Operate'
    return { revision: this.input.nextRevision(), operationId: this.input.operationId,
      navigationId: this.navigationId, phase, kind, token: this.token, deadline, completedMs: COMPLETED_CUE_MS, moveMs: 180, method: this.method, keyLabel: this.keyLabel, clearReason: 'invalidate',
      label: phase === 'completed' ? `${action} complete` : `${this.input.operatorName.slice(0, 64)} · ${action}` }
  }
  private async page(payload: FeedbackPayload): Promise<unknown> {
    if (this.input.contents.isDestroyed()) return false
    const result = await this.input.contents.executeJavaScriptInIsolatedWorld(BROWSER_OPERATION_FEEDBACK_WORLD_ID,
      [{ code: buildBrowserOperationFeedbackScript(payload) }])
    if (result === false && payload.phase !== 'clear') throw new Error('Page feedback was unavailable')
    return result
  }
  private async document(context: TargetContext, payload: FeedbackPayload): Promise<unknown> {
    const response = await context.send('Runtime.evaluate', { contextId: context.id, expression: buildBrowserOperationFeedbackScript(payload), returnByValue: true }) as { exceptionDetails?: unknown; result?: { value?: unknown } }
    if (response.exceptionDetails || (response.result?.value === false && payload.phase !== 'clear')) throw new Error('Document feedback was unavailable')
    return response
  }
  private async bounded(work: Promise<unknown>, generation: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Feedback display deadline')), DISPLAY_BUDGET_MS)
      })])
    } catch {
      if (generation !== this.generation) return
      if (!this.warned) { this.warned = true; try { this.input.warn() } catch { /* A notification failure cannot disable the page action. */ } }
      if (this.mode !== 'clear') void this.clear()
    } finally { clearTimeout(timer) }
  }
  async begin(method: string, key?: unknown): Promise<number> {
    const generation = ++this.generation
    await this.clearAt(generation, 'replace')
    if (generation !== this.generation || !this.input.isCurrent()) return generation
    this.navigationId = this.input.navigationId(); this.token = randomUUID()
    this.method = method
    // Only actual named keys are displayable. Text, credentials and literal chords stay generic.
    const named = ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Backspace', 'Delete', 'Space']
    this.keyLabel = typeof key === 'string' && named.includes(key) ? key : '⌨'
    this.mode = 'running'
    await this.bounded(this.page(this.payload('running', 'page', Date.now() + DISPLAY_BUDGET_MS)), generation)
    return generation
  }
  async showTarget(node: BrowserPageNode, send: BrowserCdpSender, action = this.generation): Promise<void> {
    if (action !== this.generation || !node.frameId || this.mode !== 'running' || !this.current()) return
    const generation = this.generation, deadline = Date.now() + DISPLAY_BUDGET_MS
    const live = () => generation === this.generation && this.mode === 'running' && this.current() && Date.now() <= deadline
    const work = async () => {
      const created = await send('Page.createIsolatedWorld', { frameId: node.frameId, worldName: BROWSER_OPERATION_FEEDBACK_WORLD_NAME }) as { executionContextId?: number }
      if (!live()) return
      if (!Number.isInteger(created.executionContextId)) throw new Error('The target feedback world was unavailable')
      const context = { send, id: created.executionContextId! }
      if (this.target && (this.target.send !== send || this.target.id !== context.id)) {
        await this.document(this.target, this.payload('clear', 'target', 0))
        if (!live()) return
      }
      this.target = context
      const result = await send('DOM.resolveNode', { backendNodeId: node.backendNodeId, executionContextId: context.id,
        objectGroup: `feedback-${this.input.operationId}` }) as { object?: { objectId?: string } }
      if (!result.object?.objectId) {
        if (live()) throw new Error('The target feedback handle was unavailable')
        return
      }
      try {
        if (!live()) return
        const response = await send('Runtime.callFunctionOn', { objectId: result.object.objectId,
          functionDeclaration: buildBrowserOperationTargetFeedbackDeclaration(),
          arguments: [{ value: this.payload('running', 'target', deadline) }], returnByValue: true }) as { exceptionDetails?: unknown; result?: { value?: unknown } }
        if (response.exceptionDetails || response.result?.value === false) throw new Error('Target feedback was unavailable')
      } finally { await send('Runtime.releaseObject', { objectId: result.object.objectId }).catch(() => {}) }
    }
    await this.bounded(work(), generation)
  }
  async completeAction(action = this.generation): Promise<void> {
    if (action !== this.generation || this.mode !== 'running') return
    if (!this.current()) { await this.clear(); return }
    this.mode = 'completed'
    const generation = ++this.generation, deadline = Date.now() + DISPLAY_BUDGET_MS
    await this.bounded(Promise.all([this.page(this.payload('completed', 'page', deadline)),
      ...(this.target ? [this.document(this.target, this.payload('completed', 'target', deadline))] : [])]), generation)
  }
  async end(completed: boolean): Promise<void> {
    if (completed) await this.completeAction()
    else await this.clear()
  }
  async clear(reason: FeedbackPayload['clearReason'] = 'invalidate'): Promise<void> {
    await this.clearAt(++this.generation, reason)
  }
  private async clearAt(generation: number, clearReason: FeedbackPayload['clearReason'] = 'invalidate'): Promise<void> {
    this.mode = 'clear'
    this.target = undefined
    await this.bounded(this.page({ ...this.payload('clear', 'page', 0), clearReason }), generation)
  }
}

export function showBrowserOperationFeedback(input: FeedbackInput): BrowserOperationFeedback {
  return new BrowserOperationFeedback(input)
}
