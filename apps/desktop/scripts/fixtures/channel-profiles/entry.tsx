import { createRoot } from 'react-dom/client'
import { useMemo, useState } from 'react'
import type { AgentSessionUserMessage, AgentTimelineSnapshot } from '@agentmux/core'
import type { AgentInputMailboxPage } from '@agentmux/core/agent-input-mailbox'
import { parseAgentMuxMessagePrefix } from '@agentmux/core/agent-message-render'
import { inputMailboxItemKey } from '@agentmux/client-ui/use-agent-input-mailbox'
import { useAgentInputHistory } from '@agentmux/client-ui/use-agent-input-history'
import { inputMailboxPresentation } from '@agentmux/client-ui/components/InputMailboxRecords'
import { type ChannelMetadataChange, type ChannelMetadataResult, type ConnectionRecord, type RoomBinding } from '@agentmux/core/connections'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { createSpeakerResolver, speakerOfUserMessage } from '@agentmux/client-ui/conversation-speaker'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { ChannelMetadataPanel } from '../../../src/renderer/src/components/settings/ChannelMetadataPanel'
import { ConnectorHeaderLinks } from '../../../src/renderer/src/components/ConnectorHeaderLinks'
import { SessionMailbox } from '../../../src/renderer/src/components/SessionMailbox'
import type { AgentSessionControl } from '../../../src/shared/contracts'
import { useServiceNotices } from '../../../src/renderer/src/lib/use-service-notices'
import { mailboxMessageKey } from '../../../src/renderer/src/lib/session-mailbox-messages'
import { channelProfileKey, useChannelActorProfiles } from '../../../src/renderer/src/lib/use-channel-actor-profiles'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/index.css'
import './preview.css'

const config = await api.config.get()
useAppStore.setState({ config })
mountThemeRuntime(window, config.appearance)

const data = await fetch('./public-scene.json').then(response => { if (!response.ok) throw Error('Original public consumer scene is missing'); return response.json() }) as {
  messages: AgentSessionUserMessage[]; connection: ConnectionRecord; binding: RoomBinding; actor: ChannelMetadataResult; group: ChannelMetadataResult
}
const sourceHosts = new Set(data.messages.filter(message => message.author.kind === 'external').map(message => message.sourceRecord?.record.hostId))
if (!data.messages.some(message => message.author.kind === 'external') || !data.actor.entry.observation.profile || !data.binding ||
    sourceHosts.size !== 1 || sourceHosts.has(undefined)) throw Error('Nonempty original Core input, exact source Host and Channel cache are required')
const mailboxData = new URLSearchParams(location.search).has('mailbox-reading') ? await fetch('./public-mailbox-scene.json').then(response => {
  if (!response.ok) throw Error('The qualified original Mailbox scene is missing')
  return response.json()
}) as { control: AgentSessionControl; sourceHostId: string; timeline: AgentTimelineSnapshot; messages: AgentSessionUserMessage[];
  mailbox: AgentInputMailboxPage & { hostId: string }; actor: ChannelMetadataResult; selectedRecordId: string } : null
const journal = mailboxData?.mailbox.items.flatMap(entry => entry.kind === 'item' ? [entry.item] : [])
  .find(item => inputMailboxPresentation(item).speaker.role === 'external')
const historyMessage = mailboxData?.messages.find(message => message.rawId === mailboxData.selectedRecordId)
const journalView = journal ? inputMailboxPresentation(journal) : null
const journalReading = journalView?.contentBoundary === 'wire' && journalView.text !== null
  ? parseAgentMuxMessagePrefix(journalView.text) : null
if (mailboxData && (!journal || !historyMessage || historyMessage.author.kind !== 'external' ||
    mailboxData.control.agentSessionId !== mailboxData.timeline.agentSessionId || mailboxData.control.agentSessionId !== mailboxData.mailbox.agentSessionId ||
    mailboxData.control.hostId !== data.binding.executionHostId || mailboxData.mailbox.hostId !== mailboxData.control.hostId ||
    mailboxData.sourceHostId !== historyMessage.sourceRecord?.record.hostId ||
    !mailboxData.actor.entry.observation.profile?.avatarUrl)) {
  throw Error('Both original Mailbox row owners, source identity and saved avatar are required')
}
if (mailboxData && (!journalReading?.body.trim() || !journalReading.declaredChannelQuote)) {
  throw Error('The original Mailbox wire must retain its readable body and channel history quote')
}
if (mailboxData) {
  api.sessions.inputMailbox = async (reference, input = {}) => {
    if (reference.hostId !== mailboxData.control.hostId || reference.agentSessionId !== mailboxData.control.agentSessionId || input.cursor) {
      throw Error('Only the original captured Mailbox page is available in this visual scene')
    }
    // The production RuntimeController checks this route and removes the RPC
    // envelope before the shared reader validates its exact page and budget.
    const { hostId, ...page } = structuredClone(mailboxData.mailbox)
    if (hostId !== reference.hostId || page.budgetBytes !== (input.maxBytes ?? 64 * 1024)) {
      throw Error('The original visual Mailbox DTO does not match this exact route and read budget')
    }
    return page
  }
  api.sessions.listMessages = async (reference, input) => ({ hostId: reference.hostId, participantSessionId: reference.agentSessionId,
    direction: input.direction, messages: [], nextBeforeSequence: null })
  api.sessions.onEvent = () => () => {}
}
let presentMailbox: (() => void) | undefined
const listeners = new Set<(change: ChannelMetadataChange) => void>(), proof = { ready: false, failNext: false, calls: [] as string[], copies: [] as string[], errors: [] as string[], rename() {
  data.group.entry.observation.profile!.name = 'Renamed original group'
  notify(data.group)
}, mailbox: mailboxData && journal && historyMessage ? {
  historyKey: mailboxMessageKey({ message: historyMessage }), journalKey: inputMailboxItemKey(mailboxData.control.hostId, journal),
  avatar: mailboxData.actor.entry.observation.profile!.avatarUrl, name: mailboxData.actor.entry.observation.profile!.name,
  historyBody: historyMessage.content, journalBody: journalView!.text,
  journalReading: { body: journalReading!.body, quote: journalReading!.declaredChannelQuote! },
  boundary: 'Qualified original bounded read DTOs in the actual SessionMailbox. No live Core, dispatch or Runtime operation.'
} : null, openMailbox() {
  if (!mailboxData || !presentMailbox) throw Error('The explicit original Mailbox scene is not enabled')
  data.actor = structuredClone(mailboxData.actor)
  presentMailbox()
} }
// The actual card and Desktop clipboard adapter write here after native Copy.
// This private sink records the exact payload; it does not touch the user's clipboard.
api.ui.writeClipboardText = async text => { proof.copies.push(text) }
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
const unusedAction = async () => { throw Error('This read-only Mailbox visual scene has no editing or dispatch intent') }
const readHistory = async () => { throw Error('This visual scene retains only its original bounded read DTOs') }
function OriginalMailbox() {
  const original = mailboxData!
  const history = useAgentInputHistory({ scope: JSON.stringify([original.control.hostId, original.control.agentSessionId]),
    enabled: false, read: readHistory, initialMessages: original.messages })
  const system = useServiceNotices('channel-profile-visual', [], true, false)
  return <SessionMailbox control={original.control} timeline={original.timeline} system={system} queued={[]} visible
    inputHistory={{ history, messages: original.messages, sourceMessages: original.messages, inputs: [], sourceHostId: original.sourceHostId,
      localEntries: [], entries: [], canFill: false, fill: unusedAction, fillText: unusedAction, fillLocal: unusedAction, copy: unusedAction,
      resourceReader: unusedAction, nativeReading: { error: null, observationError: null, windowFrozen: false, refresh: unusedAction },
      setMailboxOpen() {}, setFocused() {} }} />
}
function Profiles() {
  const profiles = useChannelActorProfiles(data.messages.flatMap(message => message.author.kind === 'external' ? [message.author] : []),
    { hostId: data.binding.executionHostId, sourceHostId: data.messages.find(message => message.author.kind === 'external')!.sourceRecord!.record.hostId }, true)
  const describeSpeaker = useMemo(() => createSpeakerResolver({ lookupExternal: author => profiles.get(channelProfileKey(author)) }), [profiles])
  return <DesktopClientUiProvider><main className="channel-profiles-preview">
    <header><div><small>Conversation Channels</small><h1>Original conversation</h1></div>
      <ConnectorHeaderLinks bindings={[data.binding]} issue="" checking={false} retainedSetup={false} syncEnabled nameVersion={0} visible onOpen={() => {}} onConnect={() => {}} onMenuOpen={() => {}} /></header>
    <section aria-label="Original conversation messages">{data.messages.map(message => <ConversationMessage key={message.id} messageId={message.id} content={message.content}
      speaker={speakerOfUserMessage(message)} inputSource={message.source} describeSpeaker={describeSpeaker} publicContent={message.publicContent} recordedIdentity />)}</section>
    <section className="channel-profiles-preview__settings"><h2>{data.connection.config.label}</h2><p>Channel profile cache</p><ChannelMetadataPanel connection={data.connection} active /></section>
  </main></DesktopClientUiProvider>
}
function Fixture() {
  const [mailbox, setMailbox] = useState(false)
  presentMailbox = () => setMailbox(true)
  return mailbox ? <DesktopClientUiProvider><main className="channel-profiles-preview">
    <header><div><small>Original bounded input records</small><h1>Mailbox channel identities</h1></div><OriginalMailbox /></header>
  </main></DesktopClientUiProvider> : <Profiles />
}
createRoot(document.getElementById('root')!).render(<Fixture />)
proof.ready = true
