import * as ContextMenu from '@radix-ui/react-context-menu'
import { MessageSquare } from 'lucide-react'
import { useRef, type ReactNode } from 'react'
import type { NotebookPage } from '@agentmux/core/notebook-catalog'
import { resolveOverlayContainer } from './WindowOverlayHost'

export type NoteTalkHandler = (page: NotebookPage, returnFocus?: HTMLElement | null) => void

/** A directory action belongs to the clicked Note, independently of the open editor. */
export function NotebookPageContextMenu({ page, onTalk, children }: {
  page: NotebookPage; onTalk?: NoteTalkHandler | undefined; children: ReactNode
}) {
  const trigger = useRef<HTMLSpanElement>(null)
  const handoff = useRef(false)
  if (!onTalk) return children
  return <ContextMenu.Root>
    <ContextMenu.Trigger asChild ref={trigger} onKeyDown={event => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
      event.preventDefault()
      const bounds = event.currentTarget.getBoundingClientRect()
      event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
        clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 }))
    }}>{children}</ContextMenu.Trigger>
    <ContextMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}>
      <ContextMenu.Content className="tab-context-menu" collisionPadding={8}
        onCloseAutoFocus={event => { if (handoff.current) event.preventDefault() }}
        onPointerUpCapture={event => { if (event.button === 2) { event.preventDefault(); event.stopPropagation() } }}>
        <ContextMenu.Item className="tab-context-menu__item" onSelect={() => {
          handoff.current = true
          requestAnimationFrame(() => {
            handoff.current = false
            if (trigger.current?.isConnected) onTalk(page, trigger.current)
          })
        }}>
          <MessageSquare size={14} /><span>Talk with Agent</span>
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>
}
