import { useEffect, useMemo, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { parseMotePreferencesReadResult, type MoteConnectionPreferencesReadResult } from '@agentmux/core/mote-preferences'
import type { ConnectionRecord } from '@agentmux/core/connections'
import type { MoteChatConfiguration } from '@agentmux/core/mote-chat'
import { SCRATCH_WORKSPACE_ID, scratchTopicLogicalPath } from '../../../../shared/scratch-topics'
import { useScratchTopics } from '../../hooks/useScratchTopics'
import { scratchMoteTopics } from '../../lib/scratch-topic-snapshots'
import { moteConnectionChoice, moteConnectionTarget } from '../../lib/mote-connection-default'
import { api } from '../../lib/api'
import type { MoteWorkfaceScope } from '../../lib/mote-workface'
import { useAppStore } from '../../store'
import { SpaceObjectIcon } from '../SpaceObjectIcon'
import type { MoteLarkSettingsOrigin } from '../SettingsNavigation'

export type MoteIdentityReading = {
  scope: MoteWorkfaceScope
  target: ReturnType<typeof moteConnectionTarget>
  saved: MoteConnectionPreferencesReadResult | null
  issue: string
  chat: MoteChatConfiguration | null
  chatRead: boolean
  chatIssue: string
}

/** One metadata read per original Mote, shared by its card and the saved identity library. */
export function useMoteIdentityReadings(active: boolean, revision: number) {
  const workspace = useAppStore(state => state.config?.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID))
  const bindings = useAppStore(state => state.spaceZoneBindings)
  const directory = useScratchTopics(workspace?.id ?? null, active)
  const scopes = useMemo(() => workspace && directory.topics ? scratchMoteTopics(directory.topics).flatMap(topic => {
    const rootPath = scratchTopicLogicalPath(workspace, topic)
    return rootPath === null ? [] : [{ topic, workspace, rootPath }]
  }) : [], [workspace, directory.topics])
  const targets = scopes.map(scope => moteConnectionTarget(scope, bindings)), identity = JSON.stringify(targets)
  const [readings, setReadings] = useState<{ identity: string; items: MoteIdentityReading[]; reading: boolean }>({ identity: '', items: [], reading: false })
  const [attempt, setAttempt] = useState(0), lifetime = useRef(0)
  useEffect(() => {
    const epoch = ++lifetime.current
    if (!active) return
    setReadings(current => ({ identity, items: current.identity === identity ? current.items : [], reading: true }))
    void Promise.all(scopes.map(async (scope, index): Promise<MoteIdentityReading> => {
      const target = targets[index]!
      if (!target) return { scope, target, saved: null, issue: 'The original Mote home is not confirmed.', chat: null, chatRead: false, chatIssue: 'The original Mote home is not confirmed.' }
      const input = { kind: 'connection' as const, target }
      const [preference, chat] = await Promise.allSettled([api.motePreferences.read(input).then(value => parseMotePreferencesReadResult(value, input)), api.moteChat.call('space.mote.chat.inspect', { target })])
      return { scope, target, saved: preference.status === 'fulfilled' ? preference.value : null,
        issue: preference.status === 'fulfilled' ? preference.value.issue ?? '' : presentError(preference.reason),
        chat: chat.status === 'fulfilled' ? chat.value.configuration : null, chatRead: chat.status === 'fulfilled', chatIssue: chat.status === 'rejected' ? presentError(chat.reason) : '' }
    })).then(items => { if (epoch === lifetime.current) setReadings({ identity, items, reading: false }) })
    return () => { lifetime.current++ }
  }, [active, identity, revision, attempt])
  const current = readings.identity === identity ? readings : null
  const items = scopes.map((scope, index) => current?.items[index]
    ? { ...current.items[index]!, scope } : { scope, target: targets[index]!, saved: null, issue: '', chat: null, chatRead: false, chatIssue: '' })
  return { items, reading: directory.reading || !current || current.reading, issue: directory.error,
    complete: directory.topics !== null && !directory.reading && !directory.error && !!current && !current.reading && items.every(item => item.saved?.status === 'ready' && item.chatRead),
    refresh: () => setAttempt(value => value + 1) }
}
export type MoteIdentityReadings = ReturnType<typeof useMoteIdentityReadings>

function MoteIdentityCard({ reading, records, recordsIssue, onOpen, onRetry }: {
  reading: MoteIdentityReading; records: ConnectionRecord[]; recordsIssue: string
  onOpen(origin: MoteLarkSettingsOrigin, create: boolean): void; onRetry(): void
}) {
  const { scope, target, saved, issue } = reading
  const icon = useAppStore(state => target ? state.spaceObjectIcons[target.spaceId] ?? null : null)
  const ref = saved?.values?.connection
  const choice = ref && !recordsIssue ? moteConnectionChoice(ref, records) : null
  const unbound = !issue && saved?.status === 'ready' && saved.values?.connection === null
  const origin = { target, topicId: scope.topic.id, moteName: scope.topic.title }
  const status = issue || saved?.status === 'unconfirmed' ? 'Identity not confirmed'
    : ref ? choice?.record?.config.label ?? 'Saved identity'
    : unbound ? 'No identity yet' : 'Reading identity…'
  return <article className="connector-mote-card" data-mote-identity={scope.topic.id} data-identity-state={unbound ? 'unbound' : ref ? 'bound' : 'unconfirmed'}>
    <button type="button" className="connector-mote-card__identity" aria-label={`View identity for ${scope.topic.title}`} onClick={() => onOpen(origin, false)}>
      <span className="connector-mote-card__avatar"><SpaceObjectIcon kind="mote" name={scope.topic.title} manualIcon={icon}
        avatarWorkspaceId={scope.workspace.id} avatarTopicId={scope.topic.id} avatarObjectKey={target?.spaceId} /></span>
      <span><strong>{scope.topic.title}</strong><small>{status}</small></span>
    </button>
    <p className="connector-mote-card__caption">{ref ? `${ref.application.domain === 'open.feishu.cn' ? 'Feishu' : ref.application.domain === 'open.larksuite.com' ? 'Lark' : ref.application.domain} · ${choice?.issue || recordsIssue ? 'Needs attention' : 'Default identity'}` : unbound ? 'Uses this Mote’s saved profile.' : 'Your saved choice is kept.'}</p>
    {issue ? <p className="connector-mote-card__issue" role="status">{issue}</p> : null}
    <div className="connector-mote-card__actions">
      <button type="button" className={unbound ? 'primary-button' : 'small-button'} data-mote-card-action={unbound ? 'create' : 'manage'} onClick={() => onOpen(origin, unbound)}>{unbound ? 'Create Feishu identity' : ref ? 'Manage identity' : 'Review identity'}</button>
      {unbound ? <button type="button" className="connector-enrollment__text-action" onClick={() => onOpen(origin, false)}>Use existing</button> : issue ? <button type="button" className="connector-enrollment__text-action" onClick={onRetry}>Retry</button> : null}
    </div>
  </article>
}

/** Cards consume the same bounded readings as the saved identity list. */
export function MoteIdentityCards({ readings, records, recordsIssue, onOpen }: {
  readings: MoteIdentityReadings; records: ConnectionRecord[]; recordsIssue: string; onOpen(origin: MoteLarkSettingsOrigin, create: boolean): void
}) {
  return <section className="connector-mote-identities" aria-label="Mote identities">
    <header><div><h3>Mote identities</h3><p>Choose a Mote to create or manage its identity.</p></div><span className="connector-identity-count">{readings.items.length || null}</span></header>
    {readings.items.length ? <div className="connector-mote-grid">{readings.items.map(reading => <MoteIdentityCard key={JSON.stringify([reading.scope.workspace.hostId, reading.scope.workspace.id, reading.scope.topic.id])} reading={reading} records={records} recordsIssue={recordsIssue} onOpen={onOpen} onRetry={readings.refresh} />)}</div>
      : <p className="settings-group-note" role="status">{readings.reading ? 'Reading your Motes…' : readings.issue ? 'Your Motes could not be read. Saved identities remain available below.' : 'Create an identity for a Mote here, or add a general identity for any Agent.'}</p>}
  </section>
}
