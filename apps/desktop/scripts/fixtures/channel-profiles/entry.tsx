import { createRoot } from 'react-dom/client'
import { useMemo } from 'react'
import type { AgentSessionUserMessage } from '@agentmux/core'
import { type ChannelMetadataChange, type ChannelMetadataResult, type ConnectionRecord, type RoomBinding } from '@agentmux/core/connections'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { createSpeakerResolver, speakerOfUserMessage } from '@agentmux/client-ui/conversation-speaker'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { ChannelMetadataPanel } from '../../../src/renderer/src/components/settings/ChannelMetadataPanel'
import { ConnectorHeaderLinks } from '../../../src/renderer/src/components/ConnectorHeaderLinks'
import { channelProfileKey, useChannelActorProfiles } from '../../../src/renderer/src/lib/use-channel-actor-profiles'
import { api } from '../../../src/renderer/src/lib/api'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/index.css'
import './preview.css'

mountThemeRuntime(window, (await api.config.get()).appearance)

const data = await fetch('./public-scene.json').then(response => { if (!response.ok) throw Error('Original public consumer scene is missing'); return response.json() }) as {
  messages: AgentSessionUserMessage[]; connection: ConnectionRecord; binding: RoomBinding; actor: ChannelMetadataResult; group: ChannelMetadataResult
}
if (!data.messages.some(message => message.author.kind === 'external') || !data.actor.entry.observation.profile || !data.binding) throw Error('Nonempty original Core input and Channel cache are required')
const listeners = new Set<(change: ChannelMetadataChange) => void>(), proof = { ready: false, failNext: false, calls: [] as string[], errors: [] as string[], rename() {
  data.group.entry.observation.profile!.name = 'Renamed original group'
  notify(data.group)
} }
function notify(result: ChannelMetadataResult) { for (const listener of listeners) listener({ connectionId: result.connectionId, application: result.application, subject: result.entry.subject }) }
api.connections.onMetadataChanged = listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
api.connections.call = (async (method: string, input: any) => {
  proof.calls.push(method)
  const original = input.subject?.kind === 'conversation' ? data.group : data.actor
  if (method === 'connection.metadata.get') return structuredClone(original)
  if (method === 'connection.metadata.ls') return { connectionId: data.connection.config.connectionId, connectionRevision: data.connection.revision, application: data.connection.config.application,
    entries: [input.kind === 'conversation' ? data.group.entry : data.actor.entry].filter(entry => entry.cacheRevision !== null), next: null }
  if (method === 'connection.metadata.refresh') {
    await new Promise(resolve => setTimeout(resolve, 700))
    if (proof.failNext) { proof.failNext = false; throw Error('Profile refresh is unavailable. The saved profile is kept.') }
    if (original.entry.observation.profile) original.entry.observation.profile.name = input.subject.kind === 'actor' ? 'Renamed native person' : 'Renamed original group'
    notify(original); return structuredClone(original)
  }
  if (method === 'connection.metadata.clear') {
    original.entry.observation = { ...original.entry.observation, state: 'unknown', freshness: 'unknown', profile: null, reason: 'not-observed' }
    original.entry.cacheRevision = null
    notify(original); return { ...structuredClone(original), cleared: true }
  }
  throw Error('This original public-data preview does not implement ' + method)
}) as typeof api.connections.call
Object.assign(window, { channelProfilesProof: proof })
window.addEventListener('error', event => proof.errors.push(event.message))
window.addEventListener('unhandledrejection', event => proof.errors.push(String(event.reason)))
function Fixture() {
  const profiles = useChannelActorProfiles(data.messages, true)
  const describeSpeaker = useMemo(() => createSpeakerResolver({ lookupExternal: author => profiles.get(channelProfileKey(author)) }), [profiles])
  return <DesktopClientUiProvider><main className="channel-profiles-preview">
    <header><div><small>Conversation Channels</small><h1>Original conversation</h1></div>
      <ConnectorHeaderLinks bindings={[data.binding]} issue="" checking={false} retainedSetup={false} syncEnabled nameVersion={0} visible onOpen={() => {}} onConnect={() => {}} onMenuOpen={() => {}} /></header>
    <section aria-label="Original conversation messages">{data.messages.map(message => <ConversationMessage key={message.id} messageId={message.id} content={message.content}
      speaker={speakerOfUserMessage(message)} inputSource={message.source} describeSpeaker={describeSpeaker} publicContent={message.publicContent} recordedIdentity />)}</section>
    <section className="channel-profiles-preview__settings"><h2>{data.connection.config.label}</h2><p>Channel profile cache</p><ChannelMetadataPanel connection={data.connection} active /></section>
  </main></DesktopClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
proof.ready = true
