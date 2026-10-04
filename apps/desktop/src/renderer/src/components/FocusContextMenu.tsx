import * as ContextMenu from '@radix-ui/react-context-menu'
import { useRef, type ReactNode } from 'react'
import { Pencil, Square } from 'lucide-react'
import type { FocusContext } from '../lib/focus-context'
import { agentRosterMenuActions } from '../lib/agent-roster-menu'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { useAppStore } from '../store'
import { RegionMenuEntryView } from './RegionContextMenu'
import { resolveOverlayContainer } from './WindowOverlayHost'
import { useFocusStopAgent } from './FocusStopAgent'

/** A Context card knows its semantic SID, not which of its Regions to address. */
export function FocusContextMenu({ context, children, onOpenChange, onRename, onRestoreFocus }: {
  context: FocusContext; children: ReactNode; onOpenChange(open: boolean): void; onRename(): void; onRestoreFocus(): void
}) {
  const sessionId = context.id
  const actionOwnsFocus = useRef(false)
  const origin = useRef<HTMLElement | null>(null)
  const stop = useFocusStopAgent()
  const actions = agentRosterMenuActions({ sessionId, writeClipboardText: async text => {
    await copyTextToClipboard(text, error => useAppStore.getState().reportError(error))
  } })
  return <><ContextMenu.Root modal={false} onOpenChange={open => { if (open) actionOwnsFocus.current = false; onOpenChange(open) }}>
    <ContextMenu.Trigger asChild onContextMenu={event => { origin.current = event.currentTarget }} onKeyDown={event => {
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }))
    }}>{children}</ContextMenu.Trigger>
    <ContextMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}>
      <ContextMenu.Content className="tab-context-menu focus-context-menu" data-agent-session-id={sessionId} collisionPadding={8}
        onCloseAutoFocus={event => {
          const active = document.activeElement
          const closing = event.target
          const laterFocus = active instanceof HTMLElement && active !== document.body &&
            closing instanceof HTMLElement && !closing.contains(active)
          if (actionOwnsFocus.current || laterFocus) { event.preventDefault(); actionOwnsFocus.current = false }
          else onRestoreFocus()
        }}>
        <ContextMenu.Label className="focus-context-menu__identity"><strong title={context.name}>{context.name}</strong></ContextMenu.Label>
        <ContextMenu.Item className="tab-context-menu__item" onSelect={() => { actionOwnsFocus.current = true; onRename() }}><Pencil size={14} /><span>Rename Agent</span></ContextMenu.Item>
        <ContextMenu.Separator className="tab-context-menu__separator" />
        {actions.filter(action => action.key === 'copy-session').map((action, index) => <RegionMenuEntryView key={action.key} entry={{ kind: 'action', action }} index={index} Item={ContextMenu.Item} Separator={ContextMenu.Separator} />)}
        <ContextMenu.Separator className="tab-context-menu__separator" />
        <ContextMenu.Item className="tab-context-menu__item" onSelect={() => { actionOwnsFocus.current = true; onRestoreFocus(); stop.requestStop(sessionId, context.name, origin.current) }}><Square size={14} /><span>Stop Agent</span></ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>{stop.dialog}</>
}
