import { ChevronLeft, ChevronRight } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import {
  getWorkbenchTabStripState,
  sameWorkbenchTabStripState,
  type WorkbenchTabStripState
} from '../lib/workbench-tab-strip'

const EMPTY_SCROLL_STATE: WorkbenchTabStripState = {
  hasOverflow: false,
  canScrollStart: false,
  canScrollEnd: false
}

export function WorkbenchTabStrip({
  activeTabId,
  tabIds,
  children
}: {
  activeTabId: string | null
  tabIds: readonly string[]
  children: ReactNode
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollState, setScrollState] = useState(EMPTY_SCROLL_STATE)
  const tabIdsKey = useMemo(() => tabIds.join('\u0000'), [tabIds])

  const updateScrollState = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    const nextState = getWorkbenchTabStripState(element)
    setScrollState((currentState) => (
      sameWorkbenchTabStripState(currentState, nextState) ? currentState : nextState
    ))
  }, [])

  useLayoutEffect(() => {
    updateScrollState()
  }, [tabIdsKey, updateScrollState])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const handleWheel = (event: globalThis.WheelEvent) => {
      if (element.scrollWidth <= element.clientWidth) return
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return
      event.preventDefault()
      element.scrollLeft += event.deltaY
    }
    const observer = new ResizeObserver(updateScrollState)
    observer.observe(element)
    element.addEventListener('scroll', updateScrollState, { passive: true })
    element.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      observer.disconnect()
      element.removeEventListener('scroll', updateScrollState)
      element.removeEventListener('wheel', handleWheel)
    }
  }, [updateScrollState])

  useEffect(() => {
    const element = scrollRef.current
    if (!element || !activeTabId) return
    const activeTab = Array.from(
      element.querySelectorAll<HTMLElement>('[data-workbench-tab-id]')
    ).find((candidate) => candidate.dataset.workbenchTabId === activeTabId)
    activeTab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId, tabIdsKey])

  function scrollByPage(direction: -1 | 1): void {
    const element = scrollRef.current
    if (!element) return
    element.scrollBy({
      left: direction * Math.max(120, element.clientWidth * 0.72),
      behavior: 'smooth'
    })
  }

  return (
    <div className={`workbench-tab-strip ${scrollState.hasOverflow ? 'workbench-tab-strip--overflow' : ''}`}>
      <div
        ref={scrollRef}
        className="pane-tabbar__tabs"
      >
        {children}
      </div>
      {scrollState.hasOverflow ? (
        <>
          <button
            type="button"
            className="workbench-tab-strip__nav workbench-tab-strip__nav--start"
            title="Scroll tabs left"
            aria-label="Scroll tabs left"
            disabled={!scrollState.canScrollStart}
            onClick={() => scrollByPage(-1)}
          >
            <ChevronLeft size={13} />
          </button>
          <button
            type="button"
            className="workbench-tab-strip__nav workbench-tab-strip__nav--end"
            title="Scroll tabs right"
            aria-label="Scroll tabs right"
            disabled={!scrollState.canScrollEnd}
            onClick={() => scrollByPage(1)}
          >
            <ChevronRight size={13} />
          </button>
        </>
      ) : null}
    </div>
  )
}
