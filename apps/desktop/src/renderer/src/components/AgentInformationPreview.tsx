import { useCallback, useEffect, useId, useLayoutEffect, useRef, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { FocusContext } from '../lib/focus-context'
import type { FocusGoalLinks } from '../lib/focus-goal-links'
import type { FocusContextIdentity } from '../lib/focus-context-identity'
import { agentInformationPreview } from '../lib/agent-information-preview'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { WorkbenchTopology } from './WorkbenchTopology'
import { AgentInformationReader } from './AgentInformationReader'

/** Mounted once by App, outside transient, filtered and retained surface trees. */
export function AgentInformationPreviewHost() {
  const request = useSyncExternalStore(agentInformationPreview.subscribe, agentInformationPreview.get, () => null)
  useEffect(() => {
    const cancel = () => agentInformationPreview.cancelIntent()
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel() }
    document.addEventListener('keydown', escape)
    document.addEventListener('pointerdown', cancel, true)
    document.addEventListener('visibilitychange', cancel)
    window.addEventListener('scroll', cancel, true)
    window.addEventListener('resize', cancel)
    return () => {
      cancel(); document.removeEventListener('keydown', escape); document.removeEventListener('pointerdown', cancel, true)
      document.removeEventListener('visibilitychange', cancel); window.removeEventListener('scroll', cancel, true); window.removeEventListener('resize', cancel)
    }
  }, [])
  useLayoutEffect(() => () => {
    const original = agentInformationPreview.get()
    if (original) agentInformationPreview.dismiss(original.token, true)
  }, [])
  return request ? <AgentInformationReader key={request.id} request={request} /> : null
}

/** Each surface retains its own primary action; only a bounded reading intent is shared. */
export function useAgentInformationPreview(context: FocusContext, requested: boolean, identity: FocusContextIdentity | undefined, goalLinks: FocusGoalLinks | undefined,
  openWorkface: () => void) {
  const active = useWorkbenchPresentationActive(), enabled = requested && active
  const anchor = useRef<HTMLButtonElement>(null), token = useRef({}).current
  const intent = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const departure = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const restoringFocus = useRef(false), id = useId()
  const open = useSyncExternalStore(agentInformationPreview.subscribe, () => agentInformationPreview.get()?.token === token, () => false)
  const close = useCallback(() => {
    clearTimeout(intent.current); clearTimeout(departure.current)
    agentInformationPreview.dismiss(token)
  }, [token])
  function keepOpen() { clearTimeout(departure.current) }
  function suppressRestoredFocus() {
    restoringFocus.current = true
    queueMicrotask(() => { restoringFocus.current = false })
  }
  function show(enterReading = false) {
    clearTimeout(intent.current); keepOpen()
    const trigger = anchor.current
    // Only the transient peek needs an available visible invoker; Agent actions stay independent.
    if (!enabled || !trigger?.isConnected || trigger.closest('[inert]') || document.visibilityState === 'hidden') return false
    return agentInformationPreview.show({ token, id, context, identity, goalLinks, anchor: trigger, openWorkface, enterReading, keepOpen,
      restoreFocus() {
        if (!trigger.isConnected || trigger.closest('[inert]')) return
        suppressRestoredFocus(); trigger.focus({ preventScroll: true })
      } })
  }
  function showSoon() { clearTimeout(intent.current); keepOpen(); if (enabled && agentInformationPreview.schedule(token, () => clearTimeout(intent.current))) intent.current = setTimeout(show, 180) }
  function hideSoon() {
    clearTimeout(intent.current); keepOpen()
    departure.current = setTimeout(() => {
      if (document.getElementById(id)?.contains(document.activeElement) || document.activeElement === anchor.current) return
      close()
    }, 160)
  }
  useLayoutEffect(() => { agentInformationPreview.noteContent(token, context); close() }, [context.id, context.hostId, context.runId, context.name, context.state, context.detail,
    context.recap?.text, context.recap?.source, context.recap?.origin, context.recap?.reading?.text,
    context.recap?.reading?.truncated, context.workspacePath, context.originAddress, enabled, close])
  useLayoutEffect(() => () => { close() }, [close])
  const position = identity?.tabs.some(tab => tab.regions.length > 1) ? <span className="focus-context__position"
    aria-label={`${identity.occurrenceCount} confirmed ${identity.occurrenceCount === 1 ? 'position' : 'positions'}`}
    onPointerEnter={close} onPointerLeave={event => {
      if (event.relatedTarget instanceof Node && anchor.current?.contains(event.relatedTarget)) showSoon()
    }}><WorkbenchTopology tabs={identity.tabs} interactive={false} enabled={enabled && !open} /></span> : undefined
  return { anchor, position, describedBy: open ? id : undefined, close, suppressRestoredFocus,
    triggerEvents: { 'aria-keyshortcuts': enabled ? 'ArrowDown' : undefined, onPointerEnter: showSoon, onPointerLeave: hideSoon,
      onFocus: () => { if (!restoringFocus.current) show() }, onBlur: hideSoon, onPointerDown: close,
      onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== 'ArrowDown' || !enabled) return
        const reader = document.getElementById(id)?.querySelector<HTMLElement>('.agent-information-reader__reading')
        if (reader) { event.preventDefault(); keepOpen(); reader.focus({ preventScroll: true }) }
        else if (show(true)) event.preventDefault()
      } }
  }
}
