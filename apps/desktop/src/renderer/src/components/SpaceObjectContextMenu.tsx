import * as ContextMenu from '@radix-ui/react-context-menu'
import { Archive, ArchiveRestore, BookOpen, Maximize2, NotebookPen, Pencil, Pin, Plus, Shapes } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { SpaceIconTarget } from '../lib/space-object-appearance'
import { resolveOverlayContainer } from './WindowOverlayHost'

/** Radix handles pointer menus; these object menus also expose the standard keyboard gesture. */
export function useSpaceObjectMenu() {
  const trigger = useRef<HTMLElement | null>(null)
  const openPicker = useRef<(() => void) | null>(null)
  return {
    triggerProps: {
      ref: trigger,
      onKeyDown(event: KeyboardEvent<HTMLElement>) {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
        event.preventDefault()
        const node = event.currentTarget
        const rect = node.getBoundingClientRect()
        node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
          button: 2, clientX: rect.left + 8, clientY: rect.bottom }))
      }
    },
    onOpenChange(open: boolean) { if (open) openPicker.current = null },
    onCloseAutoFocus(event: Event) {
      event.preventDefault()
      // Hand focus to the Dialog only after the menu's focus scope closes.
      const next = openPicker.current
      openPicker.current = null
      const node = trigger.current
      const row = node?.matches('[data-space-icon-target]') ? node : node?.querySelector<HTMLElement>('[data-space-icon-target]')
      const focusTarget = row ?? node
      focusTarget?.focus()
      // The next Dialog inherits this original invoker, rather than a removed
      // menu item or body. Its focus and native-popover ancestry stay precise.
      if (next) next()
    },
    changeIcon(callback: () => void) { openPicker.current = callback }
  }
}

/** A real object menu for Space Motes/Topics; registered Folder menus reuse the same entry. */
export function SpaceObjectContextMenu({ target, onChangeIcon, children, onMenuOpen, moteArchive, moteActions, container }: {
  target: SpaceIconTarget; onChangeIcon?(target: SpaceIconTarget): void; children: ReactNode; onMenuOpen?(): void
  moteArchive?: { archived: boolean; disabled?: boolean; reason?: string; onChange(): Promise<boolean>; returnFocus?(): HTMLElement | null }
  moteActions?: { pinned: boolean; onTogglePin(): void; onEdit(): void; onRename?(): void; onNewDiscussion?(): void; onMaterials?(): void; onOpenSpace?(): void }
  container?: () => HTMLElement | null
}) {
  const menu = useSpaceObjectMenu()
  const archiveReturnFocus = useRef<(() => void) | null>(null)
  const archived = useRef(moteArchive?.archived); archived.current = moteArchive?.archived
  // IPC acknowledgement can precede the React commit that filters this row.
  useLayoutEffect(() => () => archiveReturnFocus.current?.(), [])
  useLayoutEffect(() => { archiveReturnFocus.current?.() }, [moteArchive?.archived])
  const [, setOpen] = useState(false)
  return <ContextMenu.Root onOpenChange={open => { setOpen(open); if (open) onMenuOpen?.(); menu.onOpenChange(open) }}>
    <ContextMenu.Trigger asChild {...menu.triggerProps}>{children}</ContextMenu.Trigger>
    <ContextMenu.Portal container={resolveOverlayContainer(container?.()) as HTMLElement | undefined}>
      <ContextMenu.Content className="tab-context-menu" collisionPadding={8} onCloseAutoFocus={event => {
        menu.onCloseAutoFocus(event); archiveReturnFocus.current?.()
      }}>
        {moteActions?.onRename ? <ContextMenu.Item className="tab-context-menu__item" onSelect={() => menu.changeIcon(moteActions.onRename!)}><Pencil size={14} /><span>Rename Mote…</span></ContextMenu.Item> : null}
        {onChangeIcon ? <ContextMenu.Item className="tab-context-menu__item" onSelect={() => menu.changeIcon(() => onChangeIcon(target))}>
          <Shapes size={14} /><span>{target.avatarTarget ? 'Change avatar…' : 'Change icon…'}</span>
        </ContextMenu.Item> : null}
        {moteActions ? <>
          <ContextMenu.Item className="tab-context-menu__item" onSelect={() => menu.changeIcon(moteActions.onEdit)}>
            <NotebookPen size={14} /><span>Edit persona</span>
          </ContextMenu.Item>
          {moteActions.onNewDiscussion || moteActions.onMaterials || moteActions.onOpenSpace ? <ContextMenu.Separator className="tab-context-menu__separator" /> : null}
          {moteActions.onNewDiscussion ? <ContextMenu.Item className="tab-context-menu__item" onSelect={() => menu.changeIcon(moteActions.onNewDiscussion!)}><Plus size={14} /><span>New discussion</span></ContextMenu.Item> : null}
          {moteActions.onMaterials ? <ContextMenu.Item className="tab-context-menu__item" onSelect={() => menu.changeIcon(moteActions.onMaterials!)}><BookOpen size={14} /><span>Open materials</span></ContextMenu.Item> : null}
          {moteActions.onOpenSpace ? <ContextMenu.Item className="tab-context-menu__item" onSelect={() => menu.changeIcon(moteActions.onOpenSpace!)}><Maximize2 size={14} /><span>Open in Space</span></ContextMenu.Item> : null}
          <ContextMenu.Separator className="tab-context-menu__separator" />
          <ContextMenu.Item className="tab-context-menu__item" onSelect={moteActions.onTogglePin}>
            <Pin size={14} /><span>{moteActions.pinned ? 'Unpin Mote' : 'Pin Mote'}</span>
          </ContextMenu.Item>
        </> : null}
        {moteArchive ? <ContextMenu.Item className="tab-context-menu__item" disabled={moteArchive.disabled ?? false}
          {...(moteArchive.reason ? { title: moteArchive.reason } : {})} onSelect={() => {
            const original = menu.triggerProps.ref.current
            const content = document.activeElement?.closest('[role="menu"]'), scope = container?.() ?? null
            let acknowledged = false, relinquished = false
            let frame: number | null = null
            let readiness: MutationObserver | null = null
            const relinquish = () => {
              relinquished = true
              if (frame !== null) cancelAnimationFrame(frame)
              readiness?.disconnect()
              document.removeEventListener('focusin', onFocus, true)
              document.removeEventListener('pointerdown', relinquish, true)
              document.removeEventListener('keydown', relinquish, true)
              if (archiveReturnFocus.current === recover) archiveReturnFocus.current = null
            }
            const onFocus = (event: FocusEvent) => {
              const node = event.target
              if (node === original || node === scope || node === document.body || node instanceof Node && content?.contains(node)) return
              relinquish()
            }
            const recover = () => {
              if (frame !== null || relinquished) return
              frame = requestAnimationFrame(() => {
                frame = null
                if (!acknowledged || relinquished) return
                if (!original || original.isConnected) {
                  // Show archived keeps the same row. Its confirmed commit
                  // completes the action without transferring focus.
                  if (!original || archived.current !== moteArchive.archived) relinquish()
                  return
                }
                // Chromium can hand lost popover focus to its own container. A
                // newer input or navigation has already cancelled this return.
                if (document.activeElement === document.body || document.activeElement === scope) {
                  const next = moteArchive.returnFocus?.()
                  if (next instanceof HTMLButtonElement && next.disabled) {
                    // The action's pending flag can commit after the filtered
                    // row. Observe this one control, then recheck all guards.
                    if (!readiness) {
                      readiness = new MutationObserver(recover)
                      readiness.observe(next, { attributes: true, attributeFilter: ['disabled'] })
                    }
                    return
                  }
                  next?.focus({ preventScroll: true })
                }
                relinquish()
              })
            }
            archiveReturnFocus.current = recover
            document.addEventListener('focusin', onFocus, true)
            document.addEventListener('pointerdown', relinquish, true)
            document.addEventListener('keydown', relinquish, true)
            void moteArchive.onChange().then(confirmed => {
              if (!confirmed) { relinquish(); return }
              acknowledged = true; recover()
            }, relinquish)
          }}>
          {moteArchive.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          <span>{moteArchive.reason ?? (moteArchive.archived ? 'Restore Mote' : 'Archive Mote')}</span>
        </ContextMenu.Item> : null}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>
}
