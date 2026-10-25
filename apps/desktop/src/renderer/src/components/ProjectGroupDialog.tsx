import { mintObjectId } from '@agentmux/core/object-id'
import { TextInput } from '@agentmux/client-ui/input'
import { Button } from '@agentmux/client-ui/components/Button'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { useMemo, useRef, useState } from 'react'
import { useWorkbenchDocument } from '../lib/workbench-document'
import type { AgentMuxProjectGroupFact } from '@agentmux/core/control'
import type { GitProjectIdentityResult } from '../../../shared/git-contracts'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useAppStore } from '../store'
import { projectGroupsFor, projectGroupMember } from '../lib/cross-device-project-groups'
import { usePathDisplay } from '../hooks/usePathDisplay'
import type { WorkspaceProject } from '../lib/workspace-projects'
import { DocumentOverlayPortal } from './WindowOverlayHost'

const ThemeObjectLinkIcon = semanticIconComponent('object.link')
const ThemeActionCloseIcon = semanticIconComponent('action.close')


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
  // A thrown save failure and an applied save whose durability is unconfirmed are different facts.
  const [failure, setFailure] = useState<string | null>(null)
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null)
  const ownerDocument = useWorkbenchDocument()
  // Capture before the mounted input takes autofocus; the opening callback is already too late.
  const opener = useRef(ownerDocument.activeElement as HTMLElement | null), content = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null)
  const suggested = new Set(seed ? related.get(seed) ?? [] : [])
  const members = useMemo(() => [...new Set([...projects.map(project => project.id), ...editing?.projectIds ?? []])]
    .sort((a, b) => Number(suggested.has(b)) - Number(suggested.has(a)))
    .map(id => ({ id, ...projectGroupMember(id, projects) })), [projects, editing, seed, related])
  async function submit() {
    setBusy(true); setFailure(null)
    try {
      const result = await save({ groupId, name, projectIds: selected })
      if (result.diskDurability !== 'confirmed') { setUnconfirmed(`Group applied. Saving is unconfirmed: ${result.reason ?? 'The Core save acknowledgement is unavailable.'} Retry saving this same group.`); return }
      setUnconfirmed(null)
      if (!editing) {
        const member = projects.find(project => selected.includes(project.id))
        if (member) await selectWorkspace(member.preferredWorkspaceId)
      }
      onClose()
    } catch (error) { setFailure(presentError(error)) }
    finally { setBusy(false) }
  }
  return <Dialog.Root recoveryCloseDisabled={busy} open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DocumentOverlayPortal component={Dialog.Portal}>
      <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content ref={content} className="confirmation-dialog dialog-surface project-group-dialog" aria-busy={busy}
        onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus() }}
        onCloseAutoFocus={event => { event.preventDefault(); const original = opener.current, active = ownerDocument.activeElement
          if (original?.isConnected && (active === ownerDocument.body || active === original || !active?.isConnected || content.current?.contains(active))) original.focus({ preventScroll: true }) }}
        onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onInteractOutside={event => { if (busy) event.preventDefault() }}>
        <header className="confirmation-dialog__heading"><ThemeObjectLinkIcon size={15} /><Dialog.Title className="confirmation-dialog__title">{editing ? 'Edit project group' : 'Create project group'}</Dialog.Title>
          <Dialog.Close className="icon-button" disabled={busy} aria-label="Close project group editor" title="Close project group editor"><ThemeActionCloseIcon size={14} /></Dialog.Close></header>
        <Dialog.Description className="confirmation-dialog__description">Organize projects together. Files and sessions stay on their devices.</Dialog.Description>
        <form onSubmit={event => { event.preventDefault(); void submit() }} onKeyDown={event => { if (event.key === 'Enter' && isImeOwnedKeyboardEvent(event.nativeEvent)) event.preventDefault() }}>
          <label className="confirmation-dialog__field project-group-dialog__name">Group name<TextInput ref={input} value={name} disabled={busy} onChange={event => setName(event.target.value)} placeholder="Group name" /></label>
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
          {unconfirmed ? <p role="status" className="project-group-dialog__unconfirmed">{unconfirmed}</p> : null}
          {failure ? <p role="alert" className="surface-inline-error">{failure}</p> : null}
          <footer><Button className="confirmation-dialog__cancel" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : unconfirmed ? 'Retry saving' : editing ? 'Save group' : 'Create group'}</Button></footer>
        </form>
      </Dialog.Content>
    </DocumentOverlayPortal>
  </Dialog.Root>
}
