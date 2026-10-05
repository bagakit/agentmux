import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { BookOpen, Check, ChevronDown, Plus } from 'lucide-react'
import type { Notebook } from '@agentmux/core/notebook-catalog'
import { useRef, type RefObject } from 'react'
import { resolveOverlayContainer } from './WindowOverlayHost'

/** Switch directory presentation; the original Notebook and file owners stay intact. */
export function NotebookSelector({ notebooks, selectedId, onSelect, onCreate, pending, triggerRef }: {
  notebooks: Notebook[]; selectedId: string | null; onSelect(id: string): void; onCreate(): void; pending: boolean; triggerRef?: RefObject<HTMLButtonElement | null>
}) {
  const current = notebooks.find(book => book.notebookId === selectedId)
  const creating = useRef(false)
  return <DropdownMenu.Root modal={false}>
    <DropdownMenu.Trigger asChild><button ref={triggerRef} className="recall-notebook-selector" aria-label="Switch notebook">
      <BookOpen size={18} strokeWidth={1.5} /><span><small>Notebook</small><strong>{current?.name ?? (selectedId ? 'Notebook unavailable' : 'Loading notebooks…')}</strong></span><ChevronDown size={14} />
    </button></DropdownMenu.Trigger>
    <DropdownMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}>
      <DropdownMenu.Content className="recall-notebook-menu" align="start" sideOffset={5} collisionPadding={8} aria-label="Choose notebook" onCloseAutoFocus={event => { if (creating.current) { event.preventDefault(); creating.current = false } }}>
        <DropdownMenu.Label className="recall-notebook-menu-label">Your notebooks</DropdownMenu.Label>
        <div className="recall-notebook-menu-books">{notebooks.map(book => <DropdownMenu.Item key={book.notebookId} className="recall-notebook-menu-item" aria-label={`Switch to notebook: ${book.name}`} onSelect={() => onSelect(book.notebookId)}>
          <BookOpen size={14} /><span>{book.name}</span>{selectedId === book.notebookId ? <Check size={14} aria-label="Current notebook" /> : null}
        </DropdownMenu.Item>)}</div>
        <DropdownMenu.Separator className="recall-notebook-menu-separator" />
        <DropdownMenu.Item className="recall-notebook-menu-item" aria-label="New notebook" disabled={pending} onSelect={() => { creating.current = true; onCreate() }}><Plus size={14} /><span>New notebook</span></DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
}
