import { useContext, useEffect, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from './api'
import { useAppStore } from '../store'
import { sessionPresentationById } from './session-presentation'
import { AgentConnectorDialog, type AgentConnectorTarget } from '../components/AgentConnectorDialog'
import { SettingsNavigation } from '../components/SettingsNavigation'

/** The existing Region menu owns this transient presentation; opening it reads only configuration. */
export function useAgentConnectorMenu(regionId: string, sessionId: string | null) {
  const [enabled, setEnabled] = useState(false), [issue, setIssue] = useState('')
  const [dialog, setDialog] = useState<{ original: AgentConnectorTarget; mode: 'create' | 'existing' | 'details' } | null>(null)
  const selection = useRef<typeof dialog>(null), menuOpen = useRef(false)
  const settings = useContext(SettingsNavigation), returned = useRef<HTMLElement | null>(null), read = useRef(0)
  useEffect(() => () => { read.current++ }, [regionId, sessionId])
  function onOpen(open: boolean) {
    menuOpen.current = open
    // The original menu releases its focus scope before the selected modal mounts.
    if (!open && selection.current) { setDialog(selection.current); selection.current = null }
    const generation = ++read.current
    if (!open || !sessionId) return
    returned.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    void api.connections.call('connection.ls', {}).then(result => {
      if (generation === read.current) { setEnabled(result.connections.some(item => item.config.enabled)); setIssue('') }
    }).catch(error => { if (generation === read.current) setIssue(presentError(error)) })
  }
  function open(mode: 'create' | 'existing' | 'details') {
    const current = useAppStore.getState(), session = sessionId ? sessionPresentationById(current.sessions).get(sessionId) : undefined
    if (session?.kind !== 'agent') { setIssue('The original Agent reference is unavailable. Existing input and draft are kept.'); return }
    const executorId = session.executorId ?? undefined, appearance = executorId ? current.config?.executors[executorId]?.avatar ?? current.config?.appearance.agentAvatars?.[executorId] : undefined
    const selected = { mode, original: { name: current.agentNames[session.id] ?? session.label, session,
      identity: { providerId: session.providerId, executorId, ...(appearance ? { appearance: structuredClone(appearance) } : {}) },
      target: { executionHostId: session.control.hostId, agentSessionId: session.control.agentSessionId, regionAnchor: { regionId } } } }
    if (menuOpen.current) selection.current = selected
    else setDialog(selected)
  }
  return { onOpen, dialogOpen: dialog !== null, issue, entries: !sessionId ? [] : [
    ...(enabled ? [{ label: 'Create group chat', onSelect: () => open('create') }, { label: 'Bind existing group chat', onSelect: () => open('existing') }, { label: 'Shared group details', onSelect: () => open('details') }] : []),
    ...(settings ? [{ label: enabled ? 'Chat application settings' : 'Enable a chat application', onSelect: () => settings.open('chat-connections') }] : [])
  ], dialog: dialog ? <AgentConnectorDialog key={JSON.stringify(dialog.original.target)} {...dialog} returnFocus={() => returned.current} onClose={() => setDialog(null)} /> : null }
}
