import type { ReactNode } from 'react'

/** A presentation choice retains the original component and body state. */
export function ConversationDetailRecord({ visible, children }: { visible: boolean; children: ReactNode }) {
  return <div className="conversation-detail-record" hidden={!visible} inert={!visible}>{children}</div>
}

/** Reuse the reader's existing selection/focus updates; no per-record listeners. */
export function protectedConversationDetailRecords(root: HTMLElement | null, recordKeys: ReadonlySet<string>): Set<string> {
  const protectedKeys = new Set<string>()
  const document = root?.ownerDocument
  const focused = document?.activeElement
  const selection = document?.defaultView?.getSelection()
  const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null
  if (range || focused && root?.contains(focused)) for (const node of root?.querySelectorAll<HTMLElement>('[data-conversation-layout-key]') ?? []) {
    const key = node.dataset.conversationLayoutKey!
    if (!recordKeys.has(key)) continue
    if (focused && node.contains(focused)) protectedKeys.add(key)
    try { if (range?.intersectsNode(node)) protectedKeys.add(key) } catch { protectedKeys.add(key) }
  }
  return protectedKeys
}
