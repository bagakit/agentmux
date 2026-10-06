import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useEffect, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { resolveOverlayContainer } from '../WindowOverlayHost'

const DownIcon = semanticIconComponent('navigation.down')

/** The host provides file actions; this menu only presents them. */
export function AnnotationOriginalMenu({ active, busy, loaded, onOpen, onSave }: {
  active: boolean; busy: boolean; loaded: boolean
  onOpen?: (() => void) | undefined
  onSave?: (() => void) | undefined
}) {
  const [open, setOpen] = useState(false), selectedAction = useRef(false)
  useEffect(() => { if (!active) setOpen(false) }, [active])
  if (!onOpen && !onSave) return null
  return <DropdownMenu.Root modal={false} open={active && open} onOpenChange={next => { if (next) selectedAction.current = false; setOpen(next) }}>
    <DropdownMenu.Trigger asChild><button type="button" disabled={busy} aria-label="Original file actions">Original <DownIcon size={12} /></button></DropdownMenu.Trigger>
    <DropdownMenu.Portal container={resolveOverlayContainer()}><DropdownMenu.Content className="tab-context-menu image-annotation-original-menu"
      align="start" sideOffset={4} collisionPadding={8}
      onEscapeKeyDown={event => { if (isImeOwnedKeyboardEvent(event)) event.preventDefault() }}
      onCloseAutoFocus={event => { if (selectedAction.current) event.preventDefault() }}>
      {onOpen ? <DropdownMenu.Item className="tab-context-menu__item" disabled={busy} onSelect={() => { selectedAction.current = true; onOpen() }}>Open original…</DropdownMenu.Item> : null}
      {onSave ? <DropdownMenu.Item className="tab-context-menu__item" disabled={busy || !loaded} onSelect={() => { selectedAction.current = true; onSave() }}>Save original…</DropdownMenu.Item> : null}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>
}
