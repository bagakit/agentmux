import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { useEffect, useState } from 'react'
import { channelMetadataSubjectKey, type ChannelMetadataEntry, type ChannelMetadataResult, type ChannelMetadataSubject, type ConnectionApplication, type RoomBinding } from '@agentmux/core/connections'
import { api } from './api'

type MetadataConnection = { connectionId: string; application: ConnectionApplication }
type MetadataRead = { observation?: ChannelMetadataEntry['observation']; loading: boolean; unconfirmed: boolean }
type MetadataReads = { scope: string; profiles: ReadonlyMap<string, MetadataRead>; updatesUnconfirmed: boolean }
export type ConnectorEntityProfileRead = { observation?: ChannelMetadataEntry['observation']; loading: boolean; issue: string; updatesUnconfirmed?: boolean }

/** One observation owner for the represented objects; native lookup remains the visible room-name policy. */
function useConnectorMetadata(connection: MetadataConnection | null, subjects: readonly ChannelMetadataSubject[], hostingTarget: ConnectionHostingTarget | null | undefined, active: boolean, refresh = 0, refreshMissingRoomName = false) {
  const selected = new Map(subjects.map(subject => [channelMetadataSubjectKey(subject), subject]))
  const identity = JSON.stringify([...selected.keys()].sort())
  const scope = connection ? JSON.stringify([connection.connectionId, connection.application.domain, connection.application.appId,
    hostingTarget === null ? null : hostingTarget ? [hostingTarget.hostId, hostingTarget.runtimeId] : 'local']) : ''
  const [read, setRead] = useState<MetadataReads>({ scope: '', profiles: new Map(), updatesUnconfirmed: false })
  useEffect(() => {
    let live = true
    const retain = (previous: MetadataReads) => new Map([...selected.keys()].flatMap(key => {
      const profile = previous.scope === scope ? previous.profiles.get(key) : undefined
      return profile ? [[key, profile] as const] : []
    }))
    setRead(previous => ({ scope, profiles: retain(previous), updatesUnconfirmed: false }))
    if (!connection || !active || hostingTarget === null || !selected.size) return
    const requests = new Map<string, number>()
    const sameApplication = (application: ConnectionApplication) => application.domain === connection.application.domain && application.appId === connection.application.appId
    const matches = (result: ChannelMetadataResult, key: string) => result.connectionId === connection.connectionId && sameApplication(result.application) && channelMetadataSubjectKey(result.entry.subject) === key
    const load = (key: string, nativeOnMiss: boolean) => {
      if (!live) return
      const subject = selected.get(key)!, request = (requests.get(key) ?? 0) + 1
      requests.set(key, request)
      const current = () => live && requests.get(key) === request
      setRead(previous => {
        if (!current()) return previous
        const profiles = retain(previous)
        profiles.set(key, { ...profiles.get(key), loading: true, unconfirmed: false })
        return { scope, profiles, updatesUnconfirmed: previous.scope === scope && previous.updatesUnconfirmed }
      })
      const finish = (observation?: ChannelMetadataEntry['observation']) => {
        if (!current()) return
        setRead(previous => {
          if (!current()) return previous
          const profiles = retain(previous)
          profiles.set(key, { ...(observation ? { observation } : profiles.get(key)), loading: false, unconfirmed: !observation })
          return { scope, profiles, updatesUnconfirmed: previous.scope === scope && previous.updatesUnconfirmed }
        })
      }
      void (async () => {
        let result = await api.connections.call('connection.metadata.get', { connectionId: connection.connectionId, subject }, hostingTarget)
        if (!current()) return
        if (!matches(result, key)) { finish(); return }
        if (nativeOnMiss && subject.kind === 'conversation' && !result.entry.observation.profile?.name) {
          result = await api.connections.call('connection.metadata.refresh', { connectionId: connection.connectionId, expectedConnectionRevision: result.connectionRevision, subject }, hostingTarget)
        }
        if (!current()) return
        if (!matches(result, key)) { finish(); return }
        finish(result.entry.observation)
      })().catch(() => finish())
    }
    let release: (() => void) | undefined, initialReadStarted = false
    const updateSubscription = (unconfirmed: boolean) => setRead(previous => live ? {
      scope, profiles: retain(previous), updatesUnconfirmed: unconfirmed
    } : previous)
    try {
      release = api.connections.onMetadataChanged(change => {
        if (!live || change.connectionId !== connection.connectionId || !sameApplication(change.application)) return
        const key = channelMetadataSubjectKey(change.subject)
        if (selected.has(key)) load(key, false)
      }, state => {
        if (!live) return
        updateSubscription(state !== 'ready')
        // A later ready notification closes the observation gap, including reconnects.
        if (state === 'ready' && initialReadStarted) for (const key of selected.keys()) load(key, false)
      }, hostingTarget)
    } catch { updateSubscription(true) }
    initialReadStarted = true
    for (const key of selected.keys()) load(key, refreshMissingRoomName)
    return () => { live = false; release?.() }
  }, [scope, identity, active, refresh, refreshMissingRoomName])
  const current = read.scope === scope ? read : undefined
  return { selected, current, loading: Boolean(connection && active && hostingTarget !== null) }
}

/** Parent-level local metadata reads for visible objects. No native lookup, polling or authority inference. */
export function useConnectorEntityProfiles(connection: MetadataConnection | null, subjects: readonly ChannelMetadataSubject[], hostingTarget?: ConnectionHostingTarget | null, active = true): ReadonlyMap<string, ConnectorEntityProfileRead> {
  const { selected, current, loading } = useConnectorMetadata(connection, subjects, hostingTarget, active)
  return new Map([...selected.keys()].map(key => {
    const profile = current?.profiles.get(key)
    const issue = hostingTarget === null ? 'Original bot hosting owner unconfirmed' : [
      profile?.unconfirmed ? 'Profile update unconfirmed' : profile?.observation?.state === 'unavailable' ? 'Profile update unavailable' : profile?.observation && profile.observation.freshness !== 'current' ? 'Profile update unconfirmed' : ''
    ].filter(Boolean).join(' · ')
    return [key, { ...(profile?.observation ? { observation: profile.observation } : {}), loading: loading && (!profile || profile.loading), issue, updatesUnconfirmed: current?.updatesUnconfirmed === true }]
  }))
}

/** Names are local Channel observations; only this visible original group's miss needs a native lookup. */
export function useConnectorRoomName(binding: RoomBinding | null, refresh = 0, visible = true, hostingTarget?: ConnectionHostingTarget | null) {
  const subject: ChannelMetadataSubject | undefined = binding ? { kind: 'conversation', externalConversationId: binding.externalConversationId } : undefined
  const { current, loading } = useConnectorMetadata(binding, subject ? [subject] : [], hostingTarget, visible, refresh, true)
  const profile = subject ? current?.profiles.get(channelMetadataSubjectKey(subject)) : undefined
  const name = profile?.observation?.profile?.name
  const issue = hostingTarget === null ? 'Original bot hosting owner unconfirmed' : [
    profile?.unconfirmed ? 'Group name unconfirmed' : profile?.observation?.state === 'unavailable' ? 'Group name update unavailable' : profile && !name ? 'Group name unconfirmed' : '',
    current?.updatesUnconfirmed ? 'Group name updates unconfirmed' : ''
  ].filter(Boolean).join(' · ')
  return { label: name ?? binding?.externalConversationId ?? '', issue, loading: loading && (!profile || profile.loading), profile: profile?.observation?.profile }
}
