import * as ContextMenu from '@radix-ui/react-context-menu'
import { useRef, type ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { FocusContext } from '../lib/focus-context'
import { agentRosterMenuActions } from '../lib/agent-roster-menu'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { useAppStore } from '../store'
import { RegionMenuEntryView } from './RegionContextMenu'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { useSessionStop } from './SessionStop'
import { useSessionRestart } from './SessionRestart'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'

const ThemeActionEditIcon = semanticIconComponent('action.edit')
const ThemeActionStopIcon = semanticIconComponent('action.stop')
const ThemeActionRestartIcon = semanticIconComponent('action.restart-session')


/** The original card carries both its presentation address and canonical execution control. */
export function FocusContextMenu({ open, context, children, onOpenChange, onRename, onRestoreFocus }: {
  open: boolean; context: FocusContext; children: ReactNode; onOpenChange(open: boolean): void; onRename(): void; onRestoreFocus(): void
}) {
  const active = useWorkbenchPresentationActive()
  const activeRef = useRef(active); activeRef.current = active
  const sessionId = context.id
  const actionOwnsFocus = useRef(false)
  const origin = useRef<HTMLElement | null>(null)
  const stop = useSessionStop(active)
  const restart = useSessionRestart(active)
  const actions = context.control ? agentRosterMenuActions({ sessionId: context.control.agentSessionId, writeClipboardText: async text => {
    await copyTextToClipboard(text, error => useAppStore.getState().reportError(error))
  } }) : [{ key: 'copy-session' as const, label: 'Copy Agent Link' as const, onSelect: async () => {
    useAppStore.getState().reportError(new Error('The original canonical Agent identity is not confirmed. No Agent link was copied.'), {
      kind: 'indeterminate', summary: 'The original work surface and draft are kept. Refresh this Agent’s identity, then retry Copy Agent Link.'
    })
  } }]
  return <><ContextMenu.Root modal={false} open={open} onOpenChange={open => { if (open) actionOwnsFocus.current = false; onOpenChange(open) }}>
    <ContextMenu.Trigger asChild onContextMenu={event => { origin.current = event.currentTarget }} onKeyDown={event => {
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }))
    }}>{children}</ContextMenu.Trigger>
    {open ? <DocumentOverlayPortal component={ContextMenu.Portal}>
      <ContextMenu.Content className="tab-context-menu focus-context-menu" data-agent-session-id={sessionId} collisionPadding={8}
        onCloseAutoFocus={event => {
          if (!activeRef.current) { event.preventDefault(); return }
          const activeElement = document.activeElement
          const closing = event.target
          const laterFocus = activeElement instanceof HTMLElement && activeElement !== document.body &&
            closing instanceof HTMLElement && !closing.contains(activeElement)
          if (actionOwnsFocus.current || laterFocus) { event.preventDefault(); actionOwnsFocus.current = false }
          else onRestoreFocus()
        }}>
        <ContextMenu.Label className="focus-context-menu__identity"><strong title={context.name}>{context.name}</strong></ContextMenu.Label>
        <ContextMenu.Item className="tab-context-menu__item" onSelect={() => { actionOwnsFocus.current = true; onRename() }}><ThemeActionEditIcon size={14} /><span>Rename Agent</span></ContextMenu.Item>
        <ContextMenu.Separator className="tab-context-menu__separator" />
        {actions.filter(action => action.key === 'copy-session').map((action, index) => <RegionMenuEntryView key={action.key} entry={{ kind: 'action', action }} index={index} Item={ContextMenu.Item} Separator={ContextMenu.Separator} />)}
        <ContextMenu.Separator className="tab-context-menu__separator" />
        <ContextMenu.Item className="tab-context-menu__item" onSelect={() => { actionOwnsFocus.current = true; onRestoreFocus(); restart.requestRestart(context, context.name, origin.current) }}><ThemeActionRestartIcon size={14} /><span>Restart Session…</span></ContextMenu.Item>
        <ContextMenu.Item className="tab-context-menu__item" onSelect={() => { actionOwnsFocus.current = true; onRestoreFocus(); stop.requestStop(context, context.name, origin.current) }}><ThemeActionStopIcon size={14} /><span>Stop Agent</span></ContextMenu.Item>
      </ContextMenu.Content>
    </DocumentOverlayPortal> : null}
  </ContextMenu.Root>{active ? <>{restart.dialog}{stop.dialog}</> : null}</>
}
