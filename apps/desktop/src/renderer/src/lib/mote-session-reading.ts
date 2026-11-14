import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { initFollowState, onContentChange, onScroll, type ScrollGeometry } from '@agentmux/client-ui/activity-autoscroll'
import { markProgrammaticReadingScroll, consumeProgrammaticReadingScroll } from '@agentmux/client-ui/reading-scroll'
import { conversationReadingAnchor, restoreConversationAnchor } from '@agentmux/client-ui/conversation-reading-anchor'
import type { ConversationReadingGeometry } from '@agentmux/client-ui/conversation-body-work'
import type { ConversationRecord } from '@agentmux/client-ui/conversation-records'

/** DOM reading intent for this exact mounted Session; the original Reader owns all messages. */
export function useMoteSessionReading(identity: string, active: boolean) {
  const viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null), tail = useRef<HTMLDivElement>(null)
  const state = useRef(initFollowState()), source = useRef(identity)
  const anchor = useRef<ReturnType<typeof conversationReadingAnchor>>(null), physical = useRef<ScrollGeometry | null>(null)
  const releaseHeld = useRef<() => void>(() => {}), resumeAtBottom = useRef<() => void>(() => {})
  const [atTail, setAtTail] = useState(true)
  if (source.current !== identity) {
    source.current = identity; state.current = initFollowState(); anchor.current = null; physical.current = null
  }
  const readingHeight = useCallback((node: HTMLElement) => Math.max(node.clientHeight, tail.current
    ? node.scrollTop + tail.current.getBoundingClientRect().top - node.getBoundingClientRect().top : node.scrollHeight), [])
  const atMessageTail = useCallback(() => {
    const node = viewport.current, end = tail.current
    if (!node || !end) return true
    const offset = end.getBoundingClientRect().top - node.getBoundingClientRect().top
    return offset >= -1 && offset <= node.clientHeight + 1
  }, [])
  const syncPosition = useCallback(() => setAtTail(atMessageTail()), [atMessageTail])
  const rawGeometry = useCallback((): ScrollGeometry | null => {
    const node = viewport.current
    return node ? { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight } : null
  }, [])
  const selected = useCallback(() => {
    const node = viewport.current, selection = node?.ownerDocument.defaultView?.getSelection()
    if (!node || !selection || selection.isCollapsed || !selection.rangeCount) return false
    try { return selection.getRangeAt(0).intersectsNode(node) } catch { return false }
  }, [])
  const capture = useCallback(() => { if (viewport.current) anchor.current = conversationReadingAnchor(viewport.current, content.current) }, [])
  const restore = useCallback(() => {
    const node = viewport.current
    if (node && anchor.current) { restoreConversationAnchor(node, anchor.current); markProgrammaticReadingScroll(node) }
    syncPosition()
  }, [syncPosition])
  const pin = useCallback(() => {
    const node = viewport.current
    if (!node) return
    node.scrollTop = Math.max(0, readingHeight(node) - node.clientHeight)
    markProgrammaticReadingScroll(node)
    state.current = { ...state.current, lastScrollTop: node.scrollTop }
    physical.current = rawGeometry(); syncPosition()
  }, [rawGeometry, readingHeight, syncPosition])
  const detach = useCallback(() => { state.current = { ...state.current, following: false }; capture(); syncPosition() }, [capture, syncPosition])
  const latest = useCallback(() => {
    const node = viewport.current, selection = node?.ownerDocument.defaultView?.getSelection()
    if (node && selected() && selection?.rangeCount) {
      const range = selection.getRangeAt(0)
      if (!node.contains(range.startContainer) || !node.contains(range.endContainer)) return false
      selection.removeAllRanges()
    }
    anchor.current = null; state.current = { ...state.current, following: true }; pin(); return true
  }, [pin, selected])
  const beforeCommit = useCallback(() => {
    if (selected()) { detach(); return false }
    if (!state.current.following) capture()
    return true
  }, [selected, detach, capture])
  const readingGeometry = useMemo<ConversationReadingGeometry>(() => ({ viewport: () => viewport.current, content: () => content.current,
    following: () => state.current.following && !selected(), pinToBottom: pin, captureAnchor: capture, restoreAnchor: restore,
    onLayout: cause => {
      if (cause === 'resize' && viewport.current) {
        physical.current = rawGeometry(); state.current = { ...state.current, lastScrollTop: viewport.current.scrollTop }
        markProgrammaticReadingScroll(viewport.current)
      }
      syncPosition()
    } }), [selected, pin, capture, restore, rawGeometry, syncPosition])
  useEffect(() => {
    const node = viewport.current
    if (!active || !node) return
    const scroll = () => {
      const wasFollowing = state.current.following, next = rawGeometry()
      if (!next) return
      const previous = physical.current, programmatic = consumeProgrammaticReadingScroll(node)
      const clamp = previous && (previous.clientHeight !== next.clientHeight || previous.scrollHeight !== next.scrollHeight)
        && Math.abs(next.scrollTop - Math.min(previous.scrollTop, Math.max(0, next.scrollHeight - next.clientHeight))) <= 1
      physical.current = next
      const readable = { ...next, scrollHeight: readingHeight(node) }
      state.current = programmatic === 'restore' || clamp ? { ...state.current, lastScrollTop: next.scrollTop }
        : programmatic === 'navigation' ? { ...state.current, following: false, lastScrollTop: next.scrollTop }
          : onScroll(state.current, readable)
      const tailAbove = tail.current && tail.current.getBoundingClientRect().top < node.getBoundingClientRect().top - 1
      if (selected() || tailAbove || !wasFollowing && !atMessageTail()) state.current = { ...state.current, following: false }
      if (programmatic !== 'restore') capture()
      syncPosition()
      if (!wasFollowing && state.current.following && !programmatic && !clamp) resumeAtBottom.current()
    }
    const disclose = (event: Event) => {
      const target = event.target as Element | null
      if (target?.closest('[data-conversation-process-key] button, summary')) detach()
    }
    const selection = () => { if (selected()) detach(); else releaseHeld.current() }
    node.addEventListener('scroll', scroll, { passive: true }); node.addEventListener('click', disclose, true)
    node.ownerDocument.addEventListener('selectionchange', selection)
    return () => { node.removeEventListener('scroll', scroll); node.removeEventListener('click', disclose, true); node.ownerDocument.removeEventListener('selectionchange', selection) }
  }, [active, identity, rawGeometry, readingHeight, atMessageTail, capture, detach, selected, syncPosition])
  const committed = useCallback((records: readonly ConversationRecord[]) => {
    if (!active) return
    const end = records.at(-1)
    const decision = onContentChange(state.current, { itemCount: records.length, lastItemId: end?.id ?? null,
      lastItemLength: end?.contentParts.reduce((length, part) => length + Object.values(part).reduce<number>((size, value) => size + (typeof value === 'string' ? value.length : 0), 0), 0) ?? 0 })
    state.current = decision.state
    if (selected()) detach()
    else if (decision.scrollToBottom) pin()
    else if (!state.current.following) restore()
    syncPosition()
  }, [active, selected, detach, pin, restore, syncPosition])
  useLayoutEffect(() => { if (active && state.current.following) pin(); else if (active) syncPosition() }, [identity, active, pin, syncPosition])
  return { viewport, content, tail, readingGeometry, beforeCommit, releaseHeld, resumeAtBottom, committed, atTail, detach, latest }
}
