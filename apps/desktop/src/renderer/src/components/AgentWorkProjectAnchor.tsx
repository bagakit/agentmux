import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { WorkspaceRecord } from '../../../shared/contracts'

const ProjectIcon = semanticIconComponent('object.folder')
const DownIcon = semanticIconComponent('navigation.down')

/** Read-only project identity; the anchored editor discloses the complete path on demand. */
export function AgentWorkProjectAnchor({ project, hostLabel, compact = false, showIcon = false }: {
  project: WorkspaceRecord | undefined
  hostLabel: string | undefined
  compact?: boolean
  showIcon?: boolean
}) {
  if (!project) return <div className="agent-work-project-anchor" data-unavailable="true"><div>
    <strong>Original project unavailable</strong><span>{hostLabel}</span>
  </div></div>
  if (!compact) return <div className="agent-work-project-anchor">{showIcon ? <ProjectIcon size={17} aria-hidden="true" /> : null}<div>
    <strong>{project.name}</strong><span>{hostLabel}</span><code>{project.path}</code>
  </div></div>
  return <details className="agent-work-project-anchor">
    <summary><ProjectIcon size={16} aria-hidden="true" /><span className="agent-work-project-anchor__identity"><strong>{project.name}</strong><span>{hostLabel}</span></span><DownIcon className="agent-work-project-anchor__chevron" size={12} aria-hidden="true" /></summary>
    <code className="agent-work-project-anchor__path">{project.path}</code>
  </details>
}
