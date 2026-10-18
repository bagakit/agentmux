import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react'
import { useClientUiOwnerDocument } from '../platform.js'

type Endpoints = { start: Node; startOffset: number; end: Node; endOffset: number }
type ReadingSelection = { rangeCount: number; isCollapsed: boolean; ranges: readonly Endpoints[]; focused: Element | null }
const emptySelection: ReadingSelection = { rangeCount: 0, isCollapsed: true, ranges: [], focused: null }
const serverSnapshot = () => emptySelection
const sameEndpoints = (a: Endpoints, b: Endpoints) => a.start === b.start && a.startOffset === b.startOffset && a.end === b.end && a.endOffset === b.endOffset

/** DOM facts only. React rechecks them before committing each candidate frame. */
export function useConversationReadingSelection(root: RefObject<HTMLElement | null>, candidate: unknown, active: boolean, onChange: () => void): void {
  const platformDocument = useClientUiOwnerDocument()
  const document = root.current?.ownerDocument ?? platformDocument
  const committedOnChange = useRef(onChange)
  const cached = useRef(emptySelection)
  useLayoutEffect(() => { committedOnChange.current = onChange })

  const readSnapshot = useCallback((): ReadingSelection => {
    const node = root.current
    const document = node?.ownerDocument ?? platformDocument
    if (!active || !node || !document) return cached.current = emptySelection
    const focused = document.activeElement && node.contains(document.activeElement) ? document.activeElement : null
    const selection = document.defaultView?.getSelection()
    const ranges: Endpoints[] = []
    let intersects = false
    for (let index = 0; index < (selection?.rangeCount ?? 0); index++) {
      const range = selection!.getRangeAt(index)
      ranges.push({ start: range.startContainer, startOffset: range.startOffset, end: range.endContainer, endOffset: range.endOffset })
      if (node.contains(range.startContainer) || node.contains(range.endContainer)) intersects = true
      else try { intersects ||= range.intersectsNode(node) } catch { intersects = true }
    }
    if (!intersects) ranges.length = 0
    if (!intersects && !focused) return cached.current = emptySelection
    const rangeCount = intersects ? selection!.rangeCount : 0, isCollapsed = intersects ? selection!.isCollapsed : true
    const previous = cached.current
    if (previous.focused === focused && previous.rangeCount === rangeCount && previous.isCollapsed === isCollapsed &&
      previous.ranges.length === ranges.length && ranges.every((range, index) => sameEndpoints(range, previous.ranges[index]!))) return previous
    return cached.current = { rangeCount, isCollapsed, ranges, focused }
  }, [root, platformDocument, active])

  const subscribe = useCallback((notify: () => void) => {
    const document = root.current?.ownerDocument ?? platformDocument
    if (!active || !document) return () => {}
    let notified = readSnapshot()
    const update = () => {
      const snapshot = readSnapshot()
      if (snapshot !== notified) { notified = snapshot; notify() }
      committedOnChange.current()
    }
    document.addEventListener('selectionchange', update)
    document.addEventListener('focusin', update)
    document.addEventListener('focusout', update)
    return () => {
      document.removeEventListener('selectionchange', update)
      document.removeEventListener('focusin', update)
      document.removeEventListener('focusout', update)
    }
  }, [root, document, platformDocument, active, readSnapshot])
  // A new getSnapshot identity registers this frame's real DOM consistency
  // check even if selectionchange has not reached the document listener yet.
  const getSnapshot = useCallback(() => readSnapshot(), [readSnapshot, candidate])
  useSyncExternalStore(subscribe, getSnapshot, serverSnapshot)
}
