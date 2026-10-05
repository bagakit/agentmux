import * as ContextMenu from '@radix-ui/react-context-menu'
import { MessageSquare } from 'lucide-react'
import { useRef, type ReactNode } from 'react'
import type { NotebookPage } from '@agentmux/core/notebook-catalog'
import { resolveOverlayContainer } from './WindowOverlayHost'

export type NoteTalkHandler = (page: NotebookPage, returnFocus?: HTMLElement | null) => void

/** One menu per directory keeps unrelated keyboard input independent of its row count. */
export function NotebookDirectoryContextMenu({ pages, onTalk, children }: {
  pages: NotebookPage[]; onTalk?: NoteTalkHandler | undefined; children: ReactNode
}) {
  const container = useRef<HTMLSpanElement>(null)
  const target = useRef<{ page: NotebookPage; button: HTMLButtonElement } | null>(null)
  const handoff = useRef(false), outside = useRef(false)
  function noteButton(node: EventTarget | null) {
    const button = node instanceof Element ? node.closest<HTMLButtonElement>('button[data-note-id]') : null
    return button && container.current?.contains(button) ? button : null
  }
  if (!onTalk) return children
  return <ContextMenu.Root>
    <ContextMenu.Trigger asChild ref={container} onContextMenu={event => {
      const button = noteButton(event.target), page = button && pages.find(page => page.noteId === button.dataset.noteId)
      if (!button || !page) { event.preventDefault(); return }
      target.current = { page, button }; handoff.current = false; outside.current = false
    }} onKeyDown={event => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
      const button = noteButton(event.target)
      if (!button) return
      event.preventDefault()
      const bounds = button.getBoundingClientRect()
      button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
        clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 }))
    }}>{children}</ContextMenu.Trigger>
    <ContextMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}>
      <ContextMenu.Content className="tab-context-menu" collisionPadding={8}
        onInteractOutside={() => { outside.current = true }}
        onCloseAutoFocus={event => {
          event.preventDefault()
          if (!handoff.current && !outside.current && target.current?.button.isConnected) target.current.button.focus()
        }}
        onPointerUpCapture={event => { if (event.button === 2) { event.preventDefault(); event.stopPropagation() } }}>
        <ContextMenu.Item className="tab-context-menu__item" onSelect={() => {
          const original = target.current
          if (!original) return
          handoff.current = true
          requestAnimationFrame(() => {
            if (original.button.isConnected) onTalk(original.page, original.button)
          })
        }}>
          <MessageSquare size={14} /><span>Talk with Agent</span>
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>
}
