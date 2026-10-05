import { mintObjectId } from '@agentmux/core/object-id'
import { TextInput } from '@agentmux/client-ui/input'
import * as Dialog from '@radix-ui/react-dialog'
import { Link2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { AgentMuxProjectGroupFact } from '@agentmux/core/control'
import type { GitProjectIdentityResult } from '../../../shared/git-contracts'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useAppStore } from '../store'
import { projectGroupsFor, projectGroupMember } from '../lib/cross-device-project-groups'
import { usePathDisplay } from '../hooks/usePathDisplay'
import type { WorkspaceProject } from '../lib/workspace-projects'
import { resolveOverlayContainer } from './WindowOverlayHost'

export function ProjectGroupDialog({ projects, seed, editing, related, observations, onClose }: {
  projects: readonly WorkspaceProject[]
  seed?: string | undefined
  editing?: AgentMuxProjectGroupFact | undefined
  related: ReadonlyMap<string, string[]>
  observations: ReadonlyMap<string, GitProjectIdentityResult>
  onClose(): void
}) {
  const groups = useAppStore(state => state.projectGroups)
  const hosts = useAppStore(state => state.config?.hosts)
  const save = useAppStore(state => state.saveProjectGroup)
  const selectWorkspace = useAppStore(state => state.selectWorkspace)
  const displayPath = usePathDisplay()
  const [groupId] = useState(() => editing?.groupId ?? mintObjectId())
  const [name, setName] = useState(editing?.name ?? projects.find(project => project.id === seed)?.name ?? '')
  const [selected, setSelected] = useState(editing?.projectIds ?? (seed ? [seed] : []))
  const [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState<string | null>(null)
  const suggested = new Set(seed ? related.get(seed) ?? [] : [])
  const members = useMemo(() => [...new Set([...projects.map(project => project.id), ...editing?.projectIds ?? []])]
    .sort((a, b) => Number(suggested.has(b)) - Number(suggested.has(a)))
    .map(id => ({ id, ...projectGroupMember(id, projects) })), [projects, editing, seed, related])
  async function submit() {
    setBusy(true); setIssue(null)
    try {
      const result = await save({ groupId, name, projectIds: selected })
      if (result.diskDurability !== 'confirmed') { setIssue(`Group applied. Saving is unconfirmed: ${result.reason ?? 'The Core save acknowledgement is unavailable.'} Retry saving this same group.`); return }
      if (!editing) {
        const member = projects.find(project => selected.includes(project.id))
        if (member) await selectWorkspace(member.preferredWorkspaceId)
      }
      onClose()
    } catch (error) { setIssue(presentError(error)) }
    finally { setBusy(false) }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <Dialog.Portal container={resolveOverlayContainer()}>
      <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content className="confirmation-dialog dialog-surface project-group-dialog" aria-busy={busy}
        onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onInteractOutside={event => { if (busy) event.preventDefault() }}>
        <header className="confirmation-dialog__heading"><Link2 size={15} /><Dialog.Title className="confirmation-dialog__title">{editing ? 'Edit project group' : 'Create project group'}</Dialog.Title>
          <Dialog.Close className="icon-button" disabled={busy} aria-label="Close project group editor"><X size={14} /></Dialog.Close></header>
        <Dialog.Description className="confirmation-dialog__description">Organize projects together. Files and sessions stay on their devices.</Dialog.Description>
        <form onSubmit={event => { event.preventDefault(); void submit() }}>
          <label className="project-group-dialog__name">Group name<TextInput autoFocus value={name} disabled={busy} onChange={event => setName(event.target.value)} placeholder="Group name" /></label>
          <div className="project-group-dialog__members" aria-label="Choose group members">
            {members.map(member => {
              const memberships = projectGroupsFor(groups, member.id).filter(group => group.groupId !== groupId)
              const hostLabel = hosts?.find(host => host.id === member.hostId)?.label ?? member.hostId ?? 'Device unconfirmed'
              const observation = observations.get(member.id)
              const note = memberships.length ? `Also in ${memberships.map(group => group.name).join(', ')}` : !member.project ? 'Registration unavailable · original member retained' : suggested.has(member.id) ? 'Related Git project' : observation?.kind === 'unavailable' ? 'Git association unconfirmed' : undefined
              return <label key={member.id} className="project-group-dialog__member" title={`${member.name}\n${hostLabel}\n${member.path}`}>
                <input type="checkbox" checked={selected.includes(member.id)} disabled={busy}
                  onChange={event => setSelected(previous => event.target.checked ? [...previous, member.id] : previous.filter(id => id !== member.id))} />
                <span><strong>{member.name}</strong><small>{hostLabel} · {displayPath(member.path, member.hostId ?? undefined)}</small>{note ? <small className="project-group-dialog__note">{note}</small> : null}</span>
              </label>
            })}
          </div>
          {projects.length === 0 ? <p>No registered Projects. Open Folders first.</p> : null}
          {issue ? <p role="alert" className="project-group-dialog__issue">{issue}</p> : null}
          <footer><button type="button" className="small-button" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="submit" className="small-button confirmation-dialog__confirm--neutral" disabled={busy}>{busy ? 'Saving…' : issue?.startsWith('Group applied.') ? 'Retry saving' : editing ? 'Save group' : 'Create group'}</button></footer>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
