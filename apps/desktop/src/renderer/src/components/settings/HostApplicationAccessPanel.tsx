import { useEffect, useRef, useState } from 'react'
import type { ApplicationAccessConfiguration, ApplicationAccessEndpoint, ApplicationAccessObservation,
  ApplicationAccessOperation, ApplicationAccessPlan, ApplicationAccessProfile } from '@agentmux/core'
import { mintObjectId } from '@agentmux/core/object-id'
import { APPLICATION_ACCESS_NOT_APPLIED_CODES, APPLICATION_ACCESS_SCHEMA } from '@agentmux/core/application-access'
import { TextInput } from '@agentmux/client-ui/input'
import type { HostConfig } from '../../../../shared/contracts'
import { configValuesEqual } from '../../../../shared/config-edit'
import { api } from '../../lib/api'
import { ConfirmationDialog } from '../ConfirmationDialog'

type DraftEndpoint = ApplicationAccessEndpoint & { argumentsText: string }
type Draft = { id: string; revision: string | null; label: string; applicationId: string; accountId: string;
  scopesText: string; source: DraftEndpoint; target: DraftEndpoint }
type PendingRequest = { id: string; profileId: string; planId: string; applicationId: string; scopes: string[];
  target: Pick<ApplicationAccessEndpoint, 'hostId' | 'runtimeId' | 'osAccount'> }
const dispositionText: Record<ApplicationAccessPlan['disposition'], string> = {
  transfer: 'Ready to synchronize', reuse: 'Target access can be reused', 'source-login-required': 'Sign in at the source first',
  'target-login-required': 'Sign in on the target', conflict: 'The target uses another account',
  unsupported: 'This connector cannot transfer this access', unknown: 'Access could not be confirmed'
}
function endpoint(host: HostConfig): DraftEndpoint {
  return { hostId: host.id, runtimeId: host.kind === 'ssh' ? host.runtimeId ?? '' : '', osAccount: '', command: '', args: [], argumentsText: '[]' }
}
function draftOf(config: ApplicationAccessConfiguration): Draft {
  const p = config.profile
  return { id: config.profileId, revision: config.revision, label: p.label, applicationId: p.applicationId,
    accountId: p.accountId, scopesText: p.scopes.join('\n'), source: { ...p.source, argumentsText: JSON.stringify(p.source.args) },
    target: { ...p.target, argumentsText: JSON.stringify(p.target.args) } }
}
function profileOf(draft: Draft): ApplicationAccessProfile {
  function parseEndpoint(value: DraftEndpoint): ApplicationAccessEndpoint {
    const args: unknown = JSON.parse(value.argumentsText)
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('Connector arguments must be a JSON array of strings.')
    return { hostId: value.hostId, runtimeId: value.runtimeId.trim(), osAccount: value.osAccount.trim(), command: value.command.trim(), args }
  }
  return { label: draft.label.trim(), applicationId: draft.applicationId.trim(), accountId: draft.accountId.trim(),
    scopes: [...new Set(draft.scopesText.split('\n').map(scope => scope.trim()).filter(Boolean))], source: parseEndpoint(draft.source), target: parseEndpoint(draft.target) }
}
const message = (error: unknown) => error instanceof Error ? error.message : 'The application service did not confirm this request.'

/** A projection of the one public application owner; no credentials or durable operation ledger in the Renderer. */
export function HostApplicationAccessPanel({ host, committed, hosts, active }: {
  host: HostConfig; committed: HostConfig | undefined; hosts: HostConfig[]; active: boolean
}) {
  const [configurations, setConfigurations] = useState<ApplicationAccessConfiguration[]>([])
  const [operations, setOperations] = useState<ApplicationAccessOperation[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [plan, setPlan] = useState<ApplicationAccessPlan | null>(null)
  const [stalePlanId, setStalePlanId] = useState<string | null>(null)
  const [requested, setRequested] = useState<PendingRequest | null>(null)
  const [operationId, setOperationId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [remove, setRemove] = useState<ApplicationAccessConfiguration | null>(null)
  const mounted = useRef(true)
  const readEpoch = useRef(0)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++readEpoch.current } }, [])
  const saved = committed !== undefined && configValuesEqual(host, committed)
  const configuration = configurations.find(item => item.profileId === selected)
  const operation = operations.find(item => item.operationId === operationId)
  const matchingPlan = plan?.profileId === selected ? plan : null
  const currentPlan = matchingPlan && matchingPlan.configurationRevision === configuration?.revision && matchingPlan.planId !== stalePlanId
  const usedPlan = matchingPlan && (operations.some(item => item.planId === matchingPlan.planId) || requested?.planId === matchingPlan.planId)
  const overlapsCurrent = (item: Pick<ApplicationAccessOperation, 'target' | 'applicationId' | 'scopes'>): boolean => {
    const p = configuration?.profile
    return !!p && item.target.runtimeId === p.target.runtimeId && item.target.osAccount === p.target.osAccount &&
      item.applicationId === p.applicationId && item.scopes.some(scope => p.scopes.includes(scope))
  }
  const unresolved = operations.some(item => (item.status === 'pending' || item.status === 'unknown') && overlapsCurrent(item)) || !!requested && overlapsCurrent(requested)
  const hostName = (id: string) => hosts.find(item => item.id === id)?.label ?? id

  async function read(): Promise<void> {
    const epoch = ++readEpoch.current
    try {
      const next = await api.applications.call('settings.applications.ls', { hostId: host.id })
      if (!mounted.current || epoch !== readEpoch.current) return
      setConfigurations(next.configurations); setOperations(next.operations); setLoaded(true)
      setSelected(previous => previous ?? next.configurations[0]?.profileId ?? null)
      setOperationId(previous => previous ?? next.operations[0]?.operationId ?? null)
      setError(null)
    } catch (failure) { if (mounted.current && epoch === readEpoch.current) setError(message(failure)) }
  }
  useEffect(() => { if (active) void read() }, [active, host.id])

  async function perform(label: string, work: () => Promise<void>): Promise<void> {
    if (busy) return
    setBusy(label); setError(null)
    try { await work() } catch (failure) { if (mounted.current) setError(message(failure)) }
    finally { if (mounted.current) setBusy(null) }
  }
  function add(): void {
    const source = hosts.find(item => item.kind === 'local') ?? hosts[0] ?? host
    setDraft({ id: mintObjectId(), revision: null, label: '', applicationId: '', accountId: '', scopesText: '', source: endpoint(source), target: endpoint(host) })
    setError(null)
  }
  async function saveDraft(): Promise<void> {
    if (!draft) return
    const captured = draft, profile = profileOf(captured)
    ++readEpoch.current
    const result = await api.applications.call('settings.applications.configure', { profileId: captured.id, expectedRevision: captured.revision, profile })
    if (!mounted.current) return
    ++readEpoch.current
    setConfigurations(current => [...current.filter(item => item.profileId !== result.profileId), result])
    setSelected(result.profileId); setDraft(current => current === captured ? null : current)
  }
  async function compare(): Promise<void> {
    if (!configuration) return
    const result = await api.applications.call('settings.applications.plan', { profileId: configuration.profileId, expectedRevision: configuration.revision })
    if (mounted.current) { setPlan(result); setStalePlanId(null) }
  }
  function acceptOperation(result: ApplicationAccessOperation): void {
    if (!mounted.current) return
    ++readEpoch.current
    setOperations(current => [result, ...current.filter(item => item.operationId !== result.operationId)])
    setOperationId(result.operationId)
    setRequested(current => current?.id === result.operationId ? null : current)
  }
  async function apply(): Promise<void> {
    if (!configuration || !matchingPlan || !currentPlan || usedPlan || unresolved) return
    const p = configuration.profile
    const intent: PendingRequest = { id: mintObjectId(), profileId: matchingPlan.profileId, planId: matchingPlan.planId,
      applicationId: p.applicationId, scopes: [...p.scopes], target: { hostId: p.target.hostId, runtimeId: p.target.runtimeId, osAccount: p.target.osAccount } }
    ++readEpoch.current
    setRequested(intent); setOperationId(intent.id)
    // Keep this exact ID if the response is lost. Reading it must never become another apply.
    try {
      const result = await api.applications.call('settings.applications.apply', { profileId: intent.profileId, planId: matchingPlan.planId, operationId: intent.id })
      acceptOperation(result)
    } catch (failure) {
      const code = failure && typeof failure === 'object' && 'code' in failure ? failure.code : undefined
      if (mounted.current && typeof code === 'string' && APPLICATION_ACCESS_NOT_APPLIED_CODES.includes(code)) {
        setRequested(current => current?.id === intent.id ? null : current)
        setStalePlanId(matchingPlan.planId)
      }
      throw failure
    }
  }
  async function inspectOriginal(id: string): Promise<void> {
    acceptOperation(await api.applications.call('settings.applications.operation', { operationId: id }))
  }

  return <section className="application-access" data-application-host={host.id} aria-label="Application account synchronization">
    <header className="application-access__header"><div><strong>Application accounts</strong><p>Bring selected application access to {host.label}.</p></div>
      <button type="button" className="small-button" disabled={!!busy} onClick={() => void perform('Reading applications', read)}>Refresh</button></header>
    {!saved ? <p className="field-hint">Save this environment connection before configuring or synchronizing application access.</p> : null}
    {configurations.length ? <div className="application-access__rules" aria-label="Application rules">{configurations.map(item => <button key={item.profileId}
      type="button" aria-pressed={item.profileId === selected} className="application-access__rule" onClick={() => {
        setSelected(item.profileId); setOperationId(operations.find(operation => operation.profileId === item.profileId)?.operationId ?? null); setError(null)
      }}>
      <strong>{item.profile.label}</strong><span>{hostName(item.profile.source.hostId)} → {hostName(item.profile.target.hostId)}</span>
      <small>{item.profile.accountId} · {item.profile.scopes.length} scopes</small></button>)}</div> : loaded ? <p className="application-access__empty">No application rules configured. Add a connector for the application you want to use here.</p> : !error ? <p role="status">Reading application rules…</p> : null}
    {!draft ? <div className="application-access__actions"><button type="button" className="small-button" disabled={!saved || !!busy} onClick={add}>Add application</button>
      {configuration ? <><button type="button" className="small-button" disabled={!saved || !!busy} onClick={() => setDraft(draftOf(configuration))}>Edit rule</button>
        <button type="button" className="small-button" disabled={!!busy} onClick={() => setRemove(configuration)}>Remove rule</button></> : null}</div> : null}
    {draft ? <form className="application-access__editor" aria-label="Application connector rule" onSubmit={event => { event.preventDefault(); void perform('Saving rule', saveDraft) }}>
      <header><strong>{draft.revision ? 'Edit application rule' : 'Add an application connector'}</strong><p>Use an application access connector on each account. Save commands and scope here; credentials stay with the application.</p></header>
      <details><summary>Connector requirements</summary><p>Each command implements <code>{APPLICATION_ACCESS_SCHEMA}</code>: application identity and scope checks, scoped transfer, target verification and original operation lookup. Use arguments for non-sensitive options; credential material travels through stdin.</p></details>
      <div className="application-access__fields">
        <label><span>Name</span><TextInput required value={draft.label} onChange={event => setDraft({ ...draft, label: event.target.value })} /></label>
        <label><span>Application ID</span><TextInput required value={draft.applicationId} onChange={event => setDraft({ ...draft, applicationId: event.target.value })} /></label>
        <label className="application-access__full"><span>Expected application account</span><TextInput required value={draft.accountId} onChange={event => setDraft({ ...draft, accountId: event.target.value })} /></label>
        <label className="application-access__full"><span>Scopes <small>one per line</small></span><textarea required rows={3} value={draft.scopesText} onChange={event => setDraft({ ...draft, scopesText: event.target.value })} /></label>
      </div>
      <div className="application-access__endpoints">{(['source', 'target'] as const).map(side => <EndpointEditor key={side} title={side === 'source' ? 'Source' : 'Target'}
        value={draft[side]} hosts={side === 'target' ? hosts.filter(item => item.id === host.id) : hosts}
        onChange={value => setDraft(current => current ? { ...current, [side]: value } : current)} />)}</div>
      <div className="application-access__actions"><button className="primary-button" type="submit" disabled={!saved || !!busy}>Save application rule</button>
        <button className="small-button" type="button" disabled={!!busy} onClick={() => setDraft(null)}>Cancel editing</button></div>
    </form> : null}
    {configuration && !draft ? <div className="application-access__comparison">
      <div className="application-access__scope"><strong>{configuration.profile.accountId}</strong><span>{configuration.profile.scopes.join(' · ')}</span></div>
      <button type="button" className="small-button" disabled={!saved || !!busy} onClick={() => void perform('Comparing access', compare)}>Compare access</button>
      {matchingPlan ? <div className="application-access__plan" role="status"><strong>{usedPlan ? 'Comparison for the original operation' : dispositionText[matchingPlan.disposition]}</strong>
        <time dateTime={matchingPlan.createdAt}>Compared {new Date(matchingPlan.createdAt).toLocaleString()}</time>
        {usedPlan ? <p>These checks preceded the original operation. Its result is shown below.</p> : null}
        <div className="application-access__observations"><AccessObservation title="Source" value={matchingPlan.source} /><AccessObservation title="Target" value={matchingPlan.target} /></div>
        {!currentPlan ? <p>This comparison is no longer current. Compare access again before synchronizing.</p> : null}
        {currentPlan && !usedPlan && ['transfer', 'reuse'].includes(matchingPlan.disposition) ? <button type="button" className="primary-button" disabled={!saved || !!busy || unresolved}
          onClick={() => void perform('Synchronizing access', apply)}>{matchingPlan.disposition === 'reuse' ? 'Verify existing target access' : 'Synchronize selected access'}</button> : null}
      </div> : <p className="field-hint">Compare the two accounts before making any changes.</p>}
    </div> : null}
    {operations.length ? <div className="application-access__operations"><strong>Recent and unresolved operations</strong><div>{operations.map(item => <button className="application-access__operation-link"
      key={item.operationId} type="button" aria-pressed={item.operationId === operationId} onClick={() => setOperationId(item.operationId)}>
      <span>{item.applicationId} · {item.accountId}</span><span>{item.status === 'succeeded' ? 'Verified' : item.status === 'unknown' ? 'Result unconfirmed' : item.status === 'pending' ? 'In progress' : 'Not completed'}</span>
    </button>)}</div></div> : null}
    {requested && !operations.some(item => item.operationId === requested.id) ? <div className="application-access__result" role="status"><strong>Synchronization result not confirmed</strong>
      <p>The original request is retained. Check its result before making another transfer.</p><button type="button" className="small-button" disabled={!!busy}
        onClick={() => void perform('Checking original operation', () => inspectOriginal(requested.id))}>Check original operation</button><details><summary>Original request</summary><code>{requested.id}</code></details></div> : null}
    {operation ? <div className="application-access__result" role="status"><strong>{operation.status === 'succeeded' ? 'Target account and scopes verified' : operation.status === 'unknown' ? 'Synchronization result not confirmed' : operation.status === 'pending' ? 'Synchronization in progress' : 'Synchronization not completed'}</strong>
      <p>{operation.accountId} · {operation.scopes.join(' · ')}</p><p>Last confirmed stage: {operation.stage.replaceAll('-', ' ')}</p>
      <time dateTime={operation.updatedAt}>{new Date(operation.updatedAt).toLocaleString()}</time>
      {operation.cause ? <p>{operation.cause.message}</p> : null}
      {operation.status !== 'succeeded' ? <button type="button" className="small-button" disabled={!!busy} onClick={() => void perform('Checking original operation', () => inspectOriginal(operation.operationId))}>Check original operation</button> : null}
      <details><summary>Operation details</summary><dl><div><dt>Original operation</dt><dd><code>{operation.operationId}</code></dd></div>
        <div><dt>Source</dt><dd>{operation.source.hostId} · {operation.source.osAccount}</dd></div><div><dt>Target</dt><dd>{operation.target.hostId} · {operation.target.osAccount}</dd></div></dl></details>
    </div> : null}
    {busy ? <p className="field-hint" role="status">{busy}…</p> : null}
    {error ? <p className="field-error" role="alert">{error}</p> : null}
    <ConfirmationDialog open={active && remove !== null} title="Remove application rule?" {...(remove ? { subject: remove.profile.label } : {})}
      description="Stops managing this rule. Credentials on either account remain unchanged, and original operations stay available."
      confirmLabel="Remove rule" busy={!!busy} onCancel={() => setRemove(null)} onConfirm={() => {
        if (!remove) return
        const captured = remove
        void perform('Removing rule', async () => {
          ++readEpoch.current
          await api.applications.call('settings.applications.delete', { profileId: captured.profileId, expectedRevision: captured.revision })
          if (!mounted.current) return
          ++readEpoch.current
          setRemove(null); setSelected(null); await read()
        })
      }} />
  </section>
}

function AccessObservation({ title, value }: { title: string; value: ApplicationAccessObservation }) {
  return <div><strong>{title}</strong><span>{value.osAccount ?? 'OS account unconfirmed'} · {value.hostId}</span>
    <span>{value.accountId ?? (value.status === 'login-required' ? 'Sign-in required' : 'Application account unconfirmed')}</span>
    <span>{value.scopes.length ? value.scopes.join(' · ') : 'No scopes confirmed'}</span>
    {value.cause ? <small>{value.cause.message}</small> : null}</div>
}

function EndpointEditor({ title, value, hosts, onChange }: {
  title: string; value: DraftEndpoint; hosts: HostConfig[]; onChange: (value: DraftEndpoint) => void
}) {
  const [reading, setReading] = useState(false), [error, setError] = useState<string | null>(null)
  const current = useRef(value)
  current.current = value
  const selected = hosts.find(host => host.id === value.hostId)
  async function identify(): Promise<void> {
    if (!selected) return
    const original = value
    setReading(true); setError(null)
    try {
      const result = await api.hosts.inspect(selected)
      if (current.current.hostId !== original.hostId || current.current.runtimeId !== original.runtimeId) return
      if (result.owner.state !== 'available') throw new Error('The environment identity is not confirmed. Connect this environment or enter its known Runtime ID.')
      onChange({ ...current.current, runtimeId: result.owner.value.runtimeId })
    } catch (failure) { setError(message(failure)) } finally { setReading(false) }
  }
  return <fieldset className="application-access__endpoint"><legend>{title}</legend>
    <label><span>Environment</span><select aria-label={`${title} environment`} value={value.hostId} onChange={event => {
      const host = hosts.find(item => item.id === event.target.value)
      if (host) { onChange({ ...value, hostId: host.id, runtimeId: host.kind === 'ssh' ? host.runtimeId ?? '' : '' }); setError(null) }
    }}>{!selected ? <option value={value.hostId}>{value.hostId} · unavailable</option> : null}{hosts.map(host => <option key={host.id} value={host.id}>{host.label}</option>)}</select></label>
    <label><span>OS account</span><TextInput required aria-label={`${title} OS account`} value={value.osAccount} onChange={event => onChange({ ...value, osAccount: event.target.value })} /></label>
    <label><span>Runtime ID</span><TextInput required aria-label={`${title} Runtime ID`} value={value.runtimeId} onChange={event => onChange({ ...value, runtimeId: event.target.value })} /></label>
    <button type="button" className="small-button" disabled={reading || !selected} onClick={() => void identify()}>{reading ? 'Reading identity…' : 'Read environment identity'}</button>
    <label><span>Connector command</span><TextInput required aria-label={`${title} connector command`} value={value.command} onChange={event => onChange({ ...value, command: event.target.value })} placeholder="Absolute executable on this Host" /></label>
    <label><span>Arguments <small>JSON array, no shell expansion</small></span><TextInput aria-label={`${title} connector arguments`} value={value.argumentsText} onChange={event => onChange({ ...value, argumentsText: event.target.value })} /></label>
    {error ? <p className="field-error" role="alert">{error}</p> : null}
  </fieldset>
}
