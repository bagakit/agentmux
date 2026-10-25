import { useEffect, useRef, useState } from 'react'
import { channelMetadataSubjectKey, type ChannelMetadataEntry, type ConnectionRecord } from '@agentmux/core/connections'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { ConnectorEntityIdentity, ConnectorIdentityField } from '../ConnectorEntityIdentity'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../../lib/api'
import type { ConnectionSettingsPort } from '../../lib/connection-settings-port'
import '../../styles/channel-metadata.css'

const LoadingIcon = semanticIconComponent('status.loading'), RefreshIcon = semanticIconComponent('action.refresh')

/** The Channel owns its schemas and storage. This panel consumes bounded typed observations only. */
export function ChannelMetadataPanel({ connection, active, connections = api.connections }: { connection: ConnectionRecord; active: boolean; connections?: ConnectionSettingsPort }) {
  const [open, setOpen] = useState(false), [kind, setKind] = useState<'actor' | 'conversation'>('actor')
  const [entries, setEntries] = useState<ChannelMetadataEntry[]>([]), [next, setNext] = useState<string | null>(null)
  const [busy, setBusy] = useState(''), [issue, setIssue] = useState('')
  const scope = JSON.stringify([connection.config.connectionId, connection.config.application.domain, connection.config.application.appId, kind])
  const current = useRef(scope), generation = useRef(0), revision = useRef(connection.revision)
  current.current = scope
  async function read(cursor?: string) {
    const original = scope, request = ++generation.current
    setBusy('read'); setIssue('')
    try {
      const result = await connections.call('connection.metadata.ls', { connectionId: connection.config.connectionId, kind, limit: 10, ...(cursor ? { cursor } : {}) })
      if (current.current !== original || request !== generation.current) return
      revision.current = result.connectionRevision
      setEntries(previous => cursor ? [...previous, ...result.entries] : result.entries); setNext(result.next)
    } catch (error) { if (current.current === original && request === generation.current) setIssue(presentError(error)) }
    finally { if (current.current === original && request === generation.current) setBusy('') }
  }
  useEffect(() => {
    setEntries([]); setNext(null); setIssue('')
    if (active && open) void read()
    return () => { generation.current++ }
  }, [scope, active, open, connections])
  async function change(entry: ChannelMetadataEntry, action: 'refresh' | 'clear') {
    if (busy) return
    const original = scope, request = ++generation.current, key = channelMetadataSubjectKey(entry.subject)
    setBusy(key); setIssue('')
    try {
      const input = { connectionId: connection.config.connectionId, expectedConnectionRevision: revision.current, subject: entry.subject }
      const result = action === 'refresh' ? await connections.call('connection.metadata.refresh', input)
        : await connections.call('connection.metadata.clear', { ...input, expectedCacheRevision: entry.cacheRevision })
      if (current.current === original && generation.current === request) setEntries(previous => previous.map(value => channelMetadataSubjectKey(value.subject) === key ? result.entry : value))
    } catch (error) { if (current.current === original && generation.current === request) setIssue(presentError(error)) }
    finally { if (current.current === original && generation.current === request) setBusy('') }
  }
  return <details className="channel-metadata" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>People & group profiles</summary>
    {open ? <div className="channel-metadata__body" aria-busy={!!busy}>
      <p>Saved names and avatars for this Channel. Refresh reads the platform; clearing a profile keeps messages, bot identities and connections.</p>
      <div className="channel-metadata__toolbar"><div role="group" aria-label="Profile type">
        <button className="small-button" aria-pressed={kind === 'actor'} disabled={!!busy} onClick={() => setKind('actor')}>People</button>
        <button className="small-button" aria-pressed={kind === 'conversation'} disabled={!!busy} onClick={() => setKind('conversation')}>Groups</button>
      </div><button className="small-button" disabled={!!busy} onClick={() => void read()}><RefreshIcon size={13} />Read saved profiles</button></div>
      {busy ? <p className="channel-metadata__status" role="status"><LoadingIcon size={13} animation="spin" />{busy === 'read' ? 'Reading saved profiles…' : 'Updating this profile…'}</p> : null}
      {issue ? <p className="channel-metadata__issue" role="status">{issue} Read saved profiles to check the current result.</p> : null}
      {entries.length ? <ul>{entries.map(entry => {
        const profile = entry.observation.profile, key = channelMetadataSubjectKey(entry.subject)
        const subject = entry.subject.kind === 'actor' ? entry.subject.actor.userId : entry.subject.externalConversationId
        return <li key={key}><div className="channel-metadata__identity">
          <ConnectorEntityIdentity identityKey={JSON.stringify([scope, key])} kind={entry.subject.kind === 'actor' ? 'person' : 'group'} name={profile?.name} missingName="Profile not observed" avatarUrl={profile?.avatarUrl}
            status={<span>{entry.observation.freshness === 'current' ? 'Saved platform profile' : entry.observation.freshness === 'stale' ? 'Saved profile · refresh unconfirmed' : 'No saved profile'}{entry.observation.reason ? ` · ${entry.observation.reason}` : ''}</span>} />
          <ConnectorIdentityField identityKey={JSON.stringify([scope, key])} label={entry.subject.kind === 'actor' ? entry.subject.actor.idType : 'Group ID'} value={subject} compact />
        </div><div className="channel-metadata__actions"><button className="small-button" disabled={!!busy} onClick={() => void change(entry, 'refresh')}>Refresh</button>
          <button className="small-button" disabled={!!busy || !entry.cacheRevision} onClick={() => void change(entry, 'clear')}>Clear saved profile</button></div></li>
      })}</ul> : !busy && !issue ? <p>No saved {kind === 'actor' ? 'people' : 'group'} profiles yet.</p> : null}
      {next ? <button className="small-button" disabled={!!busy} onClick={() => void read(next)}>Read more profiles</button> : null}
    </div> : null}
  </details>
}
