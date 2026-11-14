import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/**
 * The person's own words, read as rendered Markdown. Long text is clamped to `lines` until
 * shown in full; Edit switches to the original text editor, which stays open while a draft
 * is unsaved.
 */
export function GoalIntent({ text, lines, editor, editing, onEditingChange }: { text: string; lines: number; editor: ReactNode; editing: boolean; onEditingChange(editing: boolean): void }) {
  const [expanded, setExpanded] = useState(false), [overflows, setOverflows] = useState(false)
  const reading = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = reading.current
    if (!node) return
    const measure = () => setOverflows(node.scrollHeight > node.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [text, editing, expanded])
  if (editing) return <div className="goals-intent__editor">{editor}<div className="goals-intent__actions"><button type="button" className="small-button" onClick={() => onEditingChange(false)}>Done</button></div></div>
  if (!text.trim()) return <div className="goals-intent__empty"><span className="goals-caption">No description yet.</span><button type="button" className="small-button" onClick={() => onEditingChange(true)}>Describe the outcome</button></div>
  return <div className="goals-intent">
    <div ref={reading} className={`goals-intent__reading${expanded ? '' : ' goals-intent__reading--clamped'}`} style={{ '--goals-intent-lines': lines } as React.CSSProperties} data-goal-intent-clamped={!expanded && overflows ? '' : undefined}>
      <AgentMarkdown content={text} className="goals-intent__prose" readOnly />
    </div>
    <div className="goals-intent__actions">
      {overflows || expanded ? <button type="button" className="small-button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Show less' : 'Show all'}</button> : null}
      <button type="button" className="small-button" aria-label="Edit goal description" onClick={() => onEditingChange(true)}>Edit</button>
    </div>
  </div>
}
