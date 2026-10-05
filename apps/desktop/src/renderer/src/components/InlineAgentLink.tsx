import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import { api } from '../lib/api'
import { createFirstPromptSelector, sessionPresentationById } from '../lib/session-presentation'
import { currentConversationSpeakerMetadata } from '../lib/conversation-sender-details'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { usePathDisplay } from '../hooks/usePathDisplay'
import { AgentAvatar } from './AgentAvatar'
import { SpaceObjectIcon } from './SpaceObjectIcon'

type AgentLinkReference = { uri: string; agentSessionId: string; label?: string }

/** These extra facts and clipboard feedback exist only while the original avatar disclosure is open. */
function AgentLinkDetails({ uri, agentSessionId }: AgentLinkReference) {
  const session = useAppStore(state => sessionPresentationById(state.sessions).get(agentSessionId))
  const displayPath = usePathDisplay()
  const [copied, setCopied] = useState<'id' | 'link' | null>(null)
  return <div className="inline-agent-link__details">
    <dl><dt>Session</dt><dd>{agentSessionId}</dd>
      {session?.kind === 'agent' ? <><dt>Directory</dt><dd>{displayPath(session.workspacePath, session.hostId)}</dd>
        <dt>Observed</dt><dd>{new Date(session.status.observedAt).toLocaleString()}</dd></> : null}
    </dl>
    <p>Current details for the linked Agent.</p>
    <code>{uri}</code>
    <button type="button" className="small-button" onClick={() => {
      void copyTextToClipboard(uri, useAppStore.getState().reportError).then(ok => setCopied(ok ? 'link' : null))
    }}>{copied === 'link' ? 'Link copied' : 'Copy Agent Link'}</button>
    <button type="button" className="small-button" onClick={() => {
      void copyTextToClipboard(agentSessionId, useAppStore.getState().reportError).then(ok => setCopied(ok ? 'id' : null))
    }}>{copied === 'id' ? 'ID copied' : 'Copy ID'}</button>
  </div>
}

/** No discovery, polling or position matching: this consumes one exact SID from the existing projection. */
export function InlineAgentLink({ uri, agentSessionId, label }: AgentLinkReference) {
  const firstPrompt = useMemo(() => createFirstPromptSelector(agentSessionId), [agentSessionId])
  const identityFacts = useAppStore(useShallow(state => {
    const session = sessionPresentationById(state.sessions).get(agentSessionId)
    return { kind: session?.kind, hostId: session?.hostId, path: session?.workspacePath, label: session?.label,
      providerId: session?.kind === 'agent' ? session.providerId : undefined,
      userName: state.agentNames[agentSessionId], firstPrompt: firstPrompt(state),
      config: state.config, topics: state.scratchTopicSnapshots, icons: state.spaceObjectIcons }
  }))
  // Identity changes, not streaming/status events, refresh the existing Mote/name resolver.
  const identity = useMemo(() => {
    const state = useAppStore.getState()
    return currentConversationSpeakerMetadata(agentSessionId, { sessions: state.sessions,
      workspaces: state.config?.workspaces ?? [], config: state.config, agentNames: state.agentNames,
      timelines: state.timelines, scratchTopicSnapshots: state.scratchTopicSnapshots, spaceObjectIcons: state.spaceObjectIcons })
  }, [agentSessionId, identityFacts])
  const mote = identity?.mote
  const facts = useAppStore(useShallow(state => {
    const session = sessionPresentationById(state.sessions).get(agentSessionId)
    return session?.kind === 'agent' ? { label: session.label, providerId: session.providerId,
      hostId: session.hostId, executorId: session.executorId, state: session.status.state, detail: session.status.detail } : null
  }))
  const root = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    if (facts?.state !== 'working' && !mote) { setVisible(true); return }
    let inView = typeof IntersectionObserver === 'undefined'
    const sync = () => setVisible(inView && !document.hidden)
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
      inView = entries.some(entry => entry.isIntersecting); sync()
    })
    if (root.current) observer?.observe(root.current)
    document.addEventListener('visibilitychange', sync)
    sync()
    return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', sync) }
  }, [facts?.state, Boolean(mote)])
  const name = mote?.name ?? identity?.label ?? facts?.label ?? agentSessionId
  return <span ref={root} className="inline-agent-link" data-agent-link={uri} data-motion={visible ? 'on' : 'off'}>
    <AgentAvatar sessionId={agentSessionId} label={name} inlineLabel={label ?? name} size={16} visible={visible}
      mark={mote ? <SpaceObjectIcon kind="mote" name={mote.name} manualIcon={mote.icon}
        avatarObjectKey={mote.objectKey} avatarWorkspaceId={mote.workspaceId} avatarTopicId={mote.topicId}
        moteSessionId={agentSessionId} moteHostId={facts?.hostId} visible={visible} /> : undefined}
      providerId={facts?.providerId} executorId={facts?.executorId} state={facts?.state}
      detail={facts?.detail ?? (facts ? undefined : 'Current Agent details are unavailable. Open the original link to inspect its current position.')}
      onOpen={() => { void api.ui.openObjectLink(uri).catch(useAppStore.getState().reportError) }}
      details={<AgentLinkDetails key={uri} uri={uri} agentSessionId={agentSessionId} />} />
  </span>
}
