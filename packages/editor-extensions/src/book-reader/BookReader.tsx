import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { THEME_CHANGE_EVENT } from '@agentmux/client-ui/theme'
import { readBookProgress, restoreBookProgress } from './reading-progress'
import { BOOK_CONTENT_CSP } from '../books/security'
import type { BookLocation, BookTocItem } from '../books/types'
import type { BookReaderHost, BookReadingPosition, OpenedBook } from './protocol'
import { FilePreviewState } from '../ui/FilePreviewState'
import '../styles/book-reader.css'

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

/** One visible section. Host owns the parser realm and original bytes; the content frame has no scripts. */
export function BookReader({ host, name, position, onPosition, onRetry, positionCheckpoint }: {
  host: BookReaderHost; name: string; position?: BookReadingPosition;
  onPosition(position: BookReadingPosition, origin: 'initial' | 'scroll' | 'checkpoint'): void; onRetry(): void; positionCheckpoint?: { current: (() => void) | null }
}) {
  const [opened, setOpened] = useState<OpenedBook | null>(null), [failure, setFailure] = useState<string | null>(null)
  const [section, setSection] = useState(0), [target, setTarget] = useState<BookLocation | null>(null)
  const [url, setURL] = useState<string | null>(null), [ready, setReady] = useState(false), [outline, setOutline] = useState(false)
  const [attempt, setAttempt] = useState(0), [fontSize, setFontSize] = useState(18), [linkNotice, setLinkNotice] = useState<string | null>(null)
  const frame = useRef<HTMLIFrameElement>(null), hooks = useRef<(() => void) | null>(null)
  const lastPosition = useRef<BookReadingPosition | null>(null)
  const navigation = useRef(0), activeBook = useRef(opened); activeBook.current = opened
  const pendingNavigation = useRef<number | null>(null)
  const callback = useRef(onPosition); callback.current = onPosition
  const initial = useRef(position), restore = useRef<number | null>(position?.progress ?? null)
  const current = useRef<{ opened: OpenedBook; section: number; url: string } | null>(null)
  useLayoutEffect(() => {
    let cancelled = false, id: string | null = null
    setOpened(null); setFailure(null)
    void host.open().then(value => {
      id = value.id
      if (cancelled) { void host.close(value.id).catch(() => {}); return }
      if (!value.book.sections.length) throw new Error('This book contains no readable sections')
      const stored = initial.current, byId = stored ? value.book.sections.findIndex(item => item.id === stored.sectionId) : -1
      const index = byId >= 0 ? byId : stored && stored.section < value.book.sections.length ? stored.section : 0
      setSection(index); setOpened(value)
    }).catch(error => { if (!cancelled) setFailure(errorText(error)) })
    return () => { cancelled = true; navigation.current++; hooks.current?.(); hooks.current = null; if (id) void host.close(id).catch(() => {}) }
  }, [host])
  useLayoutEffect(() => {
    if (!opened) return
    let cancelled = false
    hooks.current?.(); hooks.current = null; current.current = null
    setURL(null); setReady(false); setFailure(null); setLinkNotice(null)
    void host.load(opened.id, section).then(value => {
      if (cancelled) return
      current.current = { opened, section, url: value }; setURL(value)
    }).catch(error => { if (!cancelled) setFailure(errorText(error)) })
    return () => { cancelled = true; hooks.current?.(); hooks.current = null; current.current = null; void host.unload(opened.id, section).catch(() => {}) }
  }, [host, opened, section, attempt])
  useEffect(() => { const doc = frame.current?.contentDocument; if (doc && opened?.book.layout === 'reflowable') doc.documentElement.style.fontSize = `${fontSize}px` }, [fontSize, opened])
  const navigate = (location: BookLocation) => { navigation.current++; pendingNavigation.current = location.index; restore.current = null; setTarget(location); setSection(location.index); setOutline(false) }
  const follow = async (href: string, fromSection?: number) => {
    if (!opened) return
    const generation = ++navigation.current, book = opened
    try { const location = await host.resolve(opened.id, href, fromSection); if (generation !== navigation.current || activeBook.current !== book) return; if (location) navigate(location); else setLinkNotice('This link has no readable destination in this book.') }
    catch (error) { if (generation === navigation.current && activeBook.current === book) setLinkNotice(errorText(error)) }
  }
  const scrollTarget = (doc: Document) => {
    let anchor: Element | null = null
    if (target?.index === section && target.selector) { try { anchor = doc.querySelector(target.selector) } catch {} }
    if (!anchor && target?.index === section && target.fragment) { let fragment = target.fragment; try { fragment = decodeURIComponent(fragment) } catch {}; anchor = doc.getElementById(fragment) ?? doc.querySelector(`[name="${CSS.escape(fragment)}"]`) }
    if (anchor) anchor.scrollIntoView({ block: 'start' })
    if (target?.index === section) setTarget(null)
  }
  useEffect(() => {
    const doc = frame.current?.contentDocument, value = current.current
    if (ready && doc && value && target?.index === value.section) {
      scrollTarget(doc)
      if (pendingNavigation.current === value.section) {
        pendingNavigation.current = null
        callback.current({ section: value.section, sectionId: value.opened.book.sections[value.section]!.id, progress: readBookProgress(doc) }, 'scroll')
      }
    }
  }, [target, ready])
  const loaded = async () => {
    const value = current.current, element = frame.current, doc = element?.contentDocument
    if (!value || !element || !doc || element.src !== value.url) return
    hooks.current?.(); hooks.current = null
    try {
      if (!doc.documentElement.hasAttribute('dir')) doc.documentElement.setAttribute('dir', value.opened.book.direction)
      const hostWindow = element.ownerDocument.defaultView!
      let themeStyle: HTMLStyleElement | null = null
      const applyTheme = () => {
        const colors = hostWindow.getComputedStyle(element)
        doc.documentElement.style.setProperty('--agentmux-book-canvas', colors.getPropertyValue('--surface-0'))
        if (!themeStyle) return
        themeStyle.textContent = `html{color-scheme:${colors.colorScheme}}body{box-sizing:border-box;max-width:70ch;margin:0 auto;padding:32px 28px;line-height:1.7;overflow-wrap:break-word;color:${colors.getPropertyValue('--text')}!important;background:${colors.getPropertyValue('--surface-0')}!important}img,svg{max-width:100%;height:auto}a{color:${colors.getPropertyValue('--accent')}!important}`
      }
      if (opened?.book.layout === 'reflowable') {
        themeStyle = doc.createElement('style'); doc.head?.append(themeStyle)
        doc.documentElement.style.fontSize = `${fontSize}px`
      }
      applyTheme()
      const images = await Promise.allSettled([...doc.images].filter(image => image.getAttribute('src')).map(image => image.decode()))
      const failedImages = images.filter(result => result.status === 'rejected').length
      if (failedImages && images.every(result => result.status === 'rejected')) {
        const texts = doc.createTreeWalker(doc.body ?? doc.documentElement, NodeFilter.SHOW_TEXT)
        let readableText = false
        while (texts.nextNode()) {
          const text = texts.currentNode, parent = text.parentElement
          if (/\S/.test(text.textContent ?? '') && parent && !parent.closest('style,script,noscript,template,[hidden]') && parent.getClientRects().length) { readableText = true; break }
        }
        if (!readableText) throw new Error('This page image could not be decoded')
      }
      if (failedImages && current.current === value) setLinkNotice(`${failedImages} illustration${failedImages === 1 ? '' : 's'} could not be displayed. The text remains available.`)
      await doc.fonts?.ready
      if (current.current !== value || frame.current !== element) return
      const previous = restore.current ?? (lastPosition.current?.section === value.section ? lastPosition.current.progress : null)
      if (previous !== null) { restoreBookProgress(doc, previous); restore.current = null }
      scrollTarget(doc)
      let scheduled = 0
      const publish = (origin: 'initial' | 'scroll' | 'checkpoint' = 'checkpoint') => {
        if (current.current !== value || element.contentDocument !== doc || !element.isConnected) return
        const bounds = element.getBoundingClientRect()
        if (!bounds.width || !bounds.height) return
        const position = { section: value.section, sectionId: value.opened.book.sections[value.section]!.id, progress: readBookProgress(doc) }
        lastPosition.current = position
        callback.current(position, origin)
      }
      if (positionCheckpoint) positionCheckpoint.current = publish
      const scroll = () => { if (!scheduled) scheduled = hostWindow.setTimeout(() => { scheduled = 0; publish('scroll') }, 500) }
      const click = (event: Event) => { const anchor = (event.target as Element).closest?.('a[href]'); if (anchor) { event.preventDefault(); void follow(anchor.getAttribute('href')!, value.section) } }
      const key = (event: KeyboardEvent) => {
        if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || (event.target as Element).closest?.('input,textarea,select,[contenteditable]')) return
        const scroller = doc.scrollingElement ?? doc.documentElement
        if (scroller.scrollWidth > scroller.clientWidth) return
        if (event.key === 'ArrowRight' && value.section + 1 < value.opened.book.sections.length) { event.preventDefault(); navigate({ index: value.section + 1 }) }
        else if (event.key === 'ArrowLeft' && value.section > 0) { event.preventDefault(); navigate({ index: value.section - 1 }) }
      }
      hostWindow.addEventListener(THEME_CHANGE_EVENT, applyTheme)
      doc.addEventListener('scroll', scroll, { passive: true }); doc.addEventListener('click', click); doc.addEventListener('keydown', key)
      hooks.current = () => { if (scheduled) hostWindow.clearTimeout(scheduled); publish(); themeStyle?.remove(); if (positionCheckpoint?.current === publish) positionCheckpoint.current = null; hostWindow.removeEventListener(THEME_CHANGE_EVENT, applyTheme); doc.removeEventListener('scroll', scroll); doc.removeEventListener('click', click); doc.removeEventListener('keydown', key) }
      const navigated = pendingNavigation.current === value.section
      if (navigated) pendingNavigation.current = null
      publish(navigated ? 'scroll' : 'initial'); setReady(true)
    } catch (error) { if (current.current === value) { setFailure('This section could not be displayed: ' + errorText(error)); setReady(false) } }
  }
  const toc = (items: BookTocItem[]) => <ol>{items.map((item, index) => <li key={`${item.href}-${index}`}><button onClick={() => void follow(item.href)}>{item.label}</button>{item.children?.length ? toc(item.children) : null}</li>)}</ol>
  return <div className="book-reader" data-book-state={failure ? 'error' : ready ? 'ready' : 'loading'}>
    <div className="book-reader__body">
      {url ? <iframe key={url} ref={frame} src={url} title={opened?.book.metadata.title ?? name} sandbox="allow-same-origin" {...{csp: BOOK_CONTENT_CSP}} referrerPolicy="no-referrer" onLoad={() => void loaded()} /> : null}
      {!ready ? <div className="book-reader__state"><FilePreviewState title={failure ? opened ? 'Section unavailable' : 'Book unavailable' : opened ? 'Preparing section' : 'Opening book'} {...(failure ? {detail: failure} : {})} error={Boolean(failure)}>{failure ? <>{opened ? <button className="small-button" onClick={() => setAttempt(value => value + 1)}>Retry section</button> : null}<button className="small-button" onClick={onRetry}>Reload original file</button></> : null}</FilePreviewState></div> : null}
      {outline && opened ? <nav className="book-reader__outline" aria-label="Book contents"><div><strong>Contents</strong><button className="small-button" onClick={() => setOutline(false)}>Close</button></div>{opened.book.toc.length ? toc(opened.book.toc) : <p>No contents list in this book.</p>}</nav> : null}
    </div>
    {linkNotice ? <div className="book-reader__notice" role="status">{linkNotice}<button className="small-button" onClick={() => setLinkNotice(null)}>Dismiss</button></div> : null}
    <footer className="book-reader__tools">
      <div className="book-reader__navigation"><button className="small-button" aria-pressed={outline} disabled={!opened} onClick={() => setOutline(value => !value)}>Contents</button><button className="small-button" aria-label="Previous section" disabled={!opened || section === 0} onClick={() => navigate({index: section - 1})}>Previous</button><label><span className="book-reader__section-label">Section </span><input aria-label="Book section" type="number" min={1} max={opened?.book.sections.length ?? 1} value={section + 1} disabled={!opened} onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && opened && value >= 1 && value <= opened.book.sections.length) navigate({index: value - 1}) }} /></label><output>of {opened?.book.sections.length ?? '—'}</output><button className="small-button" aria-label="Next section" disabled={!opened || section + 1 >= opened.book.sections.length} onClick={() => navigate({index: section + 1})}>Next</button></div>
      {opened?.book.layout === 'reflowable' ? <div className="book-reader__text-size"><button className="small-button" aria-label="Decrease text size" disabled={fontSize <= 14} onClick={() => setFontSize(value => value - 2)}>A−</button><button className="small-button" aria-label="Increase text size" disabled={fontSize >= 30} onClick={() => setFontSize(value => value + 2)}>A+</button></div> : null}
    </footer>
  </div>
}
