import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ConversationBodyWork } from '../lib/conversation-body-work.js'
import { ReadingFindBodies } from '../lib/reading-find-body.js'
import { ConversationReadingCommit } from './ConversationReadingCommit.js'

export const ConversationBodyWorkContext = createContext<{ work: ConversationBodyWork; active: boolean } | null>(null)

/** Small prose is immediate; large text, fenced code and resources need first-mount scheduling. */
export function needsProgressiveText(text: string): boolean {
  return text.length > 2000 || /```|~~~|!\[|\$\$/.test(text)
}

export function ConversationProgressiveBody({ heavy, reveal = false, reading, children }: {
  heavy: boolean; reveal?: boolean; reading?: () => readonly string[]; children: ReactNode
}) {
  const scope = useContext(ConversationBodyWorkContext)
  const find = useContext(ReadingFindBodies)
  const version = useMemo(() => ({}), [reading])
  const work = scope?.work, active = scope?.active !== false
  const node = useRef<HTMLDivElement>(null)
  const observed = useRef<HTMLElement | null>(null)
  const [mounted, setMounted] = useState(!work || !heavy)
  const committed = useRef(mounted)
  const focusBody = useRef(false)
  const show = () => {
    if (!active) return
    focusBody.current = Boolean(node.current?.contains(node.current.ownerDocument.activeElement))
    setMounted(true)
  }
  useLayoutEffect(() => {
    if (!active || !reading || !node.current || !heavy) return
    return find?.register({ node: node.current, version, presented: mounted, read: reading, reveal: show })
  }, [find, active, reading, heavy, mounted, version])
  useLayoutEffect(() => {
    if (!mounted && reveal && active) show()
    if (mounted && !committed.current && node.current) {
      committed.current = true
      work?.committed(observed.current ?? node.current)
      if (focusBody.current) {
        const focusable = node.current.querySelector<HTMLElement>('[tabindex], summary, button, a[href]')
        const target = focusable ?? node.current.firstElementChild as HTMLElement | null
        if (target) { if (!focusable) target.tabIndex = -1; target.focus({ preventScroll: true }) }
        focusBody.current = false
      }
    }
  }, [mounted, reveal, active, work])
  useLayoutEffect(() => {
    if (mounted || !work || !node.current) return
    const target = node.current.firstElementChild as HTMLElement | null
    if (!target) return
    observed.current = target
    return work.register(target, () => setMounted(true))
  }, [mounted, work])
  if (!work) return children
  const body = <div ref={node} className="conversation-progressive-body" data-conversation-body-presented={mounted}>
    {mounted ? children : <div className="log-turn__body conversation-progressive-body__placeholder"><button type="button" onClick={show}>显示正文</button></div>}
  </div>
  return work ? <ConversationReadingCommit work={work} preserve={active && mounted && !committed.current}>{body}</ConversationReadingCommit> : body
}
