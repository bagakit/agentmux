import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { literalReadingMatches, readableReadingBody, readingMatchDetails, readingQuery, sameReadingMatch, type ReadingMatch } from '../lib/reading-find.js'
import { markProgrammaticReadingScroll } from '../lib/reading-scroll.js'
import { ReadingFindBodies, type ReadingFindBody } from '../lib/reading-find-body.js'
import { SemanticIcon } from '../theme/icons.js'

type FindMatch = {
  node: HTMLElement
  range?: Range
  body?: ReadingFindBody
  text: string
  offset: number
  occurrence: number
}

function sameMatch(a: FindMatch, b: FindMatch): boolean {
  if (a.range && b.range && sameReadingMatch(a.range, b.range)) return true
  return Boolean(a.body && b.body && a.body.node === b.body.node && a.body.version === b.body.version &&
    a.text === b.text && a.offset === b.offset && a.occurrence === b.occurrence)
}

/** One workface's loaded readable body; the original host still owns content and scrolling. */
export function ReadingFind({ children, source, active = true, label, bodySelector, scrollSelector, onOpen, className = '' }: {
  children: ReactNode | ((trigger: ReactNode) => ReactNode); source: unknown; active?: boolean; label: string; bodySelector: string; scrollSelector: string; onOpen?: () => void; className?: string
}) {
  const owner = useMemo(() => ({}), [source, active])
  const latest = useRef<object | null>(owner); latest.current = owner
  const content = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const returnFocus = useRef<{ owner: object; target: HTMLElement | null } | null>(null)
  const matches = useRef<FindMatch[]>([]), selected = useRef<FindMatch | null>(null)
  const pending = useRef<FindMatch | null>(null)
  const refreshRef = useRef<(() => void) | null>(null)
  const bodies = useMemo(() => new Map<HTMLElement, ReadingFindBody>(), [owner])
  const bodyRegistry = useMemo(() => {
    let queued = false
    function changed() {
      if (queued || !refreshRef.current) return
      queued = true
      queueMicrotask(() => { queued = false; if (latest.current === owner) refreshRef.current?.() })
    }
    return { register(body: ReadingFindBody) {
      bodies.set(body.node, body); changed()
      return () => { if (bodies.get(body.node) === body) { bodies.delete(body.node); changed() } }
    } }
  }, [bodies, owner])
  const [reading, setReading] = useState<{ owner: object; open: boolean; query: string } | null>(null)
  const [result, setResult] = useState({ owner, count: 0, index: 0 })
  const [composing, setComposing] = useState(false)
  const open = active && reading?.owner === owner && reading.open
  const query = reading?.owner === owner ? reading.query : ''
  const currentResult = result.owner === owner ? result : { count: 0, index: 0 }
  const id = 'reading-find-' + useId().replace(/[^a-zA-Z0-9-]/g, '')
  const currentId = id + '-current'
  const current = () => active && latest.current === owner && content.current?.isConnected

  function paint(items: FindMatch[], index: number) {
    const ranges = items.flatMap(item => item.range ? [item.range] : [])
    const view = content.current?.ownerDocument.defaultView as (Window & {
      Highlight?: new (...ranges: Range[]) => unknown
      CSS?: { highlights?: { set(name: string, highlight: unknown): void; delete(name: string): void } }
    }) | null
    const registry = view?.CSS?.highlights
    if (!registry || !view?.Highlight) return
    registry.set(id, new view.Highlight(...ranges))
    registry.set(currentId, new view.Highlight(...(items[index]?.range ? [items[index]!.range!] : [])))
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
    pending.current = null
    setReading({ owner, open: false, query })
    returnFocus.current = { owner, target: opener.current }
  }
  function move(direction: number) {
    if (!current() || !open || composing || !matches.current.length) return
    const before = selected.current ? matches.current.findIndex(match => sameMatch(match, selected.current!)) : 0
    const index = (Math.max(0, before) + direction + matches.current.length) % matches.current.length
    const match = matches.current[index]!
    selected.current = match
    setResult({ owner, count: matches.current.length, index }); paint(matches.current, index)
    if (match.range) scrollToMatch(match.range)
    else if (match.body && bodies.get(match.node) === match.body && readableReadingBody(match.node, content.current!)) {
      pending.current = match
      match.body.reveal()
    }
  }
  function scrollToMatch(range: Range) {
    if (!current() || !open) return
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
    matches.current = []; selected.current = null; pending.current = null
    opener.current = null; returnFocus.current = null
    setComposing(false)
    return () => {
      if (latest.current === owner) latest.current = null
      opener.current = null; returnFocus.current = null; pending.current = null
    }
  }, [owner])
  useLayoutEffect(() => {
    const root = content.current
    if (!root || !open || !query || composing) return
    const refresh = () => {
      if (!current()) return
      const expression = readingQuery(query)
      const ranges: FindMatch[] = readingMatchDetails(root, query, bodySelector).map((match: ReadingMatch) => ({
        node: match.body ?? match.range.startContainer.parentElement!, range: match.range,
        ...(!match.opaque && match.body && bodies.has(match.body) ? { body: bodies.get(match.body)! } : {}),
        text: match.text, offset: match.offset, occurrence: match.occurrence
      }))
      for (const body of bodies.values()) {
        if (body.presented || !readableReadingBody(body.node, root)) continue
        const occurrences = new Map<string, number>()
        for (const text of body.read()) {
          if (!text) continue
          const occurrence = occurrences.get(text) ?? 0
          occurrences.set(text, occurrence + 1)
          for (const match of literalReadingMatches(text, expression)) ranges.push({
            node: body.node, body, text, occurrence, offset: match.offset
          })
        }
      }
      ranges.sort((a, b) => a.node === b.node ? 0 : a.node.compareDocumentPosition(b.node) & 4 ? -1 : 1)
      const retained = selected.current ? ranges.findIndex(match => sameMatch(match, selected.current!)) : -1
      const index = retained >= 0 ? retained : 0
      matches.current = ranges; selected.current = ranges[index] ?? null
      paint(ranges, index)
      if (pending.current) {
        const revealed = ranges.find(match => sameMatch(match, pending.current!) && match.range)
        if (revealed?.range) { pending.current = null; scrollToMatch(revealed.range) }
        else if (!ranges.some(match => sameMatch(match, pending.current!))) pending.current = null
      }
      setResult(previous => previous.owner === owner && previous.count === ranges.length && previous.index === index ? previous : { owner, count: ranges.length, index })
    }
    refreshRef.current = refresh
    refresh()
    const affected = (node: Node) => {
      const element = node.nodeType === 1 ? node as Element : node.parentElement
      return element?.closest(bodySelector + ', .conversation-progressive-body') || element?.querySelector(bodySelector + ', .conversation-progressive-body')
    }
    const observer = new MutationObserver(records => {
      if (records.some(record => {
        return affected(record.target) || [...record.removedNodes].some(affected)
      })) refresh()
    })
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'inert', 'aria-hidden', 'open', 'class', 'style'] })
    return () => {
      observer.disconnect(); refreshRef.current = null; matches.current = []; selected.current = null; pending.current = null
      const registry = (root.ownerDocument.defaultView?.CSS as typeof CSS & { highlights?: { delete(name: string): void } })?.highlights
      registry?.delete(id); registry?.delete(currentId)
    }
  }, [owner, open, query, composing, bodySelector, id, currentId, bodies])

  const findTrigger = <button ref={trigger} className="reading-find__trigger" type="button" disabled={!active}
    data-reading-find-exclude aria-label={`Find in ${label}`} title="Find in loaded text (Ctrl/⌘+F)"
    aria-expanded={open} aria-controls={open ? id + '-tools' : undefined}
    onMouseDown={event => event.preventDefault()} onClick={show}><SemanticIcon name="action.search" size={13} aria-hidden="true" /></button>

  return <div className={`reading-find ${className}`} onKeyDownCapture={event => {
    if (!current() || event.defaultPrevented || event.nativeEvent.isComposing || composing || !event.currentTarget.contains(event.target as Node)) return
    const editing = (event.target as Element).closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f' && (!editing || event.target === input.current)) { event.preventDefault(); event.stopPropagation(); show() }
    else if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
  }}>
    <style>{`::highlight(${id}) { background-color: color-mix(in srgb, var(--green) 18%, transparent); color: var(--text); } ::highlight(${currentId}) { background-color: color-mix(in srgb, var(--green) 38%, transparent); color: var(--text); text-decoration: underline; }`}</style>
    {open ? <div id={id + '-tools'} className="reading-find__tools" role="search" aria-label={`Find in ${label}`} data-reading-find-exclude onMouseDown={event => {
      // Pointer navigation keeps the query/caret and the original document Selection.
      if ((event.target as Element).closest('button')) event.preventDefault()
    }}>
        <label className="reading-find__field"><SemanticIcon name="action.search" size={13} aria-hidden="true" /><input ref={input} type="search" aria-label={`Find in ${label}`} placeholder="Find text" value={query}
          title={`Search ${label} only`}
          onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
          onChange={event => { if (current()) { selected.current = null; pending.current = null; setResult({ owner, count: 0, index: 0 }); setReading({ owner, open: true, query: event.target.value }) } }}
          onKeyDown={event => { if (!event.nativeEvent.isComposing && !composing && event.key === 'Enter') { event.preventDefault(); move(event.shiftKey ? -1 : 1) } }} /></label>
        <output aria-live="polite" className="reading-find__count">{query ? `${currentResult.count ? currentResult.index + 1 : 0} / ${currentResult.count}` : '0 / 0'}</output>
        <button type="button" disabled={!currentResult.count} aria-label="Previous match" title="Previous match (Shift+Enter)" onClick={() => move(-1)}><SemanticIcon name="navigation.up" size={13} /></button>
        <button type="button" disabled={!currentResult.count} aria-label="Next match" title="Next match (Enter)" onClick={() => move(1)}><SemanticIcon name="navigation.down" size={13} /></button>
        <button type="button" aria-label="Close find" title="Close find (Escape)" onClick={close}><SemanticIcon name="action.close" size={13} /></button>
    </div> : null}
    <ReadingFindBodies.Provider value={bodyRegistry}><div ref={content} className="reading-find__content" tabIndex={-1}>
      {typeof children === 'function' ? children(findTrigger) : <><div className="reading-find__floating-trigger">{findTrigger}</div>{children}</>}
    </div></ReadingFindBodies.Provider>
  </div>
}
