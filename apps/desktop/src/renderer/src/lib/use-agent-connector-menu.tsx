import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { api } from './api'
import { useAppStore } from '../store'
import { sessionPresentationById } from './session-presentation'
import { AgentConnectorDialog, type AgentConnectorTarget } from '../components/AgentConnectorDialog'
import { agentMoteConnectionSource } from './mote-connection-default'
import { readConnectorService, selectConnectorServiceObservation } from './connector-service-observation'
import { agentMenuSession, type AgentMenuTarget } from './agent-menu-target'
import { useWorkbenchPresentationActive } from './workbench-presentation'

/** Session and Region menus share this transient presentation; opening reads only configuration. */
export function useAgentConnectorMenu(regionId: string | undefined, sessionId: string | null, tabId?: string,
  options: { source?: AgentMenuTarget | undefined; active?: boolean | undefined } = {}) {
  const presentationActive = useWorkbenchPresentationActive()
  const active = options.active ?? presentationActive
  const [issue, setIssue] = useState('')
  const [hostingTarget, setHostingTarget] = useState<ConnectionHostingTarget | null>(null)
  const [dialog, setDialog] = useState<{ original: AgentConnectorTarget; mode: 'create' | 'existing' | 'details' } | null>(null)
  const [menuVisible, setMenuVisible] = useState(false)
  const selection = useRef<typeof dialog>(null), menuOpen = useRef(false)
  const returned = useRef<HTMLElement | null>(null), read = useRef(0)
  const observing = active && (menuVisible || dialog !== null)
  const subscribe = useCallback((listener: () => void) => observing ? useAppStore.subscribe(listener) : () => {}, [observing])
  const snapshot = useCallback(() => observing && sessionId
    ? selectConnectorServiceObservation(useAppStore.getState().connectorServiceObservation, hostingTarget) : null, [observing, sessionId, hostingTarget])
  const observed = useSyncExternalStore(subscribe, snapshot, snapshot)
  const service = observed?.state
  useEffect(() => { setHostingTarget(null); return () => { read.current++ } }, [regionId, sessionId, tabId])
  useEffect(() => {
    if (active) return
    read.current++; menuOpen.current = false; selection.current = null
    setMenuVisible(false); setDialog(null)
  }, [active])
  async function readService(generation: number) {
    const owner = await api.connections.hostingTarget()
    if (generation !== read.current) return
    setHostingTarget(owner)
    await readConnectorService(() => generation === read.current, owner)
  }
  function onOpen(open: boolean) {
    menuOpen.current = open
    setMenuVisible(open)
    // The original menu releases its focus scope before the selected modal mounts.
    if (!open && selection.current) { setDialog(selection.current); selection.current = null }
    const generation = ++read.current
    if (!open || !sessionId) return
    returned.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    void readService(generation).catch(() => {})
  }
  function open(mode: 'create' | 'existing' | 'details', channel?: string) {
    const current = useAppStore.getState(), session = options.source
      ? agentMenuSession(current.sessions, options.source) : sessionId ? sessionPresentationById(current.sessions).get(sessionId) : undefined
    if (session?.kind !== 'agent') {
      const message = 'The original Agent reference is unavailable. Existing input and draft are kept.'
      setIssue(message)
      current.reportError(new Error(message), { kind: 'indeterminate', ...(options.source?.control ? { subject: options.source.control } : {}),
        summary: 'Reopen Connections on the intended Agent. Its original Session and draft are kept.' })
      return
    }
    const region = tabId && regionId ? current.tabs[tabId]?.regions[regionId] : undefined
    if (tabId && (region?.kind !== 'agent' || region.sessionId !== sessionId)) {
      setIssue('This menu’s original Agent display changed. Reopen the menu on the intended Agent; existing input and groups are kept.'); return
    }
    setIssue('')
    const executorId = session.executorId ?? undefined, appearance = executorId ? current.config?.executors[executorId]?.avatar ?? current.config?.appearance.agentAvatars?.[executorId] : undefined
    const mote = tabId && regionId && sessionId ? agentMoteConnectionSource(current, tabId, regionId, sessionId) : undefined
    const selected = { mode, original: { ...(channel ? { channel } : {}), name: current.agentNames[session.id] ?? session.label, session,
      ...(mote ? { mote } : {}),
      identity: { providerId: session.providerId, executorId, ...(appearance ? { appearance: structuredClone(appearance) } : {}) },
      target: { executionHostId: session.control.hostId, agentSessionId: session.control.agentSessionId, ...(regionId ? { regionAnchor: { regionId } } : {}) } } }
    if (menuOpen.current) selection.current = selected
    else setDialog(selected)
  }
  function openConnect(trigger: HTMLElement, mode: 'existing' | 'details' = 'existing', channel?: string) {
    returned.current = trigger
    const generation = ++read.current
    void readService(generation).catch(() => {})
    open(mode, channel)
  }
  return { onOpen, openConnect, issue, dialogOpen: dialog !== null, group: !sessionId ? null : {
    label: 'Connections',
    entries: [
      { label: 'Connect group…', onSelect: () => void open('existing') },
      { label: 'Shared group details', onSelect: () => void open('details') },
      { label: 'Automatic sync settings', onSelect: () => void open('details') }
    ],
    issue: [!service ? 'Automatic chat sync is not confirmed. Open Connections to check it.' : !service.enabled ? 'Automatic chat sync is off. Open Connections to turn it on. Existing groups are kept.' : '', observed?.issue ? `Current service check unconfirmed; keeping the last confirmed policy. ${observed.issue}` : '', issue].filter(Boolean).join(' ')
  }, dialog: active && dialog ? <AgentConnectorDialog key={JSON.stringify([dialog.original.target, dialog.original.hostingTarget, dialog.original.channel])} {...dialog} returnFocus={() => returned.current} onClose={() => setDialog(null)} /> : null }
}
