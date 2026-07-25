import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

type UseSidebarResizeOptions = {
  isOpen: boolean
  width: number
  minWidth: number
  maxWidth: number
  deltaSign: 1 | -1
  renderedExtraWidth?: number
  setWidth: (width: number) => void
  onDraftWidthChange?: (width: number) => void
}

type UseSidebarResizeResult<T extends HTMLElement> = {
  containerRef: React.RefObject<T | null>
  isResizing: boolean
  onResizeStart: (event: React.MouseEvent) => void
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

// Adapted from Orca's useSidebarResize at 34f2a62. Live drag width stays out of
// React state so unrelated renders cannot pull the handle back under the pointer.
export function useSidebarResize<T extends HTMLElement>({
  isOpen,
  width,
  minWidth,
  maxWidth,
  deltaSign,
  renderedExtraWidth = 0,
  setWidth,
  onDraftWidthChange
}: UseSidebarResizeOptions): UseSidebarResizeResult<T> {
  const containerRef = useRef<T | null>(null)
  const isResizingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(width)
  const storedStartWidthRef = useRef(width)
  const draftWidthRef = useRef(width)
  const frameRef = useRef<number | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
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
  }, [applyRenderedWidth, onDraftWidthChange, width])

  const stopResize = useCallback(() => {
    if (!isResizingRef.current) return
    isResizingRef.current = false
    setIsResizing(false)
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    resetDocumentStyles()
    const finalWidth = draftWidthRef.current
    applyRenderedWidth(finalWidth)
    onDraftWidthChange?.(finalWidth)
    if (finalWidth !== width) setWidth(finalWidth)
  }, [applyRenderedWidth, onDraftWidthChange, resetDocumentStyles, setWidth, width])

  const handleMouseMove = useCallback(
    (event: MouseEvent) => {
      if (!isResizingRef.current) return
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

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', stopResize)
    window.addEventListener('blur', stopResize)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', stopResize)
      window.removeEventListener('blur', stopResize)
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      isResizingRef.current = false
      resetDocumentStyles()
    }
  }, [handleMouseMove, resetDocumentStyles, stopResize])

  const onResizeStart = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      isResizingRef.current = true
      setIsResizing(true)
      startXRef.current = event.clientX
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
    [maxWidth, minWidth, onDraftWidthChange, width]
  )

  return { containerRef, isResizing, onResizeStart }
}
