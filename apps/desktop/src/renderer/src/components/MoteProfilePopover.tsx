import * as Dialog from '@agentmux/client-ui/components/Modal'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMoteWorkfaceScope, type MoteWorkfaceScope } from '../lib/mote-workface'
import { useMoteMaterialsActions } from '../lib/mote-materials-actions'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { MoteDetailsPanel } from './MoteDetailsPanel'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { SpaceContentPresentationContext } from '../lib/space-content-presentation'

const ThemeObjectContactIcon = semanticIconComponent('object.contact')
const ThemeActionCloseIcon = semanticIconComponent('action.close')


/** The same Profile is accessible from the header and roster without moving the conversation. */
export function MoteProfilePopover({ workspaceId, topicId, reference, active, onReferenceSelect, children, avatar }: {
  workspaceId: string; topicId: string; reference?: WorkbenchProjectionSelection | null | undefined; active: boolean
  onReferenceSelect(topicId: string, reference: WorkbenchProjectionSelection): void
  children?(trigger: ReactNode): ReactNode
  avatar?: { label: string; content: ReactNode }
}) {
  const [open, setOpen] = useState(false)
  const [owner, setOwner] = useState({ workspaceId, topicId, reference })
  const surface = useRef<HTMLDivElement>(null)
  const resolved = useMoteWorkfaceScope(owner.workspaceId, owner.topicId, active && open)
  const retained = useRef<MoteWorkfaceScope | null>(null)
  const scope = useMemo(() => {
    const held = retained.current
    if (held && (!resolved || resolved.workspace.hostId !== held.workspace.hostId || resolved.workspace.path !== held.workspace.path ||
      resolved.topic.directoryPath !== held.topic.directoryPath || resolved.rootPath !== held.rootPath))
      return { ...held, issue: 'The original Profile resource changed. Its open editors and drafts are kept; close this Profile and reopen to inspect the new resource.' }
    if (resolved) retained.current = resolved
    return resolved
  }, [resolved, owner])
  const materials = useMoteMaterialsActions(scope, { floating: true, reference: owner.reference,
    onReferenceSelect: reference => onReferenceSelect(owner.topicId, reference) })
  useLayoutEffect(() => { if (!active) setOpen(false) }, [active])
  const label = avatar ? 'Open profile for ' + avatar.label : 'Show Mote profile'
  const trigger = <Dialog.Trigger asChild><button type="button"
    className={avatar ? 'mote-chooser__profile' : 'pane-action mote-profile-trigger'}
    aria-label={label} aria-pressed={open && active} title={avatar ? undefined : 'Mote profile'}>
    {avatar ? <>{avatar.content}<ThemeObjectContactIcon className="mote-chooser__profile-glyph" size={11} aria-hidden /></> : <ThemeObjectContactIcon size={14} />}
  </button></Dialog.Trigger>
  return <Dialog.Root modal={false} open={open && active} onOpenChange={next => {
    if (next) { retained.current = null; setOwner({ workspaceId, topicId, reference }) }
    setOpen(next)
  }}>
    {children ? children(trigger) : trigger}
    <DocumentOverlayPortal component={Dialog.Portal}>
      <Dialog.Content ref={surface} className="mote-profile-popover"
        onOpenAutoFocus={event => { event.preventDefault(); surface.current?.focus({ preventScroll: true }) }}>
        <Dialog.Title hidden>Mote profile</Dialog.Title>
        <Dialog.Description hidden>Identity, behavior, current work and ideas for the selected Mote.</Dialog.Description>
        <Dialog.Close className="icon-button mote-profile-popover__close" aria-label="Close Mote profile" title="Close profile"><ThemeActionCloseIcon size={14} /></Dialog.Close>
        {scope?.issue ? <p role="status" className="mote-details__hint">{scope.issue}</p> : null}
        {scope ? <SpaceContentPresentationContext.Provider value={null}><MoteDetailsPanel key={owner.topicId} scope={scope} reference={owner.reference} active={active && open && !scope.issue}
          onOpenPath={materials.open} /></SpaceContentPresentationContext.Provider>
          : <p role="status" className="mote-details__hint">The original Mote profile is being read. Your conversation stays available.</p>}
      </Dialog.Content>
    </DocumentOverlayPortal>
  </Dialog.Root>
}
