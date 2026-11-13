import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { TextInput } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'

const ThemeActionCloseIcon = semanticIconComponent('action.close')
/** One-line rows; matches the CSS row padding (git-workbench.css, source-control.css). */
const ROW_HEIGHT = 28
/** Below this a list renders whole; filtering a handful of files only adds a control to read past. */
const FILTER_FROM = 12

export type ChangedFile = { path: string; origPath: string | null; change: string }

/**
 * One read of a fixed changed-file list: every file is available, only the rows near the viewport mount,
 * and a path filter narrows long lists. The list owns no Git facts; callers pass the files and the row.
 */
export function ChangedFileList<File extends ChangedFile>({ files, scroller, className, renderFile }: {
  files: readonly File[]
  /**
   * The element that scrolls; the list may sit below other content inside it. Passed as a value, not a ref:
   * a parent's ref is still empty when the parent and this list mount in the same commit.
   */
  scroller: HTMLElement | null
  className: string
  renderFile(file: File): ReactNode
}) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLocaleLowerCase()
  const shown = useMemo(() => needle ? files.filter(file =>
    file.path.toLocaleLowerCase().includes(needle) || !!file.origPath?.toLocaleLowerCase().includes(needle)) : files, [files, needle])
  const rows = useRef<HTMLUListElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  useLayoutEffect(() => {
    const list = rows.current
    if (!scroller || !list) return
    const measure = () => {
      if (list.getClientRects().length === 0) return
      const next = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      setScrollMargin(current => Math.abs(current - next) < 1 ? current : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [scroller, files])
  const virtualizer = useVirtualizer({ count: shown.length, getScrollElement: () => scroller,
    estimateSize: () => ROW_HEIGHT, getItemKey: index => shown[index]!.path, overscan: 12, scrollMargin, useFlushSync: false })
  return <>
    {files.length >= FILTER_FROM && <div className="changed-file-list__filter">
      <TextInput aria-label="Filter changed files" placeholder="Filter files by path" autoComplete="off" spellCheck={false}
        value={query} onChange={event => setQuery(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery('') } }} />
      {query && <button type="button" className="changed-file-list__clear" aria-label="Clear file filter" onClick={() => setQuery('')}>
        <ThemeActionCloseIcon size={12} /></button>}
      {needle && <span className="changed-file-list__count" role="status">{shown.length} of {files.length}</span>}
    </div>}
    {needle && shown.length === 0 && <p className="changed-file-list__empty">No changed file matches “{query.trim()}”.</p>}
    <ul ref={rows} className={className + ' changed-file-list'} style={{ height: virtualizer.getTotalSize() }}
      aria-setsize={shown.length}>
      {virtualizer.getVirtualItems().map(item => <li key={item.key} className="changed-file-list__row"
        style={{ height: ROW_HEIGHT, transform: `translateY(${item.start - scrollMargin}px)` }}>
        {renderFile(shown[item.index]!)}
      </li>)}
    </ul>
  </>
}
