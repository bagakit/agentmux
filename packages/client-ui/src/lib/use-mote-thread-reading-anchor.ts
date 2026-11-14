import { useLayoutEffect } from 'react'
import { conversationScrollParent } from './conversation-body-work.js'
import { markProgrammaticReadingScroll } from './reading-scroll.js'

type Anchor = { target: Element; range?: Range; offset: number }

function visibleAnchor(pane: HTMLElement, viewport: HTMLElement): Anchor | null {
  const document = pane.ownerDocument
  const clip = viewport.getBoundingClientRect()
  const selection = document.getSelection()
  if (selection && !selection.isCollapsed && selection.rangeCount) {
    const range = selection.getRangeAt(0)
    const target = range.startContainer.parentElement
    if (target && pane.contains(target) && pane.contains(range.endContainer)) {
      const rect = range.getBoundingClientRect()
      if (rect.height && rect.top < clip.bottom && rect.bottom > clip.top) return { target, range, offset: rect.top - clip.top }
    }
  }

  // One hit test in the visible reader band keeps ordinary scrolling local.
  const reader = pane.getBoundingClientRect()
  const left = Math.max(clip.left, reader.left), right = Math.min(clip.right, reader.right)
  const top = Math.max(clip.top, reader.top), bottom = Math.min(clip.bottom, reader.bottom)
  if (right <= left || bottom <= top) return null
  const hit = document.elementFromPoint((left + right) / 2, top + (bottom - top) / 3)
  const target = hit?.closest('.md-paragraph, .mote-work-event__reply, .mote-work-event__assignment')
  return target && pane.contains(target) ? { target, offset: target.getBoundingClientRect().top - clip.top } : null
}

/** Keep the original reading point when the same open details reflow in their actual scroll viewport. */
export function useMoteThreadReadingAnchor(pane: HTMLElement | null, activeThread: string | null) {
  useLayoutEffect(() => {
    const surface = pane?.closest<HTMLElement>('.mote-threads')
    const document = pane?.ownerDocument, view = document?.defaultView
    if (!pane || !surface || !document || !view?.ResizeObserver || !activeThread) return

    let width = surface.clientWidth
    let viewport: HTMLElement | null = null
    let anchor: Anchor | null = null
    let frame: number | null = null
    const remember = () => {
      if (viewport && surface.clientWidth === width) anchor = visibleAnchor(pane, viewport)
    }
    const onScroll = () => {
      if (frame !== null) return
      frame = view.requestAnimationFrame(() => { frame = null; remember() })
    }

    const updateViewport = () => {
      const next = conversationScrollParent(pane)
      if (next === viewport) return
      viewport?.removeEventListener('scroll', onScroll)
      viewport = next
      viewport?.addEventListener('scroll', onScroll, { passive: true })
    }

    const observer = new view.ResizeObserver(() => {
      const nextWidth = surface.clientWidth
      updateViewport()
      if (viewport && nextWidth > 0 && nextWidth !== width && anchor && pane.contains(anchor.target)) {
        const clip = viewport.getBoundingClientRect()
        const rect = (anchor.range ?? anchor.target).getBoundingClientRect()
        if (rect.height > 0) {
          const offset = Math.min(anchor.offset, Math.max(0, viewport.clientHeight - rect.height))
          viewport.scrollTop += rect.top - clip.top - offset
          markProgrammaticReadingScroll(viewport)
        }
      }
      width = nextWidth
      remember()
    })
    observer.observe(surface)
    updateViewport()
    remember()
    document.addEventListener('selectionchange', remember)
    return () => {
      observer.disconnect()
      if (frame !== null) view.cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', remember)
      viewport?.removeEventListener('scroll', onScroll)
    }
  }, [activeThread, pane])
}
