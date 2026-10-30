import * as ContextMenu from '@radix-ui/react-context-menu'
import { useCallback, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { FocusContext } from '../lib/focus-context'
import { agentRosterMenuActions } from '../lib/agent-roster-menu'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { useAppStore } from '../store'
import { WorkbenchCopyLinkRow } from './WorkbenchCopyLinkRow'
import { AgentMenuContent } from './AgentMenuContent'
import { WorkbenchMenuScope } from './WorkbenchMenuScope'
import { useAgentNativeSourceControls } from './AgentNativeSourceControls'
import { agentMenuSession } from '../lib/agent-menu-target'
import { executionHostProjection } from '../lib/region-execution-host'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { useSessionStop } from './SessionStop'
import { useSessionRestart } from './SessionRestart'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'

const ThemeActionEditIcon = semanticIconComponent('action.edit')
const AgentIcon = semanticIconComponent('object.agent')


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
  // Keep the original confirmation controller through dismissal, but only an open
  // menu subscribes to Store changes. Closed cards add no update fan-out/readers.
  const subscribe = useCallback((listener: () => void) => open ? useAppStore.subscribe(listener) : () => {}, [open])
  const selectFacts = useShallow((state: ReturnType<typeof useAppStore.getState>) => ({
    session: agentMenuSession(state.sessions, context),
    host: state.config?.hosts.find(host => host.id === (context.control?.hostId ?? context.hostId)),
    executor: context.executorId ? state.config?.executors[context.executorId] : undefined
  }))
  const heldFacts = useRef<ReturnType<typeof selectFacts>>({ session: undefined, host: undefined, executor: undefined })
  const readFacts = useCallback(() => {
    if (open) heldFacts.current = selectFacts(useAppStore.getState())
    return heldFacts.current
  }, [open, selectFacts])
  const { session, host, executor } = useSyncExternalStore(subscribe, readFacts, readFacts)
  const nativeSource = useAgentNativeSourceControls({ session: session ?? null, readOnly: false })
  const [refreshing, setRefreshing] = useState(false)
  async function refreshObservation() {
    setRefreshing(true)
    try { await useAppStore.getState().refreshSession(context.id) }
    catch (error) { useAppStore.getState().reportError(error) }
    finally { setRefreshing(false) }
  }
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
        <WorkbenchMenuScope.Provider value={ContextMenu}>
          <AgentMenuContent name={context.name} executorLabel={executor?.label ?? context.providerId ?? 'Executor unknown'}
            sessionId={context.control?.agentSessionId}
            executionHost={executionHostProjection(context.control?.hostId ?? context.hostId, context.workspacePath, host)}
            links={<WorkbenchCopyLinkRow actions={actions.map(action => ({ ...action, icon: <AgentIcon size={16} /> }))}
              Item={ContextMenu.Item} Group={ContextMenu.Group} Label={ContextMenu.Label} labelPresentation="tooltip" />}
            nativeSourceDetails={nativeSource.details} nativeSourceCheck={nativeSource.checkAction}
            onRefreshObservation={session ? refreshObservation : undefined} refreshing={refreshing}
            onRestart={() => { actionOwnsFocus.current = true; onRestoreFocus(); restart.requestRestart(context, context.name, origin.current) }}
            onStop={() => { actionOwnsFocus.current = true; onRestoreFocus(); stop.requestStop(context, context.name, origin.current) }}
            extensions={{ identityActions: <ContextMenu.Item className="tab-context-menu__item" onSelect={() => {
              actionOwnsFocus.current = true; onRename()
            }}><ThemeActionEditIcon size={14} /><span>Rename Agent</span></ContextMenu.Item> }} />
        </WorkbenchMenuScope.Provider>
      </ContextMenu.Content>
    </DocumentOverlayPortal> : null}
  </ContextMenu.Root>{active ? <>{restart.dialog}{stop.dialog}</> : null}</>
}
