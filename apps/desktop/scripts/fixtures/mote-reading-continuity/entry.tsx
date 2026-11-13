import '../../../src/renderer/src/styles/index.css'
import { api } from '../../../src/renderer/src/lib/api'
import { createConversationReadApi } from '../../../src/renderer/src/lib/conversation-read-api'
import { mountReadingScene } from './scene'
const port = (window as any).privateReadingPort
Object.assign(api.conversation, createConversationReadApi(port.conversation))
const scene = await mountReadingScene(document.getElementById('root')!, await port.seed())
let anchor: { id: string; body: HTMLElement; details: HTMLDetailsElement | null; range: Range; offset: number; text: string } | null = null
const nodeIds = new WeakMap<Node, number>(); let serial = 0
const placement: unknown[] = []
function tracePlacement() {
  const observe = (method: string, receiver: Node, args: unknown[], operation: () => unknown) => {
    const body = anchor?.body, feed = body?.closest<HTMLElement>('.activity-feed')
    const affected = body && [receiver, ...args].some(value => value instanceof Node && (value === body || value.contains(body)))
    const state = () => ({ connected: body?.isConnected, top: feed?.scrollTop, height: feed?.clientHeight, text: window.getSelection()?.toString(), parent: feed?.parentElement?.className })
    if (affected) placement.push({ method, phase: 'before', receiver: receiver instanceof Element ? { id: receiver.id, class: receiver.className } : receiver.nodeName, ...state() })
    const result = operation()
    if (affected) placement.push({ method, phase: 'after', ...state() })
    return result
  }
  for (const [prototype, methods] of [[Node.prototype, ['removeChild', 'appendChild', 'insertBefore']], [Element.prototype, ['append', 'moveBefore', 'hidePopover', 'showPopover']]] as const) {
    for (const method of methods) {
      const original = (prototype as any)[method]
      if (typeof original !== 'function') continue
      Object.defineProperty(prototype, method, { configurable: true, value(this: Node, ...args: unknown[]) { return observe(method, this, args, () => Reflect.apply(original, this, args)) } })
    }
  }
}
function nodeId(node: Node | null) { if (!node) return null; if (!nodeIds.has(node)) nodeIds.set(node, ++serial); return nodeIds.get(node) }
function snapshot() {
  const feed = scene.feed(), frame = feed?.getBoundingClientRect()
  const nodes = [...scene.panel().querySelectorAll<HTMLElement>('[data-native-record-id]')]
  const target = anchor && scene.panel().querySelector<HTMLElement>(`[data-native-record-id="${anchor.id}"] .log-turn__body`)
  const latest = nodes.at(-1)?.getBoundingClientRect()
  return { ...scene.facts(), physical: feed && frame ? { feedNode: nodeId(feed), scrollTop: feed.scrollTop, scrollHeight: feed.scrollHeight, clientHeight: feed.clientHeight,
    tailDistance: feed.scrollHeight - feed.clientHeight - feed.scrollTop, frame: frame.toJSON(), latest: latest?.toJSON(),
    readingTail: feed.querySelector('[data-conversation-reading-tail]')?.getBoundingClientRect().toJSON(),
    firstVisible: nodes.find(node => { const r = node.getBoundingClientRect(); return r.bottom > frame.top && r.top < frame.bottom })?.dataset.nativeRecordId } : null,
    anchor: anchor ? { id: anchor.id, beforeOffset: anchor.offset, offset: target && frame ? target.getBoundingClientRect().top - frame.top : null,
      nodeRetained: target === anchor.body, bodyNode: nodeId(target || null), expanded: target?.querySelector('details')?.open ?? false,
      rangeRetained: window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) === anchor.range : false,
      text: window.getSelection()?.toString(), originalText: anchor.text } : null }
}
Object.assign(window, { readingProof: { ready: true, open: scene.open, hide: scene.hide, snapshot, placement: () => placement,
  rememberAnchor() {
    const feed = scene.feed(), frame = feed.getBoundingClientRect()
    const node = [...feed.querySelectorAll<HTMLElement>('[data-native-record-id]')].find(node => {
      const body = node.querySelector<HTMLElement>('.log-turn__body'), r = body?.getBoundingClientRect()
      return !!r && r.top >= frame.top + 20 && r.bottom <= frame.bottom - 20 && !!body?.querySelector('p') && !!body.querySelector('details')
    })
    if (!node) throw Error('A fully visible original reply is required for the upward anchor')
    const body = node.querySelector<HTMLElement>('.log-turn__body')!, details = body.querySelector('details')
    if (details) details.open = true
    const paragraph = body.querySelector('p')!, range = document.createRange(); range.selectNodeContents(paragraph)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    anchor = { id: node.dataset.nativeRecordId!, body, details, range, offset: body.getBoundingClientRect().top - frame.top, text: selection.toString() }
    if (new URLSearchParams(location.search).has('placementTrace')) tracePlacement()
    return snapshot()
  },
  clearSelection() { window.getSelection()?.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) },
  jump() { const button = scene.panel().querySelector<HTMLButtonElement>('[data-message-tool-control="jump-to-latest"]'); if (!button) throw Error('Original jump-to-latest action absent'); button.click() }
} })
