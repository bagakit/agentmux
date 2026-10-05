import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { HostConfig, WorkspaceRecord } from '../../../../shared/contracts'

const ThemeObjectFolderOpenIcon = semanticIconComponent('object.folder-open')


/** Published workspace references, not a second project editor or an execution target. */
export function HostLinkedProjects({ host, projects }: { host: HostConfig; projects: WorkspaceRecord[] }) {
  return <section className="settings-host-projects" aria-label={`Projects registered on ${host.label}`}>
    <header><strong>Linked projects</strong><small>{projects.length} saved registration{projects.length === 1 ? '' : 's'}</small></header>
    <p className="settings-group-note">Projects registered on this environment. Manage their configuration in Workspaces.</p>
    {projects.length ? <ul>{projects.map((project) => <li key={project.id}>
      <ThemeObjectFolderOpenIcon size={16} aria-hidden="true" />
      <div><strong>{project.name}</strong><code>{project.path}</code></div>
    </li>)}</ul> : <div className="settings-resource-editor__empty"><ThemeObjectFolderOpenIcon size={24} aria-hidden="true" />
      <strong>No linked projects</strong><p>Add a workspace with this environment to see it here.</p></div>}
  </section>
}
