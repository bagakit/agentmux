import { useState } from 'react'
import { AGENT_EXECUTION_GUIDE } from '@agentmux/core/agent-execution-guide'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'

/** One Core-owned guide, read locally without opening resources or starting work. */
export function RemoteExecutionGuide({ active }: { active: boolean }) {
  const [open, setOpen] = useState(false)
  return <details className="remote-execution-guide" data-settings-field="guide" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Step-by-step guide <span>Space · choose both environments · continue work</span></summary>
    {open && active ? <div className="remote-execution-guide__body"><AgentMarkdown content={AGENT_EXECUTION_GUIDE} documentMode readOnly visible /></div> : null}
  </details>
}
