import * as ContextMenu from '@radix-ui/react-context-menu'
import { Archive, ArchiveRestore, Shapes } from 'lucide-react'
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
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
      if (next) next()
      else {
        const node = trigger.current
        const row = node?.matches('[data-space-icon-target]') ? node : node?.querySelector<HTMLElement>('[data-space-icon-target]')
        const focusTarget = row ?? node
        focusTarget?.focus()
      }
    },
    changeIcon(callback: () => void) { openPicker.current = callback }
  }
}

/** A real object menu for Space Motes/Topics; registered Folder menus reuse the same entry. */
export function SpaceObjectContextMenu({ target, onChangeIcon, children, onMenuOpen, moteArchive, container }: {
  target: SpaceIconTarget; onChangeIcon?(target: SpaceIconTarget): void; children: ReactNode; onMenuOpen?(): void
  moteArchive?: { archived: boolean; disabled?: boolean; reason?: string; onChange(): Promise<void>; returnFocus?(): HTMLElement | null }
  container?: () => HTMLElement | null
}) {
  const menu = useSpaceObjectMenu()
  const [, setOpen] = useState(false)
  return <ContextMenu.Root onOpenChange={open => { setOpen(open); if (open) onMenuOpen?.(); menu.onOpenChange(open) }}>
    <ContextMenu.Trigger asChild {...menu.triggerProps}>{children}</ContextMenu.Trigger>
    <ContextMenu.Portal container={resolveOverlayContainer(container?.()) as HTMLElement | undefined}>
      <ContextMenu.Content className="tab-context-menu" collisionPadding={8} onCloseAutoFocus={menu.onCloseAutoFocus}>
        {onChangeIcon ? <ContextMenu.Item className="tab-context-menu__item" onSelect={() => menu.changeIcon(() => onChangeIcon(target))}>
          <Shapes size={14} /><span>{target.avatarTarget ? 'Change avatar…' : 'Change icon…'}</span>
        </ContextMenu.Item> : null}
        {moteArchive ? <ContextMenu.Item className="tab-context-menu__item" disabled={moteArchive.disabled ?? false}
          {...(moteArchive.reason ? { title: moteArchive.reason } : {})} onSelect={() => {
            const original = menu.triggerProps.ref.current
            void moteArchive.onChange().then(() => requestAnimationFrame(() => {
              // Filtering may remove the returned row after IPC acknowledgement. Only recover
              // that lost focus; a later user focus or changed local target belongs to the user.
              if (original && !original.isConnected && document.activeElement === document.body) moteArchive.returnFocus?.()?.focus()
            }))
          }}>
          {moteArchive.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          <span>{moteArchive.reason ?? (moteArchive.archived ? 'Restore Mote' : 'Archive Mote')}</span>
        </ContextMenu.Item> : null}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>
}
