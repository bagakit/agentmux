import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import '../styles/mote-conversation-browser.css'

const Back = semanticIconComponent('navigation.back')

export type MoteConversationChoice = {
  id: string
  title: string
  row: ReactNode
  actions?: ReactNode
  conversation(active: boolean): ReactNode
}

/** Presentation only. Each source owns its identity and original Reader. Visited
 * panes keep their reading position; only the visible pane observes its source. */
export function MoteConversationBrowser({ choices, active, heading, footer, empty, initialSelection }: {
  choices: readonly MoteConversationChoice[]; active: boolean; initialSelection?: string | undefined; heading?: ReactNode; footer?: ReactNode; empty?: ReactNode
}) {
  const root = useRef<HTMLDivElement>(null), detailId = useId()
  const [wide, setWide] = useState(false), [detailOpen, setDetailOpen] = useState(false)
  const [selected, setSelected] = useState<{ id: string; explicit: boolean } | null>(null), [visited, setVisited] = useState<Set<string>>(() => new Set())
  const fallback = active ? initialSelection ?? choices[0]?.id ?? null : null
  const current = selected && (selected.explicit || !fallback || choices.some(choice => choice.id === selected.id)) ? selected.id : fallback
  const retained = useRef<MoteConversationChoice | null>(null)
  const selectedChoice = choices.find(choice => choice.id === current)
  if (selectedChoice) retained.current = selectedChoice
  const panes = choices.filter(choice => choice.id === current || visited.has(choice.id))
  if (!selectedChoice && retained.current?.id === current) panes.push(retained.current)
  useEffect(() => {
    if (active && current && selected?.id !== current) setSelected({ id: current, explicit: false })
    if (current) setVisited(previous => previous.has(current) ? previous : new Set(previous).add(current))
  }, [active, selected?.id, current])
  useEffect(() => {
    const node = root.current
    if (!active || !node) return
    const measure = () => setWide(node.getBoundingClientRect().width >= 640)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [active])
  const open = (id: string) => { setSelected({ id, explicit: true }); setVisited(previous => new Set(previous).add(id)); setDetailOpen(true); if (!wide) requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('.mote-conversation-browser__pane:not([hidden]) [aria-label="返回对话列表"]')?.focus({ preventScroll: true })) }
  const showDetail = wide || detailOpen
  return <div ref={root} className="mote-conversation-browser" data-layout={wide ? 'split' : 'stack'} data-detail-open={detailOpen || undefined}>
    <aside className="mote-conversation-browser__list" hidden={!wide && detailOpen} aria-label="对话列表">
      {heading}
      <ol>{choices.map(choice => <li key={choice.id}>
        <button type="button" className="mote-conversation-browser__choice" data-mote-conversation-choice={choice.id}
          aria-label={`阅读 ${choice.title}`} aria-current={choice.id === current ? 'page' : undefined} aria-controls={detailId} onClick={() => open(choice.id)}>{choice.row}</button>
      </li>)}</ol>
      {!choices.length ? empty : null}
      {footer}
    </aside>
    <div id={detailId} className="mote-conversation-browser__detail" hidden={!showDetail}>
      {panes.map(choice => <section key={choice.id}
        className="mote-conversation-browser__pane" data-mote-conversation-pane={choice.id} hidden={choice.id !== current}>
        <header className="mote-conversation-browser__heading">
          {!wide ? <button type="button" className="icon-button" aria-label="返回对话列表" onClick={() => { setDetailOpen(false); requestAnimationFrame(() => [...root.current?.querySelectorAll<HTMLButtonElement>('[data-mote-conversation-choice]') ?? []].find(button => button.dataset.moteConversationChoice === current)?.focus({ preventScroll: true })) }}><Back size={16} /></button> : null}
          <strong title={choice.title}>{choice.title}</strong>{choice.actions}
        </header>
        <div className="mote-conversation-browser__reading">{!selectedChoice && choice.id === current ? <p role="status" className="mote-conversation__issue">原列表来源暂未确认，所选原对话保留。</p> : null}{choice.conversation(active && showDetail && choice.id === current)}</div>
      </section>)}
      {!choices.length ? empty : null}
    </div>
  </div>
}
