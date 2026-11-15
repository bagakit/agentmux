import { Fragment, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { AgentMuxRpcParams, AgentMuxRpcResult } from '@agentmux/core'
import { AgentProviderIcon } from '@agentmux/client-ui/components/AgentProviderIcon'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { NativeSelect, TextInput } from '@agentmux/client-ui/input'
import type { AppConfig, HostConfig } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import { ServiceWindowNotice } from '../ServiceWindowNotice'
import './provider-hooks.css'

export type ProviderHookDestination = { hostId: string; providerId: string; label: string; executorId?: string }
type HookScopes = AgentMuxRpcResult<'settings.providers.hooks-list'>
type HookScope = HookScopes['scopes'][number]
type ScopeTarget = AgentMuxRpcParams<'settings.providers.hooks-inspect'>
type ScopeObservation = { result?: HookScope; update?: HookScope['update'] | undefined; error?: string }
type ScopeRead = { host: HostConfig; workspacePath?: string | undefined; result?: HookScopes | undefined; error?: string | undefined; refreshing?: boolean }

const healthLabels = {
  current: 'Configuration current', issue: 'Needs attention', unknown: 'Configuration unconfirmed', 'not-managed': 'No managed Hook'
}

function HookWorkspaceField({ label, caption = 'Workspace', path, workspaces, onChange }: {
  label: string; caption?: string; path: string | undefined; workspaces: AppConfig['workspaces']; onChange(path: string | undefined): void
}) {
  const [customPath, setCustomPath] = useState(path ?? '')
  function applyWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onChange(customPath.trim() || undefined)
  }
  return <div className="provider-hooks__workspace">
    {workspaces.length ? <label className="settings-compact-field"><span>{caption}</span>
      <NativeSelect aria-label={label} value={path ?? ''} onChange={event => onChange(event.target.value || undefined)}>
        <option value="">Choose a workspace</option>
        {workspaces.map(workspace => <option key={workspace.id} value={workspace.path}>{workspace.name}</option>)}
      </NativeSelect>
    </label> : <form className="settings-compact-field" onSubmit={applyWorkspace}>
      <label className="settings-compact-field"><span>{caption}</span>
        <TextInput aria-label={label} placeholder="Absolute path on this Host" value={customPath} onChange={event => setCustomPath(event.target.value)} />
      </label>
      <button className="small-button" type="submit">Use workspace</button>
    </form>}
  </div>
}

function HookActivationCheck({ scope, hostId, runtimeId, initialWorkspace, workspaces, requestedExecutor }: {
  scope: HookScope; hostId: string; runtimeId: string; initialWorkspace: string | undefined
  workspaces: AppConfig['workspaces']; requestedExecutor: string | undefined
}) {
  const eligible = scope.executors.filter(item => item.canInspectLoading)
  const [chosenExecutor, setChosenExecutor] = useState(requestedExecutor)
  const executor = eligible.find(item => item.executorId === chosenExecutor) ?? eligible[0]
  const [workspacePath, setWorkspacePath] = useState(initialWorkspace)
  const [pending, setPending] = useState(false)
  const inFlight = useRef(false)
  const [read, setRead] = useState<{ key: string; message: string; action?: string | null }>()
  const key = JSON.stringify([executor?.executorId, executor?.configRevision, workspacePath])
  async function check() {
    if (!executor || !workspacePath || inFlight.current) return
    inFlight.current = true
    setPending(true)
    setRead(undefined)
    const input = { hostId, runtimeId, workspacePath, executorId: executor.executorId, configRevision: executor.configRevision }
    try {
      const reply = await api.providers.inspectHookActivation(input)
      if (reply.routeHostId !== hostId || reply.runtimeId !== runtimeId || reply.workspacePath !== workspacePath ||
          reply.executorId !== executor.executorId || reply.configRevision !== executor.configRevision || reply.inspection.providerId !== scope.providerId) {
        throw new Error('The reply did not confirm this Executor and Workspace.')
      }
      const replyPaths = new Set(reply.inspection.targets.map(item => item.path))
      if (scope.kind === 'configuration' && replyPaths.size > 0 && (scope.paths.length !== replyPaths.size || scope.paths.some(path => !replyPaths.has(path)))) {
        setRead({ key, message: 'This Workspace uses a different Hook configuration.', action: 'Select this Workspace for relative Hook paths to find its scope.' })
        return
      }
      const { code, status, action } = reply.inspection
      const message = code === 'HOOK_CONFIGURATION_DISABLED' || code === 'HOOK_NATIVE_DISABLED' ? 'Native activation is disabled for this launch configuration.'
        : status === 'installed' ? 'Native activation confirmed for this launch configuration.' : 'Native activation unconfirmed.'
      setRead({ key, message, action })
    } catch (cause) {
      setRead({ key, message: 'Native activation unconfirmed.', action: presentError(cause) })
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }
  return <details className="provider-hook-scope__details">
    <summary>Native activation check</summary>
    <p>Check the selected Executor’s launch configuration in a Workspace. Each Run has its own loading and delivery state.</p>
    {eligible.length > 1 ? <label className="settings-compact-field"><span>Executor</span>
      <NativeSelect aria-label="Executor for native activation" value={executor?.executorId ?? ''} onChange={event => setChosenExecutor(event.target.value)}>
        {eligible.map(item => <option key={item.executorId} value={item.executorId}>{item.label}</option>)}
      </NativeSelect>
    </label> : null}
    <HookWorkspaceField label="Native activation workspace" path={workspacePath} workspaces={workspaces} onChange={setWorkspacePath} />
    <button type="button" className="small-button" disabled={pending || !executor || !workspacePath} onClick={() => void check()}>Check native activation</button>
    {pending ? <p role="status">Checking native activation…</p> : read?.key === key ? <p role="status">{read.message} {read.action}</p> : null}
  </details>
}

function HookScopeCard({ scope, target, runtimeId, hostId, workspacePath, workspaces, requestedExecutor, stale, focusRef, onExecutor }: {
  scope: HookScope
  target: ScopeTarget | undefined
  runtimeId: string | undefined
  hostId: string
  workspacePath: string | undefined
  workspaces: AppConfig['workspaces']
  requestedExecutor: string | undefined
  stale: boolean
  focusRef?: ((element: HTMLElement | null) => void) | undefined
  onExecutor(executorId: string): void
}) {
  const titleId = useId()
  const [observation, setObservation] = useState<ScopeObservation>()
  const [pending, setPending] = useState<'check' | 'update'>()
  const inFlight = useRef(false)
  const exact = observation?.result
  const { health, inspection, canUpdate } = exact && exact.inspection.checkedAt >= scope.inspection.checkedAt ? exact : scope
  const update = observation?.update ?? scope.update
  const canInspectLoading = scope.executors.some(item => item.canInspectLoading)

  async function maintain(action: 'check' | 'update') {
    if (!target || inFlight.current) return
    inFlight.current = true
    setPending(action)
    try {
      const operation = action === 'check' ? api.providers.inspectHookScope : api.providers.updateHookScope
      const result = await operation(target)
      if (result.routeHostId !== target.hostId || result.runtimeId !== target.runtimeId || result.workspacePath !== target.workspacePath ||
          result.scope.providerId !== target.providerId || result.scope.scopeId !== target.scopeId || result.scope.scopeRevision !== target.scopeRevision) {
        throw new Error('The reply did not confirm this Hook scope.')
      }
      const checked = result.scope.inspection.status !== 'error' && result.scope.inspection.status !== 'skipped'
      setObservation(previous => ({ result: result.scope,
        update: action === 'update' ? result.scope.update : previous?.update?.status === 'unconfirmed' && checked ? undefined : previous?.update }))
    } catch (cause) {
      setObservation(current => ({ ...current, error: presentError(cause) }))
    } finally {
      inFlight.current = false
      setPending(undefined)
    }
  }

  const title = scope.kind === 'configuration' ? 'Configuration' : scope.kind === 'launch-carried' ? 'Hooks supplied at launch'
    : scope.kind === 'unmanaged' ? 'No managed Hook' : 'Configuration scope unconfirmed'
  const status = pending === 'update' ? 'Updating…' : pending ? 'Checking…' : observation?.error ? 'Check unconfirmed'
    : scope.kind === 'configuration' ? healthLabels[health] : undefined
  // The readback describes the native file. A successful write and a later Run's load are separate facts.
  const updateMessage = update.status === 'updated' ? 'Managed configuration updated.'
    : update.status === 'unchanged' ? 'The managed configuration required no write.'
    : update.status === 'unconfirmed' ? `Update unconfirmed (${update.code}). Check this scope before retrying.`
    : undefined
  const details = inspection.targets.filter(item => item.expectedRevision || item.legacyDeclarations)
  return <li ref={focusRef} className="provider-hook-scope" data-hook-scope={scope.scopeId} data-requested={Boolean(requestedExecutor) || undefined}
    aria-labelledby={titleId} tabIndex={requestedExecutor ? -1 : undefined}>
    <div className="provider-hook-scope__main">
      <div className="provider-hook-scope__identity">
        <h4 id={titleId}>{scope.paths.length ? scope.paths.map(path => <code key={path}>{path}</code>) : title}</h4>
        {status ? <span className="provider-hook-scope__status" data-health={observation?.error || pending ? 'unknown' : health} role="status">
          {health === 'issue' ? <span className="settings-hook-problem-dot" role="img" aria-label="Hook needs attention" /> : null}{status}
        </span> : null}
      </div>
      {target ? <div className="provider-hook-scope__actions">
        <button type="button" className="small-button" disabled={Boolean(pending)} onClick={() => void maintain('check')}>Check</button>
        {canUpdate ? <button type="button" className="small-button" disabled={Boolean(pending || observation?.error || update.status === 'unconfirmed' || stale && !exact)}
          onClick={() => void maintain('update')}>Update configuration</button> : null}
      </div> : null}
    </div>
    {scope.executors.length ? <div className="provider-hook-scope__executors">
      <span>{scope.executors.length === 1 ? 'Executor' : 'Executors'}</span>
      <ul aria-label="Associated Executors">
        {scope.executors.map(item => <li key={item.executorId}>
          <button type="button" title={item.executorId} aria-current={item.executorId === requestedExecutor ? 'true' : undefined}
            onClick={() => onExecutor(item.executorId)}>{item.label}</button>
        </li>)}
      </ul>
    </div> : null}
    {scope.kind === 'launch-carried' ? <p>Check loading on the original Run.</p> : inspection.action ? <p>{inspection.action}</p> : null}
    {updateMessage ? <p role="status">{updateMessage}</p> : null}
    {observation?.error ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
      step: 'Hook operation unconfirmed', mode: observation.error, restore: 'Check this scope again. Existing Runs retain their execution state.'
    } }} /> : null}
    {details.length ? <details className="provider-hook-scope__details">
      <summary>Configuration details</summary>
      {details.map(item => <div key={item.path}>
        {details.length > 1 ? <code>{item.path}</code> : null}
        {item.expectedRevision ? <dl className="settings-executor-identity">
          <div><dt>Observed config revision</dt><dd>{item.observedRevision
            ? <code title={item.observedRevision}>{item.observedRevision.slice(0, 12)}</code>
            : item.status === 'not_present' ? 'Not present' : 'Unconfirmed'}</dd></div>
          <div><dt>Expected config revision</dt><dd><code title={item.expectedRevision}>{item.expectedRevision.slice(0, 12)}</code></dd></div>
        </dl> : null}
        {item.legacyDeclarations ? <p>{item.legacyDeclarations} older {item.legacyDeclarations === 1 ? 'declaration' : 'declarations'}{item.missingLegacyEntrypoints ? ` · ${item.missingLegacyEntrypoints} with a missing executable or runner` : ''}</p> : null}
      </div>)}
    </details> : null}
    {runtimeId && canInspectLoading ? <HookActivationCheck scope={scope} hostId={hostId} runtimeId={runtimeId}
      initialWorkspace={workspacePath} workspaces={workspaces} requestedExecutor={requestedExecutor} /> : null}
  </li>
}

export function ProviderHooksPane({ active, destination, host, workspaces, onBack, onExecutor }: {
  active: boolean
  destination: ProviderHookDestination
  host: HostConfig | undefined
  workspaces: AppConfig['workspaces']
  onBack(): void
  onExecutor(hostId: string, providerId: string, executorId: string): void
}) {
  const { hostId, providerId, label, executorId } = destination
  const [workspacePath, setWorkspacePath] = useState<string>()
  const [refresh, setRefresh] = useState(0)
  const [read, setRead] = useState<ScopeRead>()
  const heading = useRef<HTMLHeadingElement>(null)
  const requestedScope = useRef<HTMLElement | null>(null)
  const focusScope = useRef(true)
  const availableWorkspaces = workspaces.filter(workspace => workspace.hostId === hostId && !workspace.closeout)
  const current = read && read.host === host && read.workspacePath === workspacePath ? read : undefined
  const scopes = current?.result?.scopes
  const runtimeId = current?.result?.runtimeId
  const matching = executorId ? scopes?.find(scope => scope.executors.some(item => item.executorId === executorId)) : undefined
  const workspaceAnchor = scopes?.find(scope => scope.inspection.code === 'HOOK_WORKSPACE_REQUIRED')
  const workspaceControl = workspaceAnchor || workspacePath ? <HookWorkspaceField label="Hook workspace" caption="Workspace for relative Hook paths"
    path={workspacePath} workspaces={availableWorkspaces} onChange={setWorkspacePath} /> : null

  useEffect(() => { if (active) heading.current?.focus() }, [active, destination])
  useEffect(() => {
    if (active && focusScope.current && requestedScope.current) {
      focusScope.current = false
      requestedScope.current.focus()
    }
  }, [active, matching?.scopeId])
  useEffect(() => {
    if (!active || !host) return
    let live = true
    const input = { hostId, providerId, ...(workspacePath ? { workspacePath } : {}) }
    setRead(previous => ({ host, workspacePath, refreshing: true,
      result: previous?.host === host && previous.workspacePath === workspacePath ? previous.result : undefined }))
    void api.providers.listHookScopes(input).then(result => {
      if (!live) return
      if (result.routeHostId !== hostId || result.workspacePath !== workspacePath || result.scopes.some(scope => scope.providerId !== providerId)) {
        throw new Error('The reply did not confirm this Host and Provider.')
      }
      setRead({ host, workspacePath, result })
    }).catch(cause => {
      if (live) setRead(previous => ({ host, workspacePath, error: presentError(cause),
        result: previous?.host === host && previous.workspacePath === workspacePath ? previous.result : undefined }))
    })
    return () => { live = false }
  }, [active, host, hostId, providerId, workspacePath, refresh])

  return <section className="settings-pane-stack provider-hooks" aria-label="Provider Hooks" hidden={!active}>
    <button type="button" className="provider-hooks__back" aria-label="Back to Providers" onClick={onBack}>
      <SemanticIcon name="navigation.back" size={14} aria-hidden="true" /> Providers
    </button>
    <header className="provider-hooks__heading">
      <AgentProviderIcon providerId={providerId} size={25} />
      <div><h3 ref={heading} tabIndex={-1}>{label} Hooks</h3><p>{host?.label ?? hostId}</p></div>
      {host ? <button type="button" className="icon-button" aria-label="Refresh Hook scopes" title="Refresh Hook scopes" disabled={current?.refreshing} onClick={() => setRefresh(value => value + 1)}>
        <SemanticIcon name="action.refresh" size={14} aria-hidden="true" />
      </button> : null}
    </header>
    {!host ? <p role="status">This Host is unavailable.</p> : !current?.result && !current?.error ? <p role="status">Reading Hook scopes…</p> : null}
    {current?.error ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
      step: 'Hook scope discovery failed', mode: current.error, restore: 'Refresh Hook scopes when the Host is reachable.'
    } }} /> : null}
    {scopes && !scopes.length ? <p role="status">This Host reports no Hook scopes for {label}.</p> : null}
    {executorId && scopes && !matching ? <p role="status">This Host did not confirm a Hook scope for {executorId}.</p> : null}
    {scopes?.length ? <ul className="provider-hooks__scopes" aria-label="Hook scopes">
      {scopes.map(scope => <Fragment key={JSON.stringify([runtimeId, workspacePath, scope.scopeId, scope.scopeRevision])}>
        {scope === workspaceAnchor ? <li className="provider-hooks__workspace-anchor">{workspaceControl}</li> : null}
        <HookScopeCard scope={scope} target={scope.kind === 'configuration' && runtimeId && scope.scopeRevision ? {
            hostId, runtimeId, providerId, scopeId: scope.scopeId, scopeRevision: scope.scopeRevision, ...(workspacePath ? { workspacePath } : {})
          } : undefined}
          runtimeId={runtimeId} hostId={hostId} workspacePath={workspacePath} workspaces={availableWorkspaces} stale={Boolean(current?.error)}
          requestedExecutor={scope === matching ? executorId : undefined} focusRef={scope === matching ? element => { requestedScope.current = element } : undefined}
          onExecutor={id => onExecutor(hostId, providerId, id)} />
      </Fragment>)}
    </ul> : null}
    {!workspaceAnchor ? workspaceControl : null}
  </section>
}
