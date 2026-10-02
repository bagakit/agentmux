import { useCallback, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import type { GitHistoryCommit, GitHistoryRef } from '../../../shared/git-contracts'
import { markWindowOverlayDismissal, WindowOverlayPortal } from './WindowOverlayHost'

type DetailTarget = { commit: GitHistoryCommit; anchor: HTMLElement | SVGElement; region: Element; scope: string; focus: boolean }

/** A single transient reader for facts already in this History snapshot. No Git reads or branch membership guesses. */
export function useGitHistoryDetails(scope: string, enabled: boolean) {
  const id = useId()
  const surface = useRef<HTMLDivElement>(null)
  const active = useRef<DetailTarget | null>(null)
  const intent = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const departure = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const restoringFocus = useRef(false)
  const current = useRef({ scope, enabled })
  current.current = { scope, enabled }
  const [target, setTarget] = useState<DetailTarget | null>(null)
  const opened = enabled && target?.scope === scope ? target : null

  const close = useCallback((restoreFocus = false) => {
    clearTimeout(intent.current); clearTimeout(departure.current)
    intent.current = undefined; departure.current = undefined
    const previous = active.current
    active.current = null
    setTarget(null)
    if (restoreFocus && previous?.anchor.isConnected && surface.current?.contains(document.activeElement)) {
      restoringFocus.current = true
      previous.anchor.focus({ preventScroll: true })
      queueMicrotask(() => { restoringFocus.current = false })
    }
  }, [])
  const keepOpen = () => { clearTimeout(departure.current); departure.current = undefined }
  const enterSurface = () => { clearTimeout(intent.current); intent.current = undefined; keepOpen() }
  const show = (next: DetailTarget) => {
    clearTimeout(intent.current); intent.current = undefined; keepOpen()
    if (!current.current.enabled || current.current.scope !== next.scope || document.visibilityState === 'hidden' ||
      !next.anchor.isConnected || next.anchor.closest('[inert]')) return
    active.current = next
    setTarget(next)
  }
  const leave = (related: EventTarget | null, region: Element | null) => {
    if (related instanceof Node && (region?.contains(related) || surface.current?.contains(related))) { keepOpen(); return }
    clearTimeout(intent.current); intent.current = undefined; keepOpen()
    departure.current = setTimeout(() => {
      const focused = document.activeElement
      if (focused && (region?.contains(focused) || surface.current?.contains(focused))) return
      close()
    }, 160)
  }

  useLayoutEffect(() => { close() }, [scope, enabled, close])
  useLayoutEffect(() => () => {
    clearTimeout(intent.current); clearTimeout(departure.current)
    active.current = null
  }, [])
  useLayoutEffect(() => {
    if (!enabled) return
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || (!active.current && !intent.current)) return
      event.preventDefault(); markWindowOverlayDismissal(event); close(true)
    }
    const hide = () => { if (document.visibilityState === 'hidden') close() }
    const outside = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && (active.current?.region.contains(event.target) || surface.current?.contains(event.target))) return
      close()
    }
    const scroll = (event: Event) => {
      // Selecting or scrolling long details keeps this reader; History/window scrolling dismisses it.
      if (event.target instanceof Node && surface.current?.contains(event.target)) return
      close()
    }
    const resize = () => close()
    document.addEventListener('keydown', escape)
    document.addEventListener('visibilitychange', hide)
    document.addEventListener('pointerdown', outside)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('keydown', escape)
      document.removeEventListener('visibilitychange', hide)
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', resize)
    }
  }, [enabled, close])
  useLayoutEffect(() => {
    const panel = surface.current
    if (!opened || !panel) return
    panel.style.visibility = 'hidden'
    let disposed = false
    let positioned = false
    let revision = 0
    const update = async () => {
      const request = ++revision
      const { x, y } = await computePosition(opened.anchor, panel, {
        strategy: 'fixed', placement: 'bottom-start', middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 }),
          size({ padding: 8, apply({ availableHeight }) {
            if (!disposed) panel.style.maxHeight = `${Math.max(0, Math.min(440, availableHeight))}px`
          } })]
      })
      if (disposed || request !== revision || !opened.anchor.isConnected) return
      Object.assign(panel.style, { left: `${x}px`, top: `${y}px`, visibility: 'visible' })
      if (!positioned) {
        positioned = true
        if (opened.focus && document.activeElement === opened.anchor) panel.focus({ preventScroll: true })
      }
    }
    const stop = autoUpdate(opened.anchor, panel, () => { void update() })
    return () => { disposed = true; stop() }
  }, [opened])

  function triggerEvents(commit: GitHistoryCommit, ref?: GitHistoryRef) {
    const makeTarget = (anchor: HTMLElement | SVGElement, focus = false): DetailTarget => ({
      commit, anchor, region: anchor.closest('.git-history-commit') ?? anchor, scope, focus
    })
    return {
      tabIndex: 0,
      'aria-haspopup': 'dialog' as const,
      'aria-controls': opened?.commit.oid === commit.oid ? id : undefined,
      'aria-keyshortcuts': 'Enter',
      'aria-label': ref ? `${ref.kind} reference ${ref.name}. Commit ${commit.oid.slice(0, 7)}` : `${commit.subject || '(No commit message)'}. Commit ${commit.oid.slice(0, 7)}`,
      onPointerEnter: (event: PointerEvent<HTMLElement | SVGElement>) => {
        clearTimeout(intent.current); keepOpen()
        const next = makeTarget(event.currentTarget)
        if (enabled) intent.current = setTimeout(() => show(next), 180)
      },
      onPointerLeave: (event: PointerEvent<HTMLElement | SVGElement>) => leave(event.relatedTarget, makeTarget(event.currentTarget).region),
      onFocus: (event: FocusEvent<HTMLElement | SVGElement>) => {
        if (event.target === event.currentTarget && !restoringFocus.current) show(makeTarget(event.currentTarget))
      },
      onBlur: (event: FocusEvent<HTMLElement | SVGElement>) => {
        if (event.target === event.currentTarget) leave(event.relatedTarget, makeTarget(event.currentTarget).region)
      },
      onKeyDown: (event: KeyboardEvent<HTMLElement | SVGElement>) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
        event.preventDefault(); event.stopPropagation(); show(makeTarget(event.currentTarget, true))
      }
    }
  }
  const authoredDate = opened?.commit.authoredAt === null || !opened ? null : new Date(opened.commit.authoredAt)
  const knownTime = authoredDate && Number.isFinite(authoredDate.getTime()) ? authoredDate : null
  const preview = opened ? <WindowOverlayPortal><div ref={surface} id={id} tabIndex={-1}
    className="git-history-details" role="dialog" aria-label="Commit details" data-state="open" data-history-detail-oid={opened.commit.oid}
    style={{ visibility: 'hidden' }} onPointerEnter={enterSurface}
    onPointerLeave={event => leave(event.relatedTarget, opened.region)} onFocus={enterSurface}
    onBlur={event => leave(event.relatedTarget, opened.region)}>
    <strong className="git-history-details__subject">{opened.commit.subject || '(No commit message)'}</strong>
    <code className="git-history-details__oid">{opened.commit.oid}</code>
    <dl className="git-history-details__metadata">
      <dt>Author</dt><dd>{opened.commit.author || '(Not recorded)'}</dd>
      <dt>Time</dt><dd>{knownTime ? <time dateTime={knownTime.toISOString()}>{knownTime.toLocaleString()}</time> : 'Time unknown'}</dd>
    </dl>
    <section aria-label="Commit parents"><h4>Parents · {opened.commit.parents.length}</h4>
      {opened.commit.parents.length ? <ul>{opened.commit.parents.map(parent => <li key={parent}><code>{parent}</code></li>)}</ul> : <p>Root commit · no parents</p>}
    </section>
    <section aria-label="Commit references"><h4>References · {opened.commit.refs.length}</h4>
      {opened.commit.refs.length ? <ul>{opened.commit.refs.map(ref => <li key={ref.name} className="git-history-details__ref">
        <span>{ref.kind}</span><code>{ref.name}</code><code>{ref.oid}</code>
      </li>)}</ul> : <p>No references at this commit</p>}
    </section>
  </div></WindowOverlayPortal> : null
  return { close: () => close(), triggerEvents, preview }
}
