import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { useEffect, useMemo, useState } from 'react'
import { channelMetadataSubjectKey, type ChannelMetadataInput, type ChannelMetadataEntry, type ChannelMetadataResult, type ChannelMetadataSubject, type ConnectionApplication, type RoomBinding } from '@agentmux/core/connections'
import { api } from './api'
import { presentError } from '@agentmux/client-ui/error-presentation'

type MetadataConnection = { connectionId: string; application: ConnectionApplication }
type MetadataRead = { observation?: ChannelMetadataEntry['observation']; loading: boolean; unconfirmed: boolean; updatesUnconfirmed?: boolean; error?: string | undefined }
export type ConnectorEntityProfileRead = { observation?: ChannelMetadataEntry['observation']; loading: boolean; issue: string; updatesUnconfirmed?: boolean }
export type ConnectorProfileGroup = { connection: MetadataConnection; subjects: readonly ChannelMetadataSubject[]; hostingTarget?: ConnectionHostingTarget | null | undefined }
const hostingKey = (target: ConnectionHostingTarget | null | undefined) => JSON.stringify(target === null ? null : target ? [target.hostId, target.runtimeId] : 'local')
export const connectorProfileGroupKey = ({ connection, hostingTarget }: ConnectorProfileGroup) =>
  JSON.stringify([hostingKey(hostingTarget), connection.connectionId, connection.application.domain, connection.application.appId])

// Only outstanding requests are shared. Completed observations remain in the Channel owner.
const refreshes = new Map<string, Promise<ChannelMetadataResult>>()
export function refreshConnectorProfile(input: ChannelMetadataInput, hostingTarget?: ConnectionHostingTarget) {
  const key = JSON.stringify([hostingTarget ?? 'local', input.connectionId, input.expectedConnectionRevision, channelMetadataSubjectKey(input.subject)])
  const existing = refreshes.get(key)
  if (existing) return existing
  const pending = api.connections.call('connection.metadata.refresh', input, hostingTarget)
  refreshes.set(key, pending)
  void pending.finally(() => { if (refreshes.get(key) === pending) refreshes.delete(key) }).catch(() => {})
  return pending
}

/** One visible reading owns a bounded set of exact subjects and one watch per hosting owner. */
export function useConnectorProfileGroups(groups: readonly ConnectorProfileGroup[], active = true, refresh = 0, readMissing: false | 'name' | 'profile' = 'profile') {
  const selected = new Map<string, { group: ConnectorProfileGroup; subject: ChannelMetadataSubject }>()
  for (const group of groups) for (const subject of group.subjects)
    selected.set(JSON.stringify([connectorProfileGroupKey(group), channelMetadataSubjectKey(subject)]), { group, subject })
  const identity = JSON.stringify([...selected.keys()].sort())
  const [read, setRead] = useState<ReadonlyMap<string, MetadataRead>>(new Map())
  useEffect(() => {
    let live = true
    const retain = (previous: ReadonlyMap<string, MetadataRead>) => new Map([...selected.keys()].flatMap(key => {
      const profile = previous.get(key)
      return profile ? [[key, profile] as const] : []
    }))
    setRead(retain)
    if (!active || !selected.size) return
    const requests = new Map<string, number>(), pendingReads = new Map<string, number>()
    const load = async (key: string, nativeOnMiss: boolean) => {
      const { group: { connection, hostingTarget }, subject } = selected.get(key)!
      if (!live || hostingTarget === null) return
      const request = (requests.get(key) ?? 0) + 1
      requests.set(key, request); pendingReads.set(key, request)
      const current = () => live && requests.get(key) === request
      const matches = (result: ChannelMetadataResult) => result.connectionId === connection.connectionId &&
        result.application.domain === connection.application.domain && result.application.appId === connection.application.appId &&
        channelMetadataSubjectKey(result.entry.subject) === channelMetadataSubjectKey(subject)
      const finish = (observation?: ChannelMetadataEntry['observation'], loading = false, unconfirmed = !observation, error?: string) => {
        if (!current()) return
        setRead(previous => {
          if (!current()) return previous
          const profiles = retain(previous)
          profiles.set(key, { ...profiles.get(key), ...(observation ? { observation } : {}), loading, unconfirmed, error })
          return profiles
        })
      }
      finish(undefined, true, false)
      try {
        let result = await api.connections.call('connection.metadata.get', { connectionId: connection.connectionId, subject }, hostingTarget)
        if (!current()) return
        if (!matches(result)) { finish(); return }
        const observation = result.entry.observation
        const missing = !observation.profile?.name || readMissing === 'profile' && !observation.profile?.avatarUrl
        if (nativeOnMiss && missing) {
          finish(observation, true)
          result = await refreshConnectorProfile({ connectionId: connection.connectionId, expectedConnectionRevision: result.connectionRevision, subject }, hostingTarget)
        }
        if (!current()) return
        if (!matches(result)) { finish(); return }
        finish(result.entry.observation)
      } catch (error) { finish(undefined, false, true, presentError(error)) }
      finally { if (pendingReads.get(key) === request) pendingReads.delete(key) }
    }
    const owners = new Map<string, { target: ConnectionHostingTarget | undefined; keys: Set<string> }>()
    for (const [key, { group }] of selected) {
      if (group.hostingTarget === null) continue
      const id = hostingKey(group.hostingTarget), owner = owners.get(id) ?? { target: group.hostingTarget, keys: new Set<string>() }
      owner.keys.add(key); owners.set(id, owner)
    }
    const releases: Array<() => void> = []
    let initialReadStarted = false
    for (const { target, keys } of owners.values()) {
      const updateSubscription = (unconfirmed: boolean) => setRead(previous => {
        if (!live) return previous
        const profiles = retain(previous)
        for (const key of keys) profiles.set(key, { loading: false, unconfirmed: false, ...profiles.get(key), updatesUnconfirmed: unconfirmed })
        return profiles
      })
      try {
        releases.push(api.connections.onMetadataChanged(change => {
          if (!live) return
          for (const key of keys) {
            const { group: { connection }, subject } = selected.get(key)!
            if (change.connectionId === connection.connectionId && change.application.domain === connection.application.domain &&
              change.application.appId === connection.application.appId && channelMetadataSubjectKey(change.subject) === channelMetadataSubjectKey(subject)) void load(key, false)
          }
        }, state => {
          if (!live) return
          updateSubscription(state !== 'ready')
          if (state === 'ready' && initialReadStarted) for (const key of keys) if (!pendingReads.has(key)) void load(key, false)
        }, target))
      } catch { updateSubscription(true) }
    }
    initialReadStarted = true
    const remaining = selected.keys()
    // Leaving this represented set stops queued work; an already issued native read retains its owner.
    for (let worker = 0; worker < Math.min(4, selected.size); worker++) void (async () => {
      while (live) {
        const next = remaining.next()
        if (next.done) return
        await load(next.value, readMissing !== false)
      }
    })()
    return () => { live = false; for (const release of releases) release() }
  }, [identity, active, refresh, readMissing, api.connections.call, api.connections.onMetadataChanged])
  return useMemo(() => {
  const result = new Map<string, Map<string, ConnectorEntityProfileRead>>()
  for (const [key, { group, subject }] of selected) {
    const profile = read.get(key), groupKey = connectorProfileGroupKey(group), profiles = result.get(groupKey) ?? new Map()
    const issue = group.hostingTarget === null ? 'Original bot hosting owner unconfirmed' :
      profile?.unconfirmed ? profile.error ?? 'Profile update unconfirmed' : profile?.observation?.state === 'unavailable' ? 'Profile update unavailable' :
        profile?.observation && profile.observation.freshness !== 'current' ? 'Profile update unconfirmed' : ''
    profiles.set(channelMetadataSubjectKey(subject), { ...(profile?.observation ? { observation: profile.observation } : {}),
      loading: active && group.hostingTarget !== null && (!profile || profile.loading), issue, updatesUnconfirmed: profile?.updatesUnconfirmed === true })
    result.set(groupKey, profiles)
  }
  return result
  }, [identity, read, active])
}

/** Visible objects share metadata, missing-profile lookup and change observations. */
export function useConnectorEntityProfiles(connection: MetadataConnection | null, subjects: readonly ChannelMetadataSubject[], hostingTarget?: ConnectionHostingTarget | null, active = true): ReadonlyMap<string, ConnectorEntityProfileRead> {
  const group = connection ? { connection, subjects, hostingTarget } : undefined
  const reads = useConnectorProfileGroups(group ? [group] : [], active)
  return group ? reads.get(connectorProfileGroupKey(group)) ?? new Map() : new Map()
}

/** Names are Channel observations; only this visible original group's miss needs a native lookup. */
export function useConnectorRoomName(binding: RoomBinding | null, refresh = 0, visible = true, hostingTarget?: ConnectionHostingTarget | null) {
  const subject: ChannelMetadataSubject | undefined = binding ? { kind: 'conversation', externalConversationId: binding.externalConversationId } : undefined
  const group = binding && subject ? { connection: binding, subjects: [subject], hostingTarget } : undefined
  const reads = useConnectorProfileGroups(group ? [group] : [], visible, refresh, 'name')
  const profile = group && subject ? reads.get(connectorProfileGroupKey(group))?.get(channelMetadataSubjectKey(subject)) : undefined
  const name = profile?.observation?.profile?.name
  const issue = [profile?.issue, profile?.updatesUnconfirmed ? 'Group name updates unconfirmed' : '',
    profile?.observation && !name ? 'Group name unconfirmed' : ''].filter(Boolean).join(' · ')
  return { label: name ?? binding?.externalConversationId ?? '', issue, loading: profile?.loading ?? false, profile: profile?.observation?.profile }
}
