import { useState, type ReactNode } from 'react'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import { SegmentedControl } from '@agentmux/client-ui/components/SegmentedControl'

const views = [
  { value: 'preview', label: 'Preview' },
  { value: 'source', label: 'Source' },
  { value: 'execution', label: 'Execution details' }
] as const

/** All views read the same saved operation. Only parse a request when someone opens it. */
export function GoalRequestReader({ text, unavailable, details, children }: {
  text?: string | undefined; unavailable?: string | undefined; details: ReactNode; children?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<typeof views[number]['value']>('preview')
  return <details className="goal-delegation__source goal-request-reader" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Original request</summary>
    {open ? <div className="goal-request-reader__surface">
      {text !== undefined ? <SegmentedControl aria-label="Request view" className="goal-request-reader__switch" options={views} value={view} onValueChange={setView} /> : null}
      {text === undefined ? <p className="goals-muted">{unavailable}</p> : null}
      {text === undefined || view === 'execution' ? <div className="goal-request-reader__details">{details}</div>
        : view === 'source' ? <pre className="goal-request-reader__raw">{text}</pre>
        : <AgentMarkdown content={text} documentMode readOnly className="goal-request-reader__document" />}
      {children}
    </div> : null}
  </details>
}
