import * as Dialog from '@radix-ui/react-dialog'
import { Contact, X } from 'lucide-react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import { useMoteWorkfaceScope, type MoteWorkfaceScope } from '../lib/mote-workface'
import { useMoteMaterialsActions } from '../lib/mote-materials-actions'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { MoteDetailsPanel } from './MoteDetailsPanel'
import { resolveOverlayContainer } from './WindowOverlayHost'

/** The same Profile, opened from the Tab row without moving its original input tree. */
export function MoteProfilePopover({ workspaceId, topicId, reference, active, onReferenceSelect, children }: {
  workspaceId: string; topicId: string; reference?: WorkbenchProjectionSelection | null | undefined; active: boolean
  onReferenceSelect(topicId: string, reference: WorkbenchProjectionSelection): void
  children(trigger: ReactNode): ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [owner, setOwner] = useState({ workspaceId, topicId, reference })
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [content, setContent] = useState<HTMLDivElement | null>(null)
  const surface = useRef<HTMLDivElement>(null)
  const attach = useCallback((node: HTMLDivElement | null) => { surface.current = node; setContent(node) }, [])
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
  useLayoutEffect(() => {
    if (!open || !anchor || !content) return
    const invoker = anchor
    let current = true
    const position = async () => {
      const result = await computePosition(invoker, content, { strategy: 'fixed', placement: 'bottom-end',
        middleware: [offset(6), flip(), shift({ padding: 12 }), size({ padding: 12, apply: ({ availableHeight, availableWidth }) => {
          if (current) Object.assign(content.style, { maxHeight: Math.max(0, availableHeight) + 'px', maxWidth: Math.max(0, availableWidth) + 'px' })
        } })] })
      if (current) Object.assign(content.style, { left: result.x + 'px', top: result.y + 'px', visibility: 'visible' })
    }
    const release = autoUpdate(invoker, content, () => { void position() })
    return () => { current = false; release() }
  }, [open, anchor, content])
  return <Dialog.Root modal={false} open={open && active} onOpenChange={next => {
    if (next) { retained.current = null; setOwner({ workspaceId, topicId, reference }) }
    setOpen(next)
  }}>
    {children(<Dialog.Trigger asChild><button ref={setAnchor} type="button" className="pane-action mote-profile-trigger" aria-label="Show Mote profile"
      aria-pressed={open && active} title="Mote profile"><Contact size={14} /></button></Dialog.Trigger>)}
    <Dialog.Portal container={resolveOverlayContainer()}>
      <Dialog.Content ref={attach} className="mote-profile-popover" style={{ visibility: 'hidden' }}
        onOpenAutoFocus={event => { event.preventDefault(); surface.current?.focus({ preventScroll: true }) }}>
        <Dialog.Title hidden>Mote profile</Dialog.Title>
        <Dialog.Description hidden>Identity, behavior, current work and ideas for the selected Mote.</Dialog.Description>
        <Dialog.Close className="icon-button mote-profile-popover__close" aria-label="Close Mote profile" title="Close profile"><X size={14} /></Dialog.Close>
        {scope?.issue ? <p role="status" className="mote-details__hint">{scope.issue}</p> : null}
        {scope ? <MoteDetailsPanel key={owner.topicId} scope={scope} reference={owner.reference} active={active && open && !scope.issue}
          onOpenPath={materials.open} />
          : <p role="status" className="mote-details__hint">The original Mote profile is being read. Your conversation stays available.</p>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
