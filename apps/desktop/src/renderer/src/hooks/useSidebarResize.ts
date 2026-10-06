import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'

type UseSidebarResizeOptions = {
  isOpen: boolean
  /** A retained or collapsed navigation shell can stay rendered without owning a drag. */
  resizable?: boolean
  width: number
  minWidth: number
  maxWidth: number
  defaultWidth: number
  deltaSign: 1 | -1
  renderedExtraWidth?: number
  setWidth: (width: number) => void
  onDraftWidthChange?: (width: number) => void
}

type UseSidebarResizeResult<T extends HTMLElement> = {
  containerRef: React.RefObject<T | null>
  isResizing: boolean
  onResizeStart: (event: React.MouseEvent) => void
  onResizeReset: (event: React.SyntheticEvent) => void
}

export function clampSidebarResizeWidth(width: number, minWidth: number, maxWidth: number): number {
  return Math.min(maxWidth, Math.max(minWidth, width))
}

export function getRenderedSidebarWidthCssValue(
  isOpen: boolean,
  width: number,
  renderedExtraWidth: number,
  minWidth = 0,
  maxWidth = Number.POSITIVE_INFINITY
): string {
  const renderedWidth = clampSidebarResizeWidth(width, minWidth, maxWidth)
  return isOpen ? `${renderedWidth + renderedExtraWidth}px` : '0px'
}

export function getNextSidebarResizeWidth({
  clientX,
  startX,
  startWidth,
  deltaSign,
  minWidth,
  maxWidth
}: {
  clientX: number
  startX: number
  startWidth: number
  deltaSign: 1 | -1
  minWidth: number
  maxWidth: number
}): number {
  const delta = (clientX - startX) * deltaSign
  return clampSidebarResizeWidth(startWidth + delta, minWidth, maxWidth)
}

export function getNextSidebarResizeDraftWidth({
  clientX,
  startX,
  storedStartWidth,
  renderedStartWidth,
  deltaSign,
  minWidth,
  maxWidth
}: {
  clientX: number
  startX: number
  storedStartWidth: number
  renderedStartWidth: number
  deltaSign: 1 | -1
  minWidth: number
  maxWidth: number
}): number {
  if (clientX === startX) return storedStartWidth
  return getNextSidebarResizeWidth({
    clientX,
    startX,
    startWidth: renderedStartWidth,
    deltaSign,
    minWidth,
    maxWidth
  })
}

// Live drag width stays out of
// React state so unrelated renders cannot pull the handle back under the pointer.
export function useSidebarResize<T extends HTMLElement>({
  isOpen,
  resizable = isOpen,
  width,
  minWidth,
  maxWidth,
  defaultWidth,
  deltaSign,
  renderedExtraWidth = 0,
  setWidth,
  onDraftWidthChange
}: UseSidebarResizeOptions): UseSidebarResizeResult<T> {
  const containerRef = useRef<T | null>(null)
  const isResizingRef = useRef(false)
  const startXRef = useRef(0)
  const startYRef = useRef(0)
  const startWidthRef = useRef(width)
  const storedStartWidthRef = useRef(width)
  const draftWidthRef = useRef(width)
  const frameRef = useRef<number | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const secondPressRef = useRef(false)
  const movedRef = useRef(false)
  const [isResizing, setIsResizing] = useState(false)

  const removeDragOverlay = useCallback(() => {
    const overlay = overlayRef.current
    if (overlay?.parentNode) overlay.parentNode.removeChild(overlay)
    overlayRef.current = null
  }, [])

  const resetDocumentStyles = useCallback(() => {
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    removeDragOverlay()
  }, [removeDragOverlay])

  const applyRenderedWidth = useCallback(
    (nextWidth: number) => {
      if (!containerRef.current) return
      containerRef.current.style.width = getRenderedSidebarWidthCssValue(
        isOpen,
        nextWidth,
        renderedExtraWidth,
        minWidth,
        maxWidth
      )
    },
    [isOpen, maxWidth, minWidth, renderedExtraWidth]
  )

  useLayoutEffect(() => {
    if (isResizingRef.current) return
    draftWidthRef.current = width
    applyRenderedWidth(width)
    onDraftWidthChange?.(width)
    if (isResizing) containerRef.current?.getBoundingClientRect()
  }, [applyRenderedWidth, onDraftWidthChange, width])

  const finishResize = useCallback((commit: boolean) => {
    if (!isResizingRef.current) return
    isResizingRef.current = false
    secondPressRef.current = false
    movedRef.current = false
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    resetDocumentStyles()
    const finalWidth = commit ? draftWidthRef.current : storedStartWidthRef.current
    draftWidthRef.current = finalWidth
    applyRenderedWidth(finalWidth)
    onDraftWidthChange?.(finalWidth)
    // Commit the final geometry while the caller's drag class still disables transitions.
    // Otherwise cancelling can animate the handle away from the next native press.
    containerRef.current?.getBoundingClientRect()
    setIsResizing(false)
    if (commit && finalWidth !== width) setWidth(finalWidth)
  }, [applyRenderedWidth, onDraftWidthChange, resetDocumentStyles, setWidth, width])
  const stopOnBlur = useCallback(() => finishResize(true), [finishResize])
  const cancelResize = useCallback((event: KeyboardEvent) => {
    if (!isResizingRef.current || event.key !== 'Escape' || isImeOwnedKeyboardEvent(event)) return
    event.preventDefault(); event.stopPropagation(); finishResize(false)
  }, [finishResize])
  useLayoutEffect(() => { if (!resizable) finishResize(false) }, [resizable, finishResize])
  const resetWidth = useCallback(() => {
    finishResize(false)
    applyRenderedWidth(defaultWidth); onDraftWidthChange?.(defaultWidth)
    if (defaultWidth !== width) setWidth(defaultWidth)
  }, [finishResize, applyRenderedWidth, defaultWidth, onDraftWidthChange, setWidth, width])
  const onResizeReset = useCallback((event: React.SyntheticEvent) => {
    if (!resizable || event.nativeEvent instanceof KeyboardEvent && isImeOwnedKeyboardEvent(event.nativeEvent)) return
    event.preventDefault(); event.stopPropagation(); resetWidth()
  }, [resizable, resetWidth])
  const stopResize = useCallback(() => {
    // The shield receives release. Only a completed second click can reset;
    // a second press followed by movement remains an ordinary drag.
    if (isResizingRef.current && secondPressRef.current && !movedRef.current) resetWidth()
    else finishResize(true)
  }, [finishResize, resetWidth])

  const handleMouseMove = useCallback(
    (event: MouseEvent) => {
      if (!isResizingRef.current) return
      if (event.clientX !== startXRef.current || event.clientY !== startYRef.current) movedRef.current = true
      const nextWidth = getNextSidebarResizeDraftWidth({
        clientX: event.clientX,
        startX: startXRef.current,
        storedStartWidth: storedStartWidthRef.current,
        renderedStartWidth: startWidthRef.current,
        deltaSign,
        minWidth,
        maxWidth
      })
      if (nextWidth === draftWidthRef.current) return
      draftWidthRef.current = nextWidth
      if (frameRef.current !== null) return
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null
        applyRenderedWidth(draftWidthRef.current)
        onDraftWidthChange?.(draftWidthRef.current)
      })
    },
    [applyRenderedWidth, deltaSign, maxWidth, minWidth, onDraftWidthChange]
  )

  useLayoutEffect(() => {
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', stopResize)
    window.addEventListener('blur', stopOnBlur)
    window.addEventListener('keydown', cancelResize, true)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', stopResize)
      window.removeEventListener('blur', stopOnBlur)
      window.removeEventListener('keydown', cancelResize, true)
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      const ownedDrag = isResizingRef.current
      if (ownedDrag) setIsResizing(false)
      isResizingRef.current = false
      secondPressRef.current = false
      movedRef.current = false
      if (ownedDrag) resetDocumentStyles()
    }
  }, [handleMouseMove, resetDocumentStyles, stopResize, stopOnBlur, cancelResize])

  const onResizeStart = useCallback(
    (event: React.MouseEvent) => {
      if (!resizable || event.button !== 0) return
      event.preventDefault()
      isResizingRef.current = true
      secondPressRef.current = event.detail === 2
      movedRef.current = false
      setIsResizing(true)
      startXRef.current = event.clientX
      startYRef.current = event.clientY
      startWidthRef.current = clampSidebarResizeWidth(width, minWidth, maxWidth)
      storedStartWidthRef.current = width
      draftWidthRef.current = width
      onDraftWidthChange?.(width)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      if (!overlayRef.current) {
        const overlay = document.createElement('div')
        overlay.style.position = 'fixed'
        overlay.style.inset = '0'
        overlay.style.zIndex = '2147483647'
        overlay.style.cursor = 'col-resize'
        overlay.style.background = 'transparent'
        document.body.appendChild(overlay)
        overlayRef.current = overlay
      }
    },
    [resizable, maxWidth, minWidth, onDraftWidthChange, width]
  )

  return { containerRef, isResizing, onResizeStart, onResizeReset }
}
