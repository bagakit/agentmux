import { useContext, useEffect, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from './api'
import { useAppStore } from '../store'
import { sessionPresentationById } from './session-presentation'
import { AgentConnectorDialog, type AgentConnectorTarget } from '../components/AgentConnectorDialog'
import { SettingsNavigation } from '../components/SettingsNavigation'
import { agentMoteConnectionSource } from './mote-connection-default'
import { readConnectorService } from './connector-service-observation'

/** The existing Region menu owns this transient presentation; opening it reads only configuration. */
export function useAgentConnectorMenu(regionId: string, sessionId: string | null, tabId?: string) {
  const [botEnabled, setBotEnabled] = useState(false), [issue, setIssue] = useState('')
  const observation = useAppStore(state => sessionId ? state.connectorServiceObservation : null)
  const observed = observation?.source === api.connections.call ? observation : null
  const service = observed?.state
  const [dialog, setDialog] = useState<{ original: AgentConnectorTarget; mode: 'create' | 'existing' | 'details' } | null>(null)
  const selection = useRef<typeof dialog>(null), menuOpen = useRef(false)
  const settings = useContext(SettingsNavigation), returned = useRef<HTMLElement | null>(null), read = useRef(0)
  useEffect(() => () => { read.current++ }, [regionId, sessionId, tabId])
  function onOpen(open: boolean) {
    menuOpen.current = open
    // The original menu releases its focus scope before the selected modal mounts.
    if (!open && selection.current) { setDialog(selection.current); selection.current = null }
    const generation = ++read.current
    if (!open || !sessionId) return
    returned.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    void readConnectorService(() => generation === read.current).catch(() => {})
    void api.connections.call('connection.ls', {}).then(result => {
      if (generation === read.current) { setBotEnabled(result.connections.some(item => item.config.enabled)); setIssue('') }
    }).catch(error => { if (generation === read.current) setIssue(presentError(error)) })
  }
  function open(mode: 'create' | 'existing' | 'details') {
    const current = useAppStore.getState(), session = sessionId ? sessionPresentationById(current.sessions).get(sessionId) : undefined
    if (session?.kind !== 'agent') { setIssue('The original Agent reference is unavailable. Existing input and draft are kept.'); return }
    const region = tabId ? current.tabs[tabId]?.regions[regionId] : undefined
    if (tabId && (region?.kind !== 'agent' || region.sessionId !== sessionId)) {
      setIssue('This menu’s original Agent display changed. Reopen the menu on the intended Agent; existing input and groups are kept.'); return
    }
    const executorId = session.executorId ?? undefined, appearance = executorId ? current.config?.executors[executorId]?.avatar ?? current.config?.appearance.agentAvatars?.[executorId] : undefined
    const mote = tabId && sessionId ? agentMoteConnectionSource(current, tabId, regionId, sessionId) : undefined
    const selected = { mode, original: { name: current.agentNames[session.id] ?? session.label, session,
      ...(mote ? { mote } : {}),
      identity: { providerId: session.providerId, executorId, ...(appearance ? { appearance: structuredClone(appearance) } : {}) },
      target: { executionHostId: session.control.hostId, agentSessionId: session.control.agentSessionId, regionAnchor: { regionId } } } }
    if (menuOpen.current) selection.current = selected
    else setDialog(selected)
  }
  const available = service?.enabled === true && botEnabled
  return { onOpen, dialogOpen: dialog !== null, group: !sessionId || service?.enabled === false ? null : {
    label: 'Lark',
    entries: [
      ...(available ? [{ label: 'Create group chat', onSelect: () => open('create') }, { label: 'Bind existing group chat', onSelect: () => open('existing') }, { label: 'Shared group details', onSelect: () => open('details') }] : []),
      ...(settings ? [{ label: !service ? 'Lark settings' : available ? 'Chat application settings' : 'Enable a chat application', onSelect: () => {
        const session = sessionId ? sessionPresentationById(useAppStore.getState().sessions).get(sessionId) : undefined
        if (session?.kind === 'agent') settings.openLark({ sessionId: session.id, hostId: session.control.hostId, agentSessionId: session.control.agentSessionId })
        else settings.open('lark')
      } }] : [])
    ],
    issue: [!service ? 'External chat sync is not confirmed. Open Lark settings to check it.' : '', observed?.issue ? `Current service check unconfirmed; keeping the last confirmed policy. ${observed.issue}` : '', issue].filter(Boolean).join(' ')
  }, dialog: dialog ? <AgentConnectorDialog key={JSON.stringify(dialog.original.target)} {...dialog} returnFocus={() => returned.current} onClose={() => setDialog(null)} /> : null }
}
