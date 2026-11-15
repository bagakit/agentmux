import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { SUBAGENT_LABELS, type FocusNativeSubagents } from '../lib/focus-native-subagents'

const TeamIcon = semanticIconComponent('object.team')

export function AgentSubagentDetails({ subagents }: { subagents: FocusNativeSubagents }) {
  return <details className="agent-subagent-details">
    <summary><TeamIcon size={14} aria-hidden="true" /><strong>Subagents</strong><span>{subagents.summary}</span></summary>
    {subagents.coverageUnknown ? <p>Some child activity may be missing.</p> : null}
    {subagents.rows.length ? <ul aria-label="Observed subagents">
      {subagents.rows.map(child => <li key={child.id} data-subagent-id={child.id} data-subagent-state={child.state}>
        <code title={child.id}>{child.id}</code>
        <span>{child.waitingFor === 'permission' ? 'Waiting for permission' : child.waitingFor === 'question' ? 'Waiting for a reply' : SUBAGENT_LABELS[child.state]}</span>
      </li>)}
    </ul> : null}
  </details>
}
