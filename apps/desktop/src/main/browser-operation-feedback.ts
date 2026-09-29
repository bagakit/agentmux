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
  kind: 'page' | 'target'; token: string; label: string; deadline: number; completedMs: number
}

/** Runs only in our isolated world; no HTML strings, page-authored labels or input values. */
function applyFeedback(payload: FeedbackPayload, target?: Element): boolean {
  const key = '__agentMuxBrowserOperationFeedback'
  const globals = globalThis as typeof globalThis & { [key: string]: any }
  const previous = globals[key]
  if (previous && payload.phase !== 'running' && (previous.operationId !== payload.operationId || previous.navigationId !== payload.navigationId || previous.token !== payload.token)) return false
  if (previous && previous.revision >= payload.revision) return false
  if (payload.phase !== 'clear' && Date.now() > payload.deadline) return false
  let point = payload.phase === 'completed' && previous?.operationId === payload.operationId ? previous.point : null
  if (target) {
    if (!target.isConnected || target.ownerDocument !== document) return false
    const rect = target.getBoundingClientRect()
    const left = Math.max(0, rect.left), top = Math.max(0, rect.top)
    const right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom)
    if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return false
    point = { x: (left + right) / 2, y: (top + bottom) / 2 }
  }
  if (payload.kind === 'page') {
    const bridgeKey = '__agentMuxBrowserOperationFeedbackBridge'
    let bridge = globals[bridgeKey]
    if (!bridge) {
      bridge = { source: null, token: '', operationId: '', navigationId: '' }
      bridge.listener = (event: MessageEvent) => {
        const data = event.data
        if (!data || data.channel !== 'agentmux-feedback' || data.type !== 'register' || !event.source) return
        const current = globals[key]
        const accepted = current && current.token === data.token && current.operationId === data.operationId && current.navigationId === data.navigationId && current.phase !== 'clear'
        if (!accepted) {
          ;(event.source as Window).postMessage({ channel: 'agentmux-feedback', type: 'clear', token: data.token, operationId: data.operationId, navigationId: data.navigationId }, '*')
          return
        }
        if (bridge.source && bridge.source !== event.source) bridge.clear()
        bridge.source = event.source; bridge.token = data.token; bridge.operationId = data.operationId; bridge.navigationId = data.navigationId
      }
      bridge.clear = () => {
        bridge.source?.postMessage({ channel: 'agentmux-feedback', type: 'clear', token: bridge.token, operationId: bridge.operationId, navigationId: bridge.navigationId }, '*')
        bridge.source = null
      }
      window.addEventListener('message', bridge.listener)
      globals[bridgeKey] = bridge
    }
    if (payload.phase !== 'completed') bridge.clear()
  }
  previous?.cleanup?.()
  const state: any = { revision: payload.revision, operationId: payload.operationId,
    navigationId: payload.navigationId, phase: payload.phase, kind: payload.kind, token: payload.token, point,
    host: null, shadow: null, expiresAt: 0, cleanup: () => {} }
  globals[key] = state // Keep a tombstone: a late older write/clear cannot revive or remove a newer owner.
  if (payload.phase === 'clear' || (payload.phase === 'completed' && (!point || payload.kind === 'page'))) return true
  const root = document.documentElement
  if (!root) return false
  const host = document.createElement('div')
  host.setAttribute('data-agentmux-browser-operation-feedback', '')
  host.setAttribute('data-operation-id', payload.operationId)
  host.setAttribute('data-navigation-id', payload.navigationId)
  host.setAttribute('data-phase', payload.phase)
  host.setAttribute('data-kind', payload.kind)
  host.setAttribute('aria-hidden', 'true')
  for (const [name, value] of Object.entries({ position: 'fixed', inset: '0', 'z-index': '2147483645',
    'pointer-events': 'none', cursor: 'default', 'user-select': 'none', contain: 'layout style paint', overflow: 'hidden' })) {
    host.style.setProperty(name, value, 'important')
  }
  const shadow = host.attachShadow({ mode: 'closed' })
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(`:host,*{pointer-events:none;cursor:default;box-sizing:border-box}.glow{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 100%,rgba(120,221,160,.065),transparent 65%);box-shadow:inset 0 -10px 35px -24px rgba(120,221,160,.55)}.pointer{position:absolute;left:0;top:0;width:18px;height:22px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.4))}.label{position:absolute;left:0;top:0;max-width:144px;padding:3px 6px;border-radius:5px;background:rgba(20,29,24,.92);color:#cbf3d8;font:500 10px/1.35 -apple-system,BlinkMacSystemFont,sans-serif;white-space:normal;overflow-wrap:anywhere}.label.complete{color:#c1cbc5}.complete{opacity:.85}`)
  shadow.adoptedStyleSheets = [sheet]
  if (payload.kind === 'page' && payload.phase === 'running') {
    const glow = document.createElement('div'); glow.className = 'glow'; shadow.appendChild(glow)
  }
  if (point && payload.kind === 'target') {
    const pointer = document.createElement('span')
    pointer.className = payload.phase === 'completed' ? 'pointer complete' : 'pointer'
    pointer.style.transform = `translate(${point.x}px,${point.y}px)`
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '18'); svg.setAttribute('height', '22'); svg.setAttribute('viewBox', '0 0 18 22')
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    arrow.setAttribute('d', 'M1 1L1 17L5.5 13L9 21L12 19.5L8.5 12L15 12Z')
    arrow.setAttribute('fill', '#78dda0'); arrow.setAttribute('stroke', '#16251c'); arrow.setAttribute('stroke-width', '1')
    svg.appendChild(arrow); pointer.appendChild(svg)
    const label = document.createElement('span'); label.className = payload.phase === 'completed' ? 'label complete' : 'label'; label.textContent = payload.label
    label.style.maxWidth = `${Math.max(1, Math.min(144, innerWidth - 12))}px`
    shadow.appendChild(pointer); shadow.appendChild(label)
  }
  root.appendChild(host)
  state.host = host; state.shadow = shadow
  if (point) {
    const label = shadow.querySelector<HTMLElement>('.label')
    if (label) {
      const rect = label.getBoundingClientRect()
      const x = Math.max(6, Math.min(point.x + 15, innerWidth - rect.width - 6))
      const below = point.y + 21
      const y = Math.max(6, Math.min(below + rect.height > innerHeight - 6 ? point.y - rect.height - 4 : below, innerHeight - rect.height - 6))
      label.style.transform = `translate(${x}px,${y}px)`
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const clearPosition = () => {
    if (globals[key] !== state) return
    state.cleanup(); state.host = null; state.shadow = null; state.point = null; state.phase = 'clear'; state.expiresAt = 0
  }
  const onClear = (event: MessageEvent) => {
    if (event.source !== window.top || event.data?.channel !== 'agentmux-feedback' || event.data.type !== 'clear' ||
        event.data.token !== payload.token || event.data.operationId !== payload.operationId || event.data.navigationId !== payload.navigationId) return
    clearPosition()
  }
  const onHuman = (event: Event) => { if (event.isTrusted) clearPosition() }
  const onVisibility = () => { if (document.hidden) clearPosition() }
  state.cleanup = () => {
    clearTimeout(timer)
    window.removeEventListener('message', onClear)
    document.removeEventListener('pointerdown', onHuman, true)
    document.removeEventListener('keydown', onHuman, true)
    document.removeEventListener('wheel', onHuman, true)
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', clearPosition)
    window.removeEventListener('scroll', clearPosition, true)
    window.removeEventListener('resize', clearPosition, true)
    document.removeEventListener('scroll', clearPosition, true)
    host.remove()
  }
  if (payload.kind === 'target') {
    window.addEventListener('message', onClear)
    window.addEventListener('scroll', clearPosition, true)
    document.addEventListener('scroll', clearPosition, true)
    window.addEventListener('resize', clearPosition, true)
    document.addEventListener('pointerdown', onHuman, true)
    document.addEventListener('keydown', onHuman, true)
    document.addEventListener('wheel', onHuman, { capture: true, passive: true })
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', clearPosition)
    window.top?.postMessage({ channel: 'agentmux-feedback', type: 'register', token: payload.token, operationId: payload.operationId, navigationId: payload.navigationId }, '*')
  }
  if (payload.phase === 'completed') {
    state.expiresAt = Date.now() + payload.completedMs
    timer = setTimeout(clearPosition, payload.completedMs)
  }
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
  private warned = false
  private token = ''
  private navigationId = ''
  constructor(private readonly input: FeedbackInput) {}
  private current(): boolean { return this.input.isCurrent() && this.input.navigationId() === this.navigationId }
  private payload(phase: FeedbackPayload['phase'], kind: FeedbackPayload['kind'], deadline: number): FeedbackPayload {
    const action = ACTION_LABELS[this.method] ?? 'Operate'
    return { revision: this.input.nextRevision(), operationId: this.input.operationId,
      navigationId: this.navigationId, phase, kind, token: this.token, deadline, completedMs: COMPLETED_CUE_MS,
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
      void this.clear()
    } finally { clearTimeout(timer) }
  }
  async begin(method: string): Promise<number> {
    const generation = ++this.generation
    await this.clearAt(generation)
    if (generation !== this.generation || !this.input.isCurrent()) return generation
    this.navigationId = this.input.navigationId(); this.token = randomUUID()
    this.method = method; this.mode = 'running'
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
  async clear(): Promise<void> {
    await this.clearAt(++this.generation)
  }
  private async clearAt(generation: number): Promise<void> {
    if (this.mode === 'clear' && !this.target) return
    this.mode = 'clear'
    this.target = undefined
    await this.bounded(this.page(this.payload('clear', 'page', 0)), generation)
  }
}

export function showBrowserOperationFeedback(input: FeedbackInput): BrowserOperationFeedback {
  return new BrowserOperationFeedback(input)
}
