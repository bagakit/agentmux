import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { readingMatches, sameReadingMatch } from '../lib/reading-find.js'
import { markProgrammaticReadingScroll } from '../lib/reading-scroll.js'
import { SemanticIcon } from '../theme/icons.js'

/** One workface's loaded readable body; the original host still owns content and scrolling. */
export function ReadingFind({ children, source, active = true, label, bodySelector, scrollSelector, onOpen, className = '' }: {
  children: ReactNode; source: unknown; active?: boolean; label: string; bodySelector: string; scrollSelector: string; onOpen?: () => void; className?: string
}) {
  const owner = useMemo(() => ({}), [source, active])
  const latest = useRef<object | null>(owner); latest.current = owner
  const content = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const returnFocus = useRef<{ owner: object; target: HTMLElement | null } | null>(null)
  const matches = useRef<Range[]>([]), selected = useRef<Range | null>(null)
  const [reading, setReading] = useState<{ owner: object; open: boolean; query: string } | null>(null)
  const [result, setResult] = useState({ owner, count: 0, index: 0 })
  const [composing, setComposing] = useState(false)
  const open = active && reading?.owner === owner && reading.open
  const query = reading?.owner === owner ? reading.query : ''
  const currentResult = result.owner === owner ? result : { count: 0, index: 0 }
  const id = 'reading-find-' + useId().replace(/[^a-zA-Z0-9-]/g, '')
  const currentId = id + '-current'
  const current = () => active && latest.current === owner && content.current?.isConnected

  function paint(ranges: Range[], index: number) {
    const view = content.current?.ownerDocument.defaultView as (Window & {
      Highlight?: new (...ranges: Range[]) => unknown
      CSS?: { highlights?: { set(name: string, highlight: unknown): void; delete(name: string): void } }
    }) | null
    const registry = view?.CSS?.highlights
    if (!registry || !view?.Highlight) return
    registry.set(id, new view.Highlight(...ranges))
    registry.set(currentId, new view.Highlight(...(ranges[index] ? [ranges[index]!] : [])))
  }

  function show() {
    if (!current()) return
    const focused = content.current!.ownerDocument.activeElement
    if (!open || focused instanceof HTMLElement && content.current!.contains(focused)) {
      opener.current = focused instanceof HTMLElement && content.current!.contains(focused) ? focused : trigger.current
    }
    onOpen?.()
    if (open) input.current?.focus({ preventScroll: true })
    setReading({ owner, open: true, query })
  }
  function close() {
    if (!current()) return
    setReading({ owner, open: false, query })
    returnFocus.current = { owner, target: opener.current }
  }
  function move(direction: number) {
    if (!current() || !open || composing || !matches.current.length) return
    const before = selected.current ? matches.current.findIndex(range => sameReadingMatch(range, selected.current!)) : 0
    const index = (Math.max(0, before) + direction + matches.current.length) % matches.current.length
    const range = matches.current[index]!
    selected.current = range
    setResult({ owner, count: matches.current.length, index }); paint(matches.current, index)
    const viewport = content.current!.querySelector<HTMLElement>(scrollSelector)
    if (!viewport || !viewport.contains(range.startContainer)) return
    // Reveal only within this original viewport (including an inner code scroller), never the page/Region.
    for (let element = range.startContainer.parentElement; element && content.current!.contains(element); element = element.parentElement) {
      if (element === viewport || (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) && /auto|scroll/.test(getComputedStyle(element).overflow + getComputedStyle(element).overflowX + getComputedStyle(element).overflowY)) {
        const rect = range.getBoundingClientRect(), box = element.getBoundingClientRect()
        if (rect.top < box.top + 8) element.scrollTop += rect.top - box.top - 8
        else if (rect.bottom > box.bottom - 8) element.scrollTop += rect.bottom - box.bottom + 8
        if (rect.left < box.left + 8) element.scrollLeft += rect.left - box.left - 8
        else if (rect.right > box.right - 8) element.scrollLeft += rect.right - box.right + 8
        markProgrammaticReadingScroll(element, 'navigation')
      }
      if (element === viewport) break
    }
  }

  useLayoutEffect(() => {
    if (open) input.current?.focus({ preventScroll: true })
    else if (returnFocus.current?.owner === owner) {
      const target = returnFocus.current.target
      returnFocus.current = null
      ;(target?.isConnected ? target : trigger.current)?.focus({ preventScroll: true })
    }
  }, [owner, open])
  useLayoutEffect(() => {
    latest.current = owner
    matches.current = []; selected.current = null
    opener.current = null; returnFocus.current = null
    setComposing(false)
    return () => {
      if (latest.current === owner) latest.current = null
      opener.current = null; returnFocus.current = null
    }
  }, [owner])
  useLayoutEffect(() => {
    const root = content.current
    if (!root || !open || !query || composing) return
    const refresh = () => {
      if (!current()) return
      const ranges = readingMatches(root, query, bodySelector)
      const retained = selected.current ? ranges.findIndex(range => sameReadingMatch(range, selected.current!)) : -1
      const index = retained >= 0 ? retained : 0
      matches.current = ranges; selected.current = ranges[index] ?? null
      paint(ranges, index)
      setResult(previous => previous.owner === owner && previous.count === ranges.length && previous.index === index ? previous : { owner, count: ranges.length, index })
    }
    refresh()
    const affected = (node: Node) => {
      const element = node.nodeType === 1 ? node as Element : node.parentElement
      return element?.closest(bodySelector) || element?.querySelector(bodySelector)
    }
    const observer = new MutationObserver(records => {
      if (records.some(record => {
        return affected(record.target) || [...record.removedNodes].some(affected)
      })) refresh()
    })
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'inert', 'aria-hidden', 'open', 'class', 'style'] })
    return () => {
      observer.disconnect(); matches.current = []; selected.current = null
      const registry = (root.ownerDocument.defaultView?.CSS as typeof CSS & { highlights?: { delete(name: string): void } })?.highlights
      registry?.delete(id); registry?.delete(currentId)
    }
  }, [owner, open, query, composing, bodySelector, id, currentId])

  return <div className={`reading-find ${className}`} onKeyDownCapture={event => {
    if (!current() || event.defaultPrevented || event.nativeEvent.isComposing || composing || !event.currentTarget.contains(event.target as Node)) return
    const editing = (event.target as Element).closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f' && (!editing || event.target === input.current)) { event.preventDefault(); event.stopPropagation(); show() }
    else if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
  }}>
    <style>{`::highlight(${id}) { background-color: color-mix(in srgb, var(--green) 18%, transparent); color: var(--text); } ::highlight(${currentId}) { background-color: color-mix(in srgb, var(--green) 38%, transparent); color: var(--text); text-decoration: underline; }`}</style>
    <div className="reading-find__tools" data-reading-find-exclude onMouseDown={event => {
      // Pointer navigation keeps the query/caret and the original document Selection.
      if ((event.target as Element).closest('button')) event.preventDefault()
    }}>
      {open ? <>
        <label className="reading-find__field"><SemanticIcon name="action.search" size={13} aria-hidden="true" /><input ref={input} type="search" aria-label={`Find in ${label}`} placeholder="Find text" value={query}
          onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
          onChange={event => { if (current()) { selected.current = null; setResult({ owner, count: 0, index: 0 }); setReading({ owner, open: true, query: event.target.value }) } }}
          onKeyDown={event => { if (!event.nativeEvent.isComposing && !composing && event.key === 'Enter') { event.preventDefault(); move(event.shiftKey ? -1 : 1) } }} /></label>
        <output aria-live="polite" className="reading-find__count">{query ? `${currentResult.count ? currentResult.index + 1 : 0} / ${currentResult.count}` : '0 / 0'}</output>
        <button type="button" disabled={!currentResult.count} aria-label="Previous match" title="Previous match (Shift+Enter)" onClick={() => move(-1)}><SemanticIcon name="navigation.up" size={13} /></button>
        <button type="button" disabled={!currentResult.count} aria-label="Next match" title="Next match (Enter)" onClick={() => move(1)}><SemanticIcon name="navigation.down" size={13} /></button>
        <button type="button" aria-label="Close find" onClick={close}><SemanticIcon name="action.close" size={13} /></button>
        <span className="reading-find__scope">{label}</span>
      </> : <button ref={trigger} type="button" disabled={!active} aria-label={`Find in ${label}`} title="Find in loaded text (Ctrl/⌘+F)" onClick={show}><SemanticIcon name="action.search" size={13} />Find</button>}
    </div>
    <div ref={content} className="reading-find__content" tabIndex={-1}>{children}</div>
  </div>
}
