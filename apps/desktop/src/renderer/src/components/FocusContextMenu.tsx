import * as ContextMenu from '@radix-ui/react-context-menu'
import type { ReactNode } from 'react'
import { agentRosterMenuActions } from '../lib/agent-roster-menu'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { useAppStore } from '../store'
import { RegionMenuEntryView } from './RegionContextMenu'
import { resolveOverlayContainer } from './WindowOverlayHost'

/** A Context card knows its semantic SID, not which of its Regions to address. */
export function FocusContextMenu({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const actions = agentRosterMenuActions({ sessionId, writeClipboardText: async text => {
    await copyTextToClipboard(text, error => useAppStore.getState().reportError(error))
  } })
  return <ContextMenu.Root modal={false}>
    <ContextMenu.Trigger asChild onKeyDown={event => {
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }))
    }}>{children}</ContextMenu.Trigger>
    <ContextMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}>
      <ContextMenu.Content className="tab-context-menu focus-context-menu" data-agent-session-id={sessionId} collisionPadding={8}>
        {actions.map((action, index) => <RegionMenuEntryView key={action.key} entry={{ kind: 'action', action }} index={index} Item={ContextMenu.Item} Separator={ContextMenu.Separator} />)}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>
}
