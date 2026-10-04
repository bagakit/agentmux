import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'

const TREE_ROW_HEIGHT = 24

/** Keeps active interactions mounted without making every selected path a rendered row. */
export function useFileTreeViewport(
  projection: FileExplorerRowProjection,
  scrollRef: RefObject<HTMLDivElement | null>,
  retainedPaths: readonly (string | null | undefined)[],
  scope: string
) {
  const prefixRef = useRef<HTMLDivElement>(null)
  const rowsRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  const retainedIndexes = useMemo(() => retainedPaths.flatMap(path => {
    const index = path === null || path === undefined ? null : projection.getIndexByPath(path)
    return index === null ? [] : [index]
  }), [projection, retainedPaths])
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const indexes = new Set(defaultRangeExtractor(range))
    for (const index of retainedIndexes) indexes.add(index)
    return [...indexes].sort((left, right) => left - right)
  }, [retainedIndexes])
  const getItemKey = useCallback((index: number) => projection.getRowAtIndex(index)!.path, [projection])
  const virtualizer = useVirtualizer({
    count: projection.getVisibleCount(),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TREE_ROW_HEIGHT,
    getItemKey,
    rangeExtractor,
    overscan: 8,
    scrollMargin,
    useFlushSync: false
  })

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current
    const rows = rowsRef.current
    if (!scrollElement || !rows) return
    const measure = () => {
      const next = rows.offsetTop
      setScrollMargin(current => current === next ? current : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scrollElement)
    if (prefixRef.current) observer.observe(prefixRef.current)
    return () => observer.disconnect()
  }, [scope, scrollRef])

  const scrollToPath = useCallback((path: string) => {
    const index = projection.getIndexByPath(path)
    if (index !== null) virtualizer.scrollToIndex(index, { align: 'auto' })
  }, [projection, virtualizer])

  return { prefixRef, rowsRef, scrollMargin, virtualizer, scrollToPath }
}
