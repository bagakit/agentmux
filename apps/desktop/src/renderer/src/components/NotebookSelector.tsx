import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { Notebook } from '@agentmux/core/notebook-catalog'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { resolveOverlayContainer } from './WindowOverlayHost'

const ThemeObjectNoteIcon = semanticIconComponent('object.note')
const ThemeNavigationDownIcon = semanticIconComponent('navigation.down')
const ThemeStatusSelectedIcon = semanticIconComponent('status.selected')
const ThemeActionCreateNotebookIcon = semanticIconComponent('action.create-notebook')


/** Switch directory presentation; the original Notebook and file owners stay intact. */
export function NotebookSelector({ notebooks, selectedId, onSelect, onCreate, pending, triggerRef, active }: {
  notebooks: Notebook[]; selectedId: string | null; onSelect(id: string): void; onCreate(): void; pending: boolean; triggerRef?: RefObject<HTMLButtonElement | null>; active: boolean
}) {
  const current = notebooks.find(book => book.notebookId === selectedId)
  const creating = useRef(false), activeRef = useRef(active)
  activeRef.current = active
  const [open, setOpen] = useState(false)
  useEffect(() => { if (!active) setOpen(false) }, [active])
  return <DropdownMenu.Root modal={false} open={active && open} onOpenChange={value => setOpen(active && value)}>
    <DropdownMenu.Trigger asChild><button ref={triggerRef} className="recall-notebook-selector" aria-label="Switch notebook">
      <ThemeObjectNoteIcon size={18} strokeWidth={1.5} /><span><small>Notebook</small><strong>{current?.name ?? (selectedId ? 'Notebook unavailable' : 'Loading notebooks…')}</strong></span><ThemeNavigationDownIcon size={14} />
    </button></DropdownMenu.Trigger>
    <DropdownMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}>
      <DropdownMenu.Content className="recall-notebook-menu" align="start" sideOffset={5} collisionPadding={8} aria-label="Choose notebook" onCloseAutoFocus={event => { if (!activeRef.current || creating.current) event.preventDefault(); creating.current = false }}>
        <DropdownMenu.Label className="recall-notebook-menu-label">Your notebooks</DropdownMenu.Label>
        <DropdownMenu.RadioGroup className="recall-notebook-menu-books" value={selectedId ?? ''} onValueChange={onSelect}>
          {notebooks.map(book => <DropdownMenu.RadioItem key={book.notebookId} value={book.notebookId} className="recall-notebook-menu-item" aria-label={`Switch to notebook: ${book.name}`}>
            <ThemeObjectNoteIcon size={14} aria-hidden="true" /><span>{book.name}</span><DropdownMenu.ItemIndicator className="recall-notebook-menu-check"><ThemeStatusSelectedIcon size={14} aria-label="Current notebook" /></DropdownMenu.ItemIndicator>
          </DropdownMenu.RadioItem>)}
        </DropdownMenu.RadioGroup>
        <DropdownMenu.Separator className="recall-notebook-menu-separator" />
        <DropdownMenu.Item className="recall-notebook-menu-item" aria-label="New notebook" disabled={pending} onSelect={() => { creating.current = true; onCreate() }}><ThemeActionCreateNotebookIcon size={14} /><span>New notebook</span></DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
}
