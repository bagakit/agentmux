import { useEffect, useId, useRef, useState } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import { parseNodePublishingPolicy, type NodeSettings, type NodePublishingPolicy } from '@agentmux/core/node-publishing'
import { Switch, Textarea, TextInput } from '@agentmux/client-ui/input'
import { FormRow } from '@agentmux/client-ui/components/FormRow'
import { api } from '../../lib/api'
import { useAppStore, updateNodePublicationDraft } from '../../store'
import { nodePublicationDraftForRuntime, type NodePublicationDraft } from '../../lib/node-publication-draft'
import { configValuesEqual } from '../../../../shared/config-edit'
import { HostRuntimePanel } from './HostRuntimePanel'
import { nodePublicationTarget, useNodePublicationReporter } from './NodePublicationObservation'
import { NodeShareAddress } from './NodeShareAddress'
import { SelectionField } from '../SelectionField'
import type { HostConfig } from '../../../../shared/contracts'
import type { NodeOwnerTarget } from '../../../../shared/node-publishing'
import type { SettingsPaneProps } from './settings-catalog'
import './network-node.css'

/** Selection is presentation; only the answering original Core supplies its identity. */
export function NetworkNodeSettingsPane({ config, active, onNavigate, navigationRequest }: SettingsPaneProps) {
  const publication = useNodePublicationReporter()
  const local = config.hosts.find(host => host.kind === 'local')
  const fieldId = useId(), labelId = `node-to-manage-label-${fieldId}`, hintId = `node-to-manage-hint-${fieldId}`
  const [selected, setSelected] = useState(navigationRequest?.hostId ?? local?.id ?? '')
  useEffect(() => { if (navigationRequest?.hostId) setSelected(navigationRequest.hostId) }, [navigationRequest])
  const host = config.hosts.find(item => item.id === selected)
  const route = host ? JSON.stringify((({ label: _label, ...value }) => value)(host)) : ''
  const [identity, setIdentity] = useState<{ route: string; target?: NodeOwnerTarget; error?: string }>()
  const [refresh, setRefresh] = useState(0)
  useEffect(() => { if (active && host) publication?.select(nodePublicationTarget(host)) }, [active, route, publication])
  useEffect(() => {
    if (!active || !host) return
    const controller = new AbortController()
    if (host.kind === 'ssh' && host.runtimeId) {
      setIdentity({ route, target: { hostId: host.id, expectedRuntimeId: host.runtimeId } })
      return () => controller.abort()
    }
    void api.nodePublishing.call('node.inspect', { hostId: host.id }, controller.signal).then(observed => {
      if (controller.signal.aborted) return
      if (!observed.node.runtimeId) throw new Error('The original Node identity is not available. Refresh this saved Host; its input and Agents are kept.')
      publication?.select(nodePublicationTarget(host, observed.node.runtimeId))
      publication?.confirmed(nodePublicationTarget(host, observed.node.runtimeId), { runtimeId: observed.node.runtimeId, published: observed.resourcesShared || observed.roots.length > 0, checkedAt: Date.now() })
      setIdentity({ route, target: { hostId: host.id, expectedRuntimeId: observed.node.runtimeId } })
    }).catch(cause => { if (!controller.signal.aborted) { const message = cause instanceof Error ? cause.message : String(cause); setIdentity({ route, error: message }); publication?.unknown(nodePublicationTarget(host), message) } })
    return () => controller.abort()
  }, [route, active, refresh, publication])
  const target = identity?.route === route ? identity.target : undefined
  return <div className="settings-pane-stack network-node-settings" data-settings-host={host?.id}>
    <div className="network-node-intro"><h3>Manage a node</h3><p>Select a saved Host to manage what its original Core publishes. Connecting and starting work stay separate.</p><button type="button" className="small-button" onClick={() => onNavigate('hosts')}>Open Mesh</button></div>
    <label className="network-node-field"><span id={labelId}>Node to manage</span><SelectionField label="Node to manage" labelledBy={labelId} describedBy={hintId} value={selected} missingOptionLabel="Original saved Host unavailable" missingOptionDescription="Select an original saved Host; no replacement target is selected automatically." options={config.hosts.map(item => ({ value: item.id, label: `${item.label} · ${item.kind === 'local' ? 'This device' : 'Remote Host'} · ${item.id}` }))} onValueChange={setSelected} /><small id={hintId}>{host ? `${host.id}${target ? ` · Runtime ${target.expectedRuntimeId}` : ' · Identity not confirmed'}` : 'Select an original saved Host; no replacement target is selected automatically.'}</small></label>
    {host && target ? <NodePublicationEditor key={route + target.expectedRuntimeId} host={host} target={target} active={active} /> : <section className="network-node-section"><p role="status">{identity?.route === route && identity.error ? identity.error : host ? 'Reading the selected Node identity…' : 'The requested saved Host is unavailable. Original drafts are retained.'}</p><button type="button" className="small-button" onClick={() => setRefresh(value => value + 1)}>Refresh Node identity</button></section>}
  </div>
}

/** Core owns publication. Each mounted editor retains exactly one original Runtime. */
function NodePublicationEditor({ host, target, active }: { host: HostConfig; target: NodeOwnerTarget; active: boolean }) {
  const publication = useNodePublicationReporter()
  const publicationTarget = nodePublicationTarget(host, target.expectedRuntimeId)
  const publicationRead = useRef<AbortController | null>(null)
  const publicationVisible = useRef(active)
  publicationVisible.current = active
  const report = (next: NodeSettings) => {
    publicationRead.current?.abort()
    if (!publication) return
    // Only Core knows which configured folders are actually published after exclusions.
    // This display-only read neither delays nor changes the owner's editor or save.
    if (!next.policy.shareResources && next.policy.allowedPaths.length > 0) {
      if (!publicationVisible.current) return
      const controller = new AbortController(); publicationRead.current = controller
      publication.unknown(publicationTarget, 'Reading the original published folders…')
      void api.nodePublishing.call('node.inspect', { hostId: host.id, expectedRuntimeId: target.expectedRuntimeId }, controller.signal).then(reply => {
        if (!controller.signal.aborted) publication.confirmed(publicationTarget, { runtimeId: reply.node.runtimeId, published: reply.resourcesShared || reply.roots.length > 0, checkedAt: Date.now() })
      }).catch(cause => { if (!controller.signal.aborted) publication.unknown(publicationTarget, cause instanceof Error ? cause.message : String(cause)) })
    } else publication.confirmed(publicationTarget, { runtimeId: next.node.runtimeId, published: next.policy.shareResources, checkedAt: Date.now() })
  }
  useEffect(() => { if (!active) publicationRead.current?.abort(); return () => publicationRead.current?.abort() }, [active])
  const [observed, setObserved] = useState<NodeSettings>(), [newer, setNewer] = useState<NodeSettings>()
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const edits = useAppStore(state => state.nodePublicationDrafts)
  let edit: NodePublicationDraft | undefined, editIssue = ''
  try { if (observed) edit = nodePublicationDraftForRuntime(edits, observed.node.runtimeId) }
  catch (cause) { editIssue = cause instanceof Error ? cause.message : String(cause) }
  const saved = edit?.baseline ?? observed, draft = edit?.draft ?? observed?.policy
  const operation = edit?.pending?.operationId ?? (observed?.operation?.status === 'unknown' ? observed.operation.operationId : undefined)
  const loaded = useRef(false), epoch = useRef(0), reader = useRef<AbortController | null>(null)
  const displayedPending = useRef<{ runtimeId: string; operationId: string } | undefined>(undefined)
  const [monitor, setMonitor] = useState(false)
  const baseline = (value: NodeSettings) => ({ node: value.node, policyRevision: value.policyRevision, policy: value.policy })
  const unresolved = (value: NodePublicationDraft): NodePublicationDraft | undefined => value.pending || !configValuesEqual(value.baseline.policy, value.draft) ? value : undefined
  async function retain(runtimeId: string, update: (current: NodePublicationDraft | undefined) => NodePublicationDraft | undefined, flush = false) {
    await updateNodePublicationDraft(runtimeId, update, flush)
  }
  async function confirmed(runtimeId: string, operationId: string, next: NodeSettings): Promise<boolean> {
    let review = false
    await retain(runtimeId, current => {
      if (current?.pending?.operationId !== operationId) return current
      const laterDraft = !configValuesEqual(current.draft, current.pending.submitted)
      if (laterDraft && next.policyRevision !== next.operation?.revision) {
        review = true
        const { pending: _completed, ...rest } = current
        return rest
      }
      return unresolved({ baseline: baseline(next), draft: laterDraft ? current.draft : next.policy })
    })
    return review
  }
  async function inspect(originalOperation?: string, expectedRuntimeId?: string) {
    reader.current?.abort(); const controller = new AbortController(); reader.current = controller
    const editsBeforeRead = useAppStore.getState().nodePublicationDrafts
    const request = ++epoch.current; setBusy(true); setError('')
    try {
      const next = await api.nodePublishing.owner(target, 'settings.node.inspect', originalOperation ? { operationId: originalOperation } : {}, controller.signal)
      if (request !== epoch.current || controller.signal.aborted) return
      if (next.node.runtimeId !== (expectedRuntimeId ?? target.expectedRuntimeId)) throw new Error('The original Node Runtime changed. Its publication edit and request are kept for that Runtime; this read did not retarget them.')
      setObserved(next)
      const retained = nodePublicationDraftForRuntime(useAppStore.getState().nodePublicationDrafts, next.node.runtimeId)
      const beforeRead = nodePublicationDraftForRuntime(editsBeforeRead, next.node.runtimeId)
      loaded.current = true
      // An independent publication read confirms current policy, separately from any old OP receipt.
      report(next)
      if (!originalOperation && beforeRead?.pending && !retained?.pending) {
        // A completed producer may precede this initial read's older snapshot.
        void inspect(beforeRead.pending.operationId, next.node.runtimeId)
        return
      }
      if (originalOperation && retained?.pending?.operationId === originalOperation) {
        if (next.operation?.status === 'confirmed') {
          if (await confirmed(next.node.runtimeId, originalOperation, next)) {
            setNewer(next); setError('Saved publication changed after the original save. Your later draft is kept; review the current saved settings before saving it.')
          }
        } else if (next.operation === null && retained.pending.phase !== 'in-flight') {
          await retain(next.node.runtimeId, current => {
            if (current?.pending?.operationId !== originalOperation) return current
            const { pending: _original, ...rest } = current
            return rest.baseline.policyRevision !== next.policyRevision ? rest : unresolved(rest)
          })
          if (retained.baseline.policyRevision !== next.policyRevision) setNewer(next)
        } else if (retained.pending.phase !== 'in-flight') setError('The original save is not confirmed. Inspect its result before saving again.')
      } else if (!originalOperation && retained?.pending) {
        // Restoring an input reference authorizes only this read, never configure.
        void inspect(retained.pending.operationId, next.node.runtimeId)
      } else if (retained && retained.baseline.policyRevision !== next.policyRevision) {
        setNewer(next); setError('Saved publication changed. Your draft is kept; review the saved settings or keep your draft before saving.')
      } else if (next.operation?.status === 'unknown') setError('The original save is not confirmed. Inspect its result before saving again.')
      if (originalOperation && next.operation === null && retained?.pending?.phase !== 'in-flight') setError('The original operation was not recorded. Current publication was read again. Your draft is kept.')
    } catch (cause) { if (request === epoch.current && !controller.signal.aborted) { const message = cause instanceof Error ? cause.message : String(cause); setError(message); publication?.unknown(publicationTarget, message) } }
    finally { if (reader.current === controller) reader.current = null; if (request === epoch.current && !controller.signal.aborted) setBusy(false) }
  }
  useEffect(() => { if (active && !loaded.current) void inspect(); if (!active && reader.current) { reader.current.abort(); reader.current = null; setBusy(false) } }, [active])
  useEffect(() => {
    if (!active || !observed) return
    const previous = displayedPending.current
    displayedPending.current = edit?.pending ? { runtimeId: observed.node.runtimeId, operationId: edit.pending.operationId } : undefined
    // A departed producer can close the edit after this pane read the older policy.
    // Borrow the same original observation instead of keeping a policy mirror.
    if (!edit?.pending && previous?.runtimeId === observed.node.runtimeId) void inspect(previous.operationId, previous.runtimeId)
  }, [active, observed?.node.runtimeId, edits])
  useEffect(() => () => { ++epoch.current; reader.current?.abort() }, [])
  async function savePolicy() {
    if (!saved || !draft || busy || operation || editIssue) return
    let submitted: NodePublishingPolicy
    try { submitted = parseNodePublishingPolicy(structuredClone(draft)) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return }
    const runtimeId = saved.node.runtimeId, operationId = mintObjectId(), request = ++epoch.current
    let dispatched = false
    setBusy(true); setError('')
    try {
      // The original user writer confirms custody before any external configure call.
      await retain(runtimeId, current => {
        if (current?.pending) throw new Error('An original publication request is retained. Inspect it before saving again.')
        return { baseline: current?.baseline ?? { node: saved.node, policyRevision: saved.policyRevision, policy: saved.policy }, draft: current?.draft ?? submitted,
          pending: { operationId, expectedRevision: saved.policyRevision, submitted, phase: 'in-flight' } }
      }, true)
      if (nodePublicationDraftForRuntime(useAppStore.getState().nodePublicationDrafts, runtimeId)?.pending?.operationId !== operationId) throw new Error('The original local publication intent changed before dispatch. No policy request was sent.')
      dispatched = true
      publicationRead.current?.abort()
      publication?.unknown(publicationTarget, 'The publication save is awaiting confirmation.')
      const next = await api.nodePublishing.owner(target, 'settings.node.configure', { expectedRevision: saved.policyRevision, operationId, policy: submitted })
      if (next.node.runtimeId !== runtimeId) throw new Error('Publication returned another Runtime. The original request and edit are retained for inspection.')
      const review = next.operation?.status === 'confirmed' ? await confirmed(runtimeId, operationId, next) : false
      if (request !== epoch.current) return
      setObserved(next); setNewer(review ? next : undefined)
      if (next.operation?.status === 'confirmed') report(next)
      if (review) setError('Saved publication changed after the original save. Your later draft is kept; review the current saved settings before saving it.')
      else if (next.operation?.status !== 'confirmed') setError('The original save is not confirmed. Inspect its result before saving again.')
    } catch (cause) {
      if (request === epoch.current && dispatched) publication?.unknown(publicationTarget, 'The original save needs confirmation.')
      if (request === epoch.current) setError(`${dispatched ? 'Publication save was not confirmed. Inspect the original result.' : 'Publication request was not sent. Saving its local edit failed; inspect the original request before trying again.'} ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      await retain(runtimeId, current => current?.pending?.operationId === operationId && current.pending.phase === 'in-flight'
        ? { ...current, pending: { ...current.pending, phase: 'unknown' } } : current).catch(cause => { if (request === epoch.current) setError(cause instanceof Error ? cause.message : String(cause)) })
      if (request === epoch.current) setBusy(false)
    }
  }
  async function useSaved(value: NodeSettings, keepDraft = false) {
    try {
      await retain(value.node.runtimeId, current => {
        if (current?.pending) throw new Error('The original publication request still needs inspection. Its edit and operation are kept.')
        return keepDraft && current ? unresolved({ ...current, baseline: baseline(value) }) : undefined
      }, true)
      setObserved(value); setNewer(undefined); setError(keepDraft ? 'Your draft is kept against the current saved revision.' : '')
    } catch (cause) { setError(`The local publication edit is not confirmed saved. ${cause instanceof Error ? cause.message : String(cause)}`) }
  }
  const dirty = Boolean(saved && draft && !configValuesEqual(saved.policy, draft))
  const patch = (value: Partial<NodePublishingPolicy>) => {
    if (!observed || editIssue) return
    void retain(observed.node.runtimeId, current => unresolved({ baseline: current?.baseline ?? baseline(observed), draft: { ...(current?.draft ?? observed.policy), ...value }, ...(current?.pending ? { pending: current.pending } : {}) })).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
  }
  const map = draft?.mapLocation ?? { coordinates: '', label: '', estimatePublicEgress: false }
  return <>
    <section className="network-node-section" data-settings-field="publishing" aria-label="Node publishing">
      <header><div><h3>Publish {host.label}</h3><p>Review the full publication policy on this Node. Saving re-confirms all listed folders; existing owner access stays independent.</p></div><button type="button" className="small-button" disabled={busy} onClick={() => void inspect(operation, operation ? observed?.node.runtimeId : undefined)}>Refresh</button></header>
      {observed ? <NodeShareAddress node={observed.node} /> : null}
      {draft ? <>
        <FormRow className="network-node-field" layout="stacked" label="Node alias"
          description="A readable locator. Original Runtime identity remains unchanged.">
          {field => <TextInput {...field} name="alias" value={draft.alias} onChange={event => patch({ alias: event.target.value })} placeholder="Optional lowercase name" />}
        </FormRow>
        <FormRow className="network-node-switch" label="Share system resources"
          description="Let authorized Node readers see this device’s real resource measurements.">
          {field => <Switch {...field} name="shareResources" checked={draft.shareResources} onChange={event => patch({ shareResources: event.target.checked })} />}
        </FormRow>
        <details className="network-node-identities">
          <summary>Map location</summary>
          <FormRow className="network-node-field" layout="stacked" label="Place name">
            {field => <TextInput {...field} name="mapPlace" value={map.label} onChange={event => patch({ mapLocation: { ...map, label: event.target.value } })} />}
          </FormRow>
          <FormRow className="network-node-field" layout="stacked" label="Latitude, longitude" description="Share a point on the map with people who can read this node.">
            {field => <TextInput {...field} name="mapCoordinates" value={map.coordinates} onChange={event => patch({ mapLocation: { ...map, coordinates: event.target.value } })} />}
          </FormRow>
          <FormRow className="network-node-switch" label="Estimate from this node’s internet connection"
            description="When this node has no declared or registered location, ask GeoJS for its approximate exit region. A VPN can change the result.">
            {field => <Switch {...field} name="mapPublicEgress" checked={map.estimatePublicEgress} onChange={event => patch({ mapLocation: { ...map, estimatePublicEgress: event.target.checked } })} />}
          </FormRow>
        </details>
        <div className="network-node-paths">
          <FormRow className="network-node-field" layout="stacked" label="Shared folders"
            description="Absolute paths, one per line. Only these published roots are browsable.">
            {field => <Textarea {...field} name="allowedPaths" rows={3} spellCheck={false} value={draft.allowedPaths.join('\n')}
              onChange={event => patch({ allowedPaths: event.target.value.split('\n') })}
              onBlur={() => patch({ allowedPaths: draft.allowedPaths.filter(value => value !== '') })} />}
          </FormRow>
          <FormRow className="network-node-field" layout="stacked" label="Excluded paths"
            description="Excluded paths take precedence, including descendants.">
            {field => <Textarea {...field} name="deniedPaths" rows={3} spellCheck={false} value={draft.deniedPaths.join('\n')}
              onChange={event => patch({ deniedPaths: event.target.value.split('\n') })}
              onBlur={() => patch({ deniedPaths: draft.deniedPaths.filter(value => value !== '') })} />}
          </FormRow>
        </div>
        <FormRow className="network-node-field" layout="stacked" label="Default landing folder"
          description="The first browsing location; this is not an operating-system sandbox.">
          {field => <TextInput {...field} name="defaultPath" value={draft.defaultPath ?? ''} onChange={event => patch({ defaultPath: event.target.value || null })} placeholder="Optional path inside a shared folder" />}
        </FormRow>
        <div className="network-node-save"><span role="status">{busy ? 'Reading or saving publication…' : editIssue ? 'Saved publication edit unavailable' : edit?.pending?.phase === 'in-flight' ? 'Original save is in progress' : operation ? 'Original save needs confirmation' : dirty ? 'Publication: unsaved changes' : 'Publication saved'}</span><button type="button" className="primary-button" disabled={busy || !dirty || Boolean(operation) || Boolean(newer) || Boolean(editIssue)} onClick={() => void savePolicy()}>Save publication</button></div>
      </> : <p role="status">{busy ? 'Reading this node…' : 'Publication has not been observed.'}</p>}
      {error || editIssue ? <p className="network-node-feedback" role="status">{error || editIssue}</p> : null}
      {newer ? <><details className="network-node-identities" data-publication-review><summary>Review saved publication</summary><dl><dt>Node alias</dt><dd>{newer.policy.alias || 'No alias'}</dd><dt>System resources</dt><dd>{newer.policy.shareResources ? 'Shared' : 'Not shared'}</dd><dt>Map location</dt><dd>{[newer.policy.mapLocation?.label, newer.policy.mapLocation?.coordinates, newer.policy.mapLocation?.estimatePublicEgress && 'Internet estimate enabled'].filter(Boolean).join(' · ') || 'No declared location'}</dd><dt>Shared folders</dt><dd className="network-node-path-review">{newer.policy.allowedPaths.join('\n') || 'No shared folders'}</dd><dt>Excluded paths</dt><dd className="network-node-path-review">{newer.policy.deniedPaths.join('\n') || 'No excluded paths'}</dd><dt>Landing folder</dt><dd>{newer.policy.defaultPath || 'Not set'}</dd><dt>Policy revision</dt><dd>{newer.policyRevision}</dd></dl></details><div className="network-node-save"><button type="button" className="small-button" onClick={() => void useSaved(newer)}>Use saved publication</button><button type="button" className="small-button" onClick={() => void useSaved(newer, true)}>Keep my publication draft</button></div></> : null}
      {operation ? <button type="button" className="small-button" disabled={busy} onClick={() => void inspect(operation, operation ? observed?.node.runtimeId : undefined)}>Inspect original save</button> : null}
      {saved ? <details className="network-node-identities"><summary>Original node identity</summary><dl><dt>Runtime</dt><dd>{saved.node.runtimeId}</dd><dt>Core instance</dt><dd>{saved.node.ownerInstanceId}</dd><dt>Policy revision</dt><dd>{saved.policyRevision}</dd></dl><button type="button" className="small-button" disabled={busy || Boolean(operation)} onClick={() => { if (observed) void useSaved(observed) }}>Use saved settings</button></details> : null}
    </section>
    <details className="network-node-section" data-settings-field="monitoring" open={monitor} onToggle={event => setMonitor(event.currentTarget.open)}><summary>Service status <span>Private owner observation · {host.label}</span></summary><HostRuntimePanel host={host} committed={host} ownerTarget={target} active={active && monitor} /></details>
  </>
}
