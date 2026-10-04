import { TextInput } from '@agentmux/client-ui/input'
import { Check, Folder, Plus } from 'lucide-react'
import { useState } from 'react'
import { usePathDisplay } from '../hooks/usePathDisplay'
import type { HostConfig, WorkspaceRecord } from '../../../shared/contracts'

/** Browsing a machine is local to the disclosure; only an exact project selects execution. */
export function LauncherExecutionPicker({ hosts, workspaces, selected, disabled, onSelect, onManageProjects }: {
  hosts: readonly HostConfig[]
  workspaces: readonly WorkspaceRecord[]
  selected: WorkspaceRecord | undefined
  disabled: boolean
  onSelect(workspaceId: string): void
  onManageProjects(): void
}) {
  const displayPath = usePathDisplay()
  const [hostId, setHostId] = useState(selected?.hostId ?? hosts[0]?.id ?? '')
  const [filter, setFilter] = useState('')
  const projects = workspaces.filter(project => project.hostId === hostId &&
    `${project.name} ${project.path}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
  return <section className="launcher-target" aria-label="Execution target">
    <label className="launcher-target__machine"><span>Machine</span><select aria-label="Machine for new session" value={hostId}
      onChange={event => { setHostId(event.target.value); setFilter('') }}>
      {!hosts.some(host => host.id === hostId) ? <option value={hostId}>Host not configured</option> : null}
      {hosts.map(host => <option key={host.id} value={host.id}>{host.label} · {host.kind === 'local' ? 'Local' : 'Remote'}</option>)}
    </select></label>
    <TextInput type="search" className="launcher-target__filter" aria-label="Find a project on this machine"
      placeholder="Find a project…" value={filter} onChange={event => setFilter(event.target.value)} />
    <div className="launcher-target__projects" aria-label="Registered projects">
      {projects.map(project => <button key={project.id} type="button" className="launcher-target__project"
        data-workspace-id={project.id} aria-pressed={project.id === selected?.id} disabled={disabled}
        onClick={() => onSelect(project.id)} title={`${project.name}\n${displayPath(project.path, project.hostId)}`}>
        <Folder size={14} aria-hidden="true" /><span><strong>{project.name}</strong><small>{displayPath(project.path, project.hostId)}</small></span>
        {project.id === selected?.id ? <Check size={14} aria-label="Selected project" /> : null}
      </button>)}
      {projects.length === 0 ? <p role="status">{workspaces.some(project => project.hostId === hostId)
        ? 'No matching projects.' : 'No project registered on this machine yet.'}</p> : null}
    </div>
    <button type="button" className="launcher-target__manage" onClick={onManageProjects}><Plus size={13} />Manage projects</button>
  </section>
}
