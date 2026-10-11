import { useEffect, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { parseMotePreferencesReadResult, type MoteConnectionPreferencesReadResult } from '@agentmux/core/mote-preferences'
import type { ConnectionRecord } from '@agentmux/core/connections'
import { SCRATCH_WORKSPACE_ID, scratchTopicLogicalPath } from '../../../../shared/scratch-topics'
import { useScratchTopics } from '../../hooks/useScratchTopics'
import { scratchMoteTopics } from '../../lib/scratch-topic-snapshots'
import { moteConnectionChoice, moteConnectionTarget } from '../../lib/mote-connection-default'
import { api } from '../../lib/api'
import type { MoteWorkfaceScope } from '../../lib/mote-workface'
import { useAppStore } from '../../store'
import { SpaceObjectIcon } from '../SpaceObjectIcon'
import type { MoteConnectorSettingsOrigin } from '../SettingsNavigation'

function MoteIdentityCard({ scope, records, recordsIssue, onOpen }: {
  scope: MoteWorkfaceScope; records: ConnectionRecord[]; recordsIssue: string
  onOpen(origin: MoteConnectorSettingsOrigin, create: boolean): void
}) {
  const bindings = useAppStore(state => state.spaceZoneBindings)
  const target = moteConnectionTarget(scope, bindings), identity = JSON.stringify(target)
  const icon = useAppStore(state => target ? state.spaceObjectIcons[target.spaceId] ?? null : null)
  const [saved, setSaved] = useState<MoteConnectionPreferencesReadResult | null>(null), [issue, setIssue] = useState('')
  const lifetime = useRef(0)
  async function read() {
    const epoch = ++lifetime.current
    if (!target) { setIssue('The original Mote home is not confirmed.'); return }
    try {
      const input = { kind: 'connection' as const, target }
      const value = parseMotePreferencesReadResult(await api.motePreferences.read(input), input)
      if (epoch === lifetime.current) { setSaved(value); setIssue(value.issue ?? '') }
    } catch (error) { if (epoch === lifetime.current) setIssue(presentError(error)) }
  }
  useEffect(() => { setSaved(null); setIssue(''); void read(); return () => { lifetime.current++ } }, [identity])
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
      {unbound ? <button type="button" className="connector-enrollment__text-action" onClick={() => onOpen(origin, false)}>Use existing</button> : issue ? <button type="button" className="connector-enrollment__text-action" onClick={() => void read()}>Retry</button> : null}
    </div>
  </article>
}

/** The original directory and preferences are read only while this library is visible. */
export function MoteIdentityCards({ records, recordsIssue, onOpen }: {
  records: ConnectionRecord[]; recordsIssue: string; onOpen(origin: MoteConnectorSettingsOrigin, create: boolean): void
}) {
  const workspace = useAppStore(state => state.config?.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID))
  const { topics, reading, error } = useScratchTopics(workspace?.id ?? null)
  const scopes = workspace && topics ? scratchMoteTopics(topics).flatMap(topic => {
    const rootPath = scratchTopicLogicalPath(workspace, topic)
    return rootPath === null ? [] : [{ topic, workspace, rootPath }]
  }) : []
  return <section className="connector-mote-identities" aria-label="Mote identities">
    <header><div><h3>Mote identities</h3><p>Choose a Mote to create or manage its identity.</p></div><span className="connector-identity-count">{scopes.length || null}</span></header>
    {scopes.length ? <div className="connector-mote-grid">{scopes.map(scope => <MoteIdentityCard key={JSON.stringify([scope.workspace.hostId, scope.workspace.path, scope.topic.id])} scope={scope} records={records} recordsIssue={recordsIssue} onOpen={onOpen} />)}</div>
      : <p className="settings-group-note" role="status">{reading ? 'Reading your Motes…' : error ? 'Your Motes could not be read. Saved identities remain available below.' : 'Create an identity for a Mote here, or add a general identity for any Agent.'}</p>}
    {error && scopes.length ? <p role="status" className="settings-group-note">{error}</p> : null}
  </section>
}
