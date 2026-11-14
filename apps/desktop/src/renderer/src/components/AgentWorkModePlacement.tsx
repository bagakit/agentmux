import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AgentWorkMode } from '../lib/agent-work-mode'

const AgentIcon = semanticIconComponent('object.agent')
const ProjectIcon = semanticIconComponent('object.folder')

/** Static role locations explain a choice; the original placement projection owns live addresses. */
export function AgentWorkModePlacement({ mode, referenceLabel = 'Here', otherLabel = 'Remote' }: {
  mode: AgentWorkMode; referenceLabel?: string; otherLabel?: string
}) {
  const agent = mode === 'local' || mode === 'remote-project' ? 'here' : 'remote'
  const project = mode === 'local' || mode === 'remote-agent' ? 'here' : 'remote'
  return <span className="agent-work-mode-placement" aria-hidden="true">
    {(['here', 'remote'] as const).map(location => <span className="agent-work-mode-placement__zone" key={location}>
      <span className="agent-work-mode-placement__roles" data-placement-zone={location}>
        {agent === location ? <AgentIcon size={12} data-placement-role="agent" /> : null}
        {project === location ? <ProjectIcon size={12} data-placement-role="project" /> : null}
        {agent !== location && project !== location ? <i /> : null}
      </span><small>{location === 'here' ? referenceLabel : otherLabel}</small>
    </span>)}
  </span>
}
