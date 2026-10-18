import { observeVisibleWork } from './use-visible-work.js'
import { markProgrammaticReadingScroll } from './reading-scroll.js'
import { selectedConversationReadingNode } from './conversation-reading-anchor.js'

/** Host follow policy is read-only here. No layout event grants a reading intent. */
export type ConversationReadingGeometry = {
  viewport(): HTMLElement | null
  content?(): HTMLElement | null
  following(): boolean
  pinToBottom(): void
  /** Desktop can retain a terminal segment outside the shared record sequence. */
  captureAnchor?(): void
  restoreAnchor?(): void
  onLayout?(cause?: 'resize'): void
}
type Body = { node: HTMLElement; mount(): void }
type Anchor = { node: HTMLElement; viewport: HTMLElement; offset: number }

export function conversationScrollParent(root: HTMLElement | null): HTMLElement | null {
  for (let node = root?.parentElement; node; node = node.parentElement) {
    if (node.hasAttribute('data-workbench-reading-scroll')
      || node.clientHeight > 0 && node.scrollHeight > node.clientHeight) return node
  }
  return null
}
export function conversationReadingNode(node: HTMLElement): HTMLElement | null {
  return node.dataset.conversationProcessKey ? node.querySelector<HTMLElement>('.wf-card--observation > .wf-head') : node
}

/** One reading position's DOM work. Holds nodes/callbacks, never message bodies or Reader facts. */
export class ConversationBodyWork {
  private root: HTMLElement | null = null
  private owner: Document | null = null
  private viewport: HTMLElement | null = null
  private active = false
  private generation = 0
  private geometry: ConversationReadingGeometry | undefined
  private observer: IntersectionObserver | undefined
  private resize: ResizeObserver | undefined
  private frame: number | undefined
  private mounting: HTMLElement | null = null
  private bodies = new Map<HTMLElement, Body>()
  private shells = new Set<HTMLElement>()
  private near = new Set<HTMLElement>()
  private anchor: Anchor | null = null
  private anchorCaptured = false
  private cleanup: (() => void) | undefined

  connect(root: HTMLElement | null, active: boolean, geometry?: ConversationReadingGeometry): void {
    this.geometry = geometry
    const viewport = geometry?.viewport() ?? conversationScrollParent(root)
    if (root === this.root && root?.ownerDocument === this.owner && viewport === this.viewport && active === this.active) return
    this.disconnect()
    this.root = root; this.owner = root?.ownerDocument ?? null; this.viewport = viewport; this.active = active
    if (!root || !active) return
    const owner = root.ownerDocument, view = owner.defaultView, generation = this.generation
    const valid = () => this.generation === generation && this.root === root && this.active && root.ownerDocument === owner
    this.observer = observeVisibleWork(owner, entries => {
        if (!valid()) return
        for (const entry of entries) {
          const node = entry.target as HTMLElement
          if (entry.isIntersecting) this.near.add(node); else this.near.delete(node)
        }
        if (!this.anchorCaptured) this.capture()
        this.schedule()
      }, { root: viewport, rootMargin: '600px 0px' })
    if (this.observer) {
      for (const node of this.bodies.keys()) this.observer.observe(node)
      for (const node of this.shells) this.observer.observe(node)
    }
    const Resize = view?.ResizeObserver
    if (Resize) {
      this.resize = new Resize(() => { if (valid() && owner.visibilityState !== 'hidden') { this.restore('resize'); this.schedule() } })
      this.resize.observe(root)
      const content = geometry?.content?.()
      if (content && content !== root) this.resize.observe(content)
      if (viewport) this.resize.observe(viewport)
    }
    const scroll = () => { if (valid()) { if (!this.geometry?.captureAnchor) this.capture(); this.schedule() } }
    const visibility = () => {
      if (!valid()) return
      if (owner.visibilityState === 'hidden') this.cancel()
      else { this.capture(); this.schedule() }
    }
    const focusout = () => { if (valid()) this.schedule() }
    viewport?.addEventListener('scroll', scroll, { passive: true })
    viewport?.addEventListener('focusout', focusout)
    owner.addEventListener('visibilitychange', visibility)
    this.cleanup = () => { viewport?.removeEventListener('scroll', scroll); viewport?.removeEventListener('focusout', focusout); owner.removeEventListener('visibilitychange', visibility) }
    this.capture(); this.schedule()
  }
  disconnect(): void {
    this.generation += 1
    this.cancel(); this.observer?.disconnect(); this.resize?.disconnect(); this.cleanup?.()
    this.observer = undefined; this.resize = undefined; this.cleanup = undefined
    this.near.clear(); this.mounting = null; this.anchor = null; this.anchorCaptured = false; this.active = false
  }
  updateShells(): void {
    const next = new Set(this.root?.querySelectorAll<HTMLElement>('[data-conversation-layout-key]') ?? [])
    for (const node of this.shells) if (!next.has(node)) { this.observer?.unobserve(node); this.near.delete(node) }
    for (const node of next) if (!this.shells.has(node)) this.observer?.observe(node)
    this.shells = next
  }
  register(node: HTMLElement, mount: () => void): () => void {
    this.bodies.set(node, { node, mount }); this.observer?.observe(node)
    const shell = node.closest<HTMLElement>('[data-conversation-layout-key]')
    if (shell && !this.shells.has(shell)) { this.shells.add(shell); this.observer?.observe(shell) }
    this.schedule()
    return () => {
      this.bodies.delete(node); this.near.delete(node); this.observer?.unobserve(node)
      if (this.mounting === node) { this.mounting = null; this.schedule() }
    }
  }
  capture(cold = false): boolean {
    if (!this.available() || this.geometry?.following()) return false
    if (this.geometry?.captureAnchor) { this.geometry.captureAnchor(); this.anchorCaptured = true; return true }
    const viewport = this.viewport
    if (!viewport) return false
    const bounds = viewport.getBoundingClientRect()
    const candidates = this.near.size || !cold ? this.near : this.shells
    const selected = this.root && selectedConversationReadingNode(this.root, '[data-conversation-layout-key]', shell => {
      const rect = conversationReadingNode(shell)?.getBoundingClientRect()
      return Boolean(rect && rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom)
    }, () => candidates)
    const selectedNode = selected && conversationReadingNode(selected)
    const selectedRect = selectedNode?.getBoundingClientRect()
    if (selectedNode && selectedRect && selectedRect.height > 0 && selectedRect.bottom > bounds.top && selectedRect.top < bounds.bottom) {
      this.anchor = { node: selectedNode, viewport, offset: selectedRect.top - bounds.top }; this.anchorCaptured = true; return true
    }
    let first: Anchor | null = null
    for (const shell of candidates) {
      if (!this.shells.has(shell)) continue
      const node = conversationReadingNode(shell)
      if (!node) continue
      const rect = node.getBoundingClientRect()
      if (rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom && (!first || rect.top < first.offset + bounds.top))
        first = { node, viewport, offset: rect.top - bounds.top }
    }
    if (first) { this.anchor = first; this.anchorCaptured = true }
    return Boolean(first)
  }
  restore(cause?: 'resize'): void {
    if (!this.available()) return
    if (this.geometry?.following()) this.geometry.pinToBottom()
    else if (this.geometry?.restoreAnchor) this.geometry.restoreAnchor()
    else if (this.anchor?.node.isConnected && this.root?.contains(this.anchor.node)) {
      const { node, viewport, offset } = this.anchor
      const delta = node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - offset
      if (delta) { viewport.scrollTop += delta; markProgrammaticReadingScroll(viewport) }
    }
    this.geometry?.onLayout?.(cause)
  }
  committed(node: HTMLElement): void {
    this.restore()
    if (this.mounting === node) { this.mounting = null; this.schedule() }
  }
  private available(): boolean {
    return Boolean(this.active && this.root?.isConnected && this.root.ownerDocument === this.owner && this.owner?.visibilityState !== 'hidden')
  }
  private cancel(): void {
    if (this.frame !== undefined) this.owner?.defaultView?.cancelAnimationFrame(this.frame)
    this.frame = undefined
  }
  private schedule(): void {
    if (!this.available() || !this.observer || this.mounting || this.frame !== undefined || this.bodies.size === 0) return
    const candidates = [...this.near].filter(node => this.bodies.has(node))
    if (!candidates.length) return
    const view = this.owner?.defaultView
    if (!view) return
    const owner = this.owner, generation = this.generation
    this.frame = view.requestAnimationFrame(() => {
      if (owner !== this.owner || generation !== this.generation) return
      this.frame = undefined
      if (!this.available()) return
      const bounds = this.viewport?.getBoundingClientRect() ?? { top: 0, bottom: view.innerHeight }
      let next: Body | undefined, distance = Infinity
      const pending = [...this.near].filter(node => this.bodies.has(node))
      for (const node of pending) {
        if (!this.bodies.has(node) || !node.isConnected || node.ownerDocument !== this.owner || this.observer && !this.near.has(node)) continue
        if (node.contains(this.owner?.activeElement ?? null)) continue
        const rect = node.getBoundingClientRect()
        if (rect.height <= 0 || rect.bottom < bounds.top - 600 || rect.top > bounds.bottom + 600) continue
        const gap = rect.bottom <= bounds.top ? bounds.top - rect.bottom + 1 : rect.top >= bounds.bottom ? rect.top - bounds.bottom + 1 : 0
        if (gap < distance) { distance = gap; next = this.bodies.get(node) }
      }
      if (!next) return
      this.bodies.delete(next.node); this.observer?.unobserve(next.node); this.near.delete(next.node)
      this.mounting = next.node
      next.mount()
      // Its before-mutation snapshot captures the current reader before the body commits.
    })
  }
}
